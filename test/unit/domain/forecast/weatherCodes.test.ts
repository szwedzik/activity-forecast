import { describe, expect, it } from 'vitest';

import {
  describeWeatherCode,
  hasFreezingPrecipitation,
  hasHeavySnow,
  hasThunderstorm,
  severityOf,
  worstWeatherCode,
} from '../../../../src/domain/forecast/weatherCodes.js';

describe('describeWeatherCode', () => {
  it('names the codes we key behaviour off', () => {
    expect(describeWeatherCode(0)).toBe('Clear sky');
    expect(describeWeatherCode(61)).toBe('Light rain');
    expect(describeWeatherCode(95)).toBe('Thunderstorm');
  });

  it('does not pretend to know an unlisted code', () => {
    expect(describeWeatherCode(42)).toBe('Weather code 42');
    expect(describeWeatherCode(undefined)).toBe('Unknown');
  });
});

describe('severity order (D§2.4)', () => {
  it('ranks thunderstorm above freezing above heavy above moderate above light', () => {
    expect(severityOf(95)).toBeGreaterThan(severityOf(66));
    expect(severityOf(66)).toBeGreaterThan(severityOf(65));
    expect(severityOf(65)).toBeGreaterThan(severityOf(63));
    expect(severityOf(63)).toBeGreaterThan(severityOf(61));
  });

  it('ranks precipitation above fog above cloud above clear', () => {
    expect(severityOf(61)).toBeGreaterThan(severityOf(45));
    expect(severityOf(45)).toBeGreaterThan(severityOf(3));
    expect(severityOf(3)).toBeGreaterThan(severityOf(0));
  });

  it('treats an unknown code as mild rather than guessing upwards', () => {
    expect(severityOf(42)).toBe(0);
  });
});

describe('worstWeatherCode', () => {
  it('picks the most severe code in the window', () => {
    expect(worstWeatherCode([0, 3, 61, 95])).toBe(95);
    expect(worstWeatherCode([3, 45, 2])).toBe(45);
    expect(worstWeatherCode([0])).toBe(0);
  });

  it('breaks a severity tie on the lower code, so the answer is stable', () => {
    expect(worstWeatherCode([80, 61])).toBe(61);
    expect(worstWeatherCode([61, 80])).toBe(61);
  });

  it('has no answer for an empty window', () => {
    expect(worstWeatherCode([])).toBeUndefined();
  });
});

describe('code groups the gates use', () => {
  it('spots a thunderstorm anywhere in the window', () => {
    expect(hasThunderstorm([0, 3, 96])).toBe(true);
    expect(hasThunderstorm([0, 3, 65])).toBe(false);
  });

  it('spots freezing precipitation', () => {
    expect(hasFreezingPrecipitation([56])).toBe(true);
    expect(hasFreezingPrecipitation([67])).toBe(true);
    expect(hasFreezingPrecipitation([65, 75])).toBe(false);
  });

  it('spots heavy snow', () => {
    expect(hasHeavySnow([75])).toBe(true);
    expect(hasHeavySnow([86])).toBe(true);
    expect(hasHeavySnow([71, 73])).toBe(false);
  });
});
