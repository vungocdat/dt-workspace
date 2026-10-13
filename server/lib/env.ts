/**
 * Centralized env validation. Imported first in index.ts so that a misconfigured
 * deployment fails fast with a clear message instead of a deep stack trace from
 * some downstream module.
 *
 * SESSION_SECRET's 32-char rule is ALSO enforced in lib/session.ts at its own
 * module load (defense in depth — that module must never operate with a bad
 * secret regardless of import order).
 */
export interface AppConfig {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  port: number;
  databaseUrl: string;
  isProduction: boolean;
}

export function loadConfig(): AppConfig {
  const errors: string[] = [];

  const username = process.env.KB_USERNAME ?? '';
  const passwordHash = process.env.KB_PASSWORD_HASH ?? '';
  const sessionSecret = process.env.SESSION_SECRET ?? '';
  const databaseUrl = process.env.DATABASE_URL ?? '';

  if (!username) errors.push('KB_USERNAME is required');
  if (!passwordHash) {
    errors.push('KB_PASSWORD_HASH is required');
  } else if (!/^\$2[aby]\$/.test(passwordHash)) {
    errors.push('KB_PASSWORD_HASH does not look like a bcrypt hash');
  }
  if (sessionSecret.length !== 32) {
    errors.push(`SESSION_SECRET must be exactly 32 characters (got ${sessionSecret.length})`);
  }
  if (!databaseUrl) {
    errors.push('DATABASE_URL is required (e.g. postgres://dt_workspace:<password>@localhost:5432/dt_workspace)');
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    errors.push('DATABASE_URL must be a postgres:// or postgresql:// connection URL');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }

  return {
    username,
    passwordHash,
    sessionSecret,
    port: Number(process.env.PORT ?? 3000),
    databaseUrl,
    isProduction: process.env.NODE_ENV === 'production',
  };
}
