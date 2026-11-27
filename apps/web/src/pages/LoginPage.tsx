import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Alert, Field } from '../components/ui';
import { AuthShell } from './AuthShell';

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذّر تسجيل الدخول. حاول مجدداً.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="تسجيل الدخول"
      subtitle="الدخول إلى مساحتك الخاصة في نظام مراقبة الرسائل"
      footer={
        <>
          لا تملك حساباً؟{' '}
          <Link className="font-semibold text-brand-600 hover:underline" to="/register">
            إنشاء حساب
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <Field label="البريد الإلكتروني">
          <input
            className="field-input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="كلمة المرور">
          <input
            className="field-input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <button className="btn-primary w-full" type="submit" disabled={busy}>
          {busy ? 'جارٍ الدخول…' : 'دخول'}
        </button>
        <div className="text-center">
          <Link className="text-sm text-slate-600 hover:underline" to="/forgot-password">
            نسيت كلمة المرور؟
          </Link>
        </div>
      </form>
    </AuthShell>
  );
}
