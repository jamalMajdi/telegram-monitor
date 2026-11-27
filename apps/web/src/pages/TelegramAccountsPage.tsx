/**
 * إدارة حسابات تيليجرام المرتبطة: عرض الحسابات وحالتها، وربط حساب جديد عبر MTProto
 * (رقم الهاتف ← رمز الدخول ← كلمة مرور التحقق بخطوتين عند الحاجة)، وإعادة المصادقة والفصل.
 * لا تُحفظ أي بيانات مصادقة في المتصفح: الحالة المؤقتة في الخادم فقط، والرمز يُرسل مباشرة ولا يُخزَّن.
 */
import { useState } from 'react';
import { ApiError, telegramApi, type LoginChallenge, type TelegramAccount } from '../api/client';
import { Alert, Badge, EmptyState, Field, Spinner, formatDate } from '../components/ui';
import { useQuery } from '../lib/useQuery';

const statusLabels: Record<TelegramAccount['status'], { label: string; tone: 'green' | 'amber' | 'red' | 'slate' | 'blue' }> = {
  pending_login: { label: 'بانتظار إكمال الربط', tone: 'amber' },
  active: { label: 'مرتبط', tone: 'green' },
  needs_reauth: { label: 'يحتاج إعادة مصادقة', tone: 'red' },
  revoked: { label: 'مفصول', tone: 'slate' },
  suspended: { label: 'موقوف', tone: 'red' },
};

const phaseLabels: Record<string, string> = {
  idle: 'غير متصل',
  connecting: 'جارٍ الاتصال',
  connected: 'متصل',
  reconnecting: 'يعيد المحاولة',
  needs_reauth: 'يحتاج إعادة مصادقة',
  stopped: 'متوقف',
  unknown: 'غير معروف',
};

interface WizardState {
  accountId: string;
  phoneNumber: string;
  stage: 'code' | 'password';
  challenge: LoginChallenge | null;
  mode: 'new' | 'reauth';
}

