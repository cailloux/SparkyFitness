/**
 * Garmin Connect Personal API provider: the official, read-only API keyed by a
 * personal API key (external_data_providers.app_key, encrypted). It returns the
 * same Garmin DTOs as the garminconnect library, so the sync reuses the Garmin
 * Connect pipeline (services/garminService.ts) and writes under the same
 * 'garmin' source. Activities also get their original FIT file, imported
 * through the FIT pipeline for laps, GPS, HR zones and strength sets.
 */
import { addDays, compareDays } from '@workspace/shared';
import { getSystemClient } from '../../db/poolManager.js';
import { decrypt, ENCRYPTION_KEY } from '../../security/encryption.js';
import { log } from '../../config/logging.js';
import { describeError } from '../../utils/errors.js';
import { parseZipArchive } from '../../utils/zipUtils.js';
import { importFitBuffer } from '../../services/fitImportService.js';
import garminService, {
  processActivitiesAndWorkouts,
  type GarminSyncSource,
} from '../../services/garminService.js';
import {
  getGarminSyncPhaseErrors,
  type GarminSyncResult,
} from '../../services/garminSyncResult.js';
import {
  RANGE_LIMIT_DAYS,
  downloadActivityZip,
  garminPersonalErrorStatus,
  getInRangeChunks,
  personalApiGet,
  verifyApiKey,
} from './garminPersonalApiClient.js';
import {
  buildGarminHealthData,
  toGarminActivity,
  type PersonalApiDay,
} from './garminPersonalMapping.js';

export const GARMIN_PERSONAL_PROVIDER_TYPE = 'garmin_personal';
const ACTIVITY_PAGE_SIZE = 20;

type Dto = Record<string, unknown>;

interface ProviderRow {
  id: string;
  is_active: boolean;
  last_sync_at: Date | null;
  encrypted_app_key: string | null;
  app_key_iv: string | null;
  app_key_tag: string | null;
}

export type GarminPersonalSyncResult =
  | (GarminSyncResult & { skipped?: undefined })
  | { skipped: 'garmin_connect_active' };

async function findProvider(
  userId: string,
  providerId?: string
): Promise<ProviderRow | null> {
  const client = await getSystemClient();
  try {
    let query = `SELECT id, is_active, last_sync_at,
                        encrypted_app_key, app_key_iv, app_key_tag
                 FROM external_data_providers
                 WHERE user_id = $1 AND provider_type = '${GARMIN_PERSONAL_PROVIDER_TYPE}'`;
    const params: string[] = [userId];
    if (providerId) {
      query += ' AND id = $2';
      params.push(providerId);
    } else {
      query += ' ORDER BY is_active DESC, created_at DESC LIMIT 1';
    }
    const result = (await client.query(query, params)) as {
      rows: ProviderRow[];
    };
    return result.rows[0] ?? null;
  } finally {
    client.release();
  }
}

async function getApiKey(
  userId: string,
  providerId?: string
): Promise<{ providerId: string; apiKey: string }> {
  const row = await findProvider(userId, providerId);
  if (!row) throw new Error('Garmin Personal API provider not found.');
  if (!row.encrypted_app_key || !row.app_key_iv || !row.app_key_tag) {
    throw new Error('Garmin Personal API key is missing for this provider.');
  }
  const apiKey = await decrypt(
    row.encrypted_app_key,
    row.app_key_iv,
    row.app_key_tag,
    ENCRYPTION_KEY
  );
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new Error('Failed to decrypt the stored Garmin Personal API key.');
  }
  return { providerId: row.id, apiKey };
}

