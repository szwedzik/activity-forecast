import { describe, expect, it } from 'vitest';

import type { DayFeatures } from '../../../../src/domain/forecast/types.js';
import type { ActivityRules, Gate, ScoredDay } from '../../../../src/domain/scoring/engine.js';
import {
  confidenceForLead,
  rankDays,
  scoreAndRank,
  scoreDay,
  suitabilityOf,
} from '../../../../src/domain/scoring/engine.js';

function day(overrides: Partial<DayFeatures> = {}): DayFeatures {
  return { date: '2026-09-14', hoursInWindow: 9, weatherCodes: [], ...overrides };
}

/** Two criteria of equal weight, both a straight 0-to-1 ramp over 0–10. */
const rules = (gates: Gate[] = []): ActivityRules => ({
  activity: 'OUTDOOR_SIGHTSEEING',
  window: { kind: 'hours', fromHour: 9, toHour: 18 },
  criteria: [
    {
      name: 'warmth',
      weight: 1,
      select: (features) => features.tempMeanC,
      curve: [
        [0, 0],
        [10, 1],
      ],
      format: (value) => `${value} °C`,
    },
    {
      name: 'calm',
      weight: 1,
      select: (features) => features.windMeanKmh,
      curve: [
        [0, 1],
        [10, 0],
      ],
      format: (value) => `${value} km/h`,
    },
  ],
  gates,
});

describe('scoring one day', () => {
  it('is the weighted average of its criteria', () => {
    const score = scoreDay(rules(), day({ tempMeanC: 10, windMeanKmh: 0 }), 0);
    expect(score.score).toBe(100);

    const half = scoreDay(rules(), day({ tempMeanC: 5, windMeanKmh: 5 }), 0);
    expect(half.score).toBe(50);
  });

  it('renormalises the weights when a feature is missing, rather than counting it as zero', () => {
    // Only warmth has data, and it is perfect. Treating the missing criterion as 0
    // would give 50; as 1 would give 100 for data we do not have. Neither is right.
    const score = scoreDay(rules(), day({ tempMeanC: 10 }), 0);

    expect(score.score).toBe(100);
    expect(score.factors).toHaveLength(1);
    expect(score.factors[0]?.name).toBe('warmth');
  });

  it('lowers confidence when a criterion was skipped', () => {
    const complete = scoreDay(rules(), day({ tempMeanC: 5, windMeanKmh: 5 }), 0);
    const partial = scoreDay(rules(), day({ tempMeanC: 5 }), 0);

    expect(partial.confidence).toBeCloseTo(complete.confidence - 0.1, 5);
  });

  it('gives up on a day with no usable feature at all', () => {
    const score = scoreDay(rules(), day(), 0);

    expect(score.suitability).toBe('NOT_APPLICABLE');
    expect(score.score).toBe(0);
    expect(score.factors[0]?.note).toBe('insufficient data');
  });

  it('ignores a feature that is present but not a finite number', () => {
    const score = scoreDay(rules(), day({ tempMeanC: 10, windMeanKmh: Number.NaN }), 0);

    expect(score.score).toBe(100);
    expect(score.factors).toHaveLength(1);
  });
});

describe('gates', () => {
  const halving: Gate = { name: 'halving', apply: () => ({ effect: 0.5, value: 'half' }) };
  const quartering: Gate = { name: 'quartering', apply: () => ({ effect: 0.25, value: 'quarter' }) };
  const silent: Gate = { name: 'silent', apply: () => undefined };

  it('multiply together rather than adding', () => {
    const score = scoreDay(
      rules([halving, quartering]),
      day({ tempMeanC: 10, windMeanKmh: 0 }),
      0,
    );

    expect(score.score).toBe(13); // 100 * 0.5 * 0.25 = 12.5, rounded
  });

  it('a gate that does not fire changes nothing', () => {
    const score = scoreDay(rules([silent]), day({ tempMeanC: 10, windMeanKmh: 0 }), 0);

    expect(score.score).toBe(100);
    expect(score.factors.every((factor) => factor.kind === 'CRITERION')).toBe(true);
  });

  it('only a gate with an effect below one is reported as a factor', () => {
    const neutral: Gate = { name: 'neutral', apply: () => ({ effect: 1, value: 'fine' }) };
    const score = scoreDay(rules([neutral, halving]), day({ tempMeanC: 10, windMeanKmh: 0 }), 0);

    const gates = score.factors.filter((factor) => factor.kind === 'GATE');
    expect(gates.map((factor) => factor.name)).toEqual(['halving']);
  });

  it('can lower confidence when it fires on missing data', () => {
    const unsure: Gate = {
      name: 'unsure',
      apply: () => ({ effect: 0.5, value: 'assumed', confidenceDelta: -0.2 }),
    };
    const score = scoreDay(rules([unsure]), day({ tempMeanC: 10, windMeanKmh: 0 }), 0);

    expect(score.confidence).toBeCloseTo(confidenceForLead(0) - 0.2, 5);
  });

  it('never pushes a score outside [0, 100]', () => {
    const overshoot: Gate = { name: 'overshoot', apply: () => ({ effect: 5 }) };
    const undershoot: Gate = { name: 'undershoot', apply: () => ({ effect: -3 }) };

    expect(scoreDay(rules([overshoot]), day({ tempMeanC: 10, windMeanKmh: 0 }), 0).score).toBe(100);
    expect(scoreDay(rules([undershoot]), day({ tempMeanC: 10, windMeanKmh: 0 }), 0).score).toBe(0);
  });
});