export default function TelegramAccountsPage() {
  const accounts = useQuery(() => telegramApi.accounts(), []);
  const status = useQuery(() => telegramApi.status(), []);
  const [message, setMessage] = useState<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardState | null>(null);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');

  const ready = status.data?.ready ?? false;

  const fail = (err: unknown, fallback: string) => {
    setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : fallback });
  };

  const reloadAll = () => {
    accounts.reload();
    status.reload();
  };

  const startLink = async (mode: 'new' | 'reauth', accountId?: string) => {
    setBusy(mode === 'new' ? 'start' : `reauth:${accountId}`);
    setMessage(null);
    try {
      const body = { phoneNumber, ...(label.trim() && mode === 'new' ? { label: label.trim() } : {}) };
      const result =
        mode === 'new' ? await telegramApi.startLink(body) : await telegramApi.reauth(accountId!, { phoneNumber });
      const challenge = 'challenge' in result ? result.challenge : null;
      if (challenge) {
        setWizard({ accountId: challenge.accountId, phoneNumber, stage: challenge.stage, challenge, mode });
        setCode('');
        setPassword('');
        setMessage({
          kind: 'info',
          text: challenge.viaApp
            ? 'أُرسل رمز الدخول إلى تطبيق تيليجرام على جهاز الحساب. أدخل الرمز لإكمال الربط.'
            : 'أُرسل رمز الدخول. أدخله لإكمال الربط.',
        });
      }
      reloadAll();
    } catch (err) {
      fail(err, 'تعذّر بدء الربط.');
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    if (!wizard) return;
    setBusy('verify');
    setMessage(null);
    try {
      const result = await telegramApi.verifyCode(wizard.accountId, { code });
      if (result.status === 'password_required') {
        setWizard({ ...wizard, stage: 'password', challenge: result.challenge });
        setPassword('');
        setMessage({
          kind: 'info',
          text: result.challenge.hint
            ? `هذا الحساب محمي بالتحقق بخطوتين. تلميح كلمة المرور: ${result.challenge.hint}`
            : 'هذا الحساب محمي بالتحقق بخطوتين. أدخل كلمة المرور لإكمال الربط.',
        });
      } else {
        setMessage({ kind: 'success', text: 'تم ربط الحساب وتوصيله بنجاح.' });
        setWizard(null);
        setPhoneNumber('');
        setLabel('');
        reloadAll();
      }
    } catch (err) {
      fail(err, 'تعذّر التحقق من الرمز.');
    } finally {
      setBusy(null);
    }
  };

  const submitPassword = async () => {
    if (!wizard) return;
    setBusy('password');
    setMessage(null);
    try {
      await telegramApi.submitPassword(wizard.accountId, { password });
      setPassword('');
      setWizard(null);
      setPhoneNumber('');
      setMessage({ kind: 'success', text: 'تم ربط الحساب بعد التحقق بخطوتين.' });
      reloadAll();
    } catch (err) {
      fail(err, 'تعذّر التحقق من كلمة المرور.');
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    if (!wizard) return;
    setBusy('resend');
    setMessage(null);
    try {
      const result = await telegramApi.resendCode(wizard.accountId);
      setWizard({ ...wizard, challenge: result.challenge });
      setMessage({ kind: 'success', text: 'أُعيد إرسال الرمز.' });
    } catch (err) {
      fail(err, 'تعذّر إعادة إرسال الرمز.');
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!wizard) return;
    setBusy('cancel');
    try {
      await telegramApi.cancel(wizard.accountId);
      setWizard(null);
      setCode('');
      setPassword('');
      setMessage({ kind: 'info', text: 'أُلغيت محاولة الربط.' });
      reloadAll();
    } catch (err) {
      fail(err, 'تعذّر إلغاء المحاولة.');
    } finally {
      setBusy(null);
    }
  };

  const action = async (id: string, kind: 'connect' | 'disconnect' | 'unlink') => {
    if (kind === 'unlink' && !window.confirm('سيُفصل الحساب وتُحذف جلسته المشفّرة نهائياً. المتابعة؟')) return;
    setBusy(`${kind}:${id}`);
    setMessage(null);
    try {
      if (kind === 'unlink') await telegramApi.unlink(id);
      if (kind === 'connect') await telegramApi.connect(id);
      if (kind === 'disconnect') await telegramApi.disconnect(id);
      setMessage({
        kind: 'success',
        text: kind === 'unlink' ? 'فُصل الحساب وحُذفت جلسته.' : kind === 'connect' ? 'تم طلب الاتصال.' : 'تم فصل الاتصال.',
      });
      reloadAll();
    } catch (err) {
      fail(err, 'تعذّر تنفيذ الإجراء.');
    } finally {
      setBusy(null);
    }
  };

  const beginReauth = (account: TelegramAccount) => {
    setWizard(null);
    setPhoneNumber('');
    setLabel('');
    setMessage({
      kind: 'info',
      text: `أدخل رقم هاتف الحساب «${account.label}» ثم اضغط «إعادة المصادقة».`,
    });
    setBusy(`reauth-form:${account.id}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">حسابات تيليجرام</h1>
          <p className="mt-1 text-sm text-slate-500">
            اربط حساب تيليجرام عادي لقراءة المصادر. الجلسة تُخزَّن مشفّرة في الخادم ولا تُعرض هنا أبداً.
          </p>
        </div>
        <button className="btn-secondary" onClick={() => reloadAll()} disabled={accounts.loading}>
          تحديث
        </button>
      </div>

      {status.data && !ready ? (
        <Alert kind="warning">
          تكامل تيليجرام غير مهيأ على الخادم. يجب ضبط بيانات تطبيق Telegram ومفتاح تشفير الجلسات من مسؤول النظام قبل
          إمكانية الربط. المكتبة المثبتة: {status.data.library.name} {status.data.library.version}
        </Alert>
      ) : null}

      {message ? <Alert kind={message.kind}>{message.text}</Alert> : null}
      {accounts.error ? <Alert kind="error">{accounts.error}</Alert> : null}
      {accounts.loading ? <Spinner /> : null}

      {/* نموذج البدء / إعادة المصادقة */}
      {!wizard ? (
        <section className="card space-y-4">
          <h2 className="text-lg font-semibold text-slate-800">ربط حساب جديد</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="رقم الهاتف" hint="بالصيغة الدولية، مثل +9677xxxxxxxx">
              <input
                className="field-input"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="+9677xxxxxxxx"
                inputMode="tel"
                dir="ltr"
                autoComplete="tel"
              />
            </Field>
            <Field label="اسم الحساب (اختياري)" hint="اسم يظهر لك فقط لتمييز الحساب">
              <input
                className="field-input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="حساب القراءة الأساسي"
                maxLength={120}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              className="btn-primary"
              onClick={() => void startLink('new')}
              disabled={busy !== null || !ready || phoneNumber.trim().length < 8}
            >
              {busy === 'start' ? 'جارٍ الإرسال…' : 'إرسال رمز التحقق'}
            </button>
            {busy?.startsWith('reauth-form:') ? (
              <button
                className="btn-secondary"
                onClick={() => void startLink('reauth', busy.split(':')[1])}
                disabled={phoneNumber.trim().length < 8}
              >
                إعادة المصادقة لهذا الحساب
              </button>
            ) : null}
          </div>
          <p className="text-xs text-slate-500">
            لا يُحفظ رمز التحقق ولا كلمة مرور التحقق بخطوتين في المتصفح أو في الخادم؛ يُستخدمان لإتمام الطلب فقط.
          </p>
        </section>
      ) : (
        <section className="card space-y-4">
          <h2 className="text-lg font-semibold text-slate-800">
            {wizard.stage === 'code' ? 'إدخال رمز الدخول' : 'كلمة مرور التحقق بخطوتين'}
          </h2>
          <p className="text-sm text-slate-500">
            الحساب: <span className="font-mono" dir="ltr">{wizard.phoneNumber}</span> — تنتهي صلاحية المحاولة:{' '}
            {formatDate(wizard.challenge?.expiresAt ?? null)}
          </p>

          {wizard.stage === 'code' ? (
            <div className="space-y-3">
              <Field label="رمز الدخول" hint="الرمز الذي وصلك من تيليجرام">
                <input
                  className="field-input"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 12))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  dir="ltr"
                  maxLength={12}
                />
              </Field>
              <div className="flex flex-wrap gap-3">
                <button className="btn-primary" onClick={() => void verify()} disabled={busy !== null || code.length < 3}>
                  {busy === 'verify' ? 'جارٍ التحقق…' : 'تأكيد الرمز'}
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => void resend()}
                  disabled={busy !== null || (wizard.challenge?.resendsRemaining ?? 0) <= 0}
                >
                  إعادة إرسال الرمز ({(wizard.challenge?.resendsRemaining ?? 0)} متبقية)
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Field
                label="كلمة مرور التحقق بخطوتين"
                hint={wizard.challenge?.hint ? `تلميح: ${wizard.challenge.hint}` : 'كلمة المرور التي أنشأتها في إعدادات تيليجرام'}
              >
                <input
                  className="field-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  maxLength={200}
                />
              </Field>
              <button className="btn-primary" onClick={() => void submitPassword()} disabled={busy !== null || !password}>
                {busy === 'password' ? 'جارٍ التحقق…' : 'إكمال الربط'}
              </button>
            </div>
          )}

          <button className="btn-secondary" onClick={() => void cancel()} disabled={busy !== null}>
            إلغاء المحاولة
          </button>
        </section>
      )}

      {/* قائمة الحسابات */}
      {accounts.data && accounts.data.accounts.length === 0 ? (
        <EmptyState title="لا توجد حسابات مرتبطة" description="ابدأ بإرسال رمز التحقق إلى رقم الحساب الذي تريد ربطه." />
      ) : null}

      <div className="space-y-4">
        {accounts.data?.accounts.map((account) => {
          const badge = statusLabels[account.status];
          const phase = account.connection?.phase ?? 'unknown';
          return (
            <article key={account.id} className="card space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-800">{account.label}</h3>
                  <p className="mt-1 text-xs text-slate-500">
                    رقم ينتهي بـ {account.phoneLastDigits ?? '—'}
                    {account.telegramUsername ? ` · @${account.telegramUsername}` : ''} · أُضيف {formatDate(account.createdAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                  <Badge tone={phase === 'connected' ? 'green' : phase === 'stopped' || phase === 'needs_reauth' ? 'red' : 'slate'}>
                    {phaseLabels[phase] ?? phase}
                  </Badge>
                </div>
              </div>

              <dl className="grid gap-3 text-xs text-slate-600 sm:grid-cols-3">
                <div>
                  <dt className="font-semibold text-slate-500">آخر اتصال</dt>
                  <dd>{formatDate(account.lastConnectedAt)}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-500">رسائل مستلمة في هذه الجلسة</dt>
                  <dd>{account.connection?.receivedMessages ?? 0}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-500">آخر رمز خطأ</dt>
                  <dd dir="ltr">{account.lastErrorCode ?? account.connection?.lastErrorCode ?? '—'}</dd>
                </div>
              </dl>

              {account.connection?.floodWaitSeconds ? (
                <Alert kind="warning">
                  طلب تيليجرام الانتظار {account.connection.floodWaitSeconds} ثانية قبل إعادة المحاولة.
                </Alert>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {phase === 'connected' ? (
                  <button
                    className="btn-secondary"
                    onClick={() => void action(account.id, 'disconnect')}
                    disabled={busy !== null}
                  >
                    فصل الاتصال
                  </button>
                ) : (
                  <button
                    className="btn-secondary"
                    onClick={() => void action(account.id, 'connect')}
                    disabled={busy !== null || account.status === 'pending_login' || account.status === 'suspended'}
                  >
                    توصيل
                  </button>
                )}
                <button className="btn-secondary" onClick={() => beginReauth(account)} disabled={busy !== null}>
                  إعادة المصادقة
                </button>
                <button className="btn-danger" onClick={() => void action(account.id, 'unlink')} disabled={busy !== null}>
                  فصل الحساب وإلغاء الربط
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
