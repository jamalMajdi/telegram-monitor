/**
 * صفحة أخطاء النظام والتشغيل للمدير (P4-ج + P4-د).
 *
 * - تجميع فقط: النطاق والنوع والرمز والعدد وعدد المستخدمين المتأثرين — بلا هوية مستخدم وبلا محتوى (Q24).
 * - سجل تشغيل الاحتفاظ: ماذا نُظِّف، متى، وكم — إثبات لا ادّعاء.
 * - تشغيل دورة تنظيف يدوياً يتطلب سبباً مكتوباً ويُدقَّق.
 */
import { useState } from 'react';
import { adminApi, ApiError } from '../api/client';
import { Alert, Badge, EmptyState, Spinner, formatDate } from '../components/ui';
import { useQuery } from '../lib/useQuery';

const scopeLabels: Record<string, string> = {
  telegram: 'تيليجرام',
  processing: 'المعالجة',
  publishing: 'النشر',
  auth: 'الدخول',
  system: 'النظام',
};

const policyLabels: Record<string, string> = {
  content: 'محتوى الرسائل',
  identities: 'هويات الرسائل',
  deliveries: 'سجلات النشر',
  error_events: 'سجل الأخطاء',
  audit_events: 'سجل التدقيق',
};

const severityTone: Record<string, 'green' | 'amber' | 'red' | 'slate' | 'blue'> = {
  warn: 'amber',
  error: 'red',
  critical: 'red',
};

