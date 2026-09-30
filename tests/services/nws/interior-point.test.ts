/**
 * @fileoverview Tests for the zone interior-point derivation: the largest-area part
 * of a Polygon or MultiPolygon, then the midpoint of the widest interior interval on
 * a horizontal scan line through it.
 * @module tests/services/nws/interior-point
 */

import { describe, expect, it } from 'vitest';
import { interiorPoint } from '@/services/nws/interior-point.js';
import {
  multiPolygonZoneRecordResponse,
  polygonZoneRecordResponse,
} from '../../fixtures/nws-responses.js';

type Ring = number[][];

/** Even-odd ray cast: whether [lon, lat] lies inside the ring. */
function inRing([x, y]: number[], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > (y as number) !== yj > (y as number)) {
      if ((x as number) < ((xj - xi) * ((y as number) - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Whether [lon, lat] lies inside any part of the geometry, outside that part's holes. */
function inGeometry(point: number[], polygons: Ring[][]): boolean {
  return polygons.some(
    ([shell, ...holes]) =>
      inRing(point, shell as Ring) && !holes.some((hole) => inRing(point, hole)),
  );
}

/** Area-weighted centroid of every shell, the naive "center of the zone". */
function centroid(polygons: Ring[][]): number[] {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (const [shell] of polygons) {
    const ring = shell as Ring;
    for (let i = 0; i + 1 < ring.length; i++) {
      const [x0, y0] = ring[i] as [number, number];
      const [x1, y1] = ring[i + 1] as [number, number];
      const cross = x0 * y1 - x1 * y0;
      area += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
  }
  return [cx / (3 * area), cy / (3 * area)];
}

const square = (x0: number, y0: number, x1: number, y1: number): Ring => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

describe('interiorPoint', () => {
  it('returns a point inside a real zone Polygon, rounded to 4 decimals', () => {
    const point = interiorPoint(polygonZoneRecordResponse.geometry);

    expect(point).toEqual({ latitude: 64.514, longitude: -157.1651 });
    expect(
      inGeometry(
        [point!.longitude, point!.latitude],
        [polygonZoneRecordResponse.geometry.coordinates],
      ),
    ).toBe(true);
  });

  it('returns a point inside a MultiPolygon whose centroid and bounding-box center fall outside it', () => {
    const polygons = multiPolygonZoneRecordResponse.geometry.coordinates;
    const naive = centroid(polygons);

    // The fixture's defining property: the obvious center is not in the zone.
    expect(inGeometry(naive, polygons)).toBe(false);
    expect(inGeometry([-149.5, 65], polygons)).toBe(false);

    const point = interiorPoint(multiPolygonZoneRecordResponse.geometry);

    expect(point).toEqual({ latitude: 66, longitude: -159 });
    expect(inGeometry([point!.longitude, point!.latitude], polygons)).toBe(true);
  });

  it('takes the largest-area part, not the first', () => {
    const point = interiorPoint({
      type: 'MultiPolygon',
      coordinates: [[square(0, 0, 1, 1)], [square(10, 10, 20, 14)]],
    });

    expect(point).toEqual({ latitude: 12, longitude: 15 });
  });

  it('measures a part net of its holes when choosing the largest', () => {
    // Part one spans 10x10 but is nearly all hole (net 3.96); part two is a solid 5x5.
    const point = interiorPoint({
      type: 'MultiPolygon',
      coordinates: [[square(0, 0, 10, 10), square(0.1, 0.1, 9.9, 9.9)], [square(20, 0, 25, 5)]],
    });

    expect(point).toEqual({ latitude: 2.5, longitude: 22.5 });
  });

  it('places the point in the widest interval beside a hole, never in the hole', () => {
    const polygon = [square(0, 0, 10, 10), square(2, 3, 6, 7)];
    const point = interiorPoint({ type: 'Polygon', coordinates: polygon });

    // Scan line at y=5 crosses x=0, 2, 6, 10: intervals [0,2] and [6,10]; the wider wins.
    expect(point).toEqual({ latitude: 5, longitude: 8 });
    expect(inGeometry([point!.longitude, point!.latitude], [polygon])).toBe(true);
  });

  it('keeps a scan line off every vertex, so a concave shell still yields an inside point', () => {
    // A comb: three teeth rising from a base; vertices crowd the envelope's center line.
    const comb: Ring = [
      [0, 0],
      [9, 0],
      [9, 10],
      [7, 10],
      [7, 5],
      [6, 5],
      [6, 10],
      [3, 10],
      [3, 5],
      [2, 5],
      [2, 10],
      [0, 10],
      [0, 0],
    ];
    const point = interiorPoint({ type: 'Polygon', coordinates: [comb] });

    expect(point).toBeDefined();
    expect(inGeometry([point!.longitude, point!.latitude], [[comb]])).toBe(true);
    expect(point!.latitude).not.toBe(5);
  });

  it.each([
    { label: 'null', geometry: null },
    { label: 'undefined', geometry: undefined },
    { label: 'a Point', geometry: { type: 'Point', coordinates: [-150, 60] } },
    {
      label: 'a GeometryCollection',
      geometry: { type: 'GeometryCollection', geometries: [] },
    },
    { label: 'an empty MultiPolygon', geometry: { type: 'MultiPolygon', coordinates: [] } },
    { label: 'a Polygon with no rings', geometry: { type: 'Polygon', coordinates: [] } },
    {
      label: 'non-numeric positions',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            ['a', 'b'],
            ['c', 'd'],
            ['e', 'f'],
            ['a', 'b'],
          ],
        ],
      },
    },
    {
      label: 'a zero-area ring',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 1],
            [5, 1],
            [9, 1],
            [0, 1],
          ],
        ],
      },
    },
  ])('returns undefined for $label', ({ geometry }) => {
    expect(interiorPoint(geometry)).toBeUndefined();
  });
});
