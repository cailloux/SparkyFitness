import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSystemClient } from '../db/poolManager.js';
import garminService, {
  processActivitiesAndWorkouts,
} from '../services/garminService.js';
import { importFitBuffer } from '../services/fitImportService.js';
import { parseZipArchive } from '../utils/zipUtils.js';
import {
  GarminPersonalApiError,
  downloadActivityZip,
  personalApiGet,
  verifyApiKey,
} from '../integrations/garminpersonal/garminPersonalApiClient.js';
import garminPersonalService, {
  personalApiSyncSource,
} from '../integrations/garminpersonal/garminPersonalService.js';

vi.mock('../db/poolManager.js');
vi.mock('../security/encryption.js', () => ({
  decrypt: vi.fn(async () => 'personal-key'),
  ENCRYPTION_KEY: 'mock_key',
}));
vi.mock('../config/logging.js', () => ({ log: vi.fn() }));
vi.mock('../services/garminService.js', () => ({
  default: { syncGarminData: vi.fn() },
  processActivitiesAndWorkouts: vi.fn(async () => ({ processedEntries: 2 })),
}));
vi.mock('../services/fitImportService.js', () => ({
  importFitBuffer: vi.fn(async () => ({ status: 'updated' })),
}));
vi.mock('../utils/zipUtils.js', () => ({ parseZipArchive: vi.fn() }));
vi.mock(
  '../integrations/garminpersonal/garminPersonalApiClient.js',
  async (importActual) => ({
    ...(await importActual<
      typeof import('../integrations/garminpersonal/garminPersonalApiClient.js')
    >()),
    personalApiGet: vi.fn(async () => null),
    downloadActivityZip: vi.fn(async () => Buffer.from('zip')),
    verifyApiKey: vi.fn(async () => undefined),
  })
);

const providerRow = {
  id: 'provider-1',
  is_active: true,
  last_sync_at: null,
  encrypted_app_key: 'enc',
  app_key_iv: 'iv',
  app_key_tag: 'tag',
};
const okResult = {
  health: { processedEntries: 1 },
  activities: { processedEntries: 2 },
  nutrition: { processedEntries: 0 },
};

describe('garminPersonalService.syncGarminPersonalData', () => {
  let query: ReturnType<typeof vi.fn>;
  let garminConnectActive: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    garminConnectActive = false;
    query = vi.fn(async (sql: string) =>
      sql.includes("provider_type = 'garmin' AND")
        ? { rows: [], rowCount: garminConnectActive ? 1 : 0 }
        : { rows: [providerRow], rowCount: 1 }
    );
    vi.mocked(getSystemClient).mockResolvedValue({
      query,
      release: vi.fn(),
    } as never);
    vi.mocked(garminService.syncGarminData).mockResolvedValue(okResult);
  });

  it('runs the Garmin pipeline with the Personal API source and stamps last_sync_at', async () => {
    const result = await garminPersonalService.syncGarminPersonalData(
      'user-1',
      'manual',
      'provider-1',
      '2026-10-23',
      '2026-10-23'
    );

    expect(result).toEqual(okResult);
    expect(verifyApiKey).toHaveBeenCalledWith('personal-key');
    expect(garminService.syncGarminData).toHaveBeenCalledWith(
      'user-1',
      'manual',
      '2026-10-23',
      '2026-10-23',
      undefined,
      undefined,
      expect.objectContaining({ fetchHealth: expect.any(Function) })
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET last_sync_at = NOW()'),
      ['provider-1']
    );
  });

  it('skips while Garmin Connect is active, without touching the API', async () => {
    garminConnectActive = true;

    const result = await garminPersonalService.syncGarminPersonalData(
      'user-1',
      'scheduled'
    );

    expect(result).toEqual({ skipped: 'garmin_connect_active' });
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(garminService.syncGarminData).not.toHaveBeenCalled();
  });

  it('fails on a rejected key before any phase runs', async () => {
    vi.mocked(verifyApiKey).mockRejectedValueOnce(
      new GarminPersonalApiError(401, 'POST', '/token')
    );

    await expect(
      garminPersonalService.syncGarminPersonalData('user-1')
    ).rejects.toMatchObject({ status: 401 });
    expect(garminService.syncGarminData).not.toHaveBeenCalled();
  });

  it('leaves last_sync_at alone when a phase failed', async () => {
    vi.mocked(garminService.syncGarminData).mockResolvedValue({
      ...okResult,
      health: { error: 'boom' },
    });

    await garminPersonalService.syncGarminPersonalData('user-1');

    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('SET last_sync_at'),
      expect.anything()
    );
  });
});

