import type { SchemaInfo } from '@cloudnivo/database';

/**
 * OpenAPI 3.0 generation from the LIVE introspected schema — documentation
 * can never drift from the database because it is derived per request.
 */
export function buildOpenApiDoc(input: {
  baseUrl: string;
  projectId: string;
  schema: SchemaInfo;
  maxRows: number;
}): Record<string, unknown> {
  const server = `${input.baseUrl.replace(/\/$/, '')}/api/v1/projects/${input.projectId}`;
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};
  for (const t of input.schema.tables) {
    const schemaName = `${t.schema}_${t.name}`;
    const props: Record<string, unknown> = {};
    for (const c of t.columns) {
      props[c.name] = { type: pgToOpenApi(c.dataType), nullable: c.nullable };
    }
    schemas[schemaName] = { type: 'object', properties: props };
    const itemPath = `/${t.name}/{id}`;
    paths[`/${t.name}`] = {
      get: op(`List ${t.name}`, `Query ${t.name} rows with filter/sort/pagination`, [
        q('select', 'Columns to return, comma-separated'),
        q('limit', `Rows per page (1–${input.maxRows})`),
        q('offset', 'Rows to skip'),
        q('order', 'Sort keys, e.g. created_at.desc'),
        { name: '{column}=op.value', in: 'query', required: false, schema: { type: 'string' } },
      ]),
      post: {
        ...op(`Create ${t.name}`, `Insert one ${t.name} row`, []),
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } },
          },
        },
      },
    };
    paths[itemPath] = {
      get: op(`Get ${t.name}`, 'Fetch one row by primary key', [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ]),
      patch: {
        ...op(`Update ${t.name}`, 'Patch one row by primary key', [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ]),
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } },
          },
        },
      },
      delete: op(`Delete ${t.name}`, 'Delete one row by primary key', [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ]),
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: `Project ${input.projectId} API`, version: 'v1' },
    servers: [{ url: server }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        apiKey: { type: 'apiKey', in: 'header', name: 'apikey' },
      },
    },
    security: [{ bearerAuth: [] }, { apiKey: [] }],
  };
}

function op(summary: string, description: string, parameters: unknown[]): Record<string, unknown> {
  return {
    summary,
    description,
    parameters,
    responses: {
      '200': { description: 'OK' },
      '201': { description: 'Created' },
      '400': { description: 'Validation error' },
      '401': { description: 'Unauthorized' },
      '403': { description: 'Forbidden' },
      '404': { description: 'Not found' },
      '429': { description: 'Rate limited' },
    },
  };
}

function q(name: string, description: string): Record<string, unknown> {
  return { name, in: 'query', required: false, schema: { type: 'string' }, description };
}

function pgToOpenApi(pgType: string): string {
  const t = pgType.toLowerCase();
  if (/(int|serial|numeric|decimal|real|double|money)/.test(t)) return 'number';
  if (/(bool)/.test(t)) return 'boolean';
  if (/(json|jsonb)/.test(t)) return 'object';
  if (/(array|\[\])/.test(t)) return 'array';
  return 'string';
}

export function curlExample(
  baseUrl: string,
  projectId: string,
  table: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): string {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/projects/${projectId}/${table}`;
  const auth = `-H "apikey: YOUR_API_KEY"`;
  if (method === 'GET') return `curl ${auth} "${url}?limit=20"`;
  if (method === 'DELETE') return `curl -X DELETE ${auth} "${url}/ROW_ID"`;
  return `curl -X ${method} ${auth} -H "Content-Type: application/json" -d '${JSON.stringify(body ?? { key: 'value' })}' "${url}${method === 'PATCH' ? '/ROW_ID' : ''}"`;
}
