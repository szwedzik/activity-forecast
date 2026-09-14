/**
 * Distance between two points on the globe.
 *
 * Used only to report how far the wave-model cell is from the town asked about: the
 * marine grid answers from the nearest sea cell, which can be a few kilometres offshore,
 * and the caller deserves to know rather than be told nothing (D§2.3).
 */

export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function haversineKm(from: Coordinates, to: Coordinates): number {
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(deltaLon / 2) ** 2;

  return Math.round(EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(a)) * 10) / 10;
}
