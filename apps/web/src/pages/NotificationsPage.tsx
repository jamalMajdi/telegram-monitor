import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, EmptyState, Spinner, formatDate } from '../components/ui';
import {
  notificationsApi,
  type AlertNotification,
  type NotificationCounts,
  type NotificationSeverity,
  type NotificationStatusFilter,
} from '../api/client';

/**
 * مركز التنبيهات (P4-و).
 *
 * المبدأ: الصف يحمل `key` آلياً فقط، والجملة العربية تأتي من هذه الخريطة لا من الخادم.
 * كل تنبيه يقود إلى المكان الذي يُحلّ فيه (وجهة، نتائج، حسابات).
 */
const alertLabels: Record<
  string,
  { title: string; body: (n: AlertNotification) => string; href: string; action: string }
> = {
  publish_worker_stale: {
    title: 'عامل النشر متوقف',
    body: (n) =>
      n.payload.workerState === 'missing'
        ? 'لم يُسجَّل أي نبض لعامل النشر بعد — لا شيء يُرسل حالياً.'
        : `آخر نبض لعامل النشر قبل ${n.payload.lastSeenSeconds ?? '؟'} ثانية — الإرسال متوقف أو متأخر.`,
    href: '/telegram/publish',
    action: 'مراجعة النشر',
  },
  uncertain_delivery: {
    title: 'نتائج نشر مجهولة تنتظر دليلاً',
    body: (n) =>
      `${n.observedCount} تسليم نتيجته مجهولة (قد تكون وصلت). لا إعادة تلقائية ولا يدوية قبل تسجيل دليل.`,
    href: '/telegram/publish',
    action: 'تسجيل دليل',
  },
  needs_reauth: {
    title: 'حساب تيليجرام يحتاج إعادة تسجيل الدخول',
    body: (n) => `${n.observedCount} حساب متوقف عن المراقبة حتى تعيد الربط.`,
    href: '/telegram',
    action: 'إعادة الربط',
  },
  awaiting_review: {
    title: 'تسليمات بانتظار مراجعتك',
    body: (n) => `${n.observedCount} تسليم لن يُرسل قبل موافقتك.`,
    href: '/telegram/publish',
    action: 'مراجعة الآن',
  },
  destination_failures: {
    title: 'وجهة نشر تتعرض لإخفاقات متكررة',
    body: (n) =>
      n.observedCount > 1
        ? `${n.observedCount} وجهات فشلت آخر ${n.payload.threshold ?? 3} تسليمات متتالية. راجع صلاحية البوت والصلاحيات في الوجهة.`
        : `وجهة فشلت آخر ${n.payload.threshold ?? 3} تسليمات متتالية. راجع صلاحية البوت والصلاحيات في الوجهة.`,
    href: '/telegram/publish',
    action: 'فحص الوجهات',
  },
  no_source: {
    title: 'لا مصدر مراقَب',
    body: () => 'أضف قناة أو مجموعة لتبدأ المراقبة.',
    href: '/telegram/sources',
    action: 'إضافة مصدر',
  },
  no_destination: {
    title: 'لا وجهة نشر فعّالة',
    body: () => 'أضف قناة نشر واربطها بمسار حتى تصل النتائج.',
    href: '/telegram/publish',
    action: 'إضافة وجهة',
  },
};

const severityLabels: Record<NotificationSeverity, { label: string; tone: 'red' | 'amber' | 'blue' }> = {
  critical: { label: 'حرج', tone: 'red' },
  warning: { label: 'تحذير', tone: 'amber' },
  info: { label: 'إرشادي', tone: 'blue' },
};

const PAGE_SIZE = 20;

