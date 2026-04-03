/**
 * @fileoverview Tool: nws_list_alert_types — lists all valid NWS alert event type names.
 * @module mcp-server/tools/definitions/list-alert-types
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNwsService } from '@/services/nws/nws-service.js';

export const listAlertTypesTool = tool('nws_list_alert_types', {
  description:
    'List all valid NWS alert event type names. Use to discover valid values for the event filter in nws_search_alerts, or to browse alert categories. No parameters required.',
  annotations: { readOnlyHint: true },

  input: z.object({}),

  output: z.object({
    count: z.number().describe('Number of event types'),
    eventTypes: z.array(z.string()).describe('Alert event type names sorted alphabetically'),
  }),

  async handler(_input, ctx) {
    const types = await getNwsService().listAlertTypes(ctx);
    ctx.log.info('Listed alert types', { count: types.length });
    return {
      count: types.length,
      eventTypes: [...types].sort(),
    };
  },

  format: (result) => {
    const lines = [`## ${result.count} NWS Alert Event Types\n`, result.eventTypes.join(', ')];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
