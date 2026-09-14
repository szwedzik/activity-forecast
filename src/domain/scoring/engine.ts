/**
 * The scoring engine (D§7.2). Everything activity-specific is data in
 * `activities/`; this file only knows how to combine it.
 *
 * A score is the weighted average of its criteria, renormalised over whichever
 * features are actually present, multiplied by its gates. Criteria express graded
 * preference; gates express "this one thing ruins the day", which an average cannot
 * say because the good parts dilute it (D-011).
 */
import type { Activity, DayFeatures, Window } from '../forecast/types.js';
import type { Curve } from './curve.js';
import { desirability } from './curve.js';

export type Suitability =
  | 'EXCELLENT'
  | 'GOOD'
  | 'FAIR'
  | 'POOR'
  | 'UNSUITABLE'
  | 'NOT_APPLICABLE';

export type FactorKind = 'CRITERION' | 'GATE';

/** Why a score is what it is. Part of the API contract, not decoration (AGENTS.md). */
export interface ScoreFactor {
  readonly name: string;
  readonly kind: FactorKind;
  /** Formatted with its unit and statistic, e.g. "-4.2 °C daytime mean". */
  readonly value: string;
  /** Criterion desirability, or gate multiplier; 0–1. */
  readonly effect: number;
  readonly weight?: number;
  readonly note?: string;
}

/** Reads one number out of a day. A function rather than a key, because two of
 *  surfing's criteria are a fallback and a ratio rather than a stored field (D-014). */
export type FeatureSelector = (features: DayFeatures) => number | undefined;

export interface Criterion {
  readonly name: string;
  readonly weight: number;
  readonly select: FeatureSelector;
  readonly curve: Curve;
  readonly format: (value: number) => string;
}

export interface GateResult {
  /** Multiplier in [0, 1]. */
  readonly effect: number;
  readonly value?: string;
  readonly note?: string;
  /** Gates that fire on missing data say so by lowering confidence. */
  readonly confidenceDelta?: number;
}

export interface Gate {
  readonly name: string;
  /** `undefined` when the gate has nothing to say about this day. */
  readonly apply: (features: DayFeatures) => GateResult | undefined;
}

export interface ActivityRules {
  readonly activity: Activity;
  readonly window: Window;
  readonly criteria: readonly Criterion[];
  readonly gates: readonly Gate[];
}

export interface ScoredDay {
  readonly date: string;
  readonly score: number;
  readonly suitability: Suitability;
  readonly confidence: number;
  readonly factors: readonly ScoreFactor[];
}

export interface RankedDay extends ScoredDay {
  readonly rank: number;
}

/** Reported, never folded into the score (D§7.2). */
const LEAD_CONFIDENCE = [0.95, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45] as const;
const MISSING_DATA_PENALTY = 0.1;
const MIN_CONFIDENCE = 0.2;

const LABELS: readonly (readonly [min: number, label: Suitability])[] = [
  [80, 'EXCELLENT'],
  [60, 'GOOD'],
  [40, 'FAIR'],
  [20, 'POOR'],
];

export function suitabilityOf(score: number): Suitability {
  for (const [min, label] of LABELS) if (score >= min) return label;
  return 'UNSUITABLE';
}

export function confidenceForLead(leadDay: number): number {
  const last = LEAD_CONFIDENCE[LEAD_CONFIDENCE.length - 1] ?? MIN_CONFIDENCE;
  return LEAD_CONFIDENCE[leadDay] ?? last;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function usable(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

/** A day with no forecast at all: scored zero and labelled, never guessed at. */
function withoutData(date: string): ScoredDay {
  return {
    date,
    score: 0,
    suitability: 'NOT_APPLICABLE',
    confidence: MIN_CONFIDENCE,
    factors: [
      {
        name: 'data',
        kind: 'GATE',
        value: 'no forecast data for this day',
        effect: 0,
        note: 'insufficient data',
      },
    ],
  };
}

/**
 * Factor order is the explanation order: gates first, worst gate first, then criteria by
 * how much weight they actually cost. The first factor is always the biggest reason the
 * score is not 100 (D§7.2).
 */
function orderFactors(gates: ScoreFactor[], criteria: ScoreFactor[]): ScoreFactor[] {
  const byEffect = [...gates].sort((a, b) => a.effect - b.effect);
  const byCost = [...criteria].sort(
    (a, b) => (b.weight ?? 0) * (1 - b.effect) - (a.weight ?? 0) * (1 - a.effect),
  );
  return [...byEffect, ...byCost];
}

export function scoreDay(rules: ActivityRules, features: DayFeatures, leadDay: number): ScoredDay {
  const criterionFactors: ScoreFactor[] = [];
  let weighted = 0;
  let totalWeight = 0;
  let skipped = 0;

  for (const criterion of rules.criteria) {
    const value = criterion.select(features);
    if (!usable(value)) {
      skipped += 1;
      continue;
    }
    const effect = desirability(criterion.curve, value);
    weighted += criterion.weight * effect;
    totalWeight += criterion.weight;
    criterionFactors.push({
      name: criterion.name,
      kind: 'CRITERION',
      value: criterion.format(value),
      effect,
      weight: criterion.weight,
    });
  }

  if (totalWeight === 0) return withoutData(features.date);

  const gateFactors: ScoreFactor[] = [];
  let gateProduct = 1;
  let confidenceDelta = 0;

  for (const gate of rules.gates) {
    const result = gate.apply(features);
    if (result === undefined) continue;
    gateProduct *= clamp(result.effect, 0, 1);
    confidenceDelta += result.confidenceDelta ?? 0;
    if (result.effect < 1) {
      gateFactors.push({
        name: gate.name,
        kind: 'GATE',
        value: result.value ?? '',
        effect: clamp(result.effect, 0, 1),
        ...(result.note === undefined ? {} : { note: result.note }),
      });
    }
  }

  const score = Math.round(100 * (weighted / totalWeight) * gateProduct);
  const confidence =
    clamp(
      confidenceForLead(leadDay) - (skipped > 0 ? MISSING_DATA_PENALTY : 0) + confidenceDelta,
      MIN_CONFIDENCE,
      1,
    );

  return {
    date: features.date,
    score: clamp(score, 0, 100),
    suitability: suitabilityOf(clamp(score, 0, 100)),
    confidence: Math.round(confidence * 100) / 100,
    factors: orderFactors(gateFactors, criterionFactors),
  };
}

/**
 * Best day first: score, then confidence, then date. Days with no data at all sort
 * after every scored day, in date order, since "we cannot say" is not a ranking
 * (D§7.2, D-012).
 */
export function rankDays(days: readonly ScoredDay[]): RankedDay[] {
  const scored = days.filter((day) => day.suitability !== 'NOT_APPLICABLE');
  const unscored = days.filter((day) => day.suitability === 'NOT_APPLICABLE');

  scored.sort(
    (a, b) =>
      b.score - a.score || b.confidence - a.confidence || a.date.localeCompare(b.date),
  );
  unscored.sort((a, b) => a.date.localeCompare(b.date));

  return [...scored, ...unscored].map((day, index) => ({ ...day, rank: index + 1 }));
}

/** Every day scored and ranked for one activity. */
export function scoreAndRank(
  rules: ActivityRules,
  days: readonly DayFeatures[],
): RankedDay[] {
  return rankDays(days.map((features, lead) => scoreDay(rules, features, lead)));
}
