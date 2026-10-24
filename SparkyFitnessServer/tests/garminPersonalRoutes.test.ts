import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS(7016): Could not find a declaration file for module 'supertest'
import request from 'supertest';
import express from 'express';
import garminPersonalRoutes from '../routes/garminPersonalRoutes.js';
import garminPersonalService from '../integrations/garminpersonal/garminPersonalService.js';
import { GarminPersonalApiError } from '../integrations/garminpersonal/garminPersonalApiClient.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const PROVIDER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

vi.mock('../middleware/authMiddleware.js', () => ({
  default: {
    authenticate: vi.fn(
      (req: express.Request, _res: express.Response, next: () => void) => {
        req.userId = USER_ID;
        next();
      }
    ),
  },
}));
vi.mock('../middleware/checkPermissionMiddleware.js', () => ({
  default:
    () => (_req: express.Request, _res: express.Response, next: () => void) =>
      next(),
}));
vi.mock('../integrations/garminpersonal/garminPersonalService.js', () => ({
  GARMIN_PERSONAL_PROVIDER_TYPE: 'garmin_personal',
  default: {
    syncGarminPersonalData: vi.fn(),
    getStatus: vi.fn(),
    disconnect: vi.fn(),
  },
}));
vi.mock('../config/logging.js', () => ({ log: vi.fn() }));
vi.mock('../services/providerSyncClaim.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/providerSyncClaim.js')>()),
  startProviderSync: vi.fn(async (_target, sync) => ({ running: sync() })),
}));
import {
  SYNC_ALREADY_RUNNING_RESPONSE,
  startProviderSync,
} from '../services/providerSyncClaim.js';

describe('garminPersonalRoutes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/integrations/garmin-personal', garminPersonalRoutes);
  });

  it('syncs the requested range as a manual sync', async () => {
    vi.mocked(garminPersonalService.syncGarminPersonalData).mockResolvedValue({
      health: { processedEntries: 3 },
      activities: { processedEntries: 1 },
      nutrition: { processedEntries: 0 },
    });

    const res = await request(app)
      .post('/integrations/garmin-personal/sync')
      .send({
        providerId: PROVIDER_ID,
        startDate: '2026-10-23',
        endDate: '2026-10-23',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.activities).toEqual({ processedEntries: 1 });
    expect(garminPersonalService.syncGarminPersonalData).toHaveBeenCalledWith(
      USER_ID,
      'manual',
      PROVIDER_ID,
      '2026-10-23',
      '2026-10-23'
    );
  });

  it('rejects reversed and over-long ranges', async () => {
    for (const body of [
      { startDate: '2026-10-23', endDate: '2026-10-01' },
      { startDate: '2025-01-01', endDate: '2026-10-23' },
      { startDate: '2026-02-30' },
    ]) {
      const res = await request(app)
        .post('/integrations/garmin-personal/sync')
        .send(body);
      expect(res.statusCode).toBe(400);
    }
    expect(garminPersonalService.syncGarminPersonalData).not.toHaveBeenCalled();
  });

  it('answers 401 without echoing details when Garmin rejects the key', async () => {
    vi.mocked(garminPersonalService.syncGarminPersonalData).mockRejectedValue(
      new GarminPersonalApiError(401, 'POST', '/token')
    );

    const res = await request(app)
      .post('/integrations/garmin-personal/sync')
      .send({});

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/rejected the Personal API key/);
  });

  it('answers 409 while another sync holds the account', async () => {
    vi.mocked(startProviderSync).mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/integrations/garmin-personal/sync')
      .send({});

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(SYNC_ALREADY_RUNNING_RESPONSE);
    expect(startProviderSync).toHaveBeenCalledWith(
      { userId: USER_ID, providerType: 'garmin_personal' },
      expect.any(Function)
    );
  });

  it('reports status and disconnects', async () => {
    vi.mocked(garminPersonalService.getStatus).mockResolvedValue({
      connected: true,
      lastSyncAt: null,
    });
    vi.mocked(garminPersonalService.disconnect)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const status = await request(app).get(
      `/integrations/garmin-personal/status?providerId=${PROVIDER_ID}`
    );
    expect(status.body).toEqual({ connected: true, lastSyncAt: null });

    const ok = await request(app)
      .post('/integrations/garmin-personal/disconnect')
      .send({ providerId: PROVIDER_ID });
    expect(ok.statusCode).toBe(200);

    const missing = await request(app)
      .post('/integrations/garmin-personal/disconnect')
      .send({});
    expect(missing.statusCode).toBe(404);
  });
});
