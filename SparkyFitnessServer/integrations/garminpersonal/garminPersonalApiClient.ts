/**
 * Client for the official Garmin Connect Personal API
 * (https://personal.connectapi.garmin.com, read-only). Auth follows Garmin's
 * reference client (github.com/garmin/connect-personal-api-python): the API key
 * is exchanged for a 24-hour JWT, which is cached per key and refreshed an hour
 * before it expires. Neither the key nor the JWT is ever logged: request errors
 * are rethrown as GarminPersonalApiError, which carries no request config.
 */
import { createHash } from 'node:crypto';
import axios from 'axios';
import { log } from '../../config/logging.js';
import { getGarminDateChunks } from '../garminconnect/garminConnectService.js';

export const GARMIN_PERSONAL_API_BASE_URL =
  'https://personal.connectapi.garmin.com';
const TOKEN_PATH =
  '/personalapitoken-service/personal-api/personal-api-key/token';
const REFRESH_WINDOW_MS = 60 * 60 * 1000;
// Rate limits are not documented: back off on 429/5xx, three attempts in all.
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

/** Largest inclusive day range each range endpoint accepts. */
export const RANGE_LIMIT_DAYS = {
  steps: 28,
  stress: 28,
  hydration: 31,
  sleepSummaries: 31,
  bodyBattery: 31,
  dailySummaries: 365,
} as const;

export class GarminPersonalApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string
  ) {
    super(
      `Garmin Personal API ${method} ${path} failed${status ? ` with status ${status}` : ''}`
    );
    this.name = 'GarminPersonalApiError';
  }
}

/** HTTP status of a Personal API error (0 when there is none). */
export function garminPersonalErrorStatus(error: unknown): number {
  return error instanceof GarminPersonalApiError ? error.status : 0;
}

const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();

/** Test hook: forget every cached token. */
export function clearGarminPersonalTokenCache(): void {
  tokenCache.clear();
}

function fingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/** The `exp` claim of a JWT in ms, read without verifying the signature. */
export function jwtExpiryMs(jwt: string): number {
  let exp: unknown;
  try {
    const payload = jwt.split('.')[1] ?? '';
    exp = (
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        exp?: unknown;
      }
    ).exp;
  } catch {
    // A parse error would quote part of the token.
  }
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new Error(
      'The Garmin Personal API token endpoint did not return a JWT with an exp claim.'
    );
  }
  return exp * 1000;
}

function httpStatus(error: unknown): number {
  return axios.isAxiosError(error) ? (error.response?.status ?? 0) : 0;
}

function backoffMs(error: unknown, attempt: number): number {
  const seconds = axios.isAxiosError(error)
    ? Number(error.response?.headers?.['retry-after'])
    : NaN;
  const ms =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : BASE_BACKOFF_MS * 2 ** attempt;
  return Math.min(ms, MAX_BACKOFF_MS);
}

/** Runs one request, retrying 429 and 5xx; errors leave as GarminPersonalApiError. */
async function send<T>(
  method: string,
  path: string,
  request: () => Promise<{ status: number; data: T }>
): Promise<{ status: number; data: T }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      const status = httpStatus(error);
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt + 1 >= MAX_ATTEMPTS) {
        throw new GarminPersonalApiError(status, method, path);
      }
      const wait = backoffMs(error, attempt);
      log(
        'warn',
        `[garminPersonalApi] ${method} ${path} returned ${status}; retrying in ${wait}ms.`
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function getToken(apiKey: string, forceRefresh = false): Promise<string> {
  const id = fingerprint(apiKey);
  const cached = tokenCache.get(id);
  if (
    !forceRefresh &&
    cached &&
    cached.expiresAtMs - Date.now() > REFRESH_WINDOW_MS
  ) {
    return cached.token;
  }
  // Accept must be */*: application/json is answered with 406.
  const { data } = await send('POST', TOKEN_PATH, () =>
    axios.post<string>(`${GARMIN_PERSONAL_API_BASE_URL}${TOKEN_PATH}`, null, {
      headers: { Authorization: `ApiKey ${apiKey}`, Accept: '*/*' },
      responseType: 'text',
      transformResponse: (body: unknown) => body,
    })
  );
  const token = String(data).trim();
  tokenCache.set(id, { token, expiresAtMs: jwtExpiryMs(token) });
  return token;
}

/** Exchanges the key for a token (cached), so a rejected key fails fast. */
export async function verifyApiKey(apiKey: string): Promise<void> {
  await getToken(apiKey);
}

type QueryParams = Record<string, string | number>;

async function authorizedGet<T>(
  apiKey: string,
  path: string,
  params: QueryParams | undefined,
  responseType: 'json' | 'arraybuffer',
  accept: string
): Promise<{ status: number; data: T }> {
  const call = (token: string) =>
    send('GET', path, () =>
      axios.get<T>(`${GARMIN_PERSONAL_API_BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: accept },
        params,
        responseType,
      })
    );
  try {
    return await call(await getToken(apiKey));
  } catch (error) {
    // Tokens can die before exp: refresh once and retry.
    if (garminPersonalErrorStatus(error) !== 401) throw error;
    return call(await getToken(apiKey, true));
  }
}

/** GET a JSON endpoint; null when Garmin answers 204 or an empty body. */
export async function personalApiGet<T>(
  apiKey: string,
  path: string,
  params?: QueryParams
): Promise<T | null> {
  const { status, data } = await authorizedGet<T | ''>(
    apiKey,
    path,
    params,
    'json',
    'application/json'
  );
  return status === 204 || data === '' || data === null || data === undefined
    ? null
    : (data as T);
}

/** The original activity file, as the ZIP Garmin serves it. */
export async function downloadActivityZip(
  apiKey: string,
  activityId: string
): Promise<Buffer> {
  if (!/^[1-9]\d*$/.test(activityId)) {
    throw new Error('activityId must be a positive integer');
  }
  const { data } = await authorizedGet<ArrayBuffer>(
    apiKey,
    `/download-service/files/activity/${activityId}`,
    undefined,
    'arraybuffer',
    'application/zip, application/x-zip-compressed, application/octet-stream'
  );
  return Buffer.from(data);
}

/**
 * Calls a range endpoint once per window of at most `maxDays` days, since the
 * API errors on longer ranges, and returns the non-empty responses in order.
 */
export async function getInRangeChunks<T>(
  startDate: string,
  endDate: string,
  maxDays: number,
  fetchChunk: (start: string, end: string) => Promise<T | null>
): Promise<T[]> {
  const responses: T[] = [];
  for (const { start, end } of getGarminDateChunks(
    startDate,
    endDate,
    maxDays
  )) {
    const response = await fetchChunk(start, end);
    if (response !== null) responses.push(response);
  }
  return responses;
}
