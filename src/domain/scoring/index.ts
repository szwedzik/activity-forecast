/**
 * The domain's scoring entry point: forecast payloads in, ranked days out.
 * Pure — the caller decides which local date is "today" (D§4.1).
 */
import { extractDayFeatures, RANKED_DAYS } from '../forecast/features.js';
import type { Activity, DayFeatures, ForecastData, Window } from '../forecast/types.js';
import { ACTIVITIES } from '../forecast/types.js';
import { deriveIndoorDay, RULES, windowFor } from './activities/index.js';
import type { RankedDay } from './engine.js';
import { rankDays, scoreAndRank, scoreDay } from './engine.js';

export interface ActivityRanking {
  readonly activity: Activity;
  /** False when the activity cannot be judged here at all, such as surfing inland. */
  readonly applicable: boolean;
  readonly note?: string;
  /** Best day first, or date order when the activity is not applicable. */
  readonly days: readonly RankedDay[];
}

export interface RankOptions {
  /**
   * Set by the caller when it already knows surfing cannot be assessed, so the response
   * can say why: no coverage at all, or a marine outage right now (D§6.4).
   */
  readonly surfingUnavailableNote?: string | undefined;
}

const NO_WAVE_MODEL =
  "No wave-model coverage nearby; Open-Meteo's marine grid returns no data for inland locations.";

/** Uniform shape for an activity we cannot judge: every day listed, in date order, scored zero. */
function notApplicable(
  activity: Activity,
  days: readonly DayFeatures[],
  note: string,
): ActivityRanking {
  return {
    activity,
    applicable: false,
    note,
    days: [...days]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((features, index) => ({
        date: features.date,
        rank: index + 1,
        score: 0,
        suitability: 'NOT_APPLICABLE' as const,
        confidence: 0.2,
        factors: [],
      })),
  };
}

/** Surfing needs a sea. Inland, every marine value comes back null (D§2.3). */
function hasWaveData(days: readonly DayFeatures[]): boolean {
  return days.some((day) => day.waveHeightMeanM !== undefined);
}

export function rankActivity(
  activity: Activity,
  days: readonly DayFeatures[],
  options: RankOptions = {},
): ActivityRanking {
  if (activity === 'SURFING') {
    const note = options.surfingUnavailableNote;
    if (note !== undefined) return notApplicable(activity, days, note);
    if (!hasWaveData(days)) return notApplicable(activity, days, NO_WAVE_MODEL);
  }

  if (activity === 'INDOOR_SIGHTSEEING') {
    const outdoor = days.map((features, lead) => scoreDay(RULES.OUTDOOR_SIGHTSEEING, features, lead));
    const indoor = outdoor.map((day, index) => {
      const features = days[index];
      return features === undefined ? day : deriveIndoorDay(day, features);
    });
    return { activity, applicable: true, days: rankDays(indoor) };
  }

  return { activity, applicable: true, days: scoreAndRank(RULES[activity], days) };
}

/**
 * Rank several activities over the same forecast. Each has its own window, so features
 * are extracted per window and shared where two activities agree (indoor and outdoor do).
 */
export function rankActivities(
  data: ForecastData,
  todayLocal: string,
  activities: readonly Activity[] = ACTIVITIES,
  options: RankOptions = {},
  days: number = RANKED_DAYS,
): ActivityRanking[] {
  const cache = new Map<string, DayFeatures[]>();
  const featuresFor = (window: Window): DayFeatures[] => {
    const key = JSON.stringify(window);
    const cached = cache.get(key);
    if (cached) return cached;
    const extracted = extractDayFeatures(data, todayLocal, window, days);
    cache.set(key, extracted);
    return extracted;
  };

  return activities.map((activity) =>
    rankActivity(activity, featuresFor(windowFor(activity)), options),
  );
}

export { windowFor } from './activities/index.js';
export type { RankedDay, ScoreFactor, ScoredDay, Suitability } from './engine.js';
