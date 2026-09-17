import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordSchema, type ChangePasswordInput, type SessionUser } from '@infusion/shared-types';
import { apiFetch } from '../lib/api';
import { AppShell } from '../components/AppShell';
import { useAuth } from '../auth/AuthContext';

interface ChangePasswordResponse {
  accessToken: string;
  user: SessionUser;
}

export function ChangePasswordPage() {
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema) });

  const onSubmit = async (data: ChangePasswordInput) => {
    // The response carries a rotated session (fresh access token + user with
    // mustChangePassword now false) — without adopting it, the stale
    // in-memory user would still show mustChangePassword: true and
    // RequireRole would bounce straight back here.
    const result = await apiFetch<ChangePasswordResponse>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    setSession(result.accessToken, result.user);
    navigate('/', { replace: true });
  };

  return (
    <AppShell title="Set a new password">
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <p>You must set a new password before continuing.</p>
        <label>
          Current password
          <input type="password" {...register('currentPassword')} />
        </label>
        {errors.currentPassword && <p role="alert">{errors.currentPassword.message}</p>}

        <label>
          New password
          <input type="password" {...register('newPassword')} />
        </label>
        {errors.newPassword && <p role="alert">{errors.newPassword.message}</p>}

        <label>
          Confirm new password
          <input type="password" {...register('confirmPassword')} />
        </label>
        {errors.confirmPassword && <p role="alert">{errors.confirmPassword.message}</p>}

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </AppShell>
  );
}
