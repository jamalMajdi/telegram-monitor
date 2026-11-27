/**
 * الصفحة الرئيسية (P4-أ): ملخص حالة النظام لمالكه — §12.1.
 *
 * - كل رقم من الخادم (نموذج قراءة)، ولا يُحسب في المتصفح.
 * - لا محتوى رسائل ولا قيم تواصل: أعداد وتواريخ وتنبيهات فقط (D07/O03).
 * - التنبيهات مشتقّة من الأرقام نفسها، ولكل تنبيه رابط إصلاح مباشر.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError, dashboardApi, type DashboardActivityItem, type DashboardSummary } from '../api/client';
import { Alert, Badge, EmptyState, Spinner, formatDate } from '../components/ui';

const severityTone = {
  critical: 'red',
  warning: 'amber',
  info: 'blue',
} as const;

function labelOfAction(action: string): string {
  const map: Record<string, string> = {
    'publishing.route_created': 'إنشاء مسار نشر',
    'publishing.route_activated': 'تفعيل مسار نشر',
    'publishing.route_deactivated': 'تعطيل مسار نشر',
    'publishing.delivery_approved': 'اعتماد تسليم',
    'publishing.delivery_rejected': 'رفض تسليم',
    'publishing.delivery_evidence': 'تسجيل دليل على نتيجة مجهولة',
    'telegram.account_linked': 'ربط حساب تيليجرام',
    'telegram.source_added': 'إضافة مصدر',
    'telegram.connections_restored': 'استعادة اتصالات تيليجرام',
  };
  return map[action] ?? action;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [activity, setActivity] = useState<DashboardActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (fresh = false) => {
    setError(null);
    try {
      const [summaryRes, activityRes] = await Promise.all([dashboardApi.summary(fresh), dashboardApi.activity(10)]);
      setSummary(summaryRes.summary);
      setActivity(activityRes.activity);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذّر تحميل ملخص اللوحة.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner label="جارٍ تحميل حالة مساحتك…" />;

  const counts = summary?.counts;

  const cards: { label: string; value: string; hint: string; to?: string }[] = counts
    ? [
        {
          label: 'حساب تيليجرام',
          value: counts.telegram.active > 0 ? 'متصل' : counts.telegram.accounts > 0 ? 'يحتاج متابعة' : 'غير مرتبط',
          hint: `${counts.telegram.accounts} حساب · ${counts.telegram.active} نشط`,
          to: '/telegram',
        },
        {
          label: 'المصادر النشطة',
          value: `${counts.sources.active} / ${counts.sources.total}`,
          hint: `${counts.sources.paused} موقوف`,
          to: '/telegram/sources',
        },
        { label: 'الفلاتر', value: `${counts.filters.active}`, hint: `من ${counts.filters.total}`, to: '/telegram/sources' },
        { label: 'قوالب النشر', value: `${counts.templates.total}`, hint: 'جاهزة للتخصيص' },
        { label: 'قنوات النشر', value: `${counts.destinations.active} / ${counts.destinations.total}`, hint: 'فعّالة', to: '/telegram/publish' },
        {
          label: 'رسائل مطابقة',
          value: `${counts.messages.matchedTotal}`,
          hint: `${counts.messages.matchedLast24h} خلال 24 ساعة`,
          to: '/telegram/results',
        },
        {
          label: 'رسائل منشورة',
          value: `${counts.deliveries.published}`,
          hint: `${counts.deliveries.publishedLast24h} خلال 24 ساعة`,
          to: '/telegram/publish',
        },
        {
          label: 'تسليمات تحتاج انتباهاً',
          value: `${counts.deliveries.failed + counts.deliveries.uncertain + counts.deliveries.blocked}`,
          hint: `فاشلة ${counts.deliveries.failed} · مجهولة ${counts.deliveries.uncertain} · محجوبة ${counts.deliveries.blocked}`,
          to: '/telegram/publish',
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">مرحباً، {user?.displayName}</h1>
          <p className="mt-1 text-sm text-slate-500">
            ملخص مساحتك: الالتقاط والفلترة والنشر. الأرقام من قاعدة البيانات مباشرة، ولا تُعرض أي نصوص رسائل.
          </p>
        </div>
        <button type="button" className="btn-secondary text-xs" onClick={() => void load(true)}>
          تحديث الآن
        </button>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {summary && summary.alerts.length > 0 ? (
        <div className="space-y-2">
          {summary.alerts.map((alert) => (
            <div key={alert.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3">
              <div className="flex items-center gap-3">
                <Badge tone={severityTone[alert.severity]}>{alert.severity === 'critical' ? 'حرج' : alert.severity === 'warning' ? 'تحذير' : 'معلومة'}</Badge>
                <p className="text-sm text-slate-700">{alert.message}</p>
              </div>
              <Link to={alert.href} className="text-xs font-semibold text-brand-700 hover:underline">
                معالجة
              </Link>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="card">
            <p className="text-xs font-medium text-slate-500">{card.label}</p>
            <p className="mt-1 text-2xl font-bold text-slate-800">{card.value}</p>
            <p className="mt-1 text-xs text-slate-500">{card.hint}</p>
            {card.to ? (
              <Link to={card.to} className="mt-2 inline-block text-xs font-semibold text-brand-700 hover:underline">
                فتح
              </Link>
            ) : null}
          </div>
        ))}
      </div>

      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="card-title">آخر العمليات</h2>
          <span className="text-xs text-slate-400">
            {summary ? `أُنشئ الملخص ${formatDate(summary.generatedAt)}${summary.cached ? ' (من الذاكرة القصيرة)' : ''}` : null}
          </span>
        </div>
        {activity.length === 0 ? (
          <EmptyState title="لا عمليات بعد" description="ستظهر هنا عملياتك: إنشاء المسارات، اعتماد التسليمات، وربط الحسابات." />
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {activity.map((item) => (
              <li key={`${item.action}-${item.occurredAt}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-slate-700">{labelOfAction(item.action)}</span>
                  {item.outcome !== 'success' ? <Badge tone="red">{item.outcome}</Badge> : null}
                </div>
                <span className="text-xs text-slate-500">{formatDate(item.occurredAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {counts ? (
        <section className="card">
          <h2 className="card-title">حدود يجب معرفتها</h2>
          <ul className="mt-2 space-y-1 text-xs leading-6 text-slate-600">
            <li>• المراقبة تشمل الرسائل الجديدة فقط؛ لا قراءة للتاريخ السابق ولا استرجاع للفجوات.</li>
            <li>• النص فقط مدعوم؛ الوسائط والملفات لا تُحمَّل ولا تُحلَّل.</li>
            <li>• بيانات التواصل تُعرض دائماً محجوبة، حتى في المنشورات.</li>
            <li>
              • آخر رسالة مستلمة: {counts.messages.lastSeenAt ? formatDate(counts.messages.lastSeenAt) : 'لا توجد بعد'} · آخر اتصال
              بالحساب: {counts.telegram.lastConnectedAt ? formatDate(counts.telegram.lastConnectedAt) : 'غير معروف'}
            </li>
          </ul>
        </section>
      ) : null}
    </div>
  );
}
