/**
 * @fileoverview Bundle entry selection retains executable skill modules while removing dependency agent documentation.
 * @module tests/scripts/clean-mcpb
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

// The copied linter has a framework-repository-only fallback import; load its consumer path at runtime.
const { checkBundleEntries }: { checkBundleEntries(entries: string[], label: string): string[] } =
  await import(new URL('../../scripts/lint-packaging.ts', import.meta.url).href);

describe('MCPB agent documentation filtering', () => {
  it('retains SDK runtime modules and the server-published skill', () => {
    const entries = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
      'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/feature/dist/skills/worker.js',
      'node_modules/skills/index.js',
      'skills/nws-weather-guide/SKILL.md',
    ];

    expect(filterAgentDocEntries(entries)).toEqual([]);
    expect(checkBundleEntries(entries, 'fixture.mcpb')).toEqual([]);
  });

  it('removes package-root agent trees and standalone skill documents', () => {
    const entries = [
      'node_modules/example/skills/guide/SKILL.md',
      'node_modules/@scope/example/framework-skills/add-tool/SKILL.md',
      'node_modules/parent/node_modules/@scope/child/skills/guide/references/query.md',
      'node_modules/@scope/parent/node_modules/child/.claude/settings.json',
      'node_modules/example/.agents/skills/guide/SKILL.md',
      'node_modules/example/docs/SKILL.md',
    ];

    expect(filterAgentDocEntries(entries)).toEqual([
      'node_modules/example/skills/guide/SKILL.md',
      'node_modules/@scope/example/framework-skills/add-tool/SKILL.md',
      'node_modules/parent/node_modules/@scope/child/skills/guide/references/query.md',
      'node_modules/@scope/parent/node_modules/child/.claude/settings.json',
      'node_modules/example/.agents/skills/guide/SKILL.md',
      'node_modules/example/docs/SKILL.md',
    ]);
    expect(checkBundleEntries(entries, 'fixture.mcpb')).toEqual([
      expect.stringContaining('contains 6 node_modules agent-doc entries'),
    ]);
  });
});
