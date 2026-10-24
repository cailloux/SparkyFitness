/**
 * Reshapes Garmin Connect Personal API responses into the health records the
 * SparkyFitnessGarmin microservice builds (SparkyFitnessGarmin/routes.py), so
 * they feed the existing Garmin processors unchanged. The Personal API returns
 * the same Garmin DTOs as the garminconnect library; this file only ports the
 * reshaping for the endpoints the Personal API serves.
 */

type Dto = Record<string, unknown>;
export type GarminHealthRecord = Record<string, unknown>;
export type GarminHealthData = Record<string, GarminHealthRecord[]>;

/** Per-day responses (null when Garmin had nothing for the day). */
export interface PersonalApiDay {
  date: string;
  summary?: Dto | null;
  sleep?: Dto | null;
  hrv?: Dto | null;
  heartRate?: Dto | null;
  fitnessAge?: Dto | null;
}

/** Responses of the range endpoints covering the same days. */
export interface PersonalApiRangeData {
  hydration?: unknown[];
  bodyBattery?: unknown[];
  weight?: Dto | null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): Dto {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Dto)
    : {};
}

/** routes.py runs clean_garmin_data, which drops null fields. */
function compact(record: GarminHealthRecord): GarminHealthRecord {
  return Object.fromEntries(
    Object.entries(record).filter(([, v]) => v !== null && v !== undefined)
  );
}

function scaled(value: unknown, divisor: number): number | null {
  const n = num(value);
  return n === null ? null : n / divisor;
}

