/**
 * @fileoverview Tool: nws_get_alert — fetches one alert message by ID, including
 * messages a later update or cancellation has superseded.
 * @module mcp-server/tools/definitions/get-alert
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ALERT_ID_PATTERN, getNwsService } from '@/services/nws/nws-service.js';
import { alertMarkdownLines, alertOutputSchema, toAlertOutput } from '../alert-output.js';

/**
 * Alert ID shape advertised as a JSON Schema `pattern` (issue #54): the service's
 * ALERT_ID_PATTERN with the surrounding whitespace the service trims. The service
 * stays the seat of rejection, failing a malformed ID as alert_not_found before any
 * request.
 */
export const ALERT_ID_INPUT_PATTERN = new RegExp(
  `^\\s*(?:${ALERT_ID_PATTERN.source.slice(1, -1)})\\s*$`,
);

export const getAlertTool = tool('nws_get_alert', {
  description:
    'Fetch one NWS alert message by ID — a current alert, or an earlier message that an update or cancellation has since superseded and that an active-alert search no longer returns. Takes an id from nws_search_alerts or a references[].identifier from any alert, and returns the same alert fields nws_search_alerts does. The message carries its own references, newest first, so a revision chain is walked one call per message. Every reference sharing the newest sent time is an immediate predecessor (an update can merge several earlier segments), so references[0] is one of them, not always the only one. NWS serves messages for about 7 days after they are sent.',
  annotations: { readOnlyHint: true },
  // Raised by the NWS service carrying only the reason; the framework fills the hint.
  // An unknown or aged-out ID is a modeled outcome and logs at notice.
  errors: [
    {
      reason: 'alert_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'alert_id is not an NWS alert ID, or NWS has no message with that ID',
      recovery:
        'Pass an id from nws_search_alerts, or a references[].identifier from an alert it returned, exactly as given; NWS no longer serves messages sent more than about 7 days ago.',
      severity: 'notice',
      thrownBy: 'service',
    },
  ],

  input: z.object({
    alert_id: z
      .string()
      .meta({ pattern: ALERT_ID_INPUT_PATTERN.source })
      .describe(
        'NWS alert message ID, e.g. "urn:oid:2.49.0.1.840.0.654087301e4bfcbe71d24494c26a965e54d3a1ad.001.1": the id of an alert from nws_search_alerts, or the identifier of one of its references. Pass it exactly as returned; IDs are case-sensitive.',
      ),
  }),

  output: z.object({ alert: alertOutputSchema }),

  async handler(input, ctx) {
    const alert = await getNwsService().getAlert(input.alert_id, ctx);
    return { alert: toAlertOutput(alert) };
  },

  format: (result) => [
    {
      type: 'text',
      text: ['## Alert Message', '', ...alertMarkdownLines(result.alert)].join('\n'),
    },
  ],
});
