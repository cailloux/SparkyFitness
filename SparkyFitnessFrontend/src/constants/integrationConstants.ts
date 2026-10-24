export const MANUAL_SYNC_PROVIDERS = [
  'strava',
  'fitbit',
  'oura',
  'polar',
  'coros_mcp',
  'withings',
  'garmin',
  'hevy',
  'liftosaur',
  'garmin_personal',
] as const;

export type ManualSyncProvider = (typeof MANUAL_SYNC_PROVIDERS)[number];
