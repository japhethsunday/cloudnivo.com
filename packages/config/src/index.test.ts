import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './index.js';

const base = {
  DATABASE_URL: 'postgres://cloudnivo:secret@localhost:5432/cloudnivo',
  JWT_SECRET: 'a'.repeat(48),
};

describe('loadConfig', () => {
  it('loads defaults for local development', () => {
    const cfg = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(cfg.API_PORT).toBe(3001);
    expect(cfg.corsOrigins).toEqual(['http://localhost:3000']);
    expect(cfg.isDevelopment).toBe(true);
  });

  it('fails safely when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ JWT_SECRET: base.JWT_SECRET } as NodeJS.ProcessEnv)).toThrow(
      ConfigError,
    );
  });

  it('fails safely when JWT_SECRET is too short', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(
      /JWT_SECRET/,
    );
  });

  it('rejects non-postgres DATABASE_URL without leaking the value', () => {
    try {
      loadConfig({ ...base, DATABASE_URL: 'mysql://x' } as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      // Error message must describe the problem, never echo credentials.
      expect((err as Error).message).not.toContain('mysql://x');
    }
  });

  it('parses CORS allowlist', () => {
    const cfg = loadConfig({
      ...base,
      CORS_ORIGINS: 'https://a.example, https://b.example',
    } as NodeJS.ProcessEnv);
    expect(cfg.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('provides safe provisioning defaults (resource limits)', () => {
    const cfg = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(cfg.PROVISION_DRIVER).toBe('docker');
    expect(cfg.PROVISION_MAX_DATABASES).toBe(20);
    expect(cfg.PROVISION_MAX_SQL_MS).toBe(15_000);
    expect(cfg.PROVISION_MAX_SQL_ROWS).toBe(500);
    expect(cfg.PROVISION_BASE_PORT).toBe(15432);
  });

  it('rejects out-of-range provisioning limits', () => {
    expect(() =>
      loadConfig({ ...base, PROVISION_MAX_DATABASES: '0' } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });
});
