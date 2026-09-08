import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://cloudnivo:cloudnivo_dev_password_change_me@localhost:5432/cloudnivo',
  },
  verbose: true,
  strict: true,
} satisfies Config;
