/** OpenAPI fragments for the automation planes (queues, schedules, webhooks). */
export function automationOpenApiPaths(): Record<string, unknown> {
  const idParam = (name: string) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  });
  return {
    '/projects/{id}/queues': {
      get: { summary: 'List queues', parameters: [idParam('id')] },
      post: { summary: 'Create queue', parameters: [idParam('id')] },
    },
    '/projects/{id}/queues/{queueId}/messages': {
      get: { summary: 'List messages', parameters: [idParam('id'), idParam('queueId')] },
      post: { summary: 'Publish message (idempotent)', parameters: [idParam('id'), idParam('queueId')] },
    },
    '/projects/{id}/queues/{queueId}/consume': {
      post: { summary: 'Lease messages', parameters: [idParam('id'), idParam('queueId')] },
    },
    '/projects/{id}/queues/{queueId}/messages/{messageId}/ack': {
      post: { summary: 'Ack message', parameters: [idParam('id'), idParam('queueId'), idParam('messageId')] },
    },
    '/projects/{id}/queues/{queueId}/messages/{messageId}/nack': {
      post: { summary: 'Nack message (requeue or dead-letter)', parameters: [idParam('id'), idParam('queueId'), idParam('messageId')] },
    },
    '/projects/{id}/queues/{queueId}/purge': {
      post: { summary: 'Purge acked/dead messages', parameters: [idParam('id'), idParam('queueId')] },
    },
    '/projects/{id}/schedules': {
      get: { summary: 'List schedules', parameters: [idParam('id')] },
      post: { summary: 'Create cron schedule', parameters: [idParam('id')] },
    },
    '/projects/{id}/schedules/{scheduleId}': {
      get: { summary: 'Get schedule', parameters: [idParam('id'), idParam('scheduleId')] },
      patch: { summary: 'Update schedule', parameters: [idParam('id'), idParam('scheduleId')] },
      delete: { summary: 'Delete schedule', parameters: [idParam('id'), idParam('scheduleId')] },
    },
    '/projects/{id}/schedules/{scheduleId}/trigger': {
      post: { summary: 'Fire schedule now', parameters: [idParam('id'), idParam('scheduleId')] },
    },
    '/projects/{id}/webhooks': {
      get: { summary: 'List webhooks', parameters: [idParam('id')] },
      post: { summary: 'Create webhook (secret shown once)', parameters: [idParam('id')] },
    },
    '/projects/{id}/webhooks/{webhookId}': {
      get: { summary: 'Get webhook', parameters: [idParam('id'), idParam('webhookId')] },
      patch: { summary: 'Update webhook', parameters: [idParam('id'), idParam('webhookId')] },
      delete: { summary: 'Delete webhook', parameters: [idParam('id'), idParam('webhookId')] },
    },
    '/projects/{id}/webhooks/{webhookId}/rotate': {
      post: { summary: 'Rotate webhook secret', parameters: [idParam('id'), idParam('webhookId')] },
    },
    '/projects/{id}/webhooks/{webhookId}/test': {
      post: { summary: 'Send signed test delivery', parameters: [idParam('id'), idParam('webhookId')] },
    },
    '/projects/{id}/webhooks/{webhookId}/deliveries': {
      get: { summary: 'List deliveries', parameters: [idParam('id'), idParam('webhookId')] },
    },
    '/projects/{id}/webhooks/{webhookId}/deliveries/{deliveryId}/replay': {
      post: {
        summary: 'Replay delivery',
        parameters: [idParam('id'), idParam('webhookId'), idParam('deliveryId')],
      },
    },
  };
}