async function hasActiveGarminConnectProvider(
  userId: string
): Promise<boolean> {
  const client = await getSystemClient();
  try {
    const result = await client.query(
      `SELECT 1 FROM external_data_providers
       WHERE user_id = $1 AND provider_type = 'garmin' AND is_active = TRUE
       LIMIT 1`,
      [userId]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

function daysBetween(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  for (let d = startDate; compareDays(d, endDate) <= 0; d = addDays(d, 1)) {
    days.push(d);
  }
  return days;
}

/**
 * One metric failing must not drop the rest of the day, as in routes.py; a
 * rejected key (401/403 after the token refresh) still fails the phase.
 */
function optionalGet(apiKey: string) {
  return async <T>(
    path: string,
    params?: Record<string, string>
  ): Promise<T | null> => {
    try {
      return await personalApiGet<T>(apiKey, path, params);
    } catch (error) {
      const status = garminPersonalErrorStatus(error);
      if (status === 401 || status === 403) throw error;
      log('warn', `[garminPersonalService] ${describeError(error)}`);
      return null;
    }
  };
}

/** The Personal API as a data source for the Garmin sync pipeline. */
export function personalApiSyncSource(apiKey: string): GarminSyncSource {
  const get = optionalGet(apiKey);

  return {
    fetchHealth: async (_userId, startDate, endDate) => {
      const summaries = (
        await getInRangeChunks(
          startDate,
          endDate,
          RANGE_LIMIT_DAYS.dailySummaries,
          (s, e) =>
            get<{ data?: Dto[] } | Dto[]>(
              '/usersummary-service/v2/dailysummaries',
              { startDate: s, endDate: e }
            )
        )
      ).flatMap((r) => (Array.isArray(r) ? r : (r.data ?? [])));

      const days: PersonalApiDay[] = [];
      for (const date of daysBetween(startDate, endDate)) {
        days.push({
          date,
          summary: summaries.find((s) => s.calendarDate === date) ?? null,
          sleep: await get<Dto>('/sleep-service/sleep/dailySleep', { date }),
          hrv: await get<Dto>(`/hrv-service/hrv/${date}`),
          heartRate: await get<Dto>(
            '/wellness-service/wellness/dailyHeartRate',
            {
              date,
            }
          ),
          fitnessAge: await get<Dto>(
            `/fitnessage-service/fitnessage/v2/${date}`
          ),
        });
      }

      const hydration = await getInRangeChunks(
        startDate,
        endDate,
        RANGE_LIMIT_DAYS.hydration,
        (s, e) =>
          get<unknown[]>(`/usersummary-service/stats/hydration/daily/${s}/${e}`)
      );
      const bodyBattery = await getInRangeChunks(
        startDate,
        endDate,
        RANGE_LIMIT_DAYS.bodyBattery,
        (s, e) =>
          get<unknown[]>(
            '/wellness-service/wellness/bodyBattery/reports/daily',
            {
              startDate: s,
              endDate: e,
            }
          )
      );
      const weight = await get<Dto>(
        `/weight-service/weight/range/${startDate}/${endDate}`,
        { includeAll: 'true' }
      );

      return buildGarminHealthData(days, {
        hydration: hydration.flat(),
        bodyBattery: bodyBattery.flat(),
        weight,
      });
    },

    syncActivities: async (userId, startDate, endDate, timezone) => {
      const activities: Dto[] = [];
      for (let start = 0; ; start += ACTIVITY_PAGE_SIZE) {
        const page =
          (await personalApiGet<Dto[]>(
            apiKey,
            '/activitylist-service/activities/search/activities',
            { start, limit: ACTIVITY_PAGE_SIZE, startDate, endDate }
          )) ?? [];
        activities.push(...page);
        if (page.length < ACTIVITY_PAGE_SIZE) break;
      }

      // Summaries first, through the same range-replace as Garmin Connect, so
      // an activity without a usable file still lands in the diary.
      const result = await processActivitiesAndWorkouts(
        userId,
        {
          activities: activities.map((a) => ({
            activity: toGarminActivity(a),
          })),
          workouts: [],
        },
        startDate,
        endDate,
        timezone
      );

      // Then the original FIT replaces each summary (same source and
      // source_id) with laps, GPS, HR zones and strength sets.
      for (const activity of activities) {
        const activityId = String(activity.activityId ?? '');
        if (!activityId) continue;
        try {
          const zip = await downloadActivityZip(apiKey, activityId);
          const fit = parseZipArchive(zip).find(
            (e) => !e.isDirectory && /\.fit$/i.test(e.path)
          );
          if (!fit) continue; // e.g. a manual entry, or a GPX/TCX upload
          const imported = await importFitBuffer(
            userId,
            userId,
            fit.getData(),
            fit.path,
            {
              source: 'garmin',
              sourceIdOverride: activityId,
              notesLabel: 'Garmin Activity',
            }
          );
          if (imported.status === 'failed') {
            log(
              'warn',
              `[garminPersonalService] Kept the summary of activity ${activityId}: ${imported.reason}`
            );
          }
        } catch (error) {
          const status = garminPersonalErrorStatus(error);
          if (status === 401 || status === 403) throw error;
          log(
            'warn',
            `[garminPersonalService] Kept the summary of activity ${activityId}: ${describeError(error)}`
          );
        }
      }
      return result;
    },

    fetchNutrition: async (_userId, startDate, endDate) => {
      const logs: Dto[] = [];
      for (const date of daysBetween(startDate, endDate)) {
        const foodLog = await get<Dto>(`/nutrition-service/food/logs/${date}`);
        if (foodLog) logs.push(foodLog);
      }
      return logs;
    },
  };
}

/**
 * Sync a day range ('manual': last 7 days by default; 'scheduled': today).
 * Skipped while a Garmin Connect provider is active: both write the same
 * 'garmin' rows, and Garmin Connect has the richer data.
 */
async function syncGarminPersonalData(
  userId: string,
  syncType: 'manual' | 'scheduled' = 'manual',
  providerId?: string,
  startDate: string | null = null,
  endDate: string | null = null
): Promise<GarminPersonalSyncResult> {
  if (await hasActiveGarminConnectProvider(userId)) {
    log(
      'info',
      `[garminPersonalService] Skipping sync for user ${userId}: Garmin Connect is active.`
    );
    return { skipped: 'garmin_connect_active' };
  }
  const { providerId: resolvedId, apiKey } = await getApiKey(
    userId,
    providerId
  );
  // The pipeline records per-phase errors; a rejected key should fail the sync.
  await verifyApiKey(apiKey);
  const result = await garminService.syncGarminData(
    userId,
    syncType,
    startDate,
    endDate,
    undefined,
    undefined,
    personalApiSyncSource(apiKey)
  );

  const failedPhases = getGarminSyncPhaseErrors(result);
  if (failedPhases.length > 0) {
    log(
      'warn',
      `[garminPersonalService] Sync for user ${userId} had failed phases; last_sync_at not updated: ${failedPhases.join(', ')}`
    );
    return result;
  }
  const client = await getSystemClient();
  try {
    await client.query(
      `UPDATE external_data_providers
       SET last_sync_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [resolvedId]
    );
  } finally {
    client.release();
  }
  return result;
}

async function getStatus(
  userId: string,
  providerId?: string
): Promise<{ connected: boolean; lastSyncAt: string | null }> {
  const row = await findProvider(userId, providerId);
  if (!row) return { connected: false, lastSyncAt: null };
  return {
    connected: row.is_active,
    lastSyncAt: row.last_sync_at ? row.last_sync_at.toISOString() : null,
  };
}

/** Deactivates the provider row; the stored key is kept for a later reconnect. */
async function disconnect(
  userId: string,
  providerId?: string
): Promise<boolean> {
  const row = await findProvider(userId, providerId);
  if (!row) return false;
  const client = await getSystemClient();
  try {
    const result = await client.query(
      `UPDATE external_data_providers
       SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [row.id, userId]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

export { syncGarminPersonalData, getStatus, disconnect };
export default { syncGarminPersonalData, getStatus, disconnect };
