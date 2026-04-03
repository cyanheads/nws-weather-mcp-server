/**
 * @fileoverview Tests for server config parsing.
 * @module tests/config/server-config
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('server-config', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns default user agent when env var is not set', async () => {
    delete process.env.NWS_USER_AGENT;
    const { getServerConfig } = await import('@/config/server-config.js');
    const config = getServerConfig();
    expect(config.userAgent).toContain('nws-weather-mcp-server');
  });

  it('uses NWS_USER_AGENT from env', async () => {
    process.env.NWS_USER_AGENT = '(my-app, me@example.com)';
    const { getServerConfig } = await import('@/config/server-config.js');
    const config = getServerConfig();
    expect(config.userAgent).toBe('(my-app, me@example.com)');
    delete process.env.NWS_USER_AGENT;
  });

  it('caches config on second call', async () => {
    delete process.env.NWS_USER_AGENT;
    const { getServerConfig } = await import('@/config/server-config.js');
    const first = getServerConfig();
    const second = getServerConfig();
    expect(first).toBe(second);
  });
});
