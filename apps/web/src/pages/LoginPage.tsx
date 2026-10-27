import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput, type Role, type TestLogin, type TestLoginsResponse } from '@infusion/shared-types';
import { useAuth } from '../auth/AuthContext';
import { ROLE_HOME } from '../auth/roleHome';
import { ApiError, apiFetch } from '../lib/api';

const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  doctor: 'Doctor',
  reception: 'Reception',
  pharmacy: 'Pharmacy',
  insurance: 'Insurance',
  superuser: 'Super user',
};

const PAGE_LABEL: Record<string, string> = {
  '/admin': 'Admin dashboard',
  '/doctor': 'Doctor dashboard',
  '/reception': 'Reception dashboard',
  '/pharmacy': 'Pharmacy dashboard',
  '/insurance': 'Insurance dashboard',
  '/super': 'Super user dashboard',
};

interface TestRow extends TestLogin {
  key: string;
  page: string;
}

/** The quick sign-in accounts, if the API offers them (TEST_LOGINS on; see test-logins.service.ts); otherwise none. */
async function fetchTestLogins(): Promise<TestLogin[]> {
  try {
    return (await apiFetch<TestLoginsResponse>('/auth/test-logins')).accounts;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return [];
    throw err;
  }
}

/** One row per role, opening that role's own dashboard. */
function testRows(accounts: TestLogin[]): TestRow[] {
  return accounts.map((account) => ({ ...account, key: account.role, page: ROLE_HOME[account.role] }));
}

/** The home page: https://0dh.in when it is hosted on its own (VITE_LANDING_URL), else this app's root. */
const HOME_URL: string = import.meta.env.VITE_LANDING_URL || '/';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);
  const [picked, setPicked] = useState<TestRow | null>(null);
  const { data: testAccounts = [] } = useQuery({
    queryKey: ['auth', 'test-logins'],
    queryFn: fetchTestLogins,
    retry: false,
    staleTime: Infinity,
  });
  const rows = testRows(testAccounts);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  const pick = (row: TestRow) => {
    setPicked(row);
    setServerError(null);
    setValue('loginId', row.loginId, { shouldValidate: true });
    setValue('password', row.password, { shouldValidate: true });
  };

  const onSubmit = async (data: LoginInput) => {
    setServerError(null);
    try {
      const user = await login(data);
      // A picked quick sign-in opens its own page; anything else lands on the role's dashboard.
      const target = picked && picked.loginId === data.loginId ? picked.page : '/app';
      navigate(user.mustChangePassword ? '/change-password' : target, { replace: true });
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Login failed. Please try again.');
    }
  };

  return (
    <div className="login-page">
      <div className="login-stack">
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="login-brand">
            <h1>
              <a className="login-brand__home" href={HOME_URL} title="0dh.in home page">
                0dh
                {/* The domain's dot is the live light, as on the home page; a real "." stays for screen readers and copy-paste. */}
                <span className="login-brand__sr">.</span>
                <span className="login-brand__live" aria-hidden="true" />
                <span className="login-brand__in">in</span>
              </a>
            </h1>
          </div>
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

        {rows.length > 0 && (
          <section className="test-logins" aria-labelledby="test-logins-title">
            <h2 id="test-logins-title">Quick sign-in</h2>
            <p>Pick a role to fill in its login, then press Login to open its page.</p>
            <div className="test-logins__scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col" aria-label="Select" />
                    <th scope="col">Role</th>
                    <th scope="col">Login ID</th>
                    <th scope="col">Password</th>
                    <th scope="col">Opens</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key} className={picked?.key === row.key ? 'is-picked' : undefined} onClick={() => pick(row)}>
                      <td>
                        <input
                          type="radio"
                          name="test-login"
                          aria-label={`${ROLE_LABEL[row.role]}: ${PAGE_LABEL[row.page]}`}
                          checked={picked?.key === row.key}
                          onChange={() => pick(row)}
                        />
                      </td>
                      <td>{ROLE_LABEL[row.role]}</td>
                      <td data-label="Login ID">
                        <code>{row.loginId}</code>
                      </td>
                      <td data-label="Password">
                        <code>{row.password}</code>
                      </td>
                      <td data-label="Opens">{PAGE_LABEL[row.page]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
