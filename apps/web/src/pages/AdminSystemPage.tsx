/**
 * صفحة التشغيل والمقاييس (P4-ب): للمدير فقط — §13.
 *
 * - بيانات تشغيلية مجمّعة فقط: لا محتوى رسائل، ولا رموز، ولا عناوين محادثات (D07).
 * - حالة العامل من نبض مسجَّل في قاعدة البيانات لا من ذاكرة المتصفح.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminApi, ApiError, type OpsMetrics } from '../api/client';
import { Alert, Badge, EmptyState, Spinner, formatDate } from '../components/ui';

const workerLabels: Record<OpsMetrics['publishWorker']['state'], { label: string; tone: 'green' | 'amber' | 'red' }> = {
  ok: { label: 'يعمل', tone: 'green' },
  stale: { label: 'متوقف عن النبض', tone: 'amber' },
  missing: { label: 'لا نبض مسجَّل', tone: 'red' },
};

export default function AdminSystemPage() {
  const [metrics, setMetrics] = useState<OpsMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMetrics((await adminApi.metrics()).metrics);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذّر تحميل المقاييس.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner label="جارٍ قراءة المقاييس…" />;

  const worker = metrics ? workerLabels[metrics.publishWorker.state] : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">التشغيل والمقاييس</h1>
          <p className="mt-1 text-sm text-slate-500">
            صحة قاعدة البيانات، عامل النشر، عمق الطابور، ونوافذ النشر والمحاولات — بلا أي محتوى مستخدمين.
          </p>
        </div>
        <button type="button" className="btn-secondary text-xs" onClick={() => void load()}>
          تحديث
        </button>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {metrics ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="card">
              <p className="text-xs font-medium text-slate-500">قاعدة البيانات</p>
              <p className="mt-1 text-2xl font-bold text-slate-800">
                {metrics.database.ok ? 'سليمة' : 'غير متاحة'}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                زمن الفحص: {metrics.database.latencyMs ?? '—'} مللي ثانية
              </p>
            </div>
            <div className="card">
              <p className="text-xs font-medium text-slate-500">عامل النشر</p>
              <p className="mt-1 flex items-center gap-2 text-2xl font-bold text-slate-800">
                {worker ? <Badge tone={worker.tone}>{worker.label}</Badge> : '—'}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                آخر نبض: {metrics.publishWorker.lastSeenSeconds === null ? 'لا يوجد' : `قبل ${metrics.publishWorker.lastSeenSeconds} ثانية`} · العتبة{' '}
                {metrics.staleAfterSeconds} ثانية
              </p>
            </div>
            <div className="card">
              <p className="text-xs font-medium text-slate-500">أجزاء معلّقة في الطابور</p>
              <p className="mt-1 text-2xl font-bold text-slate-800">{metrics.queue.pendingParts}</p>
              <p className="mt-1 text-xs text-slate-500">
                أقدم جزء: {metrics.queue.oldestPendingAgeSeconds === null ? '—' : `قبل ${Math.round(metrics.queue.oldestPendingAgeSeconds / 60)} دقيقة`}
              </p>
            </div>
            <div className="card">
              <p className="text-xs font-medium text-slate-500">حسابات تيليجرام</p>
              <p className="mt-1 text-2xl font-bold text-slate-800">
                {metrics.ingest.accountsActive} / {metrics.ingest.accountsTotal}
              </p>
              <p className="mt-1 text-xs text-slate-500">تحتاج إعادة دخول: {metrics.ingest.accountsNeedsReauth}</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <section className="card">
              <h2 className="card-title">التسليمات (24 ساعة)</h2>
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                <li>منشورة: {metrics.deliveries24h.published}</li>
                <li>فاشلة: {metrics.deliveries24h.failed}</li>
                <li className="font-semibold text-amber-700">مجهولة (تحتاج دليلاً): {metrics.deliveries24h.uncertain}</li>
                <li>جزئية: {metrics.deliveries24h.partial}</li>
                <li>محجوبة: {metrics.deliveries24h.blocked}</li>
              </ul>
            </section>
            <section className="card">
              <h2 className="card-title">محاولات الإرسال (ساعة)</h2>
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                <li>الإجمالي: {metrics.attempts1h.total}</li>
                <li>قابلة للإعادة (429): {metrics.attempts1h.retryable}</li>
                <li>فشل نهائي: {metrics.attempts1h.permanent}</li>
                <li className="font-semibold text-amber-700">مجهولة: {metrics.attempts1h.uncertain}</li>
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                آخر رسالة مستلمة: {metrics.ingest.lastMessageAt ? formatDate(metrics.ingest.lastMessageAt) : 'لا توجد'} · خلال 24 ساعة:{' '}
                {metrics.ingest.messagesLast24h}
              </p>
            </section>
          </div>

          <section className="card">
            <h2 className="card-title">نبض المهام</h2>
            {metrics.heartbeats.length === 0 ? (
              <EmptyState title="لا نبض مسجَّل" description="العامل لم يبدأ بعد، أو أن النبض معطَّل بهذه البيئة." />
            ) : (
              <table className="table mt-2">
                <thead>
                  <tr>
                    <th>المهمة</th>
                    <th>النسخة</th>
                    <th>آخر نبض</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.heartbeats.map((beat) => (
                    <tr key={`${beat.name}-${beat.instance}`}>
                      <td className="text-sm">{beat.name}</td>
                      <td className="text-xs text-slate-500">{beat.instance}</td>
                      <td className="text-xs text-slate-500">قبل {beat.lastSeenSeconds} ثانية</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <p className="text-xs text-slate-500">آخر فحص: {formatDate(metrics.checkedAt)}</p>
        </>
      ) : null}
    </div>
  );
}
