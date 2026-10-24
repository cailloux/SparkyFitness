# Garmin Connect Personal API

The Garmin Connect Personal API provider reads your Garmin data through Garmin's **official**, read-only [Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/). It needs only a personal API key: no Garmin password, no MFA, and no SparkyFitnessGarmin microservice.

It is a separate provider from **Garmin Connect**, which uses the unofficial `garminconnect` library through the microservice. Garmin Connect still syncs more metrics (see [What you lose](#what-you-lose-compared-with-garmin-connect)); the Personal API keeps Garmin sync working if that library stops working.

---

## Setup

1. Create a personal API key in Garmin's [Connect Developer Program](https://developer.garmin.com/gc-developer-program/personal/).
2. In SparkyFitness, go to **Settings → External Providers**, click **Add New Data Provider** and pick **Garmin Connect (Personal API)**.
3. Paste the **Personal API Key**, choose a sync frequency and save. A first sync of the last 7 days runs right away.

The key is stored encrypted and is never shared with family and friends. SparkyFitness exchanges it for a 24-hour token, keeps that token in memory and never logs either.

## Using it alongside Garmin Connect

Both Garmin providers write the same Garmin data (same `garmin` source, same Garmin activity IDs), so they never create duplicate activities or metrics. To keep Garmin Connect's richer data from being replaced, the **Personal API does not sync while a Garmin Connect provider is active**; a manual sync says it was skipped.

To switch, deactivate Garmin Connect. Your history stays, and the Personal API keeps filling the same days.

## Syncing

- **Manual sync** takes a date range of up to 365 days (default: the last 7 days).
- **Scheduled sync** runs hourly for today, like Garmin Connect.
- Ranges are fetched in 7-day chunks, inside each endpoint's own range limit (28 days for steps and stress, 31 for hydration, sleep summaries and Body Battery, 1 year for daily summaries).
- Garmin does not publish rate limits; SparkyFitness backs off and retries on `429` and server errors.

## What is synced

| SparkyFitness data | Personal API endpoint |
| --- | --- |
| Steps, distance, active/sedentary time, calories (total, active, BMR), resting heart rate, stress average and max, Body Battery, floors, intensity minutes, SpO2, waking respiration | `GET /usersummary-service/v2/dailysummaries` |
| Mood derived from the day's stress average | same daily summary |
| Sleep: bed and wake time, duration, stages totals, sleep score, SpO2, respiration, sleep stress | `GET /sleep-service/sleep/dailySleep` |
| HRV readings and nightly average | `GET /hrv-service/hrv/{date}` |
| All-day heart rate samples | `GET /wellness-service/wellness/dailyHeartRate` |
| Fitness age | `GET /fitnessage-service/fitnessage/v2/{date}` |
| Hydration (read) | `GET /usersummary-service/stats/hydration/daily/{start}/{end}` |
| Body Battery for days without a summary | `GET /wellness-service/wellness/bodyBattery/reports/daily` |
| Weight, body fat, BMI, body water, bone and muscle mass | `GET /weight-service/weight/range/{start}/{end}` |
| Nutrition food logs (read) | `GET /nutrition-service/food/logs/{date}` |
| Activities, including synced third-party ones (for example Zwift) | `GET /activitylist-service/activities/search/activities` |
| Activity laps, GPS track, heart rate zones, strength sets | `GET /download-service/files/activity/{id}` (original FIT file) |

Each activity is first stored from its summary, then replaced by its original FIT file through the same importer as **FIT file import**. An activity without a FIT file (a manual entry, or a GPX/TCX upload) keeps its summary.

## Coverage compared with Garmin Connect

Every `garminconnect` call the SparkyFitnessGarmin microservice makes, and what the Personal API offers instead.

| `garminconnect` call | Used for | Personal API |
| --- | --- | --- |
| `login`, `resume_login` | Email/password + MFA login | Not needed (API key) |
| `get_user_summary` | Steps, distance, calories, resting HR, stress, Body Battery | ✅ `v2/dailysummaries` |
| `get_daily_steps` | Steps fallback | ✅ in the daily summary (`stats/steps/daily` also exists, not needed) |
| `get_floors` | Floors | ✅ in the daily summary |
| `get_intensity_minutes_data` | Intensity minutes | ✅ in the daily summary (moderate + 2 × vigorous) |
| `get_spo2_data` | SpO2 average | ✅ in the daily summary (`daily/spo2acclimation` also exists, not needed) |
| `get_respiration_data` | Respiration averages | ⚠️ Waking average from the daily summary, sleep average from sleep; no all-day average |
| `get_body_battery` | Body Battery fallback | ✅ `bodyBattery/reports/daily` |
| `get_sleep_data` | Sleep | ⚠️ `sleep/dailySleep`: summary, scores, SpO2 and respiration; no sleep-stage timeline, restless moments or overnight HRV/Body Battery change |
| `get_hrv_data` | HRV | ✅ `hrv/{date}` (may answer 204 for a night without HRV) |
| `get_heart_rates` | All-day heart rate | ✅ `dailyHeartRate` |
| `get_fitnessage_data` | Fitness age | ✅ `fitnessage/v2/{date}` |
| `get_hydration_data` | Hydration | ✅ `stats/hydration/daily` (read only) |
| `get_body_composition` | Weight and body composition | ✅ `weight/range` |
| `get_nutrition_daily_food_log` | Nutrition diary | ✅ `food/logs/{date}` (read only) |
| `get_menstrual_data_for_date`, `get_menstrual_calendar_data` | Fetched, not stored by SparkyFitness today | Available (`menstrualcycle/summary`, `dayview`), not used |
| `get_activities_by_date` | Activities | ✅ `activities/search/activities` |
| `get_activity_details` | Activity telemetry | ✅ from the original FIT file |
| `get_activity_hr_in_timezones` | Activity HR zones | ✅ from the FIT file |
| `get_activity_exercise_sets` | Strength sets | ✅ from the FIT file |
| `get_activity_splits` | Splits detail | ⚠️ Laps from the FIT file; no Garmin splits JSON |
| `get_activity_weather` | Weather | ❌ Not available |
| `get_activity_gear` | Gear | ❌ Not available |
| `get_workouts`, `get_workout_by_id` | Workout library | ❌ Not available (`activity/{id}/workouts` only lists an activity's own workout) |
| `get_stress_data` | Stress and Body Battery time series | ❌ Not available (daily averages only) |
| `get_training_readiness` | Training readiness, acute load, recovery time | ❌ Not available |
| `get_training_status` | Training status and load | ❌ Not available |
| `get_max_metrics` | VO2 max | ❌ Not available |
| `get_race_predictions` | Race predictions | ❌ Not available |
| `get_lactate_threshold` | Lactate threshold | ❌ Not available |
| `get_endurance_score` | Endurance score | ❌ Not available |
| `get_hill_score` | Hill score | ❌ Not available |
| `get_blood_pressure` | Blood pressure | ❌ Not available |
| `get_pregnancy_summary` | Pregnancy | ❌ Not available |

The Personal API is read only, so nothing is ever written back to Garmin.

## What you lose compared with Garmin Connect

- Training readiness, training status, training load (acute, chronic, ratio) and recovery time.
- VO2 max, race predictions, lactate threshold, hill score and endurance score.
- Stress and Body Battery time series (the "Raw Stress Data" measurement); mood is derived from Garmin's daily stress average instead.
- Sleep-stage timeline (stage totals and score are kept).
- Blood pressure and pregnancy data.
- Activity weather and gear, and the Garmin workout library.
- Garmin China accounts (the Personal API is `personal.connectapi.garmin.com` only).
