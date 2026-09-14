/**
 * The D§7.7 band table: one hand-built day per row, asserting the band and never the
 * reference number. The reference scores in the design were worked out from the curves
 * by hand; if one of these fails, the fix is either the curve or the band, and which it
 * was goes in docs/DECISIONS.md. Never move a curve to make a fixture look nicer (D-011).
 */
import { describe, expect, it } from 'vitest';

import type { DayFeatures } from '../../../../src/domain/forecast/types.js';
import { worstWeatherCode } from '../../../../src/domain/forecast/weatherCodes.js';
import { deriveIndoorDay } from '../../../../src/domain/scoring/activities/index.js';
import { outdoorSightseeing, skiing, surfing } from '../../../../src/domain/scoring/activities/index.js';
import type { ScoredDay } from '../../../../src/domain/scoring/engine.js';
import { scoreDay, suitabilityOf } from '../../../../src/domain/scoring/engine.js';
import { rankActivity } from '../../../../src/domain/scoring/index.js';

function day(overrides: Partial<DayFeatures> = {}): DayFeatures {
  const codes = overrides.weatherCodes ?? [0];
  return {
    date: '2026-09-14',
    hoursInWindow: 9,
    ...overrides,
    weatherCodes: codes,
    worstWeatherCode: worstWeatherCode(codes),
  };
}

const SKI_IDEAL = day({
  tempMeanC: -6,
  snowDepthMaxM: 0.5,
  snowfallDayCm: 10,
  windMeanKmh: 8,
  gustMaxKmh: 20,
  visibilityMinM: 10000,
  cloudMeanPct: 20,
  rainMm: 0,
  weatherCodes: [0],
});

const SURF_IDEAL = day({
  waveHeightMeanM: 1.5,
  waveHeightMaxM: 1.8,
  swellPeriodMeanS: 12,
  windMeanKmh: 8,
  gustMaxKmh: 15,
  windWaveHeightMeanM: 0.3,
  seaSurfaceTempC: 20,
  apparentMeanC: 22,
  precipHours: 0,
  weatherCodes: [1],
});

const OUTDOOR_IDEAL = day({
  apparentMeanC: 24,
  apparentMaxC: 28,
  precipHours: 0,
  precipMm: 0,
  precipProbMean: 5,
  windMeanKmh: 10,
  gustMaxKmh: 20,
  sunshineFraction: 0.9,
  visibilityMinM: 20000,
  snowfallCm: 0,
  weatherCodes: [0],
});

/** Six hours of rain on an otherwise pleasant day. Shared, so the outdoor row and the
 *  indoor row derived from it cannot drift apart. */
const OUTDOOR_WASHOUT = day({
  ...OUTDOOR_IDEAL,
  precipHours: 6,
  precipMm: 12,
  precipProbMean: 85,
  apparentMeanC: 14,
  apparentMaxC: 16,
  windMeanKmh: 20,
  gustMaxKmh: 35,
  sunshineFraction: 0.1,
  weatherCodes: [63],
});

const score = (rules: Parameters<typeof scoreDay>[0], features: DayFeatures): ScoredDay =>
  scoreDay(rules, features, 0);

describe('skiing bands (D§7.7)', () => {
  it('an ideal day is EXCELLENT', () => {
    const result = score(skiing, SKI_IDEAL);

    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.suitability).toBe('EXCELLENT');
  });

  it('no snow is unskiable whatever the weather, and says so first', () => {
    const result = score(skiing, day({ ...SKI_IDEAL, snowDepthMaxM: 0 }));

    expect(result.score).toBeLessThanOrEqual(5);
    expect(result.suitability).toBe('UNSUITABLE');
    expect(result.factors[0]?.name).toBe('snowCover');
  });

  it('rain on snow ruins the surface however pleasant the rest is', () => {
    const result = score(
      skiing,
      day({
        tempMeanC: 1,
        rainMm: 5,
        snowDepthMaxM: 0.5,
        cloudMeanPct: 100,
        visibilityMinM: 3000,
        windMeanKmh: 15,
        gustMaxKmh: 25,
        snowfallDayCm: 0,
        weatherCodes: [61],
      }),
    );

    expect(result.score).toBeLessThanOrEqual(30);
  });

  it('a whiteout caps an otherwise perfect day', () => {
    const result = score(skiing, day({ ...SKI_IDEAL, visibilityMinM: 150 }));

    expect(result.score).toBeLessThanOrEqual(25);
  });

  it('a thunderstorm closes the day', () => {
    const result = score(skiing, day({ ...SKI_IDEAL, weatherCodes: [95] }));

    expect(result.score).toBeLessThanOrEqual(10);
  });

  it('says the score is less certain when the model gives no snow depth', () => {
    const withDepth = score(skiing, SKI_IDEAL);
    const without = score(skiing, day({ ...SKI_IDEAL, snowDepthMaxM: undefined }));

    expect(without.confidence).toBeLessThan(withDepth.confidence);
    expect(without.factors.some((factor) => factor.name === 'snowCover')).toBe(true);
  });
});

