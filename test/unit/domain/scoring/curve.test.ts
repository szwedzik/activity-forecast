import { describe, expect, it } from 'vitest';

import { desirability, isValidCurve } from '../../../../src/domain/scoring/curve.js';
import type { Curve } from '../../../../src/domain/scoring/curve.js';

const RAMP: Curve = [
  [0, 0],
  [10, 1],
];

const HILL: Curve = [
  [0, 0],
  [5, 1],
  [10, 1],
  [20, 0.5],
];

describe('desirability', () => {
  it('returns the y of a point exactly on it', () => {
    expect(desirability(HILL, 0)).toBe(0);
    expect(desirability(HILL, 5)).toBe(1);
    expect(desirability(HILL, 10)).toBe(1);
    expect(desirability(HILL, 20)).toBe(0.5);
  });

  it('interpolates linearly between points', () => {
    expect(desirability(RAMP, 5)).toBeCloseTo(0.5, 10);
    expect(desirability(RAMP, 2.5)).toBeCloseTo(0.25, 10);
    expect(desirability(HILL, 15)).toBeCloseTo(0.75, 10);
  });

  it('holds flat between two points of equal height', () => {
    expect(desirability(HILL, 7)).toBe(1);
  });

  it('clamps below the first point and above the last', () => {
    expect(desirability(RAMP, -100)).toBe(0);
    expect(desirability(RAMP, 1000)).toBe(1);
    expect(desirability(HILL, -1)).toBe(0);
    expect(desirability(HILL, 99)).toBe(0.5);
  });

  it('works for a one-point curve, which is a constant', () => {
    expect(desirability([[3, 0.4]], -10)).toBe(0.4);
    expect(desirability([[3, 0.4]], 3)).toBe(0.4);
    expect(desirability([[3, 0.4]], 99)).toBe(0.4);
  });

  it('refuses an empty curve rather than inventing a value', () => {
    expect(() => desirability([], 1)).toThrow(RangeError);
  });
});

describe('isValidCurve', () => {
  it('accepts a sorted curve whose values are fractions', () => {
    expect(isValidCurve(RAMP)).toBe(true);
    expect(isValidCurve(HILL)).toBe(true);
  });

  it('rejects unsorted or repeated x values', () => {
    expect(
      isValidCurve([
        [10, 0],
        [5, 1],
      ]),
    ).toBe(false);
    expect(
      isValidCurve([
        [5, 0],
        [5, 1],
      ]),
    ).toBe(false);
  });

  it('rejects a y outside [0, 1]', () => {
    expect(
      isValidCurve([
        [0, 0],
        [1, 1.5],
      ]),
    ).toBe(false);
    expect(
      isValidCurve([
        [0, -0.2],
        [1, 1],
      ]),
    ).toBe(false);
  });

  it('rejects an empty curve', () => {
    expect(isValidCurve([])).toBe(false);
  });
});
