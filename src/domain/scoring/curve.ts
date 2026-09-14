/**
 * Piecewise-linear desirability (D§7.2).
 *
 * A curve is a sorted list of `[x, y]` points: linear between them, clamped outside.
 * Every threshold in the scoring model is one of these tables rather than a branch, so
 * tuning an activity means editing data and the engine never changes.
 */

export type CurvePoint = readonly [x: number, y: number];
export type Curve = readonly CurvePoint[];

/** Where `x` falls on the curve, in [0, 1] as long as the table's own y values are. */
export function desirability(curve: Curve, x: number): number {
  const first = curve[0];
  if (first === undefined) throw new RangeError('a curve needs at least one point');

  const last = curve[curve.length - 1];
  if (last === undefined || x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];

  for (let i = 1; i < curve.length; i += 1) {
    const left = curve[i - 1];
    const right = curve[i];
    if (left === undefined || right === undefined) continue;
    if (x <= right[0]) {
      const span = right[0] - left[0];
      if (span === 0) return right[1];
      return left[1] + ((right[1] - left[1]) * (x - left[0])) / span;
    }
  }

  return last[1];
}

/** Guards the data tables: points ascending in x, every y a fraction. */
export function isValidCurve(curve: Curve): boolean {
  if (curve.length === 0) return false;
  for (let i = 0; i < curve.length; i += 1) {
    const point = curve[i];
    if (point === undefined) return false;
    const [x, y] = point;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (y < 0 || y > 1) return false;
    const previous = curve[i - 1];
    if (previous !== undefined && x <= previous[0]) return false;
  }
  return true;
}
