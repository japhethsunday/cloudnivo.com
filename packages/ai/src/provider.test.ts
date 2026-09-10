import { describe, expect, it } from 'vitest';
import { LocalPlannerProvider, sanitizeContext } from './provider.js';

const SCHOOL =
  'Build a backend for a school management application. I need students, teachers, classes, attendance, assignments, results and parents. Teachers should manage students in their classes. Parents should only see their children.';

describe('local planner', () => {
  const provider = new LocalPlannerProvider();

  it('builds a school backend with relationships and roles', async () => {
    const { plan, usage } = await provider.generate(SCHOOL, {});
    const tables = plan.database.tables.map(t => t.name);
    for (const expected of [
      'students',
      'teachers',
      'classes',
      'attendance',
      'assignments',
      'results',
      'parents',
    ]) {
      expect(tables).toContain(expected);
    }
    expect(plan.database.relationships.length).toBeGreaterThan(3);
    expect(plan.auth.roles.map(r => r.name)).toEqual(expect.arrayContaining(['teacher', 'parent']));
    expect(plan.realtime.channels.map(c => c.topic)).toContain('attendance');
    expect(usage.model).toBe('local-planner-v1');
    expect(usage.promptTokens).toBe(null);
  });

  it('builds an ecommerce backend with functions', async () => {
    const { plan } = await provider.generate(
      'Create an ecommerce backend with products, categories, customers, orders, order_items and payments. Send an email when a new order is created.',
      {},
    );
    const tables = plan.database.tables.map(t => t.name);
    for (const expected of [
      'products',
      'categories',
      'customers',
      'orders',
      'order_items',
      'payments',
    ]) {
      expect(tables).toContain(expected);
    }
    expect(plan.functions.map(f => f.name)).toContain('notify-new-order');
    expect(plan.auth.roles.map(r => r.name)).toContain('customer');
  });

  it('detects storage and chat realtime needs', async () => {
    const { plan } = await provider.generate(
      'Create a chat application with messages. Users need profile pictures and avatars.',
      {},
    );
    expect(plan.database.tables.map(t => t.name)).toContain('messages');
    expect(plan.realtime.channels.map(c => c.topic)).toContain('chat');
    expect(plan.storage.buckets.map(b => b.name)).toContain('avatars');
  });

  it('returns an honest empty plan when nothing is recognized', async () => {
    const { plan } = await provider.generate('Hello there, how are you today?', {});
    expect(plan.database.tables).toEqual([]);
    expect(plan.summary).toContain('No new tables');
  });

  it('never duplicates tables that already exist', async () => {
    const { plan } = await provider.generate('I need students and teachers.', {
      tables: ['students'],
    });
    expect(plan.database.tables.map(t => t.name)).toEqual(['teachers']);
  });
});

describe('context sanitization', () => {
  it('strips secret-bearing fields before they reach a model', () => {
    const out = sanitizeContext({
      tables: [{ name: 'users' }],
      config: { DATABASE_URL: 'postgres://u:p@host/db', JWT_SECRET: 'shh', safe: 'yes' },
      nested: { arr: [{ password: 'x', keep: 1 }] },
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain('shh');
    expect(text).toContain('[redacted]');
    expect(text).toContain('users');
  });
});
