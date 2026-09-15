/** The D§7.7 invariants: properties that must hold for every activity and every day. */
import { describe, expect, it } from 'vitest';

import { extractDayFeatures } from '../../../../src/domain/forecast/features.js';
import type { Activity, DayFeatures } from '../../../../src/domain/forecast/types.js';
import { ACTIVITIES } from '../../../../src/domain/forecast/types.js';
import { RULES, windowFor } from '../../../../src/domain/scoring/activities/index.js';
import { isValidCurve } from '../../../../src/domain/scoring/curve.js';
import { rankActivities, rankActivity } from '../../../../src/domain/scoring/index.js';
import { FIXTURE_TODAY, loadMarine, loadWeather } from '../../../helpers/fixtures.js';
import { makeMarine, makeWeather } from '../../../helpers/payloads.js';

const CITIES = ['chamonix', 'lisbon', 'denver'] as const;

function dataFor(city: (typeof CITIES)[number]) {
  const marine = loadMarine(city);
  return { weather: loadWeather(city), marine };
}

describe('the shipped data tables', () => {
  it('every curve is sorted and every value is a fraction', () => {
    for (const rules of Object.values(RULES)) {
      for (const criterion of rules.criteria) {
        expect(isValidCurve(criterion.curve), `${rules.activity}/${criterion.name}`).toBe(true);
      }
    }
  });

  it('every criterion carries a positive weight', () => {
    for (const rules of Object.values(RULES)) {
      for (const criterion of rules.criteria) {
        expect(criterion.weight, `${rules.activity}/${criterion.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('names every factor uniquely within its activity', () => {
    for (const rules of Object.values(RULES)) {
      const names = [...rules.criteria.map((one) => one.name), ...rules.gates.map((one) => one.name)];
      expect(new Set(names).size, rules.activity).toBe(names.length);
    }
  });
});

describe('over the captured fixtures', () => {
  for (const city of CITIES) {
    describe(city, () => {
      const rankings = rankActivities(dataFor(city), FIXTURE_TODAY);

      it('ranks all four activities', () => {
        expect(rankings.map((one) => one.activity)).toEqual(ACTIVITIES);
      });

      it('gives every activity seven days with unique ranks one to seven', () => {
        for (const ranking of rankings) {
          expect(ranking.days, ranking.activity).toHaveLength(7);
          expect([...ranking.days].map((one) => one.rank).sort((a, b) => a - b)).toEqual([
            1, 2, 3, 4, 5, 6, 7,
          ]);
        }
      });

      it('keeps every score inside [0, 100] and every confidence inside [0, 1]', () => {
        for (const ranking of rankings) {
          for (const one of ranking.days) {
            expect(one.score, `${ranking.activity} ${one.date}`).toBeGreaterThanOrEqual(0);
            expect(one.score, `${ranking.activity} ${one.date}`).toBeLessThanOrEqual(100);
            expect(one.confidence).toBeGreaterThanOrEqual(0.2);
            expect(one.confidence).toBeLessThanOrEqual(1);
          }
        }
      });

      it('explains every scored day with at least one factor', () => {
        for (const ranking of rankings) {
          if (!ranking.applicable) continue;
          for (const one of ranking.days) {
            expect(one.factors.length, `${ranking.activity} ${one.date}`).toBeGreaterThan(0);
          }
        }
      });

      it('orders the days so the first is the best', () => {
        for (const ranking of rankings) {
          if (!ranking.applicable) continue;
          const scores = ranking.days.map((one) => one.score);
          expect([...scores].sort((a, b) => b - a)).toEqual(scores);
        }
      });
    });
  }

  it('finds surfing applicable on the coast and not inland', () => {
    const coastal = rankActivities(dataFor('lisbon'), FIXTURE_TODAY).find(
      (one) => one.activity === 'SURFING',
    );
    const inland = rankActivities(dataFor('denver'), FIXTURE_TODAY).find(
      (one) => one.activity === 'SURFING',
    );

    expect(coastal?.applicable).toBe(true);
    expect(inland?.applicable).toBe(false);
  });
});

describe('indoor mirrors outdoor', () => {
  /** Seven days that differ only in how wet they are, and never trigger a travel penalty. */
  const sweep: DayFeatures[] = [0, 1, 2, 3, 4, 6, 9].map((rainHours, index) => ({
    date: `2026-09-${String(14 + index).padStart(2, '0')}`,
    hoursInWindow: 9,
    weatherCodes: [rainHours === 0 ? 0 : 61],
    worstWeatherCode: rainHours === 0 ? 0 : 61,
    apparentMeanC: 20,
    apparentMaxC: 23,
    precipHours: rainHours,
    precipMm: rainHours * 2,
    precipProbMean: rainHours * 10,
    windMeanKmh: 10,
    gustMaxKmh: 20,
    sunshineFraction: 0.8,
    visibilityMinM: 20000,
    snowfallCm: 0,
  }));

  const outdoor = rankActivity('OUTDOOR_SIGHTSEEING', sweep);
  const indoor = rankActivity('INDOOR_SIGHTSEEING', sweep);

  it('never rises as the outdoor day improves', () => {
    const byDate = new Map(indoor.days.map((one) => [one.date, one.score]));
    const pairs = outdoor.days.map((one) => [one.score, byDate.get(one.date) ?? 0] as const);
    const ordered = [...pairs].sort((a, b) => a[0] - b[0]);

    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]?.[1] ?? 0).toBeLessThanOrEqual(ordered[i - 1]?.[1] ?? 0);
    }
  });

  it('ranks the days in exactly the reverse order when no travel penalty applies', () => {
    expect(indoor.days.map((one) => one.date)).toEqual(
      [...outdoor.days].reverse().map((one) => one.date),
    );
  });

  it('never leaves an indoor day below its floor without a travel penalty', () => {
    for (const one of indoor.days) {
      expect(one.score).toBeGreaterThanOrEqual(55);
    }
  });
});

describe('a day with nothing in it', () => {
  const empty: DayFeatures[] = ['2026-09-14', '2026-09-15'].map((date) => ({
    date,
    hoursInWindow: 0,
    weatherCodes: [],
  }));

  it('is not applicable for every activity, rather than scoring zero as if it were bad', () => {
    for (const activity of ACTIVITIES as readonly Activity[]) {
      const ranking = rankActivity(activity, empty);
      for (const one of ranking.days) {
        expect(one.suitability, activity).toBe('NOT_APPLICABLE');
        expect(one.score, activity).toBe(0);
      }
    }
  });

  it('still gives every activity the window it asks for', () => {
    expect(windowFor('SKIING')).toEqual({ kind: 'hours', fromHour: 9, toHour: 16 });
    expect(windowFor('OUTDOOR_SIGHTSEEING')).toEqual({ kind: 'hours', fromHour: 9, toHour: 18 });
    expect(windowFor('INDOOR_SIGHTSEEING')).toEqual(windowFor('OUTDOOR_SIGHTSEEING'));
    expect(windowFor('SURFING')).toEqual({ kind: 'daylight', fallbackFromHour: 6, fallbackToHour: 18 });
  });
});

describe('window choice changes the answer', () => {
  it('judges skiing on lift hours, not on the whole day', () => {
    const data = dataFor('chamonix');
    const lift = extractDayFeatures(data, FIXTURE_TODAY, windowFor('SKIING'));
    const touring = extractDayFeatures(data, FIXTURE_TODAY, windowFor('OUTDOOR_SIGHTSEEING'));

    expect(lift[0]?.hoursInWindow).toBe(7);
    expect(touring[0]?.hoursInWindow).toBe(9);
  });
});

describe('a payload all the way through to a score', () => {
  // Every row of the D§7.7 band table starts from a hand-built DayFeatures, so the step
  // from a payload to those features was never scored. A unit slip lived there: snowfall
  // is centimetres of snow and precipitation is millimetres of water, and dividing one by
  // the other at 7 instead of 0.7 left nearly all of the snow counted as rain. It made
  // the best possible ski day UNSUITABLE through the gate written to catch the worst one
  // (D-029). No fixture contains snow, so nothing else goes near this.
  it('scores a cold day of steady snow as a day worth skiing', () => {
    const weather = makeWeather({
      startDate: '2026-09-14',
      days: 1,
      hourly: {
        temperature_2m: -6,
        apparent_temperature: -11,
        // 2 cm of snow an hour is 2.86 mm of water, so 2.8 mm of precipitation is snow
        // and nothing else.
        precipitation: 2.8,
        snowfall: 2,
        snow_depth: 1.2,
        wind_speed_10m: 8,
        wind_gusts_10m: 20,
        visibility: 10_000,
        cloud_cover: 60,
        weather_code: 73,
      },
      daily: { snowfall_sum: 14 },
    });

    const [day] = extractDayFeatures({ weather }, '2026-09-14', windowFor('SKIING'), 1);
    expect(day?.rainMm).toBe(0);

    const ranking = rankActivity('SKIING', [day as DayFeatures]);
    const [scored] = ranking.days;

    // -6 °C, light wind, good visibility, 14 cm of new snow on a 1.2 m base: the band
    // the curves give it is EXCELLENT, and that is the right answer for a day like this.
    expect(scored?.score).toBeGreaterThanOrEqual(85);
    expect(scored?.suitability).toBe('EXCELLENT');
    // The rain-on-snow gate has nothing to fire on.
    expect(scored?.factors.map((one) => one.name)).not.toContain('rainOnSnow');
  });
});

describe('a week the wave model only half covers', () => {
  // Weather models run further out than wave models, so partial coverage is the normal
  // case rather than an exotic one. Renormalising over the criteria that remain gave the
  // days we know nothing about a perfect score on wind and air temperature alone, and
  // they outranked days with a real swell (D-030).
  const week = () => {
    const weather = makeWeather({
      startDate: '2026-09-14',
      days: 7,
      hourly: { wind_speed_10m: 6, wind_gusts_10m: 12, apparent_temperature: 24, is_day: 1 },
    });
    const marine = makeMarine({
      startDate: '2026-09-14',
      days: 7,
      hourly: {
        // A real swell for three days, then the model has nothing to say.
        wave_height: (time) => (time < '2026-09-17' ? 1.4 : null),
        wave_period: (time) => (time < '2026-09-17' ? 11 : null),
        swell_wave_period: (time) => (time < '2026-09-17' ? 11 : null),
        wind_wave_height: (time) => (time < '2026-09-17' ? 0.2 : null),
      },
    });
    return extractDayFeatures({ weather, marine }, '2026-09-14', windowFor('SURFING'), 7);
  };

  it('ranks the days it knows about above the days it does not', () => {
    const ranking = rankActivity('SURFING', week());

    expect(ranking.applicable).toBe(true);
    const top = ranking.days.slice(0, 3);
    expect(top.map((one) => one.date)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
    expect(top.every((one) => one.score > 0)).toBe(true);
  });

  it('says it cannot assess the rest rather than scoring them on the breeze', () => {
    const ranking = rankActivity('SURFING', week());
    const unknown = ranking.days.filter((one) => one.date >= '2026-09-17');

    expect(unknown).toHaveLength(4);
    for (const day of unknown) {
      expect(day.suitability).toBe('NOT_APPLICABLE');
      expect(day.score).toBe(0);
      expect(day.factors[0]?.note).toBe('no wave data for this day');
    }
  });
});

describe('a score can be rebuilt from the factors it ships with', () => {
  // AGENTS.md calls the factors the product, and D§8.1 contracts `effect` as the
  // criterion's desirability or the gate's multiplier. Indoor published the opportunity
  // instead, so its only factor said 0.06 on a day it scored 58 (D-031).
  it('holds for indoor sightseeing, which derives its score rather than measuring it', () => {
    const data = dataFor('denver');
    const rankings = rankActivities(data, FIXTURE_TODAY);
    const indoor = rankings.find((one) => one.activity === 'INDOOR_SIGHTSEEING');

    for (const day of indoor?.days ?? []) {
      const criteria = day.factors.filter((one) => one.kind === 'CRITERION');
      const gates = day.factors.filter((one) => one.kind === 'GATE');
      const weighted = criteria.reduce((total, one) => total + one.effect * (one.weight ?? 1), 0);
      const totalWeight = criteria.reduce((total, one) => total + (one.weight ?? 1), 0);
      const gateProduct = gates.reduce((product, one) => product * one.effect, 1);

      expect(Math.round(100 * (weighted / totalWeight) * gateProduct), day.date).toBe(day.score);
    }
  });
});
