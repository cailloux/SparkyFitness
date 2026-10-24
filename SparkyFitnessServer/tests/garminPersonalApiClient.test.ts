import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosError } from 'axios';
import {
  GarminPersonalApiError,
  clearGarminPersonalTokenCache,
  downloadActivityZip,
  getInRangeChunks,
  jwtExpiryMs,
  personalApiGet,
} from '../integrations/garminpersonal/garminPersonalApiClient.js';

vi.mock('axios', async (importActual) => {
  const actual = await importActual<typeof import('axios')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      get: vi.fn(),
      post: vi.fn(),
      isAxiosError: actual.default.isAxiosError,
    },
  };
});
vi.mock('../config/logging.js', () => ({ log: vi.fn() }));

const BASE = 'https://personal.connectapi.garmin.com';
const API_KEY = 'personal-api-key-secret';

function jwt(expSeconds: number, tag = 'a'): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString(
    'base64url'
  );
  return `header.${payload}.sig-${tag}`;
}

function httpError(status: number, headers: Record<string, string> = {}) {
  return new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_RESPONSE',
    undefined,
    undefined,
    { status, headers, data: '', statusText: '', config: {} } as never
  );
}

async function failure(
  pending: Promise<unknown>
): Promise<GarminPersonalApiError> {
  try {
    await pending;
  } catch (error) {
    return error as GarminPersonalApiError;
  }
  throw new Error('expected the request to fail');
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('garminPersonalApiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGarminPersonalTokenCache();
  });

  afterEach(() => vi.useRealTimers());

  it('exchanges the key with Accept */* and calls data endpoints with the bearer JWT', async () => {
    const token = jwt(nowSeconds() + 24 * 3600);
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: `${token}\n`,
    });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { ok: 1 } });

    const data = await personalApiGet(API_KEY, '/hrv-service/hrv/2026-10-23');

    expect(data).toEqual({ ok: 1 });
    expect(axios.post).toHaveBeenCalledWith(
      `${BASE}/personalapitoken-service/personal-api/personal-api-key/token`,
      null,
      expect.objectContaining({
        headers: { Authorization: `ApiKey ${API_KEY}`, Accept: '*/*' },
        responseType: 'text',
      })
    );
    expect(axios.get).toHaveBeenCalledWith(
      `${BASE}/hrv-service/hrv/2026-10-23`,
      expect.objectContaining({
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      })
    );
  });

  it('reuses a cached token and refreshes it within an hour of expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
    vi.mocked(axios.post).mockImplementation(async () => ({
      status: 200,
      data: jwt(nowSeconds() + 24 * 3600),
    }));
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: [] });

    await personalApiGet(API_KEY, '/a');
    await personalApiGet(API_KEY, '/b');
    expect(axios.post).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-23T22:59:00Z')); // 61 min left
    await personalApiGet(API_KEY, '/c');
    expect(axios.post).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-23T23:01:00Z')); // 59 min left
    await personalApiGet(API_KEY, '/d');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('caches tokens per API key', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: jwt(nowSeconds() + 24 * 3600),
    });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: [] });

    await personalApiGet('key-one', '/a');
    await personalApiGet('key-two', '/a');

    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('forces a token refresh and retries once on 401', async () => {
    const first = jwt(nowSeconds() + 24 * 3600, 'first');
    const second = jwt(nowSeconds() + 24 * 3600, 'second');
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ status: 200, data: first })
      .mockResolvedValueOnce({ status: 200, data: second });
    vi.mocked(axios.get)
      .mockRejectedValueOnce(httpError(401))
      .mockResolvedValueOnce({ status: 200, data: { ok: true } });

    expect(await personalApiGet(API_KEY, '/x')).toEqual({ ok: true });
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(axios.get).mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${second}`,
    });
  });

  it('gives up after one retry when the fresh token is also refused', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: jwt(nowSeconds() + 24 * 3600),
    });
    vi.mocked(axios.get).mockRejectedValue(httpError(401));

    const error = await failure(personalApiGet(API_KEY, '/x'));

    expect(error).toBeInstanceOf(GarminPersonalApiError);
    expect(error.status).toBe(401);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('never puts the key or the JWT in the thrown error', async () => {
    const token = jwt(nowSeconds() + 24 * 3600);
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: token });
    vi.mocked(axios.get).mockRejectedValue(httpError(404));

    const error = await failure(personalApiGet(API_KEY, '/missing'));

    expect(error).toBeInstanceOf(GarminPersonalApiError);
    const serialized = JSON.stringify(error) + String(error.stack);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(token);
  });

  it('returns null for 204 and empty bodies', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: jwt(nowSeconds() + 24 * 3600),
    });
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ status: 204, data: '' })
      .mockResolvedValueOnce({ status: 200, data: '' });

    expect(await personalApiGet(API_KEY, '/hrv-service/hrv/2026-10-23')).toBe(
      null
    );
    expect(await personalApiGet(API_KEY, '/empty')).toBe(null);
  });

  it('backs off on 429 (honouring Retry-After) and on 5xx', async () => {
    vi.useFakeTimers();
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: jwt(nowSeconds() + 24 * 3600),
    });
    vi.mocked(axios.get)
      .mockRejectedValueOnce(httpError(429, { 'retry-after': '3' }))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({ status: 200, data: [1] });

    const pending = personalApiGet(API_KEY, '/x');
    await vi.advanceTimersByTimeAsync(3_000); // Retry-After
    await vi.advanceTimersByTimeAsync(4_000); // 2s * 2^1
    expect(await pending).toEqual([1]);
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  it('fails after three attempts on persistent 5xx', async () => {
    vi.useFakeTimers();
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: jwt(nowSeconds() + 24 * 3600),
    });
    vi.mocked(axios.get).mockRejectedValue(httpError(500));

    const pending = failure(personalApiGet(API_KEY, '/x'));
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await pending;
    expect(error).toBeInstanceOf(GarminPersonalApiError);
    expect(error.status).toBe(500);
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  it('refuses a token without an exp claim', () => {
    expect(() => jwtExpiryMs('not-a-jwt')).toThrow(/exp claim/);
    expect(jwtExpiryMs(jwt(1_800_000_000))).toBe(1_800_000_000_000);
  });

  it('splits range requests at the endpoint limit', async () => {
    const fetchChunk = vi.fn(async (start: string, end: string) =>
      start === '2026-09-15' ? null : [`${start}..${end}`]
    );

    const responses = await getInRangeChunks(
      '2026-08-15',
      '2026-10-23',
      31,
      fetchChunk
    );

    expect(fetchChunk.mock.calls).toEqual([
      ['2026-08-15', '2026-09-14'],
      ['2026-09-15', '2026-10-15'],
      ['2026-10-16', '2026-10-23'],
    ]);
    expect(responses).toEqual([
      ['2026-08-15..2026-09-14'],
      ['2026-10-16..2026-10-23'],
    ]);
  });

  it('downloads the activity ZIP as bytes and rejects non-numeric ids', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: jwt(nowSeconds() + 24 * 3600),
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: new Uint8Array([0x50, 0x4b]).buffer,
    });

    const zip = await downloadActivityZip(API_KEY, '1000000001');

    expect(zip).toEqual(Buffer.from([0x50, 0x4b]));
    expect(axios.get).toHaveBeenCalledWith(
      `${BASE}/download-service/files/activity/1000000001`,
      expect.objectContaining({ responseType: 'arraybuffer' })
    );
    await expect(downloadActivityZip(API_KEY, '../1')).rejects.toThrow(
      /positive integer/
    );
  });
});
