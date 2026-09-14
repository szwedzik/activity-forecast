/**
 * WMO weather codes (D§2.4): a human summary and a severity rank per code.
 *
 * Severity orders "the worst thing that happened in this window", and follows the
 * design: thunderstorm > freezing precipitation > heavy > moderate > light, showers
 * and drizzle > fog > cloud > clear. It is a ranking, not a scale; only the order
 * between two codes is meaningful.
 */

interface WeatherCode {
  readonly summary: string;
  readonly severity: number;
}

const CODES: ReadonlyMap<number, WeatherCode> = new Map([
  [0, { summary: 'Clear sky', severity: 0 }],
  [1, { summary: 'Mainly clear', severity: 1 }],
  [2, { summary: 'Partly cloudy', severity: 2 }],
  [3, { summary: 'Overcast', severity: 2 }],
  [45, { summary: 'Fog', severity: 3 }],
  [48, { summary: 'Freezing fog', severity: 3 }],
  [51, { summary: 'Light drizzle', severity: 4 }],
  [53, { summary: 'Drizzle', severity: 4 }],
  [55, { summary: 'Heavy drizzle', severity: 4 }],
  [56, { summary: 'Light freezing drizzle', severity: 8 }],
  [57, { summary: 'Freezing drizzle', severity: 8 }],
  [61, { summary: 'Light rain', severity: 4 }],
  [63, { summary: 'Rain', severity: 5 }],
  [65, { summary: 'Heavy rain', severity: 6 }],
  [66, { summary: 'Light freezing rain', severity: 8 }],
  [67, { summary: 'Freezing rain', severity: 8 }],
  [71, { summary: 'Light snow', severity: 4 }],
  [73, { summary: 'Snow', severity: 5 }],
  [75, { summary: 'Heavy snow', severity: 6 }],
  [77, { summary: 'Snow grains', severity: 4 }],
  [80, { summary: 'Light rain showers', severity: 4 }],
  [81, { summary: 'Rain showers', severity: 5 }],
  [82, { summary: 'Violent rain showers', severity: 6 }],
  [85, { summary: 'Light snow showers', severity: 4 }],
  [86, { summary: 'Heavy snow showers', severity: 6 }],
  [95, { summary: 'Thunderstorm', severity: 9 }],
  [96, { summary: 'Thunderstorm with hail', severity: 10 }],
  [99, { summary: 'Thunderstorm with heavy hail', severity: 10 }],
]);

const THUNDERSTORM = new Set([95, 96, 99]);
const FREEZING = new Set([56, 57, 66, 67]);
const HEAVY_SNOW = new Set([75, 86]);

export function describeWeatherCode(code: number | undefined): string {
  if (code === undefined) return 'Unknown';
  return CODES.get(code)?.summary ?? `Weather code ${code}`;
}

/** Unknown codes rank as mild rather than catastrophic: guessing upwards would gate days off for no reason. */
export function severityOf(code: number): number {
  return CODES.get(code)?.severity ?? 0;
}

/** The most severe code in a window, ties going to the lower code for stability. */
export function worstWeatherCode(codes: Iterable<number>): number | undefined {
  let worst: number | undefined;
  let worstSeverity = -1;
  for (const code of codes) {
    const severity = severityOf(code);
    if (severity > worstSeverity || (severity === worstSeverity && worst !== undefined && code < worst)) {
      worst = code;
      worstSeverity = severity;
    }
  }
  return worst;
}

export const isThunderstorm = (code: number): boolean => THUNDERSTORM.has(code);
export const isFreezingPrecipitation = (code: number): boolean => FREEZING.has(code);
export const isHeavySnow = (code: number): boolean => HEAVY_SNOW.has(code);

export const hasThunderstorm = (codes: readonly number[]): boolean => codes.some(isThunderstorm);
export const hasFreezingPrecipitation = (codes: readonly number[]): boolean =>
  codes.some(isFreezingPrecipitation);
export const hasHeavySnow = (codes: readonly number[]): boolean => codes.some(isHeavySnow);
