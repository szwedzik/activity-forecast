import { describe, expect, it } from 'vitest';

import { extractDayFeatures, summariseDays } from '../../../../src/domain/forecast/features.js';
import type { Window } from '../../../../src/domain/forecast/types.js';
import { FIXTURE_TODAY, loadMarine, loadWeather } from '../../../helpers/fixtures.js';
import { makeMarine, makeWeather } from '../../../helpers/payloads.js';

const SKI: Window = { kind: 'hours', fromHour: 9, toHour: 16 };
const TOURING: Window = { kind: 'hours', fromHour: 9, toHour: 18 };
const DAYLIGHT: Window = { kind: 'daylight', fallbackFromHour: 6, fallbackToHour: 18 };

describe('windows over the Chamonix fixture', () => {
  const data = { weather: loadWeather('chamonix'), marine: loadMarine('chamonix') };

  it('takes seven rows for the 09:00-16:00 ski day and nine for the 09:00-18:00 touring day', () => {
    const ski = extractDayFeatures(data, FIXTURE_TODAY, SKI);
    const touring = extractDayFeatures(data, FIXTURE_TODAY, TOURING);

    expect(ski.map((day) => day.hoursInWindow)).toEqual([7, 7, 7, 7, 7, 7, 7]);
    expect(touring.map((day) => day.hoursInWindow)).toEqual([9, 9, 9, 9, 9, 9, 9]);
  });

  it('turns the eight-day payload into seven days starting at the injected today', () => {
    const days = extractDayFeatures(data, FIXTURE_TODAY, SKI);

    expect(days).toHaveLength(7);
    expect(days.map((day) => day.date)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
  });

  it('slides the window when today is later in the payload', () => {
    const days = extractDayFeatures(data, '2026-09-15', SKI);

    expect(days[0]?.date).toBe('2026-09-15');
    expect(days[6]?.date).toBe('2026-09-21');
    expect(days.every((day) => day.hoursInWindow === 7)).toBe(true);
  });

  it('reports a day outside the payload as empty rather than throwing', () => {
    const days = extractDayFeatures(data, '2026-10-01', SKI);

    expect(days[0]?.hoursInWindow).toBe(0);
    expect(days[0]?.tempMeanC).toBeUndefined();
    expect(days[0]?.weatherCodes).toEqual([]);
  });

  it('aggregates within the window only', () => {
    const [today] = extractDayFeatures(data, FIXTURE_TODAY, SKI);
    const wholeDay = extractDayFeatures(data, FIXTURE_TODAY, { kind: 'hours', fromHour: 0, toHour: 24 })[0];

    expect(today?.tempMeanC).toBeDefined();
    expect(wholeDay?.hoursInWindow).toBe(24);
    // Mid-September in the Alps: the 09-16 window is warmer than the 24-hour mean.
    expect(today?.tempMeanC ?? 0).toBeGreaterThan(wholeDay?.tempMeanC ?? 0);
  });

  it('leaves every marine feature undefined inland, where the model returns only nulls', () => {
    const days = extractDayFeatures(data, FIXTURE_TODAY, DAYLIGHT);

    for (const day of days) {
      expect(day.waveHeightMeanM).toBeUndefined();
      expect(day.swellPeriodMeanS).toBeUndefined();
      expect(day.seaSurfaceTempC).toBeUndefined();
    }
  });
});

describe('the daylight window', () => {
  it('uses the hours the model marks as day', () => {
    const data = { weather: loadWeather('lisbon'), marine: loadMarine('lisbon') };
    const days = extractDayFeatures(data, FIXTURE_TODAY, DAYLIGHT);

    // Lisbon in mid-September: somewhere between eleven and fifteen hours of daylight.
    for (const day of days) {
      expect(day.hoursInWindow).toBeGreaterThanOrEqual(11);
      expect(day.hoursInWindow).toBeLessThanOrEqual(15);
    }
  });

  it('falls back to fixed hours when the model reports no daylight at all', () => {
    const weather = makeWeather({ startDate: '2026-12-21', days: 2, hourly: { is_day: 0 } });
    const days = extractDayFeatures({ weather }, '2026-12-21', DAYLIGHT, 2);

    expect(days[0]?.hoursInWindow).toBe(12);
  });

  it('falls back when the is_day series is missing entirely', () => {
    const weather = makeWeather({ startDate: '2026-12-21', days: 2, hourly: { is_day: null } });
    const days = extractDayFeatures({ weather }, '2026-12-21', DAYLIGHT, 2);

    expect(days[0]?.hoursInWindow).toBe(12);
  });
});

describe('null tolerance', () => {
  it('averages the hours that have a value and ignores the gaps', () => {
    const weather = makeWeather({
      startDate: '2026-09-14',
      days: 1,
      hourly: { temperature_2m: (time) => (Number(time.slice(11, 13)) % 2 === 0 ? 20 : null) },
    });
    const [day] = extractDayFeatures({ weather }, '2026-09-14', TOURING, 1);

    expect(day?.tempMeanC).toBe(20);
    expect(day?.hoursInWindow).toBe(9);
  });

  it('leaves a feature undefined only when every input was null', () => {
    const weather = makeWeather({
      startDate: '2026-09-14',
      days: 1,
      hourly: { temperature_2m: null, visibility: null },
      daily: { snowfall_sum: null },
    });
    const [day] = extractDayFeatures({ weather }, '2026-09-14', TOURING, 1);

    expect(day?.tempMeanC).toBeUndefined();
    expect(day?.visibilityMinM).toBeUndefined();
    expect(day?.snowfallDayCm).toBeUndefined();
    // Series that still have values are unaffected.
    expect(day?.windMeanKmh).toBe(5);
  });

  it('counts wet hours, and knows the difference between zero and no data', () => {
    const wet = makeWeather({
      startDate: '2026-09-14',
      days: 1,
      hourly: { precipitation: (time) => (Number(time.slice(11, 13)) < 12 ? 0.5 : 0) },
    });
    const unknown = makeWeather({ startDate: '2026-09-14', days: 1, hourly: { precipitation: null } });

    expect(extractDayFeatures({ weather: wet }, '2026-09-14', TOURING, 1)[0]?.precipHours).toBe(3);
    expect(extractDayFeatures({ weather: unknown }, '2026-09-14', TOURING, 1)[0]?.precipHours).toBeUndefined();
  });

  it('derives liquid rain by removing the water equivalent of the snow (D§2.2)', () => {
    // precipitation is mm of water, snowfall is cm of snow. Measured against the live API
    // at -20 °C, where nothing falls as rain: 0.1 mm of precipitation is 0.07 cm of snow.
    // So a centimetre of snow is 1/0.7 mm of water, and 7 cm is 10 mm (D-029).
    const allSnow = makeWeather({
      startDate: '2026-09-14',
      days: 1,
      hourly: { precipitation: 10, snowfall: 7 },
    });
    const mixed = makeWeather({
      startDate: '2026-09-14',
      days: 1,
      hourly: { precipitation: 12, snowfall: 7 },
    });

    const snowDay = extractDayFeatures({ weather: allSnow }, '2026-09-14', TOURING, 1)[0];
    const mixedDay = extractDayFeatures({ weather: mixed }, '2026-09-14', TOURING, 1)[0];

    // Every millimetre is accounted for by the snow, so not a drop of it is rain.
    expect(snowDay?.precipMm).toBe(90);
    expect(snowDay?.rainMm).toBe(0);
    // Only the 2 mm an hour the snow cannot explain is rain.
    expect(mixedDay?.precipMm).toBe(108);
    expect(mixedDay?.rainMm).toBeCloseTo(18, 6);
  });
});

describe('local dates are wall-clock, never UTC', () => {
  it('picks the Sydney day even when UTC is still on the day before', () => {
    // 2026-09-14T23:30Z is 2026-09-15 09:30 in Sydney. A payload in local time labels
    // those rows 2026-09-15, and that is the day we must return.
    const weather = makeWeather({
      startDate: '2026-09-14',
      days: 3,
      timezone: 'Australia/Sydney',
      hourly: { temperature_2m: (time) => (time.startsWith('2026-09-15') ? 25 : 5) },
    });
    const [day] = extractDayFeatures({ weather }, '2026-09-15', TOURING, 1);

    expect(day?.date).toBe('2026-09-15');
    expect(day?.tempMeanC).toBe(25);
  });
});

describe('joining marine rows to weather rows', () => {
  it('matches on the time string when the two snapshots start on different days', () => {
    // The weather snapshot starts a day after the marine one, so index 0 of each array
    // is a different day. Matching by index would read the wrong sea state entirely.
    const weather = makeWeather({ startDate: '2026-09-15', days: 3 });
    const marine = makeMarine({
      startDate: '2026-09-14',
      days: 4,
      hourly: { wave_height: (time) => (time.startsWith('2026-09-15') ? 2.5 : 0.4) },
    });

    const [day] = extractDayFeatures({ weather, marine }, '2026-09-15', DAYLIGHT, 1);

    expect(day?.waveHeightMeanM).toBe(2.5);
  });

  it('leaves marine features undefined when the marine snapshot does not cover the day', () => {
    const weather = makeWeather({ startDate: '2026-09-15', days: 2 });
    const marine = makeMarine({ startDate: '2026-09-01', days: 2 });

    const [day] = extractDayFeatures({ weather, marine }, '2026-09-15', DAYLIGHT, 1);

    expect(day?.waveHeightMeanM).toBeUndefined();
  });
});

describe('summariseDays', () => {
  const data = { weather: loadWeather('lisbon'), marine: loadMarine('lisbon') };

  it('returns seven chronological days with a human summary', () => {
    const days = summariseDays(data, FIXTURE_TODAY);

    expect(days).toHaveLength(7);
    expect(days.map((day) => day.date)).toEqual([...days].sort((a, b) => a.date.localeCompare(b.date)).map((day) => day.date));
    expect(days[0]?.summary).toBe('Clear sky');
    expect(days[0]?.tempMaxC).toBe(32.6);
    expect(days[0]?.sunshineHours).toBeCloseTo(12.3, 1);
  });

  it('carries the daily wave height for a coastal town', () => {
    const days = summariseDays(data, FIXTURE_TODAY);

    expect(days[0]?.waveHeightMaxM).toBeGreaterThan(0);
  });

  it('has no wave height inland', () => {
    const inland = { weather: loadWeather('denver'), marine: loadMarine('denver') };

    expect(summariseDays(inland, FIXTURE_TODAY)[0]?.waveHeightMaxM).toBeUndefined();
  });
});
