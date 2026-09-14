/**
 * Skiing, judged over lift hours, 09:00–16:00 local (D§7.3).
 *
 * Conditions are read at the town's own grid cell, so for a valley resort this is the
 * valley floor and not the pistes above it (Q4). Curves and weights are the design's
 * tables verbatim; changing one is a decision, not an edit (D-011).
 */
import { describeWeatherCode, hasFreezingPrecipitation, hasThunderstorm } from '../../forecast/weatherCodes.js';
import type { Curve } from '../curve.js';
import { desirability } from '../curve.js';
import type { ActivityRules } from '../engine.js';
import { centimetres, celsius, curveGate, kmh, millimetres, percent, visibility } from './shared.js';

/** Bare ground below 2 cm; a workable base by 30 cm. */
const SNOW_COVER: Curve = [
  [0.02, 0],
  [0.1, 0.5],
  [0.3, 1],
];

export const skiing: ActivityRules = {
  activity: 'SKIING',
  window: { kind: 'hours', fromHour: 9, toHour: 16 },

  gates: [
    {
      // The one gate that speaks up when its feature is missing: without snow depth we
      // cannot tell a resort from a meadow, so we hedge and say the score is less certain.
      name: 'snowCover',
      apply: (features) => {
        const depth = features.snowDepthMaxM;
        if (depth === undefined) {
          return {
            effect: 0.5,
            value: 'snow depth not reported',
            note: 'this model does not provide snow depth here',
            confidenceDelta: -0.2,
          };
        }
        return {
          effect: desirability(SNOW_COVER, depth),
          value: `${Math.round(depth * 100)} cm snow depth`,
        };
      },
    },
    curveGate(
      'liftWind',
      (features) => features.gustMaxKmh,
      [
        [50, 1],
        [80, 0.2],
        [100, 0],
      ],
      (value) => `${kmh(value)} gusts`,
    ),
    {
      name: 'severe',
      apply: (features) => {
        const value = describeWeatherCode(features.worstWeatherCode);
        if (hasThunderstorm(features.weatherCodes)) return { effect: 0.1, value };
        if (hasFreezingPrecipitation(features.weatherCodes)) return { effect: 0.3, value };
        return undefined;
      },
    },
    // Rain ruins the surface however good everything else is; as a criterion alone it
    // was diluted into a GOOD day (D-011).
    curveGate(
      'rainOnSnow',
      (features) => features.rainMm,
      [
        [0.5, 1],
        [3, 0.5],
        [8, 0.25],
      ],
      (value) => `${millimetres(value)} rain on snow`,
    ),
    curveGate(
      'whiteout',
      (features) => features.visibilityMinM,
      [
        [100, 0.2],
        [500, 0.6],
        [1000, 1],
      ],
      (value) => `${visibility(value)} visibility`,
    ),
  ],

  criteria: [
    {
      name: 'temperature',
      weight: 3,
      select: (features) => features.tempMeanC,
      curve: [
        [-25, 0],
        [-15, 0.7],
        [-10, 1],
        [-2, 1],
        [2, 0.6],
        [6, 0.2],
        [10, 0],
      ],
      format: (value) => `${celsius(value)} daytime mean`,
    },
    {
      name: 'freshSnow',
      weight: 1,
      select: (features) => features.snowfallDayCm,
      curve: [
        [0, 0.5],
        [3, 0.7],
        [10, 1],
        [25, 0.8],
        [40, 0.4],
      ],
      format: (value) => `${centimetres(value)} new snow`,
    },
    {
      name: 'wind',
      weight: 2,
      select: (features) => features.windMeanKmh,
      curve: [
        [0, 1],
        [15, 1],
        [30, 0.6],
        [45, 0.25],
        [60, 0],
      ],
      format: (value) => `${kmh(value)} mean wind`,
    },
    {
      name: 'visibility',
      weight: 2,
      select: (features) => features.visibilityMinM,
      curve: [
        [100, 0],
        [500, 0.3],
        [1000, 0.5],
        [3000, 0.8],
        [8000, 1],
      ],
      format: (value) => `${visibility(value)} minimum`,
    },
    {
      name: 'sky',
      weight: 1,
      select: (features) => features.cloudMeanPct,
      curve: [
        [0, 1],
        [40, 0.9],
        [80, 0.6],
        [100, 0.4],
      ],
      format: (value) => `${percent(value)} mean cloud`,
    },
    {
      name: 'rain',
      weight: 2,
      select: (features) => features.rainMm,
      curve: [
        [0, 1],
        [0.5, 0.7],
        [2, 0.3],
        [5, 0],
      ],
      format: (value) => `${millimetres(value)} rain`,
    },
  ],
};
