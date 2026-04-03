/**
 * @fileoverview Server-specific configuration for nws-weather-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';

const ServerConfigSchema = z.object({
  userAgent: z
    .string()
    .default('(nws-weather-mcp-server, github.com/cyanheads/nws-weather-mcp-server)')
    .describe('User-Agent header for NWS API requests. Required by the API — 403 without it.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= ServerConfigSchema.parse({
    userAgent: process.env.NWS_USER_AGENT,
  });
  return _config;
}
