import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  ARGON2_SECRET: z.string().min(16).optional(),

  // The refresh cookie's Path attribute must match the PUBLIC url the
  // browser sees for /auth/*, not this app's internal route. If a reverse
  // proxy strips a path prefix (e.g. serving this API at /api/* and
  // forwarding /api/auth/* -> /auth/*), the public path is /api/auth and
  // this must be set to "/api/auth" or the browser will never send the
  // cookie back (silently breaking refresh/logout in prod, not dev).
  REFRESH_COOKIE_PATH: z.string().min(1).default('/auth'),

  CORS_ORIGINS: z
    .string()
    .min(1, 'CORS_ORIGINS is required (comma-separated allow-list, no wildcards)')
    .transform((value) => value.split(',').map((origin) => origin.trim())),

  // Lists ready-made test accounts (one per role, published passwords) on the
  // login screen. Honoured only while Vigil runs in TEST mode (simulated
  // patients); see auth/test-logins.service.ts. Off unless set.
  TEST_LOGINS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type Env = z.infer<typeof envSchema>;
