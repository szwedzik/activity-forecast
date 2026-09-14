/** The activity registry: which rules and which window belong to each activity. */
import type { Activity, Window } from '../../forecast/types.js';
import type { ActivityRules } from '../engine.js';
import { outdoorSightseeing } from './outdoorSightseeing.js';
import { skiing } from './skiing.js';
import { surfing } from './surfing.js';

export { deriveIndoorDay } from './indoorSightseeing.js';
export { outdoorSightseeing, skiing, surfing };

/** Indoor sightseeing is absent on purpose: it is derived from outdoor, not scored (D§7.6). */
export type ScoredActivity = 'SKIING' | 'SURFING' | 'OUTDOOR_SIGHTSEEING';

export const RULES: Readonly<Record<ScoredActivity, ActivityRules>> = {
  SKIING: skiing,
  SURFING: surfing,
  OUTDOOR_SIGHTSEEING: outdoorSightseeing,
};

/** Indoor shares the outdoor window, because that is the day it is compared against. */
export const WINDOWS: Readonly<Record<Activity, Window>> = {
  SKIING: skiing.window,
  SURFING: surfing.window,
  OUTDOOR_SIGHTSEEING: outdoorSightseeing.window,
  INDOOR_SIGHTSEEING: outdoorSightseeing.window,
};

export function windowFor(activity: Activity): Window {
  return WINDOWS[activity];
}
