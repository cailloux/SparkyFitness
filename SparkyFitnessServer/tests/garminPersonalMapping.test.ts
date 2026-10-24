import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildGarminHealthData,
  buildSleepEntry,
  stressToMood,
  toGarminActivity,
} from '../integrations/garminpersonal/garminPersonalMapping.js';
import { parseGarminHealthMeasurements } from '../integrations/garminconnect/garminMeasurementMapping.js';

type Dto = Record<string, unknown>;

function fixture<T = Dto>(name: string): T {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/garminPersonal/${name}.json`, import.meta.url),
      'utf8'
    )
  ) as T;
}

const DATE = '2026-10-23';
const CAPTURED = new Date('2026-10-24T12:00:00.000Z');

function fullDay() {
  return buildGarminHealthData(
    [
      {
        date: DATE,
        summary: fixture<{ data: Dto[] }>('dailysummaries').data[0],
        sleep: fixture('dailySleep'),
        hrv: fixture('hrv'),
        heartRate: fixture('dailyHeartRate'),
        fitnessAge: fixture('fitnessAge'),
      },
    ],
    {
      hydration: fixture<unknown[]>('hydration'),
      bodyBattery: fixture<unknown[]>('bodyBattery'),
      weight: fixture('weightRange'),
    },
    CAPTURED
  );
}

describe('buildGarminHealthData', () => {
  it('reshapes the daily summary into the microservice records', () => {
    const data = fullDay();

    expect(data.steps).toEqual([{ date: DATE, value: 11234 }]);
    expect(data.total_distance).toEqual([{ date: DATE, value: 8.765 }]);
    expect(data.active_seconds).toEqual([{ date: DATE, value: 90 }]);
    expect(data.total_calories).toEqual([{ date: DATE, value: 2650 }]);
    expect(data.daily_summary).toEqual([
      {
        date: DATE,
        total_calories: 2650,
        active_calories: 820,
        bmr_calories: 1830,
        resting_heart_rate: 52,
        avg_stress_level: 31,
        max_stress_level: 88,
        captured_at: CAPTURED.toISOString(),
      },
    ]);
    expect(data.floors).toEqual([
      { date: DATE, floors_ascended: 12, floors_descended: 11 },
    ]);
    expect(data.intensity_minutes).toEqual([
      { date: DATE, total_intensity_minutes: 50 },
    ]);
    expect(data.spo2).toEqual([{ date: DATE, average_spo2: 95 }]);
    expect(data.respiration).toEqual([
      { date: DATE, sleep_respiration_avg: 13, awake_respiration_avg: 14 },
    ]);
    expect(data.stress).toEqual([
      {
        date: DATE,
        derived_mood_value: 75,
        derived_mood_notes:
          'Derived from Garmin Stress: Average 31 (Confident)',
        average_stress_level: 31,
      },
    ]);
  });

  it('uses Body Battery reports only for days the summary does not cover', () => {
    const { body_battery } = fullDay();

    expect(body_battery).toEqual([
      {
        date: DATE,
        body_battery_highest: 92,
        body_battery_lowest: 18,
        body_battery_at_wake: 85,
        body_battery_charged: 60,
        body_battery_drained: 70,
        body_battery_current: 24,
      },
      {
        date: '2026-10-22',
        body_battery_highest: 80,
        body_battery_lowest: 25,
        body_battery_charged: 55,
        body_battery_drained: 61,
        body_battery_current: 25,
      },
    ]);
  });

  it('maps HRV readings, heart rate samples, fitness age, hydration and weight', () => {
    const data = fullDay();

    expect(data.hrv).toEqual([
      {
        date: DATE,
        hrvValue: [
          { time: '2026-10-23T05:00:00.000Z', data: 45 },
          { time: '2026-10-23T05:05:00.000Z', data: 51 },
        ],
        average_overnight_hrv: 48,
        last_night_avg: 48,
        last_night_5min_high: 71,
        status: 'BALANCED',
      },
    ]);
    // Null samples are dropped, as routes.py does.
    expect(data.heart_rates).toEqual([
      {
        date: DATE,
        HeartRate: [
          { time: '2026-10-23T00:00:00.000Z', data: 58 },
          { time: '2026-10-23T00:04:00.000Z', data: 61 },
        ],
      },
    ]);
    expect(data.fitness_age).toEqual([
      {
        date: DATE,
        fitness_age: 38.6,
        chronological_age: 44,
        achievable_fitness_age: 35,
      },
    ]);
    // A day with 0 ml is not stored.
    expect(data.hydration).toEqual([{ date: DATE, hydration: 1750 }]);
    expect(data.body_composition).toEqual([
      {
        date: DATE,
        weight: 74.25,
        body_fat_percentage: 18.2,
        bmi: 23.4,
        body_water_percentage: 57.1,
        bone_mass: 3.2,
        muscle_mass: 34.1,
      },
    ]);
  });

  it('drops empty metric lists, so a day of 204s yields nothing', () => {
    expect(
      buildGarminHealthData(
        [
          {
            date: DATE,
            summary: null,
            sleep: null,
            hrv: null,
            heartRate: null,
            fitnessAge: null,
          },
        ],
        { hydration: [], bodyBattery: [], weight: null }
      )
    ).toEqual({});
  });

  it('feeds the existing Garmin measurement mapping unchanged', () => {
    const measurements = parseGarminHealthMeasurements(fullDay());

    expect(measurements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'weight', value: 74.25, date: DATE }),
        expect.objectContaining({ type: 'steps', value: 11234, date: DATE }),
        expect.objectContaining({ type: 'water', value: 1750, date: DATE }),
      ])
    );
  });
});

describe('buildSleepEntry', () => {
  it('builds the sleep record from dailySleepDTO, with no stage events', () => {
    expect(buildSleepEntry(DATE, fixture('dailySleep'))).toEqual({
      entry_date: DATE,
      bedtime: '2026-10-22T22:30:00.000Z',
      wake_time: '2026-10-23T06:20:00.000Z',
      duration_in_seconds: 26400,
      time_asleep_in_seconds: 26400,
      source: 'garmin',
      sleep_score: 82,
      deep_sleep_seconds: 5400,
      light_sleep_seconds: 14400,
      rem_sleep_seconds: 6600,
      awake_sleep_seconds: 1800,
      average_spo2_value: 94,
      lowest_spo2_value: 88,
      highest_spo2_value: 99,
      average_respiration_value: 13,
      lowest_respiration_value: 10,
      highest_respiration_value: 17,
      awake_count: 2,
      avg_sleep_stress: 18,
      record_utc_offset_minutes: -240,
      stage_events: [],
    });
  });

  it('accepts a bare DTO and skips a night without timestamps', () => {
    const dto = fixture<{ dailySleepDTO: Dto }>('dailySleep').dailySleepDTO;
    expect(buildSleepEntry(DATE, dto)?.duration_in_seconds).toBe(26400);
    expect(buildSleepEntry(DATE, { dailySleepDTO: {} })).toBeNull();
  });
});

describe('toGarminActivity', () => {
  it('converts units, names unnamed activities and derives active calories', () => {
    const [ride, strength] = fixture<Dto[]>('activities').map(toGarminActivity);

    expect(ride).toMatchObject({
      activityId: 1000000001,
      activityName: 'Zwift - Watopia',
      distance: 30.5005,
      duration: 3600.4 / 60,
      movingDuration: 3590 / 60,
      active_calories: 700,
    });
    expect(strength).toMatchObject({
      activityName: 'Strength Training',
      duration: 30,
      active_calories: 170,
    });
    expect(strength).not.toHaveProperty('distance');
  });
});

describe('stressToMood', () => {
  it('matches the microservice bands', () => {
    expect(stressToMood(null)).toBeNull();
    expect(stressToMood(-1)).toBeNull();
    expect(stressToMood(0)).toEqual({ value: 95, label: 'Excited' });
    expect(stressToMood(50)).toEqual({ value: 65, label: 'Calm' });
    expect(stressToMood(100)).toEqual({ value: 15, label: 'Sad/Tired' });
  });
});
