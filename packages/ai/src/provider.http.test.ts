import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpAIProvider, PlanParseError } from './index.js';

const VALID_PLAN = {
  version: 1,
  summary: 'Task backend with priorities for the test suite.',
  database: {
    tables: [
      {
        name: 'tasks',
        description: 'Todo tasks',
        columns: [
          { name: 'id', type: 'uuid', nullable: false, unique: true },
          { name: 'title', type: 'text', nullable: true, unique: false },
          { name: 'priority', type: 'integer', nullable: true, unique: false },
          { name: 'created_at', type: 'timestamptz', nullable: false, unique: false },
        ],
        primaryKey: ['id'],
      },
    ],
    relationships: [],
    indexes: [],
  },
  auth: { providers: ['email'], roles: [], policies: [] },
  storage: { buckets: [] },
  realtime: { channels: [] },
  functions: [],
  env: [],
};

interface Captured {
  auth: string | undefined;
  body: string;
}

function stubCompletions(
  respond: (captured: Captured, req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; captured: Captured; close: () => Promise<void> }> {
  const captured: Captured = { auth: undefined, body: '' };
  const server: Server = createServer((req, res) => {
    captured.auth = req.headers.authorization;
    let text = '';
    req.on('data', c => {
      text += String(c);
    });
    req.on('end', () => {
      captured.body = text;
      respond(captured, req as IncomingMessage, res as ServerResponse);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        captured,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

function completionsEnvelope(content: string, usage = { prompt_tokens: 12, completion_tokens: 34 }): string {
  return JSON.stringify({ choices: [{ message: { content } }], usage });
}

describe('HttpAIProvider against a stub chat-completions server', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it('parses a valid plan and reports provider usage', async () => {
    const stub = await stubCompletions((_c, _req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(completionsEnvelope(JSON.stringify(VALID_PLAN)));
    });
    close = stub.close;
    const provider = new HttpAIProvider({
      provider: 'openai-compatible',
      model: 'stub-model',
      apiKey: 'test-key-123',
      baseUrl: stub.url,
      timeoutMs: 5000,
    });
    const result = await provider.generate('I need tasks with priorities.', {});
    expect(result.plan.database.tables.map(t => t.name)).toContain('tasks');
    expect(result.usage).toMatchObject({ promptTokens: 12, completionTokens: 34, model: 'stub-model' });
    expect(stub.captured.auth).toBe('Bearer test-key-123');
    expect(JSON.parse(stub.captured.body).model).toBe('stub-model');
  });

  it('rejects non-JSON model output', async () => {
    const stub = await stubCompletions((_c, _req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(completionsEnvelope('just prose, no json'));
    });
    close = stub.close;
    const provider = new HttpAIProvider({ provider: 'openai-compatible', model: 'm', apiKey: 'k', baseUrl: stub.url, timeoutMs: 5000 });
    await expect(provider.generate('I need tasks.', {})).rejects.toThrow('non-JSON');
  });

  it('rejects schema-invalid model output', async () => {
    const stub = await stubCompletions((_c, _req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(completionsEnvelope(JSON.stringify({ version: 1, nonsense: true })));
    });
    close = stub.close;
    const provider = new HttpAIProvider({ provider: 'openai-compatible', model: 'm', apiKey: 'k', baseUrl: stub.url, timeoutMs: 5000 });
    await expect(provider.generate('I need tasks.', {})).rejects.toBeInstanceOf(PlanParseError);
  });

  it('surfaces HTTP errors without leaking the key', async () => {
    const stub = await stubCompletions((_c, _req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad key' }));
    });
    close = stub.close;
    const provider = new HttpAIProvider({
      provider: 'openai-compatible',
      model: 'm',
      apiKey: 'super-secret-key-xyz',
      baseUrl: stub.url,
      timeoutMs: 5000,
    });
    let err: Error | null = null;
    try {
      await provider.generate('I need tasks.', {});
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain('401');
    expect(err?.message ?? '').not.toContain('super-secret-key-xyz');
  });

  it('times out a hanging provider', async () => {
    const stub = await stubCompletions((_c, _req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(completionsEnvelope(JSON.stringify(VALID_PLAN)));
      }, 500).unref();
    });
    close = stub.close;
    const provider = new HttpAIProvider({ provider: 'openai-compatible', model: 'm', apiKey: 'k', baseUrl: stub.url, timeoutMs: 100 });
    await expect(provider.generate('I need tasks.', {})).rejects.toThrow('timed out');
  });

  it('never sends secrets from project context', async () => {
    const stub = await stubCompletions((_c, _req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(completionsEnvelope(JSON.stringify(VALID_PLAN)));
    });
    close = stub.close;
    const provider = new HttpAIProvider({ provider: 'openai-compatible', model: 'm', apiKey: 'k', baseUrl: stub.url, timeoutMs: 5000 });
    await provider.generate('I need tasks.', {
      tables: [{ name: 'tasks' }],
      config: { DATABASE_URL: 'postgres://u:pw@host/db', JWT_SECRET: 'shh', safe: 'yes' },
    });
    expect(stub.captured.body).not.toContain('postgres://');
    expect(stub.captured.body).not.toContain('shh');
    expect(stub.captured.body).toContain('tasks');
  });

  it('refuses to call without a configured key', async () => {
    const provider = new HttpAIProvider({ provider: 'openai-compatible', model: 'm', apiKey: '', baseUrl: 'http://127.0.0.1:1', timeoutMs: 5000 });
    await expect(provider.generate('I need tasks.', {})).rejects.toThrow('not configured');
  });
});