export default function AdminLogsPage() {
  const [windowHours, setWindowHours] = useState(24);
  const [scope, setScope] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [runState, setRunState] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  const errors = useQuery(
    () => adminApi.errors({ windowHours, ...(scope ? { scope } : {}) }),
    [windowHours, scope],
  );
  const runs = useQuery(() => adminApi.retentionRuns(20), []);

  const runNow = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setRunState(null);
    try {
      const result = await adminApi.runRetention({ reason });
      setReason('');
      setRunState({
        kind: 'success',
        message: `نُفِّذت ${result.result.runs.length} سياسات، وحُذف ${result.result.totalDeleted} صفاً.`,
      });
      runs.reload();
    } catch (err) {
      setRunState({ kind: 'error', message: err instanceof ApiError ? err.message : 'تعذّر تشغيل التنظيف.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">أخطاء النظام والاحتفاظ</h1>
        <p className="mt-1 text-sm text-slate-500">
          تجميع بلا هوية مستخدم وبلا محتوى: كم مرة، وأين، ومتى — لا ماذا كُتب.
        </p>
      </div>

      <div className="card flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="field-label">النافذة الزمنية</span>
          <select className="field-input" value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value))}>
            <option value={1}>ساعة</option>
            <option value={24}>24 ساعة</option>
            <option value={168}>7 أيام</option>
            <option value={720}>30 يوماً</option>
          </select>
        </label>
        <label className="block">
          <span className="field-label">النطاق</span>
          <select className="field-input" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">الكل</option>
            {Object.entries(scopeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-secondary" onClick={errors.reload} disabled={errors.loading}>
          تحديث
        </button>
      </div>

      {errors.error ? <Alert kind="error">{errors.error}</Alert> : null}
      {errors.loading ? <Spinner label="جارٍ تحميل الأخطاء…" /> : null}

      {errors.data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="card">
              <p className="text-xs text-slate-500">إجمالي الأحداث</p>
              <p className="mt-1 text-2xl font-bold text-slate-800">{errors.data.errors.totals.total}</p>
            </div>
            <div className="card">
              <p className="text-xs text-slate-500">أحداث حرجة</p>
              <p className="mt-1 text-2xl font-bold text-rose-700">{errors.data.errors.totals.critical}</p>
            </div>
            <div className="card">
              <p className="text-xs text-slate-500">النافذة</p>
              <p className="mt-1 text-2xl font-bold text-slate-800">{errors.data.errors.windowHours} ساعة</p>
              <p className="mt-1 text-xs text-slate-500">
                {Object.entries(errors.data.errors.totals.byScope)
                  .map(([key, value]) => `${scopeLabels[key] ?? key}: ${value}`)
                  .join(' · ') || 'لا أحداث'}
              </p>
            </div>
          </div>

          {errors.data.errors.groups.length === 0 ? (
            <EmptyState title="لا أخطاء في هذه النافذة" description="جرّب توسيع النافذة الزمنية أو إزالة تصفية النطاق." />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[720px] text-right text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-3">النطاق</th>
                    <th className="px-4 py-3">الحدث</th>
                    <th className="px-4 py-3">الرمز</th>
                    <th className="px-4 py-3">الخطورة</th>
                    <th className="px-4 py-3">العدد</th>
                    <th className="px-4 py-3">مستخدمون متأثرون</th>
                    <th className="px-4 py-3">آخر ظهور</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {errors.data.errors.groups.map((group) => (
                    <tr key={`${group.scope}-${group.kind}-${group.code}`}>
                      <td className="px-4 py-2">{scopeLabels[group.scope] ?? group.scope}</td>
                      <td className="px-4 py-2 text-slate-700">{group.kind}</td>
                      <td className="px-4 py-2 font-mono text-xs">{group.code}</td>
                      <td className="px-4 py-2">
                        <Badge tone={severityTone[group.severity] ?? 'slate'}>{group.severity}</Badge>
                      </td>
                      <td className="px-4 py-2 font-semibold">{group.occurrences}</td>
                      <td className="px-4 py-2">{group.affectedUsers}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{formatDate(group.lastOccurredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      <section className="card">
        <h2 className="text-lg font-bold text-slate-800">تشغيل سياسات الاحتفاظ الآن</h2>
        <p className="mt-1 text-xs leading-6 text-slate-500">
          المشغّل الدوري يعمل كل ساعة داخل العملية. التشغيل اليدوي يحتاج سبباً مكتوباً ويُسجَّل في التدقيق.
        </p>
        <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={runNow}>
          <label className="block flex-1">
            <span className="field-label">سبب التشغيل</span>
            <input
              className="field-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={3}
              maxLength={300}
              required
              placeholder="مثال: تنظيف عاجل بعد استيراد خاطئ"
            />
          </label>
          <button className="btn-primary" type="submit" disabled={busy || reason.trim().length < 3}>
            {busy ? 'جارٍ التشغيل…' : 'تشغيل الآن'}
          </button>
        </form>
        {runState ? (
          <div className="mt-3">
            <Alert kind={runState.kind}>{runState.message}</Alert>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2 className="text-lg font-bold text-slate-800">آخر تشغيلات التنظيف</h2>
        {runs.error ? <Alert kind="error">{runs.error}</Alert> : null}
        {runs.loading ? <Spinner /> : null}
        {runs.data && runs.data.runs.length === 0 ? (
          <EmptyState title="لا تشغيلات بعد" description="أول دورة دورية ستظهر هنا بعد ساعة من الإقلاع." />
        ) : null}
        {runs.data && runs.data.runs.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-right text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3">السياسة</th>
                  <th className="px-4 py-3">المصدر</th>
                  <th className="px-4 py-3">حُذف</th>
                  <th className="px-4 py-3">البداية</th>
                  <th className="px-4 py-3">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {runs.data.runs.map((run) => (
                  <tr key={run.id}>
                    <td className="px-4 py-2">{policyLabels[run.policy] ?? run.policy}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {run.triggeredBy === 'admin' ? 'مدير' : run.triggeredBy === 'user' ? 'مستخدم' : 'دوري'}
                    </td>
                    <td className="px-4 py-2 font-semibold">{run.deleted}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{formatDate(run.startedAt)}</td>
                    <td className="px-4 py-2">
                      {run.errorCode ? <Badge tone="red">{run.errorCode}</Badge> : <Badge tone="green">تم</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
