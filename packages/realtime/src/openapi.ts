/**
 * Static OpenAPI path fragments for realtime management + the WebSocket
 * contract summary. Merged with table/storage paths at serve time.
 */
export function realtimeOpenApiPaths(): Record<string, unknown> {
  const bearer = [{ bearerAuth: [] }];
  return {
    '/realtime': {
      get: {
        summary: 'Realtime info',
        description: 'WebSocket URL, drivers, and degraded state for this project.',
        security: bearer,
        responses: { '200': { description: 'OK' }, '401': { description: 'Unauthorized' } },
      },
    },
    '/realtime/stats': {
      get: {
        summary: 'Realtime metrics',
        description: 'Connections, subscriptions, channels, events, presence, errors, latency.',
        security: bearer,
        responses: { '200': { description: 'OK' }, '401': { description: 'Unauthorized' } },
      },
    },
    '/realtime/channels': {
      get: {
        summary: 'Active channels',
        description: 'Channels with local subscriber counts for this project.',
        security: bearer,
        responses: { '200': { description: 'OK' }, '401': { description: 'Unauthorized' } },
      },
    },
    '/realtime/presence': {
      get: {
        summary: 'Presence state',
        description: 'Current presence entries per active channel (up to 50 channels).',
        security: bearer,
        responses: { '200': { description: 'OK' }, '401': { description: 'Unauthorized' } },
      },
    },
    '/realtime/ws': {
      get: {
        summary: 'WebSocket endpoint (upgrade only)',
        description:
          'Connect with `?token=<session JWT | customer JWT>` or `?apikey=<project key>`. ' +
          'JSON text frames: subscribe/unsubscribe/broadcast/presence.set/presence.remove/ping. ' +
          'Channel grammar: `project:<uuid>:<topic>` (`table:<name>` subscribes to row changes; ' +
          'optional equality `filter` object, e.g. `{"user_id":"123"}` — validated keys, never SQL). ' +
          'Expired credentials are rejected at upgrade (401) and dropped by the heartbeat sweep; ' +
          're-authenticate and reconnect.',
        responses: {
          '101': { description: 'Switching Protocols' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
  };
}