describe('labels', () => {
  it('changes at the documented boundaries, not near them', () => {
    expect(suitabilityOf(80)).toBe('EXCELLENT');
    expect(suitabilityOf(79)).toBe('GOOD');
    expect(suitabilityOf(60)).toBe('GOOD');
    expect(suitabilityOf(59)).toBe('FAIR');
    expect(suitabilityOf(40)).toBe('FAIR');
    expect(suitabilityOf(39)).toBe('POOR');
    expect(suitabilityOf(20)).toBe('POOR');
    expect(suitabilityOf(19)).toBe('UNSUITABLE');
    expect(suitabilityOf(0)).toBe('UNSUITABLE');
  });
});

describe('confidence by lead time', () => {
  it('decays across the week and stops at the last published value', () => {
    expect(confidenceForLead(0)).toBe(0.95);
    expect(confidenceForLead(6)).toBe(0.45);
    expect(confidenceForLead(9)).toBe(0.45);
  });

  it('never drops below the floor, however much is missing', () => {
    const sinking: Gate = { name: 'sinking', apply: () => ({ effect: 0.5, confidenceDelta: -5 }) };
    const score = scoreDay(rules([sinking]), day({ tempMeanC: 10 }), 6);

    expect(score.confidence).toBe(0.2);
  });
});

describe('ranking', () => {
  const scored = (date: string, score: number, confidence = 0.9): ScoredDay => ({
    date,
    score,
    suitability: suitabilityOf(score),
    confidence,
    factors: [],
  });

  it('puts the best day first and numbers from one', () => {
    const ranked = rankDays([scored('2026-09-14', 40), scored('2026-09-15', 90), scored('2026-09-16', 60)]);

    expect(ranked.map((day) => day.date)).toEqual(['2026-09-15', '2026-09-16', '2026-09-14']);
    expect(ranked.map((day) => day.rank)).toEqual([1, 2, 3]);
  });

  it('breaks a tie on confidence, then on the earlier date', () => {
    const ranked = rankDays([
      scored('2026-09-16', 70, 0.5),
      scored('2026-09-15', 70, 0.8),
      scored('2026-09-14', 70, 0.5),
    ]);

    expect(ranked.map((day) => day.date)).toEqual(['2026-09-15', '2026-09-14', '2026-09-16']);
  });

  it('sorts days with no data after every scored day, in date order', () => {
    const blank: ScoredDay = {
      date: '2026-09-14',
      score: 0,
      suitability: 'NOT_APPLICABLE',
      confidence: 0.2,
      factors: [],
    };
    const ranked = rankDays([blank, { ...blank, date: '2026-09-13' }, scored('2026-09-20', 5)]);

    expect(ranked.map((day) => day.date)).toEqual(['2026-09-20', '2026-09-13', '2026-09-14']);
    expect(ranked[0]?.rank).toBe(1);
  });

  it('gives every day a unique rank', () => {
    const ranked = scoreAndRank(rules(), [
      day({ date: '2026-09-14', tempMeanC: 1, windMeanKmh: 1 }),
      day({ date: '2026-09-15', tempMeanC: 1, windMeanKmh: 1 }),
      day({ date: '2026-09-16', tempMeanC: 9, windMeanKmh: 1 }),
    ]);

    expect(new Set(ranked.map((one) => one.rank)).size).toBe(3);
    expect(ranked[0]?.date).toBe('2026-09-16');
  });
});

describe('factor order', () => {
  it('puts the worst gate first, then the criteria that cost the most weight', () => {
    const mild: Gate = { name: 'mild', apply: () => ({ effect: 0.9, value: 'mild' }) };
    const harsh: Gate = { name: 'harsh', apply: () => ({ effect: 0.2, value: 'harsh' }) };

    // warmth is perfect (costs nothing), calm is terrible (costs its whole weight).
    const score = scoreDay(rules([mild, harsh]), day({ tempMeanC: 10, windMeanKmh: 10 }), 0);

    expect(score.factors.map((factor) => factor.name)).toEqual(['harsh', 'mild', 'calm', 'warmth']);
  });

  it('reports every criterion that had data, even a perfect one', () => {
    const score = scoreDay(rules(), day({ tempMeanC: 10, windMeanKmh: 0 }), 0);

    expect(score.factors.map((factor) => factor.name).sort()).toEqual(['calm', 'warmth']);
    expect(score.factors.every((factor) => factor.effect === 1)).toBe(true);
  });

  it('formats a factor value with its unit', () => {
    const score = scoreDay(rules(), day({ tempMeanC: 7, windMeanKmh: 3 }), 0);

    expect(score.factors.map((factor) => factor.value)).toContain('7 °C');
    expect(score.factors.map((factor) => factor.value)).toContain('3 km/h');
  });
});
