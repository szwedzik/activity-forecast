/**
 * Surfing, judged over daylight hours (D§7.4).
 *
 * Wind direction relative to the shore is the thing every surfer asks about and the one
 * thing we cannot know: Open-Meteo has no coastline model, so only wind speed counts.
 * Stated as a limitation rather than guessed at (Q4).
 */
import { describeWeatherCode, hasThunderstorm } from '../../forecast/weatherCodes.js';
import type { ActivityRules } from '../engine.js';
import { celsius, curveGate, fraction, hours, kmh, metres, seconds } from './shared.js';

export const surfing: ActivityRules = {
  activity: 'SURFING',

  // The sea is the activity. Wave models run out before weather models do, so a location
  // can have waves for three days and nothing after, and those later days must not be
  // scored on how pleasant the air is (D-030).
  applicable: (features) =>
    features.waveHeightMeanM === undefined ? 'no wave data for this day' : undefined,

  // Daylight varies enormously with latitude and season; a fixed window would judge a
  // Norwegian December against a Portuguese June. Polar night falls back to 06:00–18:00.
  window: { kind: 'daylight', fallbackFromHour: 6, fallbackToHour: 18 },

  gates: [
    // Softened on 2026-09-12: with the original gate a 0.6 m day scored GOOD because the
    // comfort criteria padded it. Small waves now cap the day (D-011).
    curveGate(
      'flat',
      (features) => features.waveHeightMeanM,
      [
        [0.2, 0],
        [0.4, 0.5],
        [0.7, 1],
      ],
      (value) => `${metres(value)} mean wave height`,
    ),
    curveGate(
      'dangerous',
      (features) => features.waveHeightMaxM,
      [
        [3.5, 1],
        [5, 0.3],
        [6, 0],
      ],
      (value) => `${metres(value)} peak wave height`,
    ),
    curveGate(
      'storm',
      (features) => features.gustMaxKmh,
      [
        [60, 1],
        [90, 0],
      ],
      (value) => `${kmh(value)} gusts`,
    ),
    {
      // Lightning on open water, with no way to get out quickly.
      name: 'severe',
      apply: (features) =>
        hasThunderstorm(features.weatherCodes)
          ? { effect: 0.05, value: describeWeatherCode(features.worstWeatherCode) }
          : undefined,
    },
  ],

  criteria: [
    {
      name: 'waveHeight',
      weight: 4,
      select: (features) => features.waveHeightMeanM,
      curve: [
        [0.3, 0.2],
        [0.6, 0.5],
        [1.0, 0.9],
        [1.5, 1],
        [2.5, 1],
        [3.0, 0.7],
        [4.0, 0.3],
      ],
      format: (value) => `${metres(value)} mean wave height`,
    },
    {
      // Groundswell period, falling back to the whole sea state when the model splits
      // out no swell. A plain field name cannot express that (D-014).
      name: 'period',
      weight: 3,
      select: (features) => features.swellPeriodMeanS ?? features.wavePeriodMeanS,
      curve: [
        [4, 0],
        [6, 0.3],
        [8, 0.6],
        [10, 0.85],
        [12, 1],
        [16, 1],
        [20, 0.9],
      ],
      format: (value) => `${seconds(value)} mean period`,
    },
    {
      name: 'wind',
      weight: 3,
      select: (features) => features.windMeanKmh,
      curve: [
        [0, 1],
        [10, 1],
        [20, 0.7],
        [30, 0.4],
        [45, 0.1],
        [60, 0],
      ],
      format: (value) => `${kmh(value)} mean wind`,
    },
    {
      // How much of the sea state is local chop rather than swell: a ratio, not a field.
      name: 'cleanliness',
      weight: 1,
      select: (features) => {
        const { windWaveHeightMeanM, waveHeightMeanM } = features;
        if (windWaveHeightMeanM === undefined || waveHeightMeanM === undefined) return undefined;
        if (waveHeightMeanM <= 0) return undefined;
        return windWaveHeightMeanM / waveHeightMeanM;
      },
      curve: [
        [0.2, 1],
        [0.5, 0.7],
        [0.8, 0.4],
        [1, 0.2],
      ],
      format: (value) => `${fraction(value)} of the sea state is local chop`,
    },
    {
      name: 'waterTemp',
      weight: 1,
      select: (features) => features.seaSurfaceTempC,
      curve: [
        [6, 0.2],
        [12, 0.6],
        [16, 0.85],
        [20, 1],
        [30, 1],
      ],
      format: (value) => `${celsius(value)} sea surface`,
    },
    {
      name: 'airComfort',
      weight: 1,
      select: (features) => features.apparentMeanC,
      curve: [
        [0, 0.2],
        [10, 0.6],
        [18, 1],
        [32, 1],
        [38, 0.6],
      ],
      format: (value) => `${celsius(value)} feels like`,
    },
    {
      // You are already wet.
      name: 'rain',
      weight: 0.5,
      select: (features) => features.precipHours,
      curve: [
        [0, 1],
        [3, 0.8],
        [8, 0.5],
      ],
      format: (value) => `${hours(value)} of rain`,
    },
  ],
};
