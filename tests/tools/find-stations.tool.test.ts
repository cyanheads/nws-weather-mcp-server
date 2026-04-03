/**
 * @fileoverview Tests for nws_find_stations tool.
 * @module tests/tools/find-stations
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FindStationsResult } from '@/services/nws/nws-service.js';

const mockFindStations = vi.fn<() => Promise<FindStationsResult>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ findStations: mockFindStations }),
}));

const { findStationsTool } = await import('@/mcp-server/tools/definitions/find-stations.tool.js');

const stationsResult: FindStationsResult = {
  stations: [
    {
      stationId: 'KSEA',
      name: 'Seattle-Tacoma International Airport',
      distance: 12.3,
      bearing: 'S',
      elevation: { value: 131, unitCode: 'wmoUnit:m' },
      timeZone: 'America/Los_Angeles',
      county: 'https://api.weather.gov/zones/county/WAC033',
      forecastZone: 'https://api.weather.gov/zones/forecast/WAZ558',
    },
    {
      stationId: 'KBFI',
      name: 'Seattle Boeing Field',
      distance: 5.1,
      bearing: 'SE',
      elevation: { value: 6, unitCode: 'wmoUnit:m' },
      timeZone: 'America/Los_Angeles',
      county: 'https://api.weather.gov/zones/county/WAC033',
      forecastZone: 'https://api.weather.gov/zones/forecast/WAZ558',
    },
  ],
};

describe('nws_find_stations', () => {
  beforeEach(() => {
    mockFindStations.mockReset();
  });

  it('parses input with default limit', () => {
    const input = findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    expect(input.limit).toBe(10);
  });

  it('rejects limit out of range', () => {
    expect(() =>
      findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3, limit: 100 }),
    ).toThrow();
  });

  it('returns stations with distance and bearing', async () => {
    mockFindStations.mockResolvedValueOnce(stationsResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    const result = await findStationsTool.handler(input, ctx);

    expect(result.stations).toHaveLength(2);
    expect(result.stations[0].stationId).toBe('KSEA');
    expect(result.stations[0].distance).toBe(12.3);
    expect(result.stations[0].bearing).toBe('S');
    expect(result.stations[1].elevation).toBe(6);
  });

  it('passes limit to service', async () => {
    mockFindStations.mockResolvedValueOnce({ stations: [] });

    const ctx = createMockContext({ tenantId: 'test' });
    const input = findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3, limit: 5 });
    await findStationsTool.handler(input, ctx);

    expect(mockFindStations).toHaveBeenCalledWith(47.6, -122.3, 5, ctx);
  });

  describe('format', () => {
    it('renders markdown table', () => {
      const output = {
        stations: [
          {
            stationId: 'KSEA',
            name: 'Seattle-Tacoma Intl',
            distance: 12.3,
            bearing: 'S',
            elevation: 131,
            timeZone: 'America/Los_Angeles',
            county: 'WAC033',
            forecastZone: 'WAZ558',
          },
        ],
      };

      const blocks = findStationsTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('KSEA');
      expect(text).toContain('12.3 km');
      expect(text).toContain('131m');
      // Should have table headers
      expect(text).toContain('Station');
      expect(text).toContain('Distance');
    });

    it('renders message for empty results', () => {
      const blocks = findStationsTool.format!({ stations: [] });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No stations found');
    });
  });
});
