/**
 * Outdoor sightseeing, judged over a touring day, 09:00–18:00 local (D§7.5).
 * Rain at three in the morning does not spoil anything.
 */
import { describeWeatherCode, hasFreezingPrecipitation, hasThunderstorm } from '../../forecast/weatherCodes.js';
import type { ActivityRules } from '../engine.js';
import { celsius, centimetres, curveGate, fraction, hours, kmh, millimetres, percent, visibility } from './shared.js';

export const outdoorSightseeing: ActivityRules = {
  activity: 'OUTDOOR_SIGHTSEEING',
  window: { kind: 'hours', fromHour: 9, toHour: 18 },

  gates: [
    {
      name: 'severe',
      apply: (features) => {
        const value = describeWeatherCode(features.worstWeatherCode);
        if (hasThunderstorm(features.weatherCodes)) return { effect: 0.15, value };
        if (hasFreezingPrecipitation(features.weatherCodes)) return { effect: 0.3, value };
        return undefined;
      },
    },
    curveGate(
      'dangerousWind',
      (features) => features.gustMaxKmh,
      [
        [70, 1],
        [90, 0.4],
        [110, 0.1],
      ],
      (value) => `${kmh(value)} gusts`,
    ),
    curveGate(
      'extremeHeat',
      (features) => features.apparentMaxC,
      [
        [38, 1],
        [42, 0.5],
        [46, 0.2],
      ],
      (value) => `${celsius(value)} feels like at the peak`,
    ),
    curveGate(
      // There is nothing to see.
      'fog',
      (features) => features.visibilityMinM,
      [
        [200, 0.6],
        [1000, 1],
      ],
      (value) => `${visibility(value)} visibility`,
    ),
    // Hours of rain dominate a touring day; as a criterion alone, six hours of it still
    // scored FAIR because the temperature and wind were pleasant (D-011).
    curveGate(
      'washout',
      (features) => features.precipHours,
      [
        [2, 1],
        [4, 0.7],
        [6, 0.4],
        [9, 0.2],
      ],
      (value) => `${hours(value)} of rain`,
    ),
  ],

  criteria: [
    {
      name: 'rainHours',
      weight: 4,
      select: (features) => features.precipHours,
      curve: [
        [0, 1],
        [1, 0.8],
        [2, 0.6],
        [4, 0.3],
        [6, 0.1],
        [9, 0],
      ],
      format: (value) => `${hours(value)} of rain in the window`,
    },
    {
      // Tells drizzle from a downpour, which hours alone cannot.
      name: 'rainAmount',
      weight: 1,
      select: (features) => features.precipMm,
      curve: [
        [0, 1],
        [1, 0.9],
        [5, 0.6],
        [15, 0.2],
        [30, 0],
      ],
      format: (value) => `${millimetres(value)} total`,
    },
    {
      // A 70 % chance matters even when the deterministic run comes out dry.
      name: 'rainRisk',
      weight: 2,
      select: (features) => features.precipProbMean,
      curve: [
        [0, 1],
        [20, 0.9],
        [40, 0.7],
        [60, 0.4],
        [80, 0.15],
        [100, 0],
      ],
      format: (value) => `${percent(value)} mean chance of rain`,
    },
    {
      name: 'temperature',
      weight: 3,
      select: (features) => features.apparentMeanC,
      curve: [
        [-10, 0],
        [0, 0.3],
        [8, 0.6],
        [14, 0.9],
        [18, 1],
        [26, 1],
        [30, 0.75],
        [34, 0.4],
        [38, 0.1],
      ],
      format: (value) => `${celsius(value)} feels like`,
    },
    {
      name: 'wind',
      weight: 2,
      select: (features) => features.windMeanKmh,
      curve: [
        [0, 1],
        [15, 1],
        [25, 0.8],
        [35, 0.5],
        [50, 0.2],
        [65, 0],
      ],
      format: (value) => `${kmh(value)} mean wind`,
    },
    {
      // Sun is nicer, but overcast is still a perfectly good day out, so this stays mild.
      name: 'sky',
      weight: 2,
      select: (features) => features.sunshineFraction,
      curve: [
        [0, 0.5],
        [0.3, 0.7],
        [0.6, 0.9],
        [1, 1],
      ],
      format: (value) => `${fraction(value)} of daylight is sunshine`,
    },
    {
      name: 'snow',
      weight: 1,
      select: (features) => features.snowfallCm,
      curve: [
        [0, 1],
        [2, 0.7],
        [8, 0.3],
        [20, 0],
      ],
      format: (value) => `${centimetres(value)} falling snow`,
    },
  ],
};
