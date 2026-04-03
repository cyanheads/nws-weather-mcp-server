/**
 * @fileoverview Resource: nws://alert-types — static list of valid NWS alert event type names.
 * @module mcp-server/resources/definitions/alert-types
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getNwsService } from '@/services/nws/nws-service.js';

export const alertTypesResource = resource('nws://alert-types', {
  name: 'NWS Alert Event Types',
  description:
    'Static list of all valid NWS alert event type names. Useful reference when constructing event filters for nws_search_alerts.',
  mimeType: 'application/json',
  params: z.object({}),

  async handler(_params, ctx) {
    const types = await getNwsService().listAlertTypes(ctx);
    return { count: types.length, eventTypes: [...types].sort() };
  },

  list: async () => ({
    resources: [
      {
        uri: 'nws://alert-types',
        name: 'NWS Alert Event Types',
        description: 'All valid alert event type names for filtering.',
        mimeType: 'application/json',
      },
    ],
  }),
});
