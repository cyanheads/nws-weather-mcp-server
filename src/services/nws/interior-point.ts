/**
 * @fileoverview Derives one point guaranteed to lie inside an NWS zone from the
 * zone record's GeoJSON geometry. A bounding-box center or area centroid is not
 * enough: for concave or multi-part zones (Alaska coastal zones, island groups)
 * both routinely fall outside the zone.
 * @module services/nws/interior-point
 */

import { z } from '@cyanheads/mcp-ts-core';

/** GeoJSON position, `[lon, lat]`; any trailing altitude is ignored. */
const PositionSchema = z.tuple([z.number(), z.number()]).rest(z.number());
const PolygonSchema = z.array(z.array(PositionSchema).min(4)).min(1);
const ZoneGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), coordinates: PolygonSchema }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(PolygonSchema).min(1) }),
]);

type Ring = z.infer<typeof PolygonSchema>[number];
type Polygon = z.infer<typeof PolygonSchema>;

/** A point inside a zone, rounded to the 4 decimals NWS `/points` accepts. */
export interface InteriorPoint {
  readonly latitude: number;
  readonly longitude: number;
}

/** Signed shoelace area of a ring, in squared degrees. */
function ringArea(ring: Ring): number {
  let twiceArea = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [x0, y0] = ring[i] as Ring[number];
    const [x1, y1] = ring[i + 1] as Ring[number];
    twiceArea += x0 * y1 - x1 * y0;
  }
  return twiceArea / 2;
}

/** Shell area net of its holes. */
function polygonArea([shell, ...holes]: Polygon): number {
  return (
    Math.abs(ringArea(shell as Ring)) - holes.reduce((sum, h) => sum + Math.abs(ringArea(h)), 0)
  );
}

/**
 * A horizontal line through the polygon that touches no vertex: midway between
 * the two vertex latitudes that bracket the envelope's center (JTS
 * `InteriorPointArea`'s scan-line choice), so every crossing is a clean edge cut.
 */
function scanLineY(polygon: Polygon): number {
  const ys = polygon.flat().map(([, y]) => y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const centreY = (minY + maxY) / 2;
  let loY = minY;
  let hiY = maxY;
  for (const y of ys) {
    if (y <= centreY) {
      if (y > loY) loY = y;
    } else if (y < hiY) {
      hiY = y;
    }
  }
  return (loY + hiY) / 2;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * One point inside the zone geometry: the largest-area part, then the midpoint of
 * the widest interior interval where a horizontal scan line crosses it (the JTS
 * `InteriorPointArea` method), rounded to 4 decimals. Returns undefined for a null
 * or non-areal geometry, malformed coordinates, or a part with no interior.
 */
export function interiorPoint(geometry: unknown): InteriorPoint | undefined {
  const parsed = ZoneGeometrySchema.safeParse(geometry);
  if (!parsed.success) return;
  const polygons =
    parsed.data.type === 'Polygon' ? [parsed.data.coordinates] : parsed.data.coordinates;
  const largest = polygons.reduce((best, p) => (polygonArea(p) > polygonArea(best) ? p : best));

  const scanY = scanLineY(largest);
  const crossings: number[] = [];
  for (const ring of largest) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [x0, y0] = ring[i] as Ring[number];
      const [x1, y1] = ring[i + 1] as Ring[number];
      if (y0 < scanY !== y1 < scanY) crossings.push(x0 + ((scanY - y0) * (x1 - x0)) / (y1 - y0));
    }
  }
  crossings.sort((a, b) => a - b);

  // Sorted crossings pair up into the intervals where the line is inside the polygon.
  let widest: [number, number] | undefined;
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const start = crossings[i] as number;
    const end = crossings[i + 1] as number;
    if (end > start && (!widest || end - start > widest[1] - widest[0])) widest = [start, end];
  }
  if (!widest) return;

  return { latitude: round4(scanY), longitude: round4((widest[0] + widest[1]) / 2) };
}
