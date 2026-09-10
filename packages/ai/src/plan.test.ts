import { describe, expect, it } from 'vitest';
import { parsePlan, PlanParseError } from './plan.js';
import { EMPTY_STATE, validatePlan } from './validate.js';

const GOOD = {
  version: 1,
  summary: 'School backend with students and classes.',
  database: {
    tables: [
      {
        name: 'students',
        description: 'Students',
        columns: [
          { name: 'id', type: 'uuid', nullable: false, unique: true },
          { name: 'full_name', type: 'text', nullable: true, unique: false },
          { name: 'class_id', type: 'uuid', nullable: true, unique: false },
        ],
        primaryKey: ['id'],
      },
      {
        name: 'classes',
        description: 'Classes',
        columns: [
          { name: 'id', type: 'uuid', nullable: false, unique: true },
          { name: 'name', type: 'text', nullable: true, unique: false },
        ],
        primaryKey: ['id'],
      },
    ],
    relationships: [
      {
        fromTable: 'students',
        fromColumn: 'class_id',
        toTable: 'classes',
        toColumn: 'id',
        onDelete: 'restrict',
      },
    ],
    indexes: [{ table: 'students', columns: ['class_id'], unique: false }],
  },
  auth: {
    providers: ['email'],
    roles: [{ name: 'teacher', description: 'Teachers' }],
    policies: [
      {
        table: 'students',
        operation: 'SELECT',
        role: 'teacher',
        rule: 'own',
        description: 'own students',
      },
    ],
  },
  storage: {
    buckets: [
      { name: 'avatars', visibility: 'public', allowedMimeTypes: ['image/'], maxFileMb: 10 },
    ],
  },
  realtime: { channels: [{ topic: 'chat', kind: 'broadcast', description: 'chat' }] },
  functions: [
    {
      name: 'notify-parent',
      purpose: 'Notify parents when results land, via mail provider.',
      trigger: 'database_insert',
      table: 'students',
    },
  ],
  env: [],
};

describe('plan schema', () => {
  it('accepts a well-formed plan', () => {
    const plan = parsePlan(GOOD);
    expect(plan.database.tables).toHaveLength(2);
  });

  it('rejects malformed model output', () => {
    expect(() => parsePlan({ version: 1 })).toThrow(PlanParseError);
    expect(() => parsePlan({ ...GOOD, version: 2 })).toThrow(PlanParseError);
    expect(() =>
      parsePlan({
        ...GOOD,
        database: {
          tables: [{ name: 'x; DROP TABLE y', columns: [], primaryKey: [] }],
          relationships: [],
          indexes: [],
        },
      }),
    ).toThrow(PlanParseError);
    expect(() => parsePlan(null)).toThrow(PlanParseError);
    expect(() => parsePlan('just prose, no json')).toThrow(PlanParseError);
  });
});

describe('plan validation', () => {
  it('passes a coherent plan', () => {
    const v = validatePlan(parsePlan(GOOD), EMPTY_STATE);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('catches duplicates, dangling refs, missing keys', () => {
    const bad = parsePlan({
      ...GOOD,
      database: {
        tables: [
          {
            name: 'a',
            description: '',
            columns: [{ name: 'id', type: 'uuid', nullable: false }],
            primaryKey: ['nope'],
          },
          {
            name: 'a',
            description: '',
            columns: [{ name: 'id', type: 'uuid', nullable: false }],
            primaryKey: ['id'],
          },
        ],
        relationships: [
          {
            fromTable: 'a',
            fromColumn: 'id',
            toTable: 'ghost',
            toColumn: 'id',
            onDelete: 'restrict',
          },
        ],
        indexes: [{ table: 'ghost', columns: ['id'], unique: false }],
      },
      auth: {
        providers: ['email'],
        roles: [],
        policies: [
          { table: 'ghost', operation: 'SELECT', role: 'x', rule: 'own', description: '' },
        ],
      },
    });
    const v = validatePlan(bad, EMPTY_STATE);
    expect(v.ok).toBe(false);
    expect(v.errors.join('|')).toContain('duplicate table: a');
    expect(v.errors.join('|')).toContain('unknown table ghost');
    expect(v.errors.join('|')).toContain('primary key nope');
  });

  it('flags destructive intent in free text', () => {
    const v = validatePlan(
      parsePlan({
        ...GOOD,
        summary: 'Please drop table students and delete bucket avatars for cleanup.',
      }),
      EMPTY_STATE,
    );
    expect(v.destructive).toContain('DROP TABLE');
    expect(v.destructive).toContain('DELETE BUCKET');
  });

  it('warns on conflicts with live state instead of failing', () => {
    const v = validatePlan(parsePlan(GOOD), {
      ...EMPTY_STATE,
      tables: ['students'],
      buckets: ['avatars'],
    });
    expect(v.ok).toBe(true);
    expect(v.warnings.join('|')).toContain('already exists');
  });
});
