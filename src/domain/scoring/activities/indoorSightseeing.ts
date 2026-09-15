/**
 * Indoor sightseeing, derived from the outdoor score for the same day (D§7.6).
 *
 * Weather does not reach a museum. What it changes is whether you would rather be
 * outside, and whether getting between venues is unpleasant. So the score has a high
 * floor, rises as the outdoor day gets worse, and is only pulled down when travel is
 * genuinely hard. The result is close to the mirror image of the outdoor ranking, which
 * is exactly the planning signal: do the galleries on the wet day.
 *
 * Venue opening days and hours matter more than any of this and are out of scope (Q5).
 */
import type { DayFeatures } from '../../forecast/types.js';
import { hasHeavySnow, hasThunderstorm } from '../../forecast/weatherCodes.js';
import type { ScoreFactor, ScoredDay } from '../engine.js';
import { suitabilityOf } from '../engine.js';

/** A perfect day outside still leaves the museums open, but you would be missing it. */
const FLOOR = 0.55;
const RANGE = 0.45;

interface TravelPenalty {
  readonly effect: number;
  readonly value: string;
}

/**
 * The worst single reason moving between venues is hard, not the product of all of them:
 * a blizzard with high gusts is one bad journey, not two.
 */
function travelGate(features: DayFeatures): TravelPenalty | undefined {
  const gusts = features.gustMaxKmh;
  const snow = features.snowfallDayCm;
  const apparentMean = features.apparentMeanC;
  const apparentMax = features.apparentMaxC;

  const penalties: TravelPenalty[] = [];

  if (gusts !== undefined && gusts >= 100) {
    penalties.push({ effect: 0.6, value: `${Math.round(gusts)} km/h gusts` });
  }
  const blizzardSnow = snow !== undefined && snow >= 15 && gusts !== undefined && gusts >= 50;
  const blizzardCodes = hasHeavySnow(features.weatherCodes) && gusts !== undefined && gusts >= 50;
  if (blizzardSnow || blizzardCodes) {
    penalties.push({ effect: 0.7, value: 'blizzard conditions between venues' });
  }
  if (apparentMean !== undefined && apparentMean <= -25) {
    penalties.push({ effect: 0.75, value: `${apparentMean.toFixed(1)} °C feels like` });
  }
  if (apparentMax !== undefined && apparentMax >= 42) {
    penalties.push({ effect: 0.85, value: `${apparentMax.toFixed(1)} °C feels like at the peak` });
  }
  if (hasThunderstorm(features.weatherCodes)) {
    penalties.push({ effect: 0.9, value: 'thunderstorm' });
  }

  return penalties.sort((a, b) => a.effect - b.effect)[0];
}

/** Turns an already-scored outdoor day into the indoor day for the same date. */
export function deriveIndoorDay(outdoor: ScoredDay, features: DayFeatures): ScoredDay {
  if (outdoor.suitability === 'NOT_APPLICABLE') return { ...outdoor };

  const opportunity = 1 - outdoor.score / 100;
  const travel = travelGate(features);
  // Published as the factor's effect, so the one criterion and the gate multiply back to
  // the score exactly the way every other activity's do (D-031). Rounded before the score
  // is taken from it, not after, so the number shipped is the number used.
  const desirability = Math.round((FLOOR + RANGE * opportunity) * 10_000) / 10_000;
  const score = Math.round(100 * desirability * (travel?.effect ?? 1));

  const factors: ScoreFactor[] = [
    {
      name: 'outdoorConditions',
      kind: 'CRITERION',
      value: `outdoor score ${outdoor.score}`,
      effect: desirability,
      weight: 1,
      note:
        outdoor.score <= 40
          ? 'a strong case for an indoor day'
          : outdoor.score >= 80
            ? 'a fine day to be outside instead'
            : 'either would work',
    },
  ];
  if (travel) {
    factors.unshift({
      name: 'travel',
      kind: 'GATE',
      value: travel.value,
      effect: travel.effect,
      note: 'getting between venues is hard',
    });
  }

  return {
    date: outdoor.date,
    score,
    suitability: suitabilityOf(score),
    confidence: outdoor.confidence,
    factors,
  };
}