describe('surfing bands (D§7.7)', () => {
  it('an ideal day is EXCELLENT', () => {
    const result = score(surfing, SURF_IDEAL);

    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.suitability).toBe('EXCELLENT');
  });

  it('small and weak surf lands in the middle, not at GOOD', () => {
    const result = score(
      surfing,
      day({
        waveHeightMeanM: 0.6,
        waveHeightMaxM: 0.8,
        swellPeriodMeanS: 7,
        windMeanKmh: 15,
        gustMaxKmh: 25,
        windWaveHeightMeanM: 0.3,
        seaSurfaceTempC: 18,
        apparentMeanC: 20,
        weatherCodes: [1],
      }),
    );

    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.score).toBeLessThanOrEqual(65);
  });

  it('a flat sea is not worth the drive', () => {
    const result = score(
      surfing,
      day({ ...SURF_IDEAL, waveHeightMeanM: 0.3, waveHeightMaxM: 0.4, swellPeriodMeanS: 10, windMeanKmh: 5 }),
    );

    expect(result.score).toBeLessThanOrEqual(20);
  });

  it('a thunderstorm all but rules it out', () => {
    const result = score(surfing, day({ ...SURF_IDEAL, weatherCodes: [95] }));

    expect(result.score).toBeLessThanOrEqual(5);
  });

  it('falls back to the whole sea state when the model reports no swell period', () => {
    const result = score(
      surfing,
      day({ ...SURF_IDEAL, swellPeriodMeanS: undefined, wavePeriodMeanS: 12 }),
    );

    expect(result.factors.some((factor) => factor.name === 'period')).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(85);
  });

  it('is not applicable at all without wave data, and still lists every day', () => {
    const days = ['2026-09-14', '2026-09-15', '2026-09-16'].map((date) => day({ ...OUTDOOR_IDEAL, date }));
    const ranking = rankActivity('SURFING', days);

    expect(ranking.applicable).toBe(false);
    expect(ranking.note).toContain('No wave-model coverage');
    expect(ranking.days).toHaveLength(3);
    expect(ranking.days.every((one) => one.suitability === 'NOT_APPLICABLE' && one.score === 0)).toBe(true);
    expect(ranking.days.map((one) => one.date)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
    expect(ranking.days.map((one) => one.rank)).toEqual([1, 2, 3]);
  });

  it('reports the reason the caller gives, rather than the generic note', () => {
    const days = [day({ ...OUTDOOR_IDEAL })];
    const ranking = rankActivity('SURFING', days, { surfingUnavailableNote: 'wave data temporarily unavailable' });

    expect(ranking.applicable).toBe(false);
    expect(ranking.note).toBe('wave data temporarily unavailable');
  });
});

describe('outdoor sightseeing bands (D§7.7)', () => {
  it('an ideal day is EXCELLENT', () => {
    const result = score(outdoorSightseeing, OUTDOOR_IDEAL);

    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.suitability).toBe('EXCELLENT');
  });

  it('a couple of hours of showers is still a decent day out', () => {
    const result = score(
      outdoorSightseeing,
      day({
        ...OUTDOOR_IDEAL,
        precipHours: 2,
        precipMm: 3,
        precipProbMean: 50,
        apparentMeanC: 18,
        apparentMaxC: 21,
        windMeanKmh: 12,
        sunshineFraction: 0.4,
        weatherCodes: [80],
      }),
    );

    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.score).toBeLessThanOrEqual(85);
  });

  it('six hours of rain is a washout, not a FAIR day', () => {
    expect(score(outdoorSightseeing, OUTDOOR_WASHOUT).score).toBeLessThanOrEqual(25);
  });

  it('a thunderstorm keeps people indoors', () => {
    const result = score(outdoorSightseeing, day({ ...OUTDOOR_IDEAL, weatherCodes: [95] }));

    expect(result.score).toBeLessThanOrEqual(20);
  });
});

describe('indoor sightseeing bands (D§7.7)', () => {
  const outdoorDay = (value: number): ScoredDay => ({
    date: '2026-09-14',
    score: value,
    suitability: suitabilityOf(value),
    confidence: 0.9,
    factors: [],
  });

  it('sits at its floor when outside is perfect', () => {
    const result = deriveIndoorDay(outdoorDay(100), day());

    expect(result.score).toBe(55);
    expect(result.suitability).toBe('FAIR');
  });

  it('reaches the top when outside is hopeless', () => {
    expect(deriveIndoorDay(outdoorDay(0), day()).score).toBe(100);
  });

  it('is the obvious plan on the washout day', () => {
    // Derived from the real scored washout above, not a hand-typed outdoor score, so the
    // two rows of the table cannot drift apart.
    const result = deriveIndoorDay(score(outdoorSightseeing, OUTDOOR_WASHOUT), OUTDOOR_WASHOUT);

    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.factors[0]?.note).toContain('indoor day');
  });

  it('is pulled down by a blizzard, because getting between venues is the hard part', () => {
    const result = deriveIndoorDay(
      outdoorDay(10),
      day({ snowfallDayCm: 20, gustMaxKmh: 60, weatherCodes: [75] }),
    );

    expect(result.score).toBeLessThanOrEqual(75);
    expect(result.factors[0]?.name).toBe('travel');
  });

  it('takes the worst single travel penalty rather than multiplying them together', () => {
    // 110 km/h gusts in a blizzard is one bad journey, not two.
    const result = deriveIndoorDay(
      outdoorDay(0),
      day({ snowfallDayCm: 20, gustMaxKmh: 110, weatherCodes: [75] }),
    );

    expect(result.score).toBe(60);
  });

  it('passes a day with no data straight through', () => {
    const blank: ScoredDay = {
      date: '2026-09-14',
      score: 0,
      suitability: 'NOT_APPLICABLE',
      confidence: 0.2,
      factors: [],
    };

    expect(deriveIndoorDay(blank, day()).suitability).toBe('NOT_APPLICABLE');
  });
});
