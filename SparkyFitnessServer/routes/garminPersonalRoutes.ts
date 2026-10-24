import express from 'express';
import { z } from 'zod';
import garminPersonalService, {
  GARMIN_PERSONAL_PROVIDER_TYPE,
} from '../integrations/garminpersonal/garminPersonalService.js';
import { garminPersonalErrorStatus } from '../integrations/garminpersonal/garminPersonalApiClient.js';
import { log } from '../config/logging.js';
import { describeError, publicErrorMessage } from '../utils/errors.js';
import authMiddleware from '../middleware/authMiddleware.js';
import checkPermissionMiddleware from '../middleware/checkPermissionMiddleware.js';
import {
  SYNC_ALREADY_RUNNING_RESPONSE,
  syncClaimTarget,
  startProviderSync,
} from '../services/providerSyncClaim.js';

const router = express.Router();

const MAX_DATE_RANGE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
  .refine(
    (val) => new Date(`${val}T00:00:00Z`).toISOString().startsWith(val),
    'Invalid calendar date'
  );

const providerIdSchema = z
  .string()
  .uuid('Invalid provider ID format')
  .optional();

const syncBodySchema = z
  .object({
    providerId: providerIdSchema,
    startDate: calendarDateSchema.nullable().optional(),
    endDate: calendarDateSchema.nullable().optional(),
  })
  .refine((d) => !d.startDate || !d.endDate || d.startDate <= d.endDate, {
    message: 'startDate must be before or equal to endDate',
    path: ['endDate'],
  })
  .refine(
    (d) =>
      !d.startDate ||
      !d.endDate ||
      Date.parse(d.endDate) - Date.parse(d.startDate) <=
        MAX_DATE_RANGE_DAYS * DAY_MS,
    {
      message: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days.`,
      path: ['endDate'],
    }
  );

const providerBodySchema = z.object({ providerId: providerIdSchema });

function badRequest(res: express.Response, error: z.ZodError) {
  return res.status(400).json({
    message: 'Invalid request',
    error: error.issues[0]?.message || 'Validation failed',
    details: error.flatten(),
  });
}

/**
 * @swagger
 * /integrations/garmin-personal/sync:
 *   post:
 *     summary: Manually trigger a Garmin Connect Personal API sync
 *     description: Skipped (200, `skipped`) while a Garmin Connect provider is active, since both write the same Garmin data.
 *     tags: [External Integrations]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               providerId: { type: string, format: uuid }
 *               startDate: { type: string, format: date, description: 'Defaults to 7 days ago' }
 *               endDate: { type: string, format: date, description: 'Defaults to today; at most 365 days after startDate' }
 *     responses:
 *       200: { description: Sync finished (per-phase results) or skipped }
 *       400: { description: Invalid request }
 *       401: { description: Garmin rejected the API key }
 *       409: { description: A sync is already running for this account }
 */
router.post(
  '/sync',
  authMiddleware.authenticate,
  checkPermissionMiddleware('diary'),
  async (req, res) => {
    const parsed = syncBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    const userId = req.userId as string;
    const { providerId, startDate, endDate } = parsed.data;
    try {
      const started = await startProviderSync(
        syncClaimTarget(userId, GARMIN_PERSONAL_PROVIDER_TYPE, providerId),
        () =>
          garminPersonalService.syncGarminPersonalData(
            userId,
            'manual',
            providerId,
            startDate,
            endDate
          )
      );
      if (!started) {
        return res.status(409).json(SYNC_ALREADY_RUNNING_RESPONSE);
      }
      res.status(200).json(await started.running);
    } catch (error) {
      log(
        'error',
        `Error syncing Garmin Personal API: ${describeError(error)}`
      );
      const status = garminPersonalErrorStatus(error);
      if (status === 401 || status === 403) {
        return res.status(401).json({
          message:
            'Garmin rejected the Personal API key. Create a new key in Garmin Connect and update it in settings.',
        });
      }
      res.status(500).json({
        message: 'Error syncing Garmin Personal API',
        error: publicErrorMessage(error),
      });
    }
  }
);

/**
 * @swagger
 * /integrations/garmin-personal/status:
 *   get:
 *     summary: Get Garmin Connect Personal API connection status
 *     tags: [External Integrations]
 *     parameters:
 *       - in: query
 *         name: providerId
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Connection status and last sync time }
 */
router.get(
  '/status',
  authMiddleware.authenticate,
  checkPermissionMiddleware('diary'),
  async (req, res) => {
    const parsed = providerBodySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      res
        .status(200)
        .json(
          await garminPersonalService.getStatus(
            req.userId as string,
            parsed.data.providerId
          )
        );
    } catch (error) {
      log(
        'error',
        `Error getting Garmin Personal API status: ${describeError(error)}`
      );
      res.status(500).json({
        message: 'Error getting Garmin Personal API status',
        error: publicErrorMessage(error),
      });
    }
  }
);

/**
 * @swagger
 * /integrations/garmin-personal/disconnect:
 *   post:
 *     summary: Disconnect the Garmin Connect Personal API integration
 *     tags: [External Integrations]
 *     responses:
 *       200: { description: Disconnected }
 *       404: { description: No Garmin Personal API provider }
 */
router.post(
  '/disconnect',
  authMiddleware.authenticate,
  checkPermissionMiddleware('diary'),
  async (req, res) => {
    const parsed = providerBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      const disconnected = await garminPersonalService.disconnect(
        req.userId as string,
        parsed.data.providerId
      );
      if (!disconnected) {
        return res
          .status(404)
          .json({ message: 'Garmin Personal API provider not found.' });
      }
      res
        .status(200)
        .json({ message: 'Garmin Personal API disconnected successfully.' });
    } catch (error) {
      log(
        'error',
        `Error disconnecting Garmin Personal API: ${describeError(error)}`
      );
      res.status(500).json({
        message: 'Error disconnecting Garmin Personal API',
        error: publicErrorMessage(error),
      });
    }
  }
);

export default router;
