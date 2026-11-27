import { useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../api/client';
import { Alert, Field } from '../components/ui';
import { AuthShell } from './AuthShell';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const result = await authApi.forgot({ email });
      setMessage(result.message);
      setDevToken(result.devResetToken ?? null);
    } catch {
      setError('تعذّر إرسال الطلب. حاول لاحقاً.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="استعادة كلمة المرور"
      subtitle="سنُنشئ طلب استعادة لهذا البريد إن كان مسجّلاً"
      footer={
        <Link className="font-semibold text-brand-600 hover:underline" to="/login">
          العودة لتسجيل الدخول
        </Link>
      }
    >
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        {error ? <Alert kind="error">{error}</Alert> : null}
        {message ? <Alert kind="success">{message}</Alert> : null}
        {devToken ? (
          <Alert kind="warning">
            <p className="font-semibold">بيئة تطوير فقط — لم يُرسل بريد فعلي</p>
            <p className="mt-1 break-all text-xs">{devToken}</p>
            <Link className="mt-2 inline-block font-semibold underline" to={`/reset-password?token=${encodeURIComponent(devToken)}`}>
              متابعة إلى صفحة تعيين كلمة المرور
            </Link>
          </Alert>
        ) : null}
        <Field label="البريد الإلكتروني">
          <input
            className="field-input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <button className="btn-primary w-full" type="submit" disabled={busy}>
          {busy ? 'جارٍ الإرسال…' : 'إرسال طلب الاستعادة'}
        </button>
        <p className="text-xs leading-6 text-slate-500">
          ملاحظة: تسليم رسائل البريد يحتاج مزوّد بريد في بيئة الإنتاج (بند تشغيلي معلّق موثّق)، لذلك يظهر الرمز هنا في
          بيئة التطوير فقط.
        </p>
      </form>
    </AuthShell>
  );
}
