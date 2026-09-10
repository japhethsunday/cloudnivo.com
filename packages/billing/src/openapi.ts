/**
 * Static OpenAPI path fragments for billing. Merged with the other planes
 * at serve time (see apps/api data.ts openapi.json handler).
 */
export function billingOpenApiPaths(): Record<string, unknown> {
  const bearer = [{ bearerAuth: [] }];
  const orgParam = {
    name: 'id',
    in: 'path',
    required: true,
    description: 'Organization id (billing scope)',
    schema: { type: 'string', format: 'uuid' },
  };
  return {
    '/organizations/{id}/billing/plan': {
      parameters: [orgParam],
      get: {
        summary: 'Current plan, subscription, and effective limits',
        security: bearer,
        responses: { '200': { description: 'OK' }, '401': { description: 'Unauthorized' }, '403': { description: 'Forbidden' } },
      },
    },
    '/organizations/{id}/billing/plans': {
      parameters: [orgParam],
      get: {
        summary: 'Comparable plan catalog',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/organizations/{id}/billing/subscription': {
      parameters: [orgParam],
      get: {
        summary: 'Subscription detail',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
      post: {
        summary: 'Change plan / start trial / cancel (owner/admin)',
        security: bearer,
        responses: { '200': { description: 'OK' }, '409': { description: 'Downgrade blocked' } },
      },
    },
    '/organizations/{id}/billing/usage': {
      parameters: [orgParam],
      get: {
        summary: 'Current-period usage with limits and warnings',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/organizations/{id}/billing/invoices': {
      parameters: [orgParam],
      get: {
        summary: 'Invoice history',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
      post: {
        summary: 'Generate invoice from real usage (owner/admin)',
        security: bearer,
        responses: { '201': { description: 'Created' } },
      },
    },
    '/organizations/{id}/billing/payments': {
      parameters: [orgParam],
      get: {
        summary: 'Payment history (provider references only)',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/organizations/{id}/billing/portal': {
      parameters: [orgParam],
      post: {
        summary: 'Customer portal session (provider instructions when manual)',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/billing/webhooks/{provider}': {
      post: {
        summary: 'Verified provider webhook (HMAC, idempotent, replay-checked)',
        responses: { '200': { description: 'Processed' }, '401': { description: 'Bad signature' } },
      },
    },
  };
}
