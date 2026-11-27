import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Badge, ConfirmDialog, Spinner, formatDate } from '../components/ui';
import { useQuery } from '../lib/useQuery';
import { telegramResultsApi, type JourneyEvent } from '../api/client';

const contactKindLabels: Record<string, string> = {
  phone: 'هاتف',
  username: 'اسم مستخدم',
  telegram_id: 'معرّف تيليجرام',
  email: 'بريد إلكتروني',
  url: 'رابط',
  invite_link: 'رابط دعوة',
};

const resolvedByLabels: Record<string, string> = {
  route: 'قالب مسار النشر (مؤجَّل)',
  source: 'تخصيص المصدر',
  filter: 'الفلتر',
  classification: 'التصنيف',
  default: 'القالب الافتراضي',
  none: 'لا قالب',
};

const stageLabels: Record<JourneyEvent['stage'], string> = {
  processing: 'المعالجة',
  filtering: 'الفلترة',
  classification: 'التصنيف والقالب',
  routing: 'التوجيه',
  publishing: 'النشر',
  review: 'المراجعة البشرية',
};

const eventLabels: Record<string, string> = {
  received: 'وصلت الرسالة',
  filter_matched: 'طابق فلتراً',
  classified: 'صُنّفت',
  template_resolved: 'حُدِّد القالب',
  delivery_created: 'أُنشئ تسليم',
  delivery_published: 'نُشر في الوجهة',
  delivery_failed: 'فشل التسليم',
  delivery_uncertain: 'نتيجة مجهولة (تحتاج دليلاً)',
  delivery_blocked: 'حُجب التسليم',
  delivery_cancelled: 'أُلغي التسليم',
  delivery_republished: 'أُعيد التخطيط للنشر',
  'review.pending': 'بانتظار مراجعة',
  'review.approved': 'اعتُمد',
  'review.rejected': 'رُفض',
  'review.not_required': 'لا مراجعة مطلوبة',
  'publish_state.not_routed': 'لم يُوجَّه بعد',
  'publish_state.routed': 'وُجِّه إلى وجهة',
  'publish_state.awaiting_review': 'بانتظار مراجعة قبل النشر',
};

function eventLabel(event: JourneyEvent): string {
  if (eventLabels[event.code]) return eventLabels[event.code]!;
  if (event.code.startsWith('attempt.')) {
    const outcome = event.code.slice('attempt.'.length);
    const map: Record<string, string> = {
      started: 'بدأت محاولة إرسال',
      ok: 'نجحت محاولة إرسال',
      retryable: 'محاولة قابلة للإعادة',
      permanent: 'فشل نهائي في المحاولة',
      uncertain: 'محاولة نتيجتها مجهولة',
    };
    return map[outcome] ?? `محاولة: ${outcome}`;
  }
  if (event.code.startsWith('evidence.')) return 'سُجّل دليل بشري';
  if (event.code.startsWith('state.')) return `حالة المعالجة: ${event.code.slice(6)}`;
  return event.code;
}

