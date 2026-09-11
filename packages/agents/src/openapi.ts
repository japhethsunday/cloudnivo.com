/**
 * Static OpenAPI path fragments for agent access. Merged with the other
 * planes at serve time (see apps/api data.ts openapi.json handler).
 */
export function agentsOpenApiPaths(): Record<string, unknown> {
  const bearer = [{ bearerAuth: [] }];
  const orgParam = {
    name: 'id',
    in: 'path',
    required: true,
    description: 'Organization id (agent scope)',
    schema: { type: 'string', format: 'uuid' },
  };
  return {
    '/agent/whoami': {
      get: {
        summary: 'Identify the calling agent token',
        security: bearer,
        responses: { '200': { description: 'OK' }, '401': { description: 'Unauthorized' } },
      },
    },
    '/agent/approvals': {
      get: {
        summary: "List the calling token's approvals",
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/organizations/{id}/agent-tokens': {
      parameters: [orgParam],
      get: {
        summary: 'List agent tokens (owner/admin)',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
      post: {
        summary: 'Issue agent token — raw value shown once (owner/admin)',
        security: bearer,
        responses: { '201': { description: 'Created' } },
      },
    },
    '/organizations/{id}/agent-tokens/{tokenId}': {
      parameters: [
        orgParam,
        { name: 'tokenId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      get: {
        summary: 'Agent token detail (owner/admin)',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
      delete: {
        summary: 'Revoke agent token immediately (owner/admin)',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/organizations/{id}/agent-activity': {
      parameters: [orgParam],
      get: {
        summary: 'Agent activity audit (owner/admin)',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/organizations/{id}/approvals': {
      parameters: [orgParam],
      get: {
        summary: 'Approval inbox (owner/admin)',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/organizations/{id}/approvals/{approvalId}/approve': {
      parameters: [
        orgParam,
        { name: 'approvalId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      post: {
        summary: 'Approve a pending agent operation (owner/admin)',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/organizations/{id}/approvals/{approvalId}/reject': {
      parameters: [
        orgParam,
        { name: 'approvalId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      post: {
        summary: 'Reject a pending agent operation (owner/admin)',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
  };
}
