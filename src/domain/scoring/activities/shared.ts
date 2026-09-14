/** Helpers shared by the activity rule tables: gate construction and factor formatting. */
import type { DayFeatures } from '../../forecast/types.js';
import type { Curve } from '../curve.js';
import { desirability } from '../curve.js';
import type { FeatureSelector, Gate } from '../engine.js';

/**
 * A gate whose multiplier comes from a curve over one feature. It stays silent when
 * the feature is missing: a gate that fired on absent data would punish a gap in the
 * model rather than the weather.
 */
export function curveGate(
  name: string,
  select: FeatureSelector,
  curve: Curve,
  format: (value: number) => string,
): Gate {
  return {
    name,
    apply: (features: DayFeatures) => {
      const value = select(features);
      if (value === undefined || !Number.isFinite(value)) return undefined;
      return { effect: desirability(curve, value), value: format(value) };
    },
  };
}

export const celsius = (value: number): string => `${value.toFixed(1)} °C`;
export const kmh = (value: number): string => `${Math.round(value)} km/h`;
export const millimetres = (value: number): string => `${value.toFixed(1)} mm`;
export const centimetres = (value: number): string => `${value.toFixed(1)} cm`;
export const percent = (value: number): string => `${Math.round(value)} %`;
export const fraction = (value: number): string => `${Math.round(value * 100)} %`;
export const metres = (value: number): string => `${value.toFixed(1)} m`;
export const seconds = (value: number): string => `${value.toFixed(1)} s`;
export const hours = (value: number): string => `${value} h`;

/** Visibility spans four orders of magnitude, so the unit follows the number. */
export const visibility = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