function gmtIso(value: unknown): string | null {
  // Garmin's GMT strings carry no zone ("2026-10-23T05:12:00.0").
  if (typeof value !== 'string') return null;
  const ms = Date.parse(
    /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`
  );
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function dateOf(entry: Dto): string | null {
  const raw = entry.calendarDate ?? entry.date ?? entry.summaryDate;
  return typeof raw === 'string' ? raw.slice(0, 10) : null;
}

/** service.py map_garmin_stress_to_mood: Garmin stress 0-100 to a mood score. */
export function stressToMood(
  stress: number | null
): { value: number; label: string } | null {
  if (stress === null || stress < 0) return null;
  const bands: Array<[number, number, string]> = [
    [10, 95, 'Excited'],
    [25, 85, 'Happy'],
    [35, 75, 'Confident'],
    [50, 65, 'Calm'],
    [60, 55, 'Thoughtful'],
    [75, 45, 'Neutral'],
    [85, 35, 'Worried'],
    [95, 25, 'Angry'],
    [100, 15, 'Sad/Tired'],
  ];
  const band = bands.find(([max]) => stress <= max);
  return band
    ? { value: band[1], label: band[2] }
    : { value: 50, label: 'Neutral' };
}

const CALORIE_ALIASES: Record<string, string[]> = {
  active_calories: ['activeKilocalories', 'activeCalories'],
  bmr_calories: ['bmrKilocalories', 'bmrCalories'],
  total_calories: ['totalKilocalories', 'totalCalories'],
};

function addSummary(
  data: GarminHealthData,
  date: string,
  s: Dto,
  capturedAt: string
): void {
  const steps = num(s.totalSteps);
  if (steps !== null) data.steps.push({ date, value: steps });
  const distance = num(s.totalDistanceMeters) ?? num(s.totalDistance);
  if (distance !== null) {
    data.total_distance.push({ date, value: distance / 1000 });
  }
  for (const [metric, field] of [
    ['highly_active_seconds', 'highlyActiveSeconds'],
    ['active_seconds', 'activeSeconds'],
    ['sedentary_seconds', 'sedentarySeconds'],
  ] as const) {
    const minutes = scaled(s[field], 60);
    if (minutes !== null) data[metric].push({ date, value: minutes });
  }
  for (const [metric, aliases] of Object.entries(CALORIE_ALIASES)) {
    const value = aliases.map((a) => num(s[a])).find((v) => v !== null);
    if (value !== undefined && value !== null && value >= 0) {
      data[metric].push({ date, value });
    }
  }

  const bodyBattery = compact({
    date,
    body_battery_highest: num(s.bodyBatteryHighestValue),
    body_battery_lowest: num(s.bodyBatteryLowestValue),
    body_battery_at_wake: num(s.bodyBatteryAtWakeTime),
    body_battery_charged: num(s.bodyBatteryChargedValue),
    body_battery_drained: num(s.bodyBatteryDrainedValue),
    body_battery_current: num(s.bodyBatteryMostRecentValue),
  });
  if (Object.keys(bodyBattery).length > 1) data.body_battery.push(bodyBattery);

  const avgStress = num(s.averageStressLevel);
  const daily = compact({
    date,
    total_calories: num(s.totalKilocalories),
    active_calories: num(s.activeKilocalories),
    bmr_calories: num(s.bmrKilocalories),
    resting_heart_rate: num(s.restingHeartRate),
    avg_stress_level: avgStress,
    max_stress_level: num(s.maxStressLevel),
  });
  if (Object.keys(daily).length > 1) {
    data.daily_summary.push({ ...daily, captured_at: capturedAt });
  }

  // No stress time series in the Personal API: derive the daily mood from
  // Garmin's own daily average instead of the intraday mean routes.py uses.
  const mood = stressToMood(avgStress);
  if (mood) {
    data.stress.push({
      date,
      derived_mood_value: mood.value,
      derived_mood_notes: `Derived from Garmin Stress: Average ${Math.round(avgStress as number)} (${mood.label})`,
      average_stress_level: Math.round(avgStress as number),
    });
  }

  const ascended = num(s.floorsAscended);
  const descended = num(s.floorsDescended);
  if (ascended !== null || descended !== null) {
    data.floors.push(
      compact({ date, floors_ascended: ascended, floors_descended: descended })
    );
  }

  // Garmin counts vigorous minutes twice toward the intensity-minutes total.
  const moderate = num(s.moderateIntensityMinutes);
  const vigorous = num(s.vigorousIntensityMinutes);
  if (moderate !== null || vigorous !== null) {
    data.intensity_minutes.push({
      date,
      total_intensity_minutes: (moderate ?? 0) + 2 * (vigorous ?? 0),
    });
  }

  const spo2 = num(s.averageSpo2);
  if (spo2) data.spo2.push({ date, average_spo2: spo2 });
}

/** routes.py sleep entry, without stage events (the API has no sleepLevels). */
export function buildSleepEntry(
  date: string,
  raw: Dto
): GarminHealthRecord | null {
  const dto = obj(raw.dailySleepDTO ?? raw);
  const startGmt = num(dto.sleepStartTimestampGMT);
  const endGmt = num(dto.sleepEndTimestampGMT);
  if (!startGmt || !endGmt) return null;

  const duration =
    num(dto.sleepTimeSeconds) ?? Math.round((endGmt - startGmt) / 1000);
  if (duration <= 0) return null;
  const deep = num(dto.deepSleepSeconds) ?? 0;
  const light = num(dto.lightSleepSeconds) ?? 0;
  const rem = num(dto.remSleepSeconds) ?? 0;
  const awake =
    num(dto.awakeSleepSeconds) ?? num(dto.awakeDuringSleepSeconds) ?? 0;

  // The Local/GMT pair encodes the watch's UTC offset when it recorded.
  const startLocal = num(dto.sleepStartTimestampLocal);
  const offset =
    startLocal === null ? null : Math.round((startLocal - startGmt) / 60000);

  return compact({
    entry_date: date,
    bedtime: new Date(startGmt).toISOString(),
    wake_time: new Date(endGmt).toISOString(),
    duration_in_seconds: duration,
    time_asleep_in_seconds: deep + light + rem,
    source: 'garmin',
    sleep_score: num(obj(obj(dto.sleepScores).overall).value),
    deep_sleep_seconds: deep,
    light_sleep_seconds: light,
    rem_sleep_seconds: rem,
    awake_sleep_seconds: awake,
    average_spo2_value: num(dto.averageSpO2Value),
    lowest_spo2_value: num(dto.lowestSpO2Value),
    highest_spo2_value: num(dto.highestSpO2Value),
    average_respiration_value: num(dto.averageRespirationValue),
    lowest_respiration_value: num(dto.lowestRespirationValue),
    highest_respiration_value: num(dto.highestRespirationValue),
    awake_count: num(dto.awakeCount),
    avg_sleep_stress: num(dto.avgSleepStress),
    restless_moments_count: num(raw.restlessMomentsCount),
    avg_overnight_hrv: num(raw.avgOvernightHrv),
    body_battery_change: num(raw.bodyBatteryChange),
    resting_heart_rate: num(raw.restingHeartRate),
    record_utc_offset_minutes:
      offset !== null && Math.abs(offset) <= 840 ? offset : null,
    stage_events: [],
  });
}

function buildHrv(date: string, raw: Dto): GarminHealthRecord {
  const readings = Array.isArray(raw.hrvReadings) ? raw.hrvReadings : [];
  const hrvValue = readings.flatMap((r) => {
    const value = num(obj(r).hrvValue);
    const time = gmtIso(obj(r).readingTimeGMT);
    return value && time ? [{ time, data: value }] : [];
  });
  const summary = obj(raw.hrvSummary);
  return compact({
    date,
    hrvValue,
    average_overnight_hrv: hrvValue.length
      ? hrvValue.reduce((sum, r) => sum + r.data, 0) / hrvValue.length
      : null,
    hrv_status: raw.hrvStatus ?? raw.status,
    weekly_avg: raw.weeklyAvg ?? raw.sevenDayAvg,
    baseline_low: raw.baselineLowUpper ?? raw.baselineLow,
    baseline_high: raw.baselineBalancedLow ?? raw.baselineHigh,
    last_night_avg: summary.lastNightAvg ?? summary.lastNight,
    last_night_5min_high: summary.lastNight5MinHigh,
    baseline_balanced_low: summary.baselineBalancedLow,
    baseline_balanced_upper: summary.baselineBalancedUpper,
    status: summary.status,
  });
}

function buildHeartRates(date: string, raw: Dto): GarminHealthRecord {
  const values = Array.isArray(raw.heartRateValues) ? raw.heartRateValues : [];
  return {
    date,
    HeartRate: values.flatMap((entry) => {
      if (!Array.isArray(entry)) return [];
      const [ts, bpm] = entry as unknown[];
      return num(ts) !== null && num(bpm)
        ? [{ time: new Date(ts as number).toISOString(), data: bpm }]
        : [];
    }),
  };
}

function addBodyBatteryReports(data: GarminHealthData, reports: unknown[]) {
  const covered = new Set(data.body_battery.map((b) => b.date));
  for (const report of reports.map(obj)) {
    const date = dateOf(report);
    if (!date || covered.has(date)) continue;
    const levels = (
      Array.isArray(report.bodyBatteryValuesArray)
        ? report.bodyBatteryValuesArray
        : []
    )
      .map((v) => (Array.isArray(v) ? num(v[1]) : null))
      .filter((v): v is number => v !== null);
    data.body_battery.push(
      compact({
        date,
        body_battery_highest: levels.length ? Math.max(...levels) : null,
        body_battery_lowest: levels.length ? Math.min(...levels) : null,
        body_battery_charged: num(report.charged),
        body_battery_drained: num(report.drained),
        body_battery_current: levels.length ? levels[levels.length - 1] : null,
      })
    );
    covered.add(date);
  }
}

function addWeights(data: GarminHealthData, weight: Dto) {
  const days = Array.isArray(weight.dailyWeightSummaries)
    ? weight.dailyWeightSummaries.map(obj)
    : [];
  for (const day of days) {
    const metrics = Array.isArray(day.allWeightMetrics)
      ? day.allWeightMetrics.map(obj)
      : [obj(day.latestWeight)];
    for (const m of metrics) {
      const date = dateOf(m) ?? dateOf(day);
      if (!date || num(m.weight) === null) continue;
      data.body_composition.push(
        compact({
          date,
          weight: scaled(m.weight, 1000),
          body_fat_percentage: num(m.bodyFat),
          bmi: num(m.bmi),
          body_water_percentage: num(m.bodyWater),
          bone_mass: scaled(m.boneMass, 1000),
          muscle_mass: scaled(m.muscleMass, 1000),
        })
      );
    }
  }
}

/**
 * Builds the microservice's health_and_wellness `data` object from Personal
 * API responses. Empty metric lists are dropped, as routes.py does.
 */
export function buildGarminHealthData(
  days: PersonalApiDay[],
  range: PersonalApiRangeData,
  capturedAt: Date = new Date()
): GarminHealthData {
  const data: GarminHealthData = Object.fromEntries(
    [
      'daily_summary',
      'steps',
      'total_distance',
      'highly_active_seconds',
      'active_seconds',
      'sedentary_seconds',
      'active_calories',
      'bmr_calories',
      'total_calories',
      'body_battery',
      'stress',
      'floors',
      'intensity_minutes',
      'spo2',
      'respiration',
      'sleep',
      'hrv',
      'heart_rates',
      'fitness_age',
      'hydration',
      'body_composition',
    ].map((k) => [k, [] as GarminHealthRecord[]])
  );
  const captured = capturedAt.toISOString();

  for (const day of days) {
    const { date } = day;
    if (day.summary) addSummary(data, date, day.summary, captured);

    const sleep = day.sleep ? buildSleepEntry(date, day.sleep) : null;
    if (sleep) {
      data.sleep.push(sleep);
      const hasSpo2 = data.spo2.some((s) => s.date === date);
      if (!hasSpo2 && sleep.average_spo2_value) {
        data.spo2.push({ date, average_spo2: sleep.average_spo2_value });
      }
    }

    const respiration = compact({
      date,
      sleep_respiration_avg: sleep?.average_respiration_value,
      awake_respiration_avg: num(day.summary?.avgWakingRespirationValue),
    });
    if (Object.keys(respiration).length > 1) data.respiration.push(respiration);

    if (day.hrv) data.hrv.push(buildHrv(date, day.hrv));
    if (day.heartRate)
      data.heart_rates.push(buildHeartRates(date, day.heartRate));
    if (day.fitnessAge) {
      data.fitness_age.push(
        compact({
          date,
          fitness_age: num(day.fitnessAge.fitnessAge),
          chronological_age: num(day.fitnessAge.chronologicalAge),
          achievable_fitness_age: num(day.fitnessAge.achievableFitnessAge),
        })
      );
    }
  }

  for (const entry of (range.hydration ?? []).map(obj)) {
    const date = dateOf(entry);
    const ml = num(obj(entry.values).valueInML) ?? num(entry.valueInML);
    if (date && ml && ml > 0) data.hydration.push({ date, hydration: ml });
  }
  addBodyBatteryReports(data, range.bodyBattery ?? []);
  if (range.weight) addWeights(data, range.weight);

  return Object.fromEntries(
    Object.entries(data).filter(([, records]) => records.length > 0)
  );
}

/**
 * routes.py activity summary: units converted (km, minutes), a name for
 * unnamed activities and active calories (calories minus BMR).
 */
export function toGarminActivity(raw: Dto): Dto {
  const typeKey = obj(raw.activityType).typeKey;
  const name =
    raw.activityName ||
    (typeof typeKey === 'string'
      ? typeKey
          .split('_')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')
      : undefined);
  return compact({
    ...raw,
    activityName: name,
    distance: scaled(raw.distance, 1000),
    duration: scaled(raw.duration, 60),
    elapsedDuration: scaled(raw.elapsedDuration, 60),
    movingDuration: scaled(raw.movingDuration, 60),
    active_calories: Math.max(
      0,
      (num(raw.calories) ?? 0) - (num(raw.bmrCalories) ?? 0)
    ),
  });
}
