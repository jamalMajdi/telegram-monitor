/**
 * صفحة السجلات والأخطاء (P4-ج): ما حدث في مساحتك، بلا محتوى.
 *
 * - كل صف: النطاق والنوع والرمز والخطورة والوقت — ولا نص رسالة ولا رقم تواصل ولا رمز بوت.
 * - التصفية من الخادم، والتنقّل بالمؤشِّر (لا أرقام صفحات تُخمّن).
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, logsApi, type LogEntry } from '../api/client';
import { Alert, Badge, EmptyState, Spinner, formatDate } from '../components/ui';

const scopeLabels: Record<string, string> = {
  telegram: 'تيليجرام',
  processing: 'المعالجة',
  publishing: 'النشر',
  auth: 'الدخول',
  system: 'النظام',
};

const kindLabels: Record<string, string> = {
  auth_failed: 'فشل مصادقة الحساب',
  connection_failed: 'تعذّر الاتصال',
  flood_wait: 'انتظار إجباري من تيليجرام',
  send_failed: 'فشل إرسال منشور',
  send_retryable: 'إعادة إرسال مجدولة',
  claim_failed: 'تعذّر حجز جزء للإرسال',
  retention_failed: 'فشل سياسة احتفاظ',
};

const severityMeta: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'slate' | 'blue' }> = {
  warn: { label: 'تحذير', tone: 'amber' },
  error: { label: 'خطأ', tone: 'red' },
  critical: { label: 'حرج', tone: 'red' },
};

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [scope, setScope] = useState('');
  const [severity, setSeverity] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextCursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await logsApi.list({
          limit: 25,
          ...(scope ? { scope } : {}),
          ...(severity ? { severity } : {}),
          cursor: nextCursor,
        });
        setLogs(page.logs);
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'تعذّر تحميل السجلات.');
      } finally {
        setLoading(false);
      }
    },
    [scope, severity],
  );

  useEffect(() => {
    setHistory([]);
    void load(null);
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">السجلات والأخطاء</h1>
        <p className="mt-1 text-sm text-slate-500">
          أخطاء الاتصال والمعالجة والنشر الخاصة بك. السجل لا يحتوي أي نص رسالة ولا أرقام تواصل ولا رموز — بالتصميم لا
          بالوعد.
        </p>
      </div>

      <div className="card flex flex-wrap items-end gap-3">
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
        <label className="block">
          <span className="field-label">الخطورة</span>
          <select className="field-input" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">الكل</option>
            <option value="warn">تحذير</option>
            <option value="error">خطأ</option>
            <option value="critical">حرج</option>
          </select>
        </label>
        <button type="button" className="btn-secondary" onClick={() => void load(null)} disabled={loading}>
          تحديث
        </button>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {loading ? <Spinner label="جارٍ تحميل السجلات…" /> : null}

      {!loading && logs.length === 0 ? (
        <EmptyState
          title="لا أخطاء مسجّلة"
          description="هذه أخبار جيدة: لا أخطاء اتصال ولا معالجة ولا نشر مطابقة لتصفيتك."
        />
      ) : null}

      {logs.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[720px] text-right text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">الوقت</th>
                <th className="px-4 py-3">النطاق</th>
                <th className="px-4 py-3">الحدث</th>
                <th className="px-4 py-3">الرمز</th>
                <th className="px-4 py-3">الخطورة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="px-4 py-2 text-xs text-slate-500">{formatDate(log.occurredAt)}</td>
                  <td className="px-4 py-2 text-slate-700">{scopeLabels[log.scope] ?? log.scope}</td>
                  <td className="px-4 py-2 text-slate-700">{kindLabels[log.kind] ?? log.kind}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">{log.code}</td>
                  <td className="px-4 py-2">
                    <Badge tone={severityMeta[log.severity]?.tone ?? 'slate'}>
                      {severityMeta[log.severity]?.label ?? log.severity}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <button
          type="button"
          className="btn-secondary"
          disabled={history.length === 0 || loading}
          onClick={() => {
            const prev = [...history];
            const target = prev.pop() ?? null;
            setHistory(prev);
            void load(target);
          }}
        >
          الصفحة السابقة
        </button>
        <span className="text-xs text-slate-500">الأحدث أولاً · 25 لكل صفحة</span>
        <button
          type="button"
          className="btn-secondary"
          disabled={!cursor || loading}
          onClick={() => {
            setHistory((prev) => [...prev, cursor]);
            void load(cursor);
          }}
        >
          الصفحة التالية
        </button>
      </div>

      <p className="text-xs leading-6 text-slate-500">
        احتفاظ سجل الأخطاء 30 يوماً (سياسة النظام). الأخطاء المجهولة في النشر لا تُعاد تلقائياً، وتحتاج دليلاً بشرياً من
        صفحة النشر.
      </p>
    </div>
  );
}
