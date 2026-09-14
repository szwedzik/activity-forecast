import { describe, expect, it } from 'vitest';

import { haversineKm } from '../../../src/domain/geo.js';
import { loadMarine } from '../../helpers/fixtures.js';

describe('haversineKm', () => {
  it('is zero for a point and itself', () => {
    expect(haversineKm({ latitude: 38.7, longitude: -9.1 }, { latitude: 38.7, longitude: -9.1 })).toBe(0);
  });

  it('is symmetric', () => {
    const lisbon = { latitude: 38.72509, longitude: -9.1498 };
    const madrid = { latitude: 40.4168, longitude: -3.7038 };

    expect(haversineKm(lisbon, madrid)).toBe(haversineKm(madrid, lisbon));
  });

  it('matches a known distance', () => {
    // Lisbon to Madrid is a little over 500 km.
    const distance = haversineKm(
      { latitude: 38.72509, longitude: -9.1498 },
      { latitude: 40.4168, longitude: -3.7038 },
    );

    expect(distance).toBeGreaterThan(495);
    expect(distance).toBeLessThan(510);
  });

  it('handles a pole and the antimeridian without going wrong', () => {
    expect(haversineKm({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 0 })).toBeCloseTo(
      20015,
      0,
    );
    // Either side of the date line is a short hop, not most of the way round the world.
    expect(
      haversineKm({ latitude: 0, longitude: 179.9 }, { latitude: 0, longitude: -179.9 }),
    ).toBeLessThan(30);
  });

  it('measures how far the wave model answered from, which is what the API reports', () => {
    // The Lisbon marine fixture answers from a cell out at sea, a few km from the town.
    const town = { latitude: 38.72509, longitude: -9.1498 };
    const cell = loadMarine('lisbon');

    const distance = haversineKm(town, { latitude: cell.latitude, longitude: cell.longitude });

    expect(distance).toBeGreaterThan(1);
    expect(distance).toBeLessThan(15);
  });
});