describe('personalApiSyncSource', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches the per-day and range endpoints for health', async () => {
    vi.mocked(personalApiGet).mockImplementation(async (_key, path) =>
      path === '/usersummary-service/v2/dailysummaries'
        ? { data: [{ calendarDate: '2026-10-22', totalSteps: 4000 }] }
        : null
    );

    const data = await personalApiSyncSource('k').fetchHealth(
      'user-1',
      '2026-10-22',
      '2026-10-23'
    );

    expect(data).toEqual({ steps: [{ date: '2026-10-22', value: 4000 }] });
    const paths = vi.mocked(personalApiGet).mock.calls.map((c) => c[1]);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/sleep-service/sleep/dailySleep',
        '/hrv-service/hrv/2026-10-22',
        '/hrv-service/hrv/2026-10-23',
        '/wellness-service/wellness/dailyHeartRate',
        '/fitnessage-service/fitnessage/v2/2026-10-23',
        '/usersummary-service/stats/hydration/daily/2026-10-22/2026-10-23',
        '/wellness-service/wellness/bodyBattery/reports/daily',
        '/weight-service/weight/range/2026-10-22/2026-10-23',
      ])
    );
  });

  it('keeps going when one metric 404s but fails the phase on 401', async () => {
    vi.mocked(personalApiGet).mockImplementation(async (_key, path) => {
      if (path.startsWith('/hrv-service')) {
        throw new GarminPersonalApiError(404, 'GET', path);
      }
      return null;
    });
    await expect(
      personalApiSyncSource('k').fetchHealth('u', '2026-10-23', '2026-10-23')
    ).resolves.toEqual({});

    vi.mocked(personalApiGet).mockRejectedValue(
      new GarminPersonalApiError(401, 'GET', '/x')
    );
    await expect(
      personalApiSyncSource('k').fetchHealth('u', '2026-10-23', '2026-10-23')
    ).rejects.toMatchObject({ status: 401 });
  });

  it('stores activity summaries, then enriches each from its FIT file', async () => {
    vi.mocked(personalApiGet).mockResolvedValueOnce([
      {
        activityId: 11,
        activityType: { typeKey: 'virtual_ride' },
        duration: 600,
      },
      { activityId: 12, activityType: { typeKey: 'walking' } },
      { activityId: 13, activityType: { typeKey: 'running' } },
    ]);
    const fitData = Buffer.from('fit');
    vi.mocked(parseZipArchive)
      .mockReturnValueOnce([
        {
          path: '11_ACTIVITY.fit',
          isDirectory: false,
          uncompressedSize: 3,
          getData: () => fitData,
        },
      ])
      .mockReturnValueOnce([
        {
          path: '12.gpx',
          isDirectory: false,
          uncompressedSize: 3,
          getData: () => Buffer.from(''),
        },
      ]);
    vi.mocked(downloadActivityZip)
      .mockResolvedValueOnce(Buffer.from('zip11'))
      .mockResolvedValueOnce(Buffer.from('zip12'))
      .mockRejectedValueOnce(new GarminPersonalApiError(404, 'GET', '/dl'));

    const result = await personalApiSyncSource('k').syncActivities(
      'user-1',
      '2026-10-23',
      '2026-10-23',
      'America/New_York'
    );

    expect(result).toEqual({ processedEntries: 2 });
    expect(personalApiGet).toHaveBeenCalledWith(
      'k',
      '/activitylist-service/activities/search/activities',
      { start: 0, limit: 20, startDate: '2026-10-23', endDate: '2026-10-23' }
    );
    const [, payload] = vi.mocked(processActivitiesAndWorkouts).mock.calls[0]!;
    expect(payload.workouts).toEqual([]);
    expect(payload.activities).toEqual([
      { activity: expect.objectContaining({ activityId: 11, duration: 10 }) },
      { activity: expect.objectContaining({ activityName: 'Walking' }) },
      { activity: expect.objectContaining({ activityName: 'Running' }) },
    ]);
    // Only the activity with a FIT file is re-imported, under the Garmin source.
    expect(importFitBuffer).toHaveBeenCalledTimes(1);
    expect(importFitBuffer).toHaveBeenCalledWith(
      'user-1',
      'user-1',
      fitData,
      '11_ACTIVITY.fit',
      {
        source: 'garmin',
        sourceIdOverride: '11',
        notesLabel: 'Garmin Activity',
      }
    );
  });

  it('pages through activity search', async () => {
    const page = Array.from({ length: 20 }, (_, i) => ({ activityId: i + 1 }));
    vi.mocked(personalApiGet)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([{ activityId: 99 }]);
    vi.mocked(parseZipArchive).mockReturnValue([]);

    await personalApiSyncSource('k').syncActivities(
      'u',
      '2026-10-01',
      '2026-10-07',
      'UTC'
    );

    expect(vi.mocked(personalApiGet).mock.calls[1]?.[2]).toMatchObject({
      start: 20,
    });
    expect(
      vi.mocked(processActivitiesAndWorkouts).mock.calls[0]![1].activities
    ).toHaveLength(21);
  });

  it('reads one food log per day', async () => {
    vi.mocked(personalApiGet).mockImplementation(async (_key, path) =>
      path.endsWith('2026-10-23') ? { mealDate: '2026-10-23' } : null
    );

    expect(
      await personalApiSyncSource('k').fetchNutrition(
        'u',
        '2026-10-22',
        '2026-10-23'
      )
    ).toEqual([{ mealDate: '2026-10-23' }]);
  });
});
