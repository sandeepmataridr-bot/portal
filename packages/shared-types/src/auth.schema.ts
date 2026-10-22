import { z } from 'zod';
import { ROLES } from './roles.js';

export const loginSchema = z.object({
  loginId: z.string().min(1, 'Login ID is required'),
  password: z.string().min(1, 'Password is required'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

export const sessionUserSchema = z.object({
  id: z.string().uuid(),
  loginId: z.string(),
  role: z.enum(ROLES),
  mustChangePassword: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    // NIST SP 800-63B prioritizes length over composition rules — 12 chars
    // rather than 8, no arbitrary complexity requirements.
    newPassword: z.string().min(12, 'New password must be at least 12 characters'),
    confirmPassword: z.string().min(1),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * GET /auth/test-logins: ready-made test accounts (one per role, published
 * passwords) for the login screen. The API serves them only in Vigil TEST
 * mode with TEST_LOGINS=true, and answers 404 otherwise.
 */
export const testLoginSchema = z.object({
  role: z.enum(ROLES),
  loginId: z.string(),
  password: z.string(),
});
export type TestLogin = z.infer<typeof testLoginSchema>;

export const testLoginsResponseSchema = z.object({ accounts: z.array(testLoginSchema) });
export type TestLoginsResponse = z.infer<typeof testLoginsResponseSchema>;
