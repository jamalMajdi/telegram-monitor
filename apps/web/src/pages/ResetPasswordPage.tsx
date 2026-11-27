import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, authApi } from '../api/client';
import { Alert, Field } from '../components/ui';
import { AuthShell } from './AuthShell';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('كلمتا المرور غير متطابقتين.');
      return;
    }
    setBusy(true);
    try {
      await authApi.reset({ token, password });
      navigate('/login', { replace: true, state: { reset: true } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذّر تعيين كلمة المرور.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="تعيين كلمة مرور جديدة"
      subtitle="بعد الحفظ ستُلغى كل الجلسات السابقة لهذا الحساب"
      footer={
        <Link className="font-semibold text-brand-600 hover:underline" to="/login">
          العودة لتسجيل الدخول
        </Link>
      }
    >
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <Field label="رمز الاستعادة">
          <input className="field-input font-mono text-xs" required value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <Field label="كلمة المرور الجديدة" hint="10 أحرف على الأقل، وتشمل حرفاً ورقماً.">
          <input
            className="field-input"
            type="password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="تأكيد كلمة المرور">
          <input
            className="field-input"
            type="password"
            required
            minLength={10}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <button className="btn-primary w-full" type="submit" disabled={busy}>
          {busy ? 'جارٍ الحفظ…' : 'حفظ كلمة المرور'}
        </button>
      </form>
    </AuthShell>
  );
}