export default function NotificationsPage() {
  const [status, setStatus] = useState<NotificationStatusFilter>('open');
  const [rows, setRows] = useState<AlertNotification[]>([]);
  const [counts, setCounts] = useState<NotificationCounts | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [page, badge] = await Promise.all([
        notificationsApi.list({ status, limit: PAGE_SIZE }),
        notificationsApi.counts(),
      ]);
      setRows(page.notifications);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
      setCounts(badge.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر تحميل التنبيهات.');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async (): Promise<void> => {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await notificationsApi.list({ status, limit: PAGE_SIZE, cursor });
      setRows((prev) => [...prev, ...page.notifications]);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر تحميل المزيد.');
    } finally {
      setLoading(false);
    }
  };

  const runAction = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر إكمال الإجراء.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500">الرئيسية / التنبيهات</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-800">مركز التنبيهات</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            كل تنبيه مشتق من حالة حقيقية في نظامك (لا تنبيهات مُلفَّقة). «الاعتراف» لا يُغلق التنبيه:
            يبقى ظاهراً حتى تزول السبب، ويعود غير معترَف به إذا تفاقمت الخطورة.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {counts ? (
            <>
              <Badge tone="red">حرج: {counts.critical}</Badge>
              <Badge tone="amber">تحذير: {counts.warning}</Badge>
              <Badge tone="blue">إرشادي: {counts.info}</Badge>
              <Badge tone="slate">غير معترَف به: {counts.unacknowledged}</Badge>
            </>
          ) : null}
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || (counts?.unacknowledged ?? 0) === 0}
            onClick={() =>
              void runAction(async () => {
                const result = await notificationsApi.acknowledgeAll();
                return `تم الاعتراف بـ${result.acknowledged} تنبيهاً.`;
              })
            }
          >
            اعتراف بالكل
          </button>
          <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
            تحديث
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ['open', 'النشطة'],
            ['acknowledged', 'المعترَف بها'],
            ['all', 'الكل (سجل)'],
          ] as [NotificationStatusFilter, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={status === value ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setStatus(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      {loading && rows.length === 0 ? <Spinner /> : null}

      {!loading && rows.length === 0 ? (
        <EmptyState
          title="لا تنبيهات"
          description={
            status === 'open'
              ? 'كل شيء سليم الآن. سيظهر هنا أي تعطّل أو تراكم يحتاج تدخّلك.'
              : 'لا سجل مطابق في هذه الحالة.'
          }
        />
      ) : null}

      <div className="space-y-3">
        {rows.map((row) => {
          const meta = alertLabels[row.key];
          const severity = severityLabels[row.severity];
          const acknowledged = row.acknowledgedAt !== null;
          return (
            <article
              key={row.id}
              className={`card space-y-2 border-s-4 ${
                row.severity === 'critical'
                  ? 'border-s-rose-500'
                  : row.severity === 'warning'
                    ? 'border-s-amber-400'
                    : 'border-s-sky-400'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={severity.tone}>{severity.label}</Badge>
                  <h2 className="text-sm font-semibold text-slate-800">{meta?.title ?? row.key}</h2>
                  {row.resolvedAt ? <Badge tone="green">محلول</Badge> : null}
                  {acknowledged ? <Badge tone="slate">معترَف به</Badge> : null}
                  {row.occurrences > 1 ? (
                    <span className="text-xs text-slate-500">تكرّر تصعيده {row.occurrences - 1} مرة</span>
                  ) : null}
                </div>
                <span className="text-xs text-slate-500">آخر رصد: {formatDate(row.lastSeenAt)}</span>
              </div>
              <p className="text-sm text-slate-600">
                {meta ? meta.body(row) : `${row.observedCount} عنصر متأثر.`}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {meta ? (
                  <Link className="btn-secondary" to={meta.href}>
                    {meta.action}
                  </Link>
                ) : null}
                {!acknowledged && !row.resolvedAt ? (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy}
                    onClick={() =>
                      void runAction(async () => {
                        await notificationsApi.acknowledge(row.id);
                        return 'تم تسجيل اعترافك بالتنبيه.';
                      })
                    }
                  >
                    اعتراف
                  </button>
                ) : null}
                {acknowledged ? (
                  <span className="text-xs text-slate-500">اعتُرف به: {formatDate(row.acknowledgedAt)}</span>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      {hasMore ? (
        <div className="flex justify-center">
          <button type="button" className="btn-secondary" onClick={() => void loadMore()} disabled={loading}>
            تحميل المزيد
          </button>
        </div>
      ) : null}
    </div>
  );
}
