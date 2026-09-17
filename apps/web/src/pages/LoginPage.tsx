import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@infusion/shared-types';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../lib/api';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  const onSubmit = async (data: LoginInput) => {
    setServerError(null);
    try {
      const user = await login(data);
      navigate(user.mustChangePassword ? '/change-password' : '/', { replace: true });
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Login failed. Please try again.');
    }
  };

  return (
    <div className="login-page">
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <h1>Infusion Platform</h1>
        <label>
          Username
          <input type="text" autoComplete="username" {...register('loginId')} />
        </label>
        {errors.loginId && <p role="alert">{errors.loginId.message}</p>}

        <label>
          Password
          <input type="password" autoComplete="current-password" {...register('password')} />
        </label>
        {errors.password && <p role="alert">{errors.password.message}</p>}

        {serverError && <p role="alert">{serverError}</p>}

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Login'}
        </button>
      </form>
    </div>
  );
}