function confidenceLabel(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

export default function TelegramResultDetailPage() {
  const { identityId = '' } = useParams();
  const detail = useQuery(() => telegramResultsApi.detail(identityId), [identityId]);
  const classifications = useQuery(() => telegramResultsApi.classifications(), []);
  const journey = useQuery(() => telegramResultsApi.journey(identityId), [identityId]);
  const [selectedClassification, setSelectedClassification] = useState('');

  /**
   * حوار تأكيد إعادة النشر (P0): يعرض الوجهة والخطة والسقف المتبقي قبل التنفيذ.
   * إعادة النشر تُبطل الاعتماد السابق وتُعيد المراجعة — إجراء يستحق تأكيداً صريحاً.
   */
  const [republishTarget, setRepublishTarget] = useState<null | {
    deliveryId: string;
    destination: string;
    remaining: number;
    parts: number;
    attempts: number;
  }>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const message = detail.data?.message;

  useEffect(() => {
    setSelectedClassification(message?.classification.manual?.id ?? '');
  }, [message?.classification.manual?.id]);

  const runAction = async (action: () => Promise<unknown>, successMessage: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      detail.reload();
      journey.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر إكمال الإجراء.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link className="text-sm text-brand-700 hover:underline" to="/telegram/results">
            ← العودة إلى النتائج
          </Link>
          <h1 className="mt-2 text-2xl font-bold text-slate-800">تفاصيل الرسالة</h1>
          <p className="mt-1 text-sm text-slate-500">
            كل قيمة هنا مرتبطة بموضعها في النص الأصلي. قيم التواصل محجوبة، ولا يمكن عرضها خامة من هذه الصفحة.
          </p>
        </div>
        <button className="btn-secondary" onClick={() => detail.reload()} disabled={detail.loading}>
          تحديث
        </button>
      </div>

      {detail.error ? <Alert kind="error">{detail.error}</Alert> : null}
      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      {detail.loading ? <Spinner /> : null}

      {detail.data && message ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="card">
              <p className="text-xs text-slate-500">المصدر</p>
              <p className="mt-1 font-semibold text-slate-800">{message.sourceTitle}</p>
              <p className="text-xs text-slate-500">{formatDate(message.receivedAt)}</p>
            </div>
            <div className="card">
              <p className="text-xs text-slate-500">الحالة</p>
              <p className="mt-1 font-semibold text-slate-800">{message.state}</p>
              <p className="text-xs text-slate-500">
                {message.reviewState === 'needs_review'
                  ? 'تحتاج مراجعة'
                  : message.reviewState === 'reviewed'
                    ? 'روجعت'
                    : 'بلا مراجعة'}
              </p>
            </div>
            <div className="card">
              <p className="text-xs text-slate-500">التصنيف الفعّال</p>
              <p className="mt-1 font-semibold text-slate-800">{message.classification.name ?? 'غير مصنف'}</p>
              <p className="text-xs text-slate-500">
                {message.classification.origin === 'manual' ? 'يدوي (يغلب في العرض)' : 'تلقائي'} · ثقة{' '}
                {confidenceLabel(message.classification.confidence)}
              </p>
            </div>
            <div className="card">
              <p className="text-xs text-slate-500">القالب المختار</p>
              <p className="mt-1 font-semibold text-slate-800">{message.templateName ?? 'لا قالب'}</p>
              <p className="text-xs text-slate-500">
                {resolvedByLabels[message.resolvedBy ?? 'none'] ?? message.resolvedBy ?? '—'}
              </p>
            </div>
          </section>

          <section className="card space-y-3">
            <h2 className="text-sm font-semibold text-slate-700">المراجعة والتعديل اليدوي</h2>
            {detail.data?.reviewHints && detail.data.reviewHints.length > 0 && message.reviewState === 'needs_review' ? (
              <Alert kind="warning">
                <p className="font-semibold">لماذا أوقف النظام هذه الرسالة؟</p>
                <ul className="mt-1 list-inside list-disc space-y-1">
                  {detail.data.reviewHints.map((hint) => (
                    <li key={hint.code}>
                      {hint.label}
                      {typeof hint.value === 'number' ? ` (${confidenceLabel(hint.value)})` : ''}
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm text-slate-600">
                تعديل التصنيف
                <select
                  className="input mt-1 block"
                  value={selectedClassification}
                  onChange={(event) => setSelectedClassification(event.target.value)}
                  disabled={busy}
                >
                  <option value="">إزالة التعديل اليدوي (الرجوع للتلقائي)</option>
                  {(classifications.data?.classifications ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn-primary"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    () =>
                      telegramResultsApi.overrideClassification(identityId, selectedClassification || null),
                    'تم حفظ التعديل اليدوي — سيغلب في العرض.',
                  )
                }
              >
                حفظ التصنيف
              </button>
              <button
                className="btn-secondary"
                disabled={busy || message.reviewState === 'reviewed'}
                onClick={() =>
                  void runAction(
                    () => telegramResultsApi.review(identityId, 'reviewed'),
                    'تم تعليم الرسالة كمراجَعة.',
                  )
                }
              >
                تعليم كمراجَعة
              </button>
              <button
                className="btn-secondary"
                disabled={busy || message.reviewState === 'needs_review'}
                onClick={() =>
                  void runAction(
                    () => telegramResultsApi.review(identityId, 'needs_review'),
                    'تم إرجاع الرسالة إلى قائمة المراجعة.',
                  )
                }
              >
                إرجاع للمراجعة
              </button>
            </div>
            {message.classification.automatic ? (
              <p className="text-xs text-slate-500">
                التصنيف التلقائي: {message.classification.automatic.name ?? 'غير مصنف'} · ثقة{' '}
                {confidenceLabel(message.classification.automatic.confidence)}
              </p>
            ) : null}
          </section>

          <section className="card space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">المعاينة من القالب</h2>
              <span className="text-xs text-slate-500">
                الحقول الغائبة تُحذف من المعاينة ولا تُملأ بقيم افتراضية.
              </span>
            </div>
            {detail.data.rendered.fields.length === 0 ? (
              <p className="text-sm text-amber-700">
                لا حقول لعرضها (لا قالب أو لا قيم مستخرجة). عند النشر لن يُرسل هيكل فارغ: يُعرض{' '}
                <strong>النص الأصلي</strong> للرسالة في حقل «التفاصيل» للقالب.
              </p>
            ) : (
              <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-800" dir="rtl">
                {detail.data.rendered.text}
              </pre>
            )}
            {detail.data.rendered.missingFields.length > 0 ? (
              <p className="text-xs text-slate-500">
                حقول محذوفة لعدم وجود قيمة: {detail.data.rendered.missingFields.map((field) => field.label).join('، ')}
              </p>
            ) : null}
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div className="card space-y-2">
              <h2 className="text-sm font-semibold text-slate-700">الحقول المستخرجة</h2>
              {detail.data.fields.length === 0 ? (
                <p className="text-sm text-slate-500">لا حقول مستخرجة.</p>
              ) : (
                <table className="min-w-full text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {detail.data.fields.map((field, index) => (
                      <tr key={`${field.key}-${index}`}>
                        <td className="py-2 pe-3 text-xs text-slate-500" dir="ltr">
                          {field.key}
                        </td>
                        <td className="py-2 pe-3 text-slate-800">{field.value}</td>
                        <td className="py-2 pe-3 text-xs text-slate-500">
                          ثقة {confidenceLabel(field.confidence)}
                        </td>
                        <td className="py-2 text-xs text-slate-400" dir="ltr">
                          [{field.span[0]}–{field.span[1]}]
                        </td>
                        <td className="py-2 text-end">
                          {field.ambiguous ? <Badge tone="amber">غامض</Badge> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700">فئات التواصل</h2>
                <Badge tone="blue">محجوبة</Badge>
              </div>
              {detail.data.contacts.length === 0 ? (
                <p className="text-sm text-slate-500">لا وسائل تواصل مرصودة.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {detail.data.contacts.map((contact, index) => (
                    <li key={`${contact.kind}-${index}`} className="flex items-center justify-between gap-2">
                      <span className="text-slate-600">{contactKindLabels[contact.kind] ?? contact.kind}</span>
                      <span className="font-mono text-slate-800" dir="ltr">
                        {contact.masked}
                      </span>
                      <span className="text-xs text-slate-500">ثقة {confidenceLabel(contact.confidence)}</span>
                      {contact.ambiguous ? <Badge tone="amber">غامض</Badge> : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-slate-500">
                القيمة الخام لا تُرسل إلى المتصفح إطلاقاً؛ الحجب يُطبَّق قبل العرض (O03).
              </p>
            </div>
          </section>


          {/* الخط الزمني الموحّد (P4-هـ): الحالات الثلاث في قصة واحدة. */}
          <section className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-700">الخط الزمني للرسالة</h2>
              {journey.data ? (
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge tone="slate">المعالجة: {journey.data.journey.states.processing}</Badge>
                  <Badge tone="blue">التوجيه: {journey.data.journey.states.publishing}</Badge>
                  {journey.data.journey.states.deliveryStatuses.map((status, index) => (
                    <Badge key={`${status}-${index}`} tone={status === 'published' ? 'green' : status === 'uncertain' || status === 'failed' ? 'red' : 'amber'}>
                      تسليم {index + 1}: {status}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
            {journey.error ? <Alert kind="error">{journey.error}</Alert> : null}
            {journey.loading ? <Spinner label="جارٍ بناء الخط الزمني…" /> : null}
            {journey.data ? (
              <>
                <ol className="space-y-2 border-s border-slate-200 ps-4">
                  {journey.data.journey.timeline.map((event, index) => (
                    <li key={`${event.at}-${event.code}-${index}`} className="relative">
                      <span className="absolute -start-[21px] top-2 h-2 w-2 rounded-full bg-brand-500" />
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-sm text-slate-800">{eventLabel(event)}</span>
                        <span className="text-xs text-slate-400">{stageLabels[event.stage]}</span>
                        <span className="text-xs text-slate-400">{formatDate(event.at)}</span>
                      </div>
                      {Object.keys(event.detail).length > 0 ? (
                        <p className="text-xs text-slate-500">
                          {Object.entries(event.detail)
                            .filter(([, value]) => value !== null && value !== '')
                            .map(([key, value]) => `${key}: ${String(value)}`)
                            .join(' · ')}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>

                {journey.data.journey.deliveries.length > 0 ? (
                  <div className="space-y-2 border-t border-slate-100 pt-3">
                    <h3 className="text-xs font-semibold text-slate-700">التسليمات وإعادة النشر</h3>
                    {journey.data.journey.deliveries.map((delivery) => (
                      <div key={delivery.id} className="rounded-lg border border-slate-200 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Badge tone={delivery.status === 'published' ? 'green' : delivery.status === 'uncertain' || delivery.status === 'failed' ? 'red' : 'amber'}>
                              {delivery.status}
                            </Badge>
                            <span className="text-sm text-slate-700">{delivery.destinationTitle ?? 'وجهة محذوفة'}</span>
                            <span className="text-xs text-slate-500">
                              أجزاء {delivery.sentParts}/{delivery.planParts} · محاولات {delivery.attempts}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-500">
                              إعادة النشر {delivery.republishCount}/3
                            </span>
                            <button
                              type="button"
                              className="btn-secondary text-xs"
                              disabled={busy || !delivery.republish.allowed}
                              title={
                                delivery.republish.reason === 'uncertain_forbidden'
                                  ? 'النتيجة المجهولة لا تُعاد: سجّل دليلاً بشرياً أولاً'
                                  : delivery.republish.reason === 'limit_reached'
                                    ? 'بلغت سقف الإعادات (3)'
                                    : delivery.republish.reason === 'not_republishable'
                                      ? 'متاحة فقط للتسليمات الفاشلة أو الملغاة أو المحجوبة'
                                      : undefined
                              }
                              onClick={() =>
                                setRepublishTarget({
                                  deliveryId: delivery.id,
                                  destination: delivery.destinationTitle ?? 'وجهة محذوفة',
                                  remaining: delivery.republish.remaining,
                                  parts: delivery.planParts,
                                  attempts: delivery.attempts,
                                })
                              }
                            >
                              إعادة النشر
                            </button>
                          </div>
                        </div>
                        {delivery.republish.reason === 'uncertain_forbidden' ? (
                          <p className="mt-2 text-xs text-rose-700">
                            النتيجة مجهولة: قد تكون الرسالة وصلت. لا إعادة تلقائية ولا يدوية قبل تسجيل دليل (معرّف
                            الرسالة في الوجهة أو تحقّق يدوي).
                          </p>
                        ) : null}
                        {delivery.lastErrorCode ? (
                          <p className="mt-1 font-mono text-xs text-rose-700" dir="ltr">
                            {delivery.lastErrorCode}
                          </p>
                        ) : null}
                        {delivery.parts.length > 0 ? (
                          <ul className="mt-2 space-y-1 text-xs text-slate-500">
                            {delivery.parts.map((part) => (
                              <li key={part.partIndex}>
                                جزء {part.partIndex}: {part.status} · {part.charCount} حرفاً
                                {part.telegramMessageId ? ` · معرّف ${part.telegramMessageId}` : ''}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {delivery.evidence.length > 0 ? (
                          <ul className="mt-2 space-y-1 text-xs text-slate-600">
                            {delivery.evidence.map((item, index) => (
                              <li key={index}>
                                دليل ({item.method}): {item.decision === 'published' ? 'نُشرت' : 'لم تُنشر'} ·{' '}
                                {formatDate(item.decidedAt)}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="border-t border-slate-100 pt-3 text-xs text-slate-500">
                    لا تسليمات لهذه الرسالة بعد (لم تُوجَّه إلى أي وجهة).
                  </p>
                )}
              </>
            ) : null}
          </section>

          <section className="card space-y-2">
            <h2 className="text-sm font-semibold text-slate-700">النص الأصلي (مقنَّع في مواضع التواصل)</h2>
            {detail.data.originalText ? (
              <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-800" dir="rtl">
                {detail.data.originalText}
              </pre>
            ) : (
              <p className="text-sm text-slate-500">
                النص غير متاح — انتهت مدة احتفاظ المحتوى (النتائج تُحذف معه، وتبقى الهوية لمنع التكرار).
              </p>
            )}
            {detail.data.caption ? (
              <p className="text-xs text-slate-500">التعليق: {detail.data.caption}</p>
            ) : null}
            <p className="text-xs text-slate-500">
              فلاتر مطابقة: {detail.data.filters.map((filter) => filter.name).join('، ') || '—'}
            </p>
          </section>
        </>
      ) : null}

      <ConfirmDialog
        open={republishTarget !== null}
        title="إعادة نشر المنشور؟"
        description="إعادة النشر تُعيد التخطيط بخطة جديدة، وتُبطل الاعتماد السابق، وتُعيد المراجعة إلى «بانتظار مراجعة» إن كان الوضع مراجعة. لا تُعاد إلا التسليمات الفاشلة أو الملغاة أو المحجوبة."
        {...(republishTarget
          ? {
              details: [
                { label: 'الوجهة', value: republishTarget.destination },
                { label: 'أجزاء الخطة', value: String(republishTarget.parts) },
                { label: 'محاولات سابقة', value: String(republishTarget.attempts) },
                {
                  label: 'السقف المتبقي',
                  value: `${Math.max(0, republishTarget.remaining - 1)} من 3 بعد هذه الإعادة`,
                },
              ],
            }
          : {})}
        confirmLabel="إعادة النشر"
        tone="primary"
        busy={busy}
        onCancel={() => setRepublishTarget(null)}
        onConfirm={() => {
          const target = republishTarget;
          if (!target) return;
          void runAction(() => telegramResultsApi.republish(target.deliveryId), 'أُعيد تخطيط النشر بخطة جديدة.').finally(
            () => setRepublishTarget(null),
          );
        }}
      />
    </div>
  );
}
