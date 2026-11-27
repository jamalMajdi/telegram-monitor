import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Alert, Field } from '../components/ui';
import { AuthShell } from './AuthShell';

export default function RegisterPage() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register(email, displayName, password);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = err.details?.[0]?.message;
        setError(detail ?? err.message);
      } else {
        setError('تعذّر إنشاء الحساب. حاول مجدداً.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="إنشاء حساب جديد"
      subtitle="كل حساب يحصل على مساحة معزولة لبياناته وإعداداته"
      footer={
        <>
          لديك حساب؟{' '}
          <Link className="font-semibold text-brand-600 hover:underline" to="/login">
            تسجيل الدخول
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <Field label="الاسم المعروض">
          <input
            className="field-input"
            required
            minLength={2}
            maxLength={120}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
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
        <Field label="كلمة المرور" hint="10 أحرف على الأقل، وتشمل حرفاً ورقماً.">
          <input
            className="field-input"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={200}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <button className="btn-primary w-full" type="submit" disabled={busy}>
          {busy ? 'جارٍ الإنشاء…' : 'إنشاء الحساب'}
        </button>
      </form>
    </AuthShell>
  );
}
