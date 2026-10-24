# Garmin Connect Personal API fixtures

One response per endpoint the Garmin Personal API provider calls, for
`2026-10-23`. These are **synthetic**: they follow the Garmin DTO field
names the `garminconnect` library returns for the same endpoints and were
written by hand before a live capture was possible. Replace each with a
sanitized live capture (strip `userProfilePK`/`userProfileId`, `displayName`,
`garmin_guid`, `deviceId`, real activity IDs and GPS) when one is available;
the tests read the files by name.

| File                  | Endpoint                                                                     |
| --------------------- | ---------------------------------------------------------------------------- |
| `dailysummaries.json` | `GET /usersummary-service/v2/dailysummaries?startDate&endDate`               |
| `dailySleep.json`     | `GET /sleep-service/sleep/dailySleep?date`                                   |
| `hrv.json`            | `GET /hrv-service/hrv/{date}`                                                |
| `dailyHeartRate.json` | `GET /wellness-service/wellness/dailyHeartRate?date`                         |
| `fitnessAge.json`     | `GET /fitnessage-service/fitnessage/v2/{date}`                               |
| `hydration.json`      | `GET /usersummary-service/stats/hydration/daily/{start}/{end}`               |
| `bodyBattery.json`    | `GET /wellness-service/wellness/bodyBattery/reports/daily?startDate&endDate` |
| `weightRange.json`    | `GET /weight-service/weight/range/{start}/{end}?includeAll=true`             |
| `activities.json`     | `GET /activitylist-service/activities/search/activities`                     |
