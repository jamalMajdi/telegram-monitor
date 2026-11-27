import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, EmptyState, Spinner, formatDate } from '../components/ui';
import { useQuery } from '../lib/useQuery';
import {
  telegramResultsApi,
  type TelegramPublishState,
  type TelegramResultSummary,
  type TelegramReviewState,
} from '../api/client';

const reviewLabels: Record<TelegramReviewState, { label: string; tone: 'green' | 'amber' | 'slate' }> = {
  none: { label: 'بلا مراجعة', tone: 'slate' },
  needs_review: { label: 'تحتاج مراجعة', tone: 'amber' },
  reviewed: { label: 'روجعت', tone: 'green' },
};

const PAGE_SIZE = 25;

const publishStateLabels: Record<string, { label: string; tone: 'green' | 'amber' | 'slate' | 'blue' }> = {
  not_routed: { label: 'لم يُوجَّه', tone: 'slate' },
  routed: { label: 'موجَّه للنشر', tone: 'blue' },
  awaiting_review: { label: 'بانتظار مراجعة', tone: 'amber' },
};

export default function TelegramResultsPage() {
  const [review, setReview] = useState<TelegramReviewState | ''>('needs_review');
  const [classificationId, setClassificationId] = useState('');
  const [publishState, setPublishState] = useState<TelegramPublishState | ''>('');
  // الترقيم مؤشِّر (P4-هـ): نُخزّن مسار المؤشِّرات لنعود للخلف بلا حسابات صفحة.
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [rows, setRows] = useState<TelegramResultSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const classifications = useQuery(() => telegramResultsApi.classifications(), []);

  const load = useCallback(
    async (target: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await telegramResultsApi.list({
          ...(review ? { review } : {}),
          ...(classificationId ? { classificationId } : {}),
          ...(publishState ? { publishState } : {}),
          limit: PAGE_SIZE,
          cursor: target,
        });
        setRows(page.results);
        setNextCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'تعذّر تحميل النتائج.');
      } finally {
        setLoading(false);
      }
    },
    [review, classificationId, publishState],
  );

  useEffect(() => {
    setHistory([]);
    setCursor(null);
    void load(null);
  }, [load, reloadKey]);

  const goNext = (): void => {
    if (!nextCursor) return;
    setHistory((prev) => [...prev, cursor]);
    setCursor(nextCursor);
    void load(nextCursor);
  };

  const goPrev = (): void => {
    if (history.length === 0) return;
    const copy = [...history];
    const target = copy.pop() ?? null;
    setHistory(copy);
    setCursor(target);
    void load(target);
  };

  const classificationOptions = useMemo(
    () => (classifications.data?.classifications ?? []).filter((item) => item.enabled),
    [classifications.data],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">نتائج المعالجة والمراجعة</h1>
          <p className="mt-1 text-sm text-slate-500">
            الرسائل التي طابقت الفلاتر، مع تصنيفها وقالبها. تُعرض قيم التواصل <strong>محجوبة دائماً</strong>، والنص
            الأصلي يظهر مقنَّعاً في مواضع التواصل.
          </p>
        </div>
        <button className="btn-secondary" onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
          تحديث
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-slate-600">
          حالة المراجعة
          <select
            className="input mt-1 block"
            value={review}
            onChange={(event) => setReview(event.target.value as TelegramReviewState | '')}
          >
            <option value="needs_review">تحتاج مراجعة</option>
            <option value="reviewed">روجعت</option>
            <option value="none">بلا مراجعة</option>
            <option value="">الكل</option>
          </select>
        </label>
        <label className="text-sm text-slate-600">
          التصنيف
          <select
            className="input mt-1 block"
            value={classificationId}
            onChange={(event) => setClassificationId(event.target.value)}
          >
            <option value="">كل التصنيفات</option>
            {classificationOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-3 block max-w-xs text-sm text-slate-600">
        حالة النشر
        <select
          className="input mt-1 block"
          value={publishState}
          onChange={(event) => setPublishState(event.target.value as TelegramPublishState | '')}
        >
          <option value="">كل الحالات</option>
          <option value="routed">موجَّه للنشر</option>
          <option value="awaiting_review">بانتظار مراجعة</option>
          <option value="not_routed">لم يُوجَّه</option>
        </select>
      </label>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {loading ? <Spinner /> : null}

      {!loading && rows.length === 0 ? (
        <EmptyState
          title="لا توجد نتائج مطابقة لهذا الفلتر"
          description="ستظهر هنا الرسائل التي اجتازت الفلترة والاستخراج. إن كانت المصادر جديدة فقد تحتاج رسالة مطابقة واحدة على الأقل."
        />
      ) : null}

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3 text-start font-medium">وقت الوصول</th>
                <th className="px-4 py-3 text-start font-medium">المصدر</th>
                <th className="px-4 py-3 text-start font-medium">التصنيف</th>
                <th className="px-4 py-3 text-start font-medium">القالب</th>
                <th className="px-4 py-3 text-start font-medium">المراجعة</th>
                <th className="px-4 py-3 text-start font-medium">النشر</th>
                <th className="px-4 py-3 text-start font-medium">التواصل</th>
                <th className="px-4 py-3 text-start font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.identityId}>
                  <td className="px-4 py-3 text-xs text-slate-600">{formatDate(row.receivedAt)}</td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">{row.sourceTitle}</p>
                    {row.isRepeat ? (
                      <span className="text-xs text-amber-700">محتوى مكرّر (تعليم فقط)</span>
                    ) : null}
                    {!row.contentAvailable ? (
                      <span className="text-xs text-slate-400">انتهت مدة احتفاظ المحتوى</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-slate-800">{row.classificationName ?? 'غير مصنف'}</p>
                    <p className="text-xs text-slate-500">
                      {row.classificationOrigin === 'manual' ? 'يدوي' : row.classificationOrigin === 'automatic' ? 'تلقائي' : '—'}
                      {row.classificationConfidence !== null
                        ? ` · ثقة ${Math.round(row.classificationConfidence * 100)}%`
                        : ''}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {row.templateName ?? 'لا قالب'}
                    <br />
                    <span className="text-slate-400">{row.resolvedBy ?? '—'}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={reviewLabels[row.reviewState].tone}>{reviewLabels[row.reviewState].label}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={publishStateLabels[row.publishState]?.tone ?? 'slate'}>
                      {publishStateLabels[row.publishState]?.label ?? row.publishState}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs" dir="ltr">
                    {row.contactCount}
                  </td>
                  <td className="px-4 py-3 text-end">
                    <Link className="text-sm font-medium text-brand-700 hover:underline" to={`/telegram/results/${row.identityId}`}>
                      التفاصيل
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex items-center justify-between text-sm text-slate-600">
        <span className="text-xs text-slate-500">
          الترقيم مؤشِّر: الصفحة ثابتة مهما وصلت رسائل جديدة أثناء التنقّل (P4-هـ).
        </span>
        <div className="flex gap-2">
          <button
            className="btn-secondary"
            onClick={goPrev}
            disabled={history.length === 0 || loading}
          >
            السابق
          </button>
          <button className="btn-secondary" onClick={goNext} disabled={!nextCursor || loading}>
            التالي
          </button>
        </div>
      </div>
    </div>
  );
}
