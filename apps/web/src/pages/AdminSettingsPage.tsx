import { useEffect, useState } from 'react';
import { ApiError, adminApi } from '../api/client';
import { Alert, Field, Spinner, formatDate } from '../components/ui';
import { useQuery } from '../lib/useQuery';

export default function AdminSettingsPage() {
  const { data, error, loading, reload } = useQuery(() => adminApi.settings(), []);
  const [registrationEnabled, setRegistrationEnabled] = useState<boolean | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  const [state, setState] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    for (const item of data.settings) {
      if (item.key === 'system.registration_enabled') {
        setRegistrationEnabled(Boolean((item.value as { enabled?: boolean }).enabled));
      }
      if (item.key === 'system.default_content_retention_hours') {
        const hours = (item.value as { hours?: number }).hours;
        if (typeof hours === 'number') setRetention(hours);
      }
    }
  }, [data]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setState(null);
    try {
      if (registrationEnabled !== null) {
        await adminApi.updateSetting('system.registration_enabled', { enabled: registrationEnabled });
      }
      if (retention !== null) {
        await adminApi.updateSetting('system.default_content_retention_hours', { hours: retention });
      }
      setState({ kind: 'success', message: 'تم حفظ إعدادات النظام.' });
      reload();
    } catch (err) {
      setState({ kind: 'error', message: err instanceof ApiError ? err.message : 'تعذّر الحفظ.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">إعدادات النظام</h1>
        <p className="mt-1 text-sm text-slate-500">إعدادات عامة يراها كل المستخدمين؛ لا تحتوي أسراراً ولا محتوى.</p>
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {loading ? <Spinner /> : null}
      {state ? <Alert kind={state.kind}>{state.message}</Alert> : null}

      {data ? (
        <>
          <form className="card space-y-4" onSubmit={save}>
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={registrationEnabled ?? false}
                onChange={(e) => setRegistrationEnabled(e.target.checked)}
              />
              <span className="text-sm text-slate-700">السماح بالتسجيل الذاتي لحسابات جديدة</span>
            </label>
            <Field label="مدة الاحتفاظ الافتراضية للمحتوى (ساعات)" hint="تُستخدم لكل حساب جديد؛ بين 1 و2160 ساعة.">
              <input
                className="field-input"
                type="number"
                min={1}
                max={2160}
                value={retention ?? 48}
                onChange={(e) => setRetention(Number(e.target.value))}
              />
            </Field>
            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}
            </button>
          </form>

          <div className="card">
            <h2 className="text-lg font-bold text-slate-800">كل مفاتيح الإعدادات</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2">المفتاح</th>
                    <th className="px-3 py-2">القيمة</th>
                    <th className="px-3 py-2">الوصف</th>
                    <th className="px-3 py-2">آخر تحديث</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.settings.map((s) => (
                    <tr key={s.key}>
                      <td className="px-3 py-2 font-mono text-xs text-slate-700">{s.key}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-600">{JSON.stringify(s.value)}</td>
                      <td className="px-3 py-2 text-slate-600">{s.description ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-500">{formatDate(s.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
