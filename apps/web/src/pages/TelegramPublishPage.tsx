/**
 * صفحة النشر (المرحلة الثالثة — 7-أ/7-ب): بوت النشر، الوجهات، المسارات، وسجل التسليمات.
 *
 * - رمز البوت يُدخل مرة واحدة ولا يُعرض بعد الحفظ (لا يُخزَّن في حالة الواجهة ولا يُعاد من الخادم).
 * - لا تُنشأ مسارات على وجهات غير فعّالة: الحالة معروضة صراحةً قبل السماح بالتفعيل.
 * - رفض منع الحلقات يظهر برسالته المحايدة كما يعيدها الخادم دون أي تفاصيل عن مسارات أخرى.
 * - 7-د: مراجعة بشرية (اعتماد/رفض)، وعرض الأجزاء والمحاولات، وتسوية النتيجة المجهولة بدليل بشري فقط.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  publishApi,
  telegramApi,
  telegramResultsApi,
  type AttributionMode,
  type PublishBot,
  type PublishDelivery,
  type PublishDeliveryDetail,
  type PublishDestination,
  type PublishRoute,
  type PublishRouteScopeKind,
  type PublishStatus,
  type TelegramClassification,
  type TelegramSource,
  type TelegramTemplate,
} from '../api/client';
import { Alert, Badge, ConfirmDialog, EmptyState, Field, Spinner, formatDate } from '../components/ui';

type ScopeTarget = { kind: PublishRouteScopeKind; id: string; label: string };

/** خيارات هوية المصدر/المرسل على مستوى المسار: الوراثة من الإعداد العام أو تجاوز صريح. */
type RouteAttributionChoice = 'inherit' | AttributionMode;

const routeAttributionLabels: Record<RouteAttributionChoice, string> = {
  inherit: 'حسب الإعداد العام',
  off: 'بلا هوية',
  source: 'المصدر فقط',
  sender: 'المرسل فقط',
  both: 'المصدر والمرسل',
};

const destinationTone: Record<string, 'green' | 'amber' | 'red' | 'slate' | 'blue'> = {
  active: 'green',
  pending: 'amber',
  paused: 'amber',
  revoked: 'red',
  error: 'red',
  deleted: 'slate',
};

const routeTone: Record<string, 'green' | 'amber' | 'red' | 'slate' | 'blue'> = {
  active: 'green',
  draft: 'slate',
  paused: 'amber',
};

const statusLabels: Record<string, string> = {
  active: 'فعّالة',
  pending: 'بانتظار التحقق',
  paused: 'موقوفة',
  revoked: 'مسحوبة الصلاحية',
  error: 'خطأ في الصلاحيات',
  deleted: 'محذوفة',
  draft: 'مسودة',
  invalid: 'رمز غير صالح',
  disabled: 'معطّل',
  awaiting_review: 'بانتظار المراجعة',
  queued: 'بانتظار الإرسال',
  sending: 'قيد الإرسال',
  published: 'منشور',
  partial: 'جزئي',
  failed: 'فاشل',
  uncertain: 'نتيجة مجهولة',
  blocked: 'محجوب',
  cancelled: 'ملغى',
  not_required: 'لا تحتاج مراجعة',
  pending_review: 'بانتظار المراجعة',
  approved: 'معتمد',
  rejected: 'مرفوض',
};

const scopeLabels: Record<PublishRouteScopeKind, string> = {
  source: 'مصدر',
  filter: 'فلتر',
  classification: 'تصنيف',
};

function labelOf(value: string | null | undefined): string {
  if (!value) return '—';
  return statusLabels[value] ?? value;
}

export default function TelegramPublishPage() {
  const [status, setStatus] = useState<PublishStatus | null>(null);
  const [bot, setBot] = useState<PublishBot | null>(null);
  const [ready, setReady] = useState(false);
  const [readyReason, setReadyReason] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<PublishDestination[]>([]);
  const [routes, setRoutes] = useState<PublishRoute[]>([]);
  const [deliveries, setDeliveries] = useState<PublishDelivery[]>([]);
  const [selected, setSelected] = useState<PublishDeliveryDetail | null>(null);
  const [evidenceMethod, setEvidenceMethod] = useState<'message_id' | 'manual_check'>('manual_check');
  const [evidenceDecision, setEvidenceDecision] = useState<'published' | 'not_published'>('published');
  const [evidenceMessageId, setEvidenceMessageId] = useState('');
  const [evidenceNote, setEvidenceNote] = useState('');
  const [sources, setSources] = useState<TelegramSource[]>([]);
  const [filters, setFilters] = useState<{ id: string; name: string }[]>([]);
  const [classifications, setClassifications] = useState<TelegramClassification[]>([]);
  const [templates, setTemplates] = useState<TelegramTemplate[]>([]);

  /**
   * حوار تأكيد واحد لكل الإجراءات الخطرة (P0):
   * حذف وجهة، حذف مسار. يُعرَّف بالبيانات لا بالسؤال العام، ويُغلق بالتراجع أو Escape.
   */
  const [confirmState, setConfirmState] = useState<null | {
    title: string;
    description: string;
    details?: { label: string; value: string }[];
    confirmLabel: string;
    tone: 'danger' | 'primary';
    action: () => Promise<void>;
    key: string;
  }>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // نماذج الإدخال
  const [token, setToken] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [routeName, setRouteName] = useState('');
  const [routeDestination, setRouteDestination] = useState('');
  const [scopeKind, setScopeKind] = useState<PublishRouteScopeKind>('filter');
  const [scopeTarget, setScopeTarget] = useState('');
  const [routeTemplate, setRouteTemplate] = useState('');
  const [publishMode, setPublishMode] = useState<'auto' | 'review'>('auto');
  const [lengthPolicy, setLengthPolicy] = useState<'split' | 'reject'>('split');
  const [routeAttribution, setRouteAttribution] = useState<RouteAttributionChoice>('inherit');

  const report = useCallback((err: unknown) => {
    setError(err instanceof ApiError ? err.message : 'تعذّر إكمال الطلب. حاول مجدداً.');
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [botRes, destRes, routeRes, deliveryRes, statusRes] = await Promise.all([
        publishApi.bot(),
        publishApi.destinations(),
        publishApi.routes(),
        publishApi.deliveries(30),
        publishApi.status(),
      ]);
      setBot(botRes.bot);
      setReady(botRes.ready);
      setReadyReason(botRes.reason);
      setDestinations(destRes.destinations);
      setRoutes(routeRes.routes);
      setDeliveries(deliveryRes.deliveries);
      setStatus(statusRes);
    } catch (err) {
      report(err);
    }
  }, [report]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [srcRes, filterRes, classRes, templateRes] = await Promise.all([
          telegramApi.sources(),
          publishApi.filters(),
          telegramResultsApi.classifications(),
          telegramResultsApi.templates(),
        ]);
        if (!alive) return;
        setSources(srcRes.sources);
        setFilters(filterRes.filters.map((f) => ({ id: f.id, name: f.name })));
        setClassifications(classRes.classifications);
        setTemplates(templateRes.templates);
      } catch {
        // اختيار الشروط إثراء للواجهة؛ فشله لا يمنع إدارة البوت والوجهات.
      }
      await loadAll();
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [loadAll]);

  const activeDestinations = useMemo(() => destinations.filter((d) => d.status === 'active'), [destinations]);

  const scopeTargets: ScopeTarget[] = useMemo(() => {
    if (scopeKind === 'source') return sources.map((s) => ({ kind: 'source', id: s.id, label: s.title }));
    if (scopeKind === 'filter') return filters.map((f) => ({ kind: 'filter', id: f.id, label: f.name }));
    return classifications.map((c) => ({ kind: 'classification', id: c.id, label: c.name }));
  }, [scopeKind, sources, filters, classifications]);

  const run = async (key: string, action: () => Promise<unknown>, successMessage?: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      await loadAll();
      if (successMessage) setNotice(successMessage);
      return true;
    } catch (err) {
      report(err);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const onConnectBot = async () => {
    if (!token.trim()) return;
    const ok = await run('bot', () => publishApi.connectBot({ token: token.trim() }), 'تم ربط بوت النشر والتحقق منه.');
    if (ok) setToken('');
  };

  const onAddDestination = async () => {
    if (!identifier.trim()) return;
    const ok = await run(
      'destination',
      () => publishApi.addDestination({ identifier: identifier.trim() }),
      'أُضيفت الوجهة. تحقّق من حالة الصلاحية قبل تفعيل أي مسار.',
    );
    if (ok) setIdentifier('');
  };

  const onCreateRoute = async () => {
    if (!routeName.trim() || !routeDestination || !scopeTarget) return;
    const ok = await run(
      'route',
      () =>
        publishApi.createRoute({
          name: routeName.trim(),
          destinationId: routeDestination,
          scopes: [{ kind: scopeKind, targetId: scopeTarget }],
          templateId: routeTemplate || null,
          publishMode,
          lengthPolicy,
          attributionMode: routeAttribution === 'inherit' ? null : routeAttribution,
        }),
      'أُنشئ المسار كمسودة. فعّله بعد التأكد من الشروط (يُفحص منع الحلقات عند التفعيل).',
    );
    if (ok) {
      setRouteName('');
      setScopeTarget('');
    }
  };

  /**
   * تجاوز الهوية لمسار واحد فقط. يرسل المسار كاملاً (الخادم يستبدل الحقول)
   * ولا يمسّ أي مسار آخر ولا الإعداد العام.
   */
  const onSetRouteAttribution = async (route: PublishRoute, choice: RouteAttributionChoice) => {
    await run(
      `attr-${route.id}`,
      () =>
        publishApi.updateRoute(route.id, {
          name: route.name,
          destinationId: route.destinationId,
          scopes: route.scopes.map((scope) => ({ kind: scope.kind, targetId: scope.targetId })),
          templateId: route.templateId,
          publishMode: route.publishMode,
          lengthPolicy: route.lengthPolicy,
          maxParts: route.maxParts,
          attributionMode: choice === 'inherit' ? null : choice,
        }),
      choice === 'inherit'
        ? 'أُعيد المسار إلى الإعداد العام.'
        : `أُوقفت/خُصّصت الهوية لهذا المسار: ${routeAttributionLabels[choice]}. بقية المسارات لم تتغيّر.`,
    );
  };

  const openDelivery = async (id: string) => {
    setBusy(`delivery-${id}`);
    setError(null);
    try {
      const res = await publishApi.deliveryDetail(id);
      setSelected(res.delivery);
      setEvidenceMethod('manual_check');
      setEvidenceDecision('published');
      setEvidenceMessageId('');
      setEvidenceNote('');
    } catch (err) {
      report(err);
    } finally {
      setBusy(null);
    }
  };

  const onApproveDelivery = async (id: string) => {
    const ok = await run(`approve-${id}`, () => publishApi.approveDelivery(id), 'اعتُمد التسليم وسيدخل طابور الإرسال.');
    if (ok) await openDelivery(id);
  };

  const onRejectDelivery = async (id: string) => {
    const ok = await run(`reject-${id}`, () => publishApi.rejectDelivery(id, 'رفض من المراجعة البشرية'), 'رُفض التسليم ولن يُرسل.');
    if (ok) await openDelivery(id);
  };

  const onSubmitEvidence = async (id: string) => {
    if (evidenceMethod === 'message_id' && !evidenceMessageId.trim()) {
      setError('أدخل معرّف الرسالة المرئية في الوجهة.');
      return;
    }
    const ok = await run(
      `evidence-${id}`,
      () =>
        publishApi.recordDeliveryEvidence(id, {
          method: evidenceMethod,
          decision: evidenceDecision,
          ...(evidenceMethod === 'message_id' ? { telegramMessageId: evidenceMessageId.trim() } : {}),
          ...(evidenceNote.trim() ? { note: evidenceNote.trim() } : {}),
        }),
      'سُجّل الدليل البشري وأُغلقت الحالة المجهولة.',
    );
    if (ok) await openDelivery(id);
  };

  if (loading) return <Spinner label="جارٍ تحميل حالة النشر…" />;

  const failingDestinations = destinations.filter((d) => d.failureStreak >= 3);

  return (
    <div className="space-y-6">
      {/* تنبيه الفشل المتكرر (P0): ظاهر أعلى الصفحة، لا يُخفى في جدول طويل. */}
      {failingDestinations.length > 0 ? (
        <Alert kind="warning">
          <p className="font-semibold">
            {failingDestinations.length === 1
              ? 'وجهة واحدة تتعرض لإخفاقات نشر متكررة'
              : `${failingDestinations.length} وجهات تتعرض لإخفاقات نشر متكررة`}
          </p>
          <ul className="mt-1 list-inside list-disc text-sm">
            {failingDestinations.slice(0, 3).map((d) => (
              <li key={d.id}>
                {d.title}
                {d.lastErrorCode ? <span className="font-mono text-xs" dir="ltr"> — {d.lastErrorCode}</span> : null}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-sm">
            آخر ثلاث تسليمات منتهية فشلت. تحقّق من بقاء البوت مشرفاً في الوجهة، ومن صلاحية حق النشر، ثم اضغط «تحقق».
          </p>
        </Alert>
      ) : null}
      <header>
        <h1 className="text-xl font-bold text-slate-800">النشر إلى تيليجرام</h1>
        <p className="mt-1 text-sm text-slate-500">
          بوت النشر ووجهاته ومسارات التوجيه. لا يُرسل شيء في هذه الدفعة: تُنشأ التسليمات وتُعرض، والإرسال
          الفعلي في الدفعة التالية.
        </p>
      </header>

      {!ready ? (
        <Alert kind="warning">
          ميزة النشر غير مهيأة على الخادم: {readyReason ?? 'مفتاح تشفير رموز البوتات غير مهيأ.'} لن يُقبل ربط بوت
          حتى يُضبط المفتاح في بيئة الخادم.
        </Alert>
      ) : null}

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="success">{notice}</Alert> : null}

      {status ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard title="بوت النشر" value={status.bot.configured ? labelOf(status.bot.status) : 'غير مربوط'} />
          <StatCard title="وجهات فعّالة" value={`${status.destinations.active} / ${status.destinations.total}`} />
          <StatCard title="مسارات فعّالة" value={`${status.routes.active} / ${status.routes.total}`} />
          <StatCard title="بانتظار المراجعة" value={String(status.deliveries.awaitingReview)} />
        </div>
      ) : null}

      {/* ── البوت ─────────────────────────────────────────────────────────── */}
      <section className="card space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="card-title">بوت النشر</h2>
            <p className="mt-1 text-sm text-slate-500">
              أنشئ بوتاً في BotFather وأضفه مشرفاً في قناتك (أو عضواً في مجموعتك)، ثم ألصق رمزه هنا مرة واحدة.
            </p>
          </div>
          {bot?.configured ? <Badge tone={bot.status === 'active' ? 'green' : bot.status === 'invalid' ? 'red' : 'slate'}>
            {labelOf(bot.status)}
          </Badge> : <Badge tone="slate">غير مربوط</Badge>}
        </div>

        {bot?.configured ? (
          <dl className="grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate-500">اسم البوت</dt>
              <dd className="font-medium text-slate-800">{bot.username ? `@${bot.username}` : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">آخر تحقق</dt>
              <dd className="font-medium text-slate-800">{formatDate(bot.verifiedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">آخر تحديث للرمز</dt>
              <dd className="font-medium text-slate-800">{formatDate(bot.tokenUpdatedAt)}</dd>
            </div>
          </dl>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <Field label="رمز البوت" hint="لا يُعرض بعد الحفظ ولا يُسجَّل. استبدال الرمز يتم بإدخال رمز جديد.">
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder="123456789:AA…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
          </div>
          <button className="btn-primary" onClick={() => void onConnectBot()} disabled={!ready || !token.trim() || busy === 'bot'}>
            {busy === 'bot' ? 'جارٍ التحقق…' : 'ربط وتحقق'}
          </button>
          {bot?.configured ? (
            <>
              <button
                className="btn-secondary"
                onClick={() => void run('verify', () => publishApi.verifyBot(), 'أُعيد التحقق من البوت.')}
                disabled={busy === 'verify'}
              >
                إعادة التحقق
              </button>
              <button
                className="btn-secondary"
                onClick={() => void run('disable', () => publishApi.disableBot(), 'عُطّل بوت النشر.')}
                disabled={busy === 'disable'}
              >
                تعطيل
              </button>
            </>
          ) : null}
        </div>
      </section>

      {/* ── الوجهات ───────────────────────────────────────────────────────── */}
      <section className="card space-y-4">
        <div>
          <h2 className="card-title">وجهات النشر</h2>
          <p className="mt-1 text-sm text-slate-500">
            أضف القناة باسمها (@name) أو بمعرّفها الرقمي. يتحقق النظام فوراً من صلاحية النشر قبل اعتمادها.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <Field label="اسم القناة أو معرّفها">
              <input
                className="input"
                placeholder="@my_channel أو ‎-1001234567890"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
              />
            </Field>
          </div>
          <button
            className="btn-primary"
            onClick={() => void onAddDestination()}
            disabled={!bot?.configured || !identifier.trim() || busy === 'destination'}
          >
            {busy === 'destination' ? 'جارٍ التحقق…' : 'إضافة وجهة'}
          </button>
        </div>

        {destinations.length === 0 ? (
          <EmptyState title="لا توجد وجهات بعد" description="أضف قناة أو مجموعة بعد ربط بوت النشر." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>الوجهة</th>
                  <th>النوع</th>
                  <th>الحالة</th>
                  <th>حق النشر</th>
                  <th>آخر تحقق</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {destinations.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <p className="font-medium text-slate-800">{d.title}</p>
                      <p className="text-xs text-slate-500" dir="ltr">
                        {d.username ? `@${d.username}` : d.chatId}
                      </p>
                    </td>
                    <td className="text-sm text-slate-600">
                      {d.chatKind === 'channel' ? 'قناة' : d.chatKind === 'supergroup' ? 'مجموعة عظمى' : 'مجموعة'}
                    </td>
                    <td>
                      <Badge tone={destinationTone[d.status] ?? 'slate'}>{labelOf(d.status)}</Badge>
                      {d.failureStreak >= 3 ? (
                        <p className="mt-1 text-xs font-semibold text-rose-700">
                          إخفاقات متكررة ({d.failureStreak})
                        </p>
                      ) : null}
                      {d.lastErrorCode ? <p className="mt-1 font-mono text-xs text-rose-600" dir="ltr">{d.lastErrorCode}</p> : null}
                    </td>
                    <td className="text-sm">{d.canPostMessages ? 'متاح' : 'غير متاح'}</td>
                    <td className="text-xs text-slate-500">{formatDate(d.verifiedAt)}</td>
                    <td className="text-left">
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          className="btn-mini"
                          onClick={() => void run(`verify-${d.id}`, () => publishApi.verifyDestination(d.id))}
                          disabled={busy === `verify-${d.id}`}
                        >
                          تحقق
                        </button>
                        {d.status === 'paused' ? (
                          <button
                            className="btn-mini"
                            onClick={() => void run(`resume-${d.id}`, () => publishApi.resumeDestination(d.id))}
                            disabled={busy === `resume-${d.id}`}
                          >
                            استئناف
                          </button>
                        ) : (
                          <button
                            className="btn-mini"
                            onClick={() => void run(`pause-${d.id}`, () => publishApi.pauseDestination(d.id))}
                            disabled={busy === `pause-${d.id}`}
                          >
                            إيقاف
                          </button>
                        )}
                        <button
                          className="btn-mini text-rose-600"
                          onClick={() =>
                            setConfirmState({
                              title: 'حذف الوجهة؟',
                              description:
                                'الحذف تعطيل دائم: يتوقف النشر إلى هذه الوجهة فوراً، وتُعطَّل مساراتها، ويبقى التاريخ للقراءة في السجل. لا يمكن التراجع من الواجهة.',
                              details: [
                                { label: 'الوجهة', value: d.title },
                                { label: 'المعرّف', value: d.username ? `@${d.username}` : d.chatId },
                                { label: 'الحالة', value: labelOf(d.status) },
                                {
                                  label: 'مسارات مرتبطة',
                                  value: String(routes.filter((r) => r.destinationId === d.id).length),
                                },
                              ],
                              confirmLabel: 'حذف نهائي',
                              tone: 'danger',
                              key: `del-${d.id}`,
                              action: async () => {
                                await run(`del-${d.id}`, () => publishApi.removeDestination(d.id), 'حُذفت الوجهة.');
                              },
                            })
                          }
                          disabled={busy === `del-${d.id}`}
                        >
                          حذف
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── المسارات ──────────────────────────────────────────────────────── */}
      <section className="card space-y-4">
        <div>
          <h2 className="card-title">مسارات التوجيه</h2>
          <p className="mt-1 text-sm text-slate-500">
            المسار يربط شرطاً (مصدر/فلتر/تصنيف) بوجهة واحدة، بقالب وسياسة مراجعة. التفعيل يفحص منع الحلقات
            فوراً ويرفض أي ربط يُنشئ دورة نشر.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="اسم المسار">
            <input className="input" value={routeName} onChange={(e) => setRouteName(e.target.value)} placeholder="مسار الوظائف" />
          </Field>
          <Field label="الوجهة" hint={activeDestinations.length === 0 ? 'لا توجد وجهة فعّالة بعد.' : undefined}>
            <select className="input" value={routeDestination} onChange={(e) => setRouteDestination(e.target.value)}>
              <option value="">اختر وجهة…</option>
              {activeDestinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="نوع الشرط">
            <select
              className="input"
              value={scopeKind}
              onChange={(e) => {
                setScopeKind(e.target.value as PublishRouteScopeKind);
                setScopeTarget('');
              }}
            >
              <option value="filter">فلتر</option>
              <option value="source">مصدر</option>
              <option value="classification">تصنيف</option>
            </select>
          </Field>
          <Field label="الشرط">
            <select className="input" value={scopeTarget} onChange={(e) => setScopeTarget(e.target.value)}>
              <option value="">اختر…</option>
              {scopeTargets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="القالب" hint="اتركه فارغاً لاستخدام القالب المحدَّد في المعالجة.">
            <select className="input" value={routeTemplate} onChange={(e) => setRouteTemplate(e.target.value)}>
              <option value="">قالب المعالجة</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="سياسة النشر">
            <select className="input" value={publishMode} onChange={(e) => setPublishMode(e.target.value as 'auto' | 'review')}>
              <option value="auto">تلقائي</option>
              <option value="review">مراجعة قبل النشر</option>
            </select>
          </Field>
          <Field label="سياسة الطول" hint="التقسيم آمن للمنشورات الطويلة؛ الرفض يمنع النشر متجاوز الحد.">
            <select className="input" value={lengthPolicy} onChange={(e) => setLengthPolicy(e.target.value as 'split' | 'reject')}>
              <option value="split">تقسيم إلى أجزاء</option>
              <option value="reject">رفض</option>
            </select>
          </Field>
          <Field
            label="هوية المصدر والمرسل"
            hint="«حسب الإعداد العام» يورّث ما في الإعدادات (افتراضياً مفعّلة). «بلا هوية» يوقفها لهذه الوجهة وحدها."
          >
            <select
              className="input"
              value={routeAttribution}
              onChange={(e) => setRouteAttribution(e.target.value as RouteAttributionChoice)}
            >
              {(Object.keys(routeAttributionLabels) as RouteAttributionChoice[]).map((choice) => (
                <option key={choice} value={choice}>
                  {routeAttributionLabels[choice]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div>
          <button
            className="btn-primary"
            onClick={() => void onCreateRoute()}
            disabled={!routeName.trim() || !routeDestination || !scopeTarget || busy === 'route'}
          >
            {busy === 'route' ? 'جارٍ الحفظ…' : 'إنشاء مسار (مسودة)'}
          </button>
        </div>

        {routes.length === 0 ? (
          <EmptyState title="لا توجد مسارات" description="أنشئ مساراً ثم فعّله لبدء إنشاء تسليمات النشر." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>المسار</th>
                  <th>الشروط</th>
                  <th>الوجهة</th>
                  <th>القالب</th>
                  <th>السياسة</th>
                  <th>الهوية</th>
                  <th>الحالة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {routes.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium text-slate-800">{r.name}</td>
                    <td className="text-xs text-slate-600">
                      {r.scopes.length === 0
                        ? '—'
                        : r.scopes.map((s) => `${scopeLabels[s.kind]}: ${s.label ?? '—'}`).join(' · ')}
                    </td>
                    <td className="text-sm">{r.destinationTitle ?? '—'}</td>
                    <td className="text-sm">{r.templateName ?? 'قالب المعالجة'}</td>
                    <td className="text-xs text-slate-600">
                      {r.publishMode === 'review' ? 'مراجعة' : 'تلقائي'} · {r.lengthPolicy === 'split' ? 'تقسيم' : 'رفض'}
                    </td>
                    <td>
                      <select
                        className="input input-mini"
                        value={r.attributionMode ?? 'inherit'}
                        disabled={busy === `attr-${r.id}`}
                        onChange={(e) => void onSetRouteAttribution(r, e.target.value as RouteAttributionChoice)}
                        title="تجاوز هوية المصدر/المرسل لهذا المسار فقط"
                      >
                        {(Object.keys(routeAttributionLabels) as RouteAttributionChoice[]).map((choice) => (
                          <option key={choice} value={choice}>
                            {routeAttributionLabels[choice]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Badge tone={routeTone[r.status] ?? 'slate'}>{labelOf(r.status)}</Badge>
                      {r.lastErrorCode ? <p className="mt-1 text-xs text-rose-600">{r.lastErrorCode}</p> : null}
                    </td>
                    <td className="text-left">
                      <div className="flex flex-wrap justify-end gap-2">
                        {r.status === 'active' ? (
                          <button
                            className="btn-mini"
                            onClick={() => void run(`deact-${r.id}`, () => publishApi.deactivateRoute(r.id))}
                            disabled={busy === `deact-${r.id}`}
                          >
                            تعطيل
                          </button>
                        ) : (
                          <button
                            className="btn-mini"
                            onClick={() => void run(`act-${r.id}`, () => publishApi.activateRoute(r.id), 'فُعّل المسار بعد اجتياز فحص الحلقات.')}
                            disabled={busy === `act-${r.id}`}
                          >
                            تفعيل
                          </button>
                        )}
                        <button
                          className="btn-mini text-rose-600"
                          onClick={() =>
                            setConfirmState({
                              title: 'حذف المسار؟',
                              description:
                                'سيتوقف توجيه الرسائل عبر هذا المسار نهائياً. الرسائل الجديدة لن تُنشئ تسليماً عليه، والتسليمات السابقة تبقى في السجل.',
                              details: [
                                { label: 'المسار', value: r.name },
                                { label: 'الوجهة', value: r.destinationTitle ?? 'وجهة محذوفة' },
                                { label: 'الحالة', value: labelOf(r.status) },
                              ],
                              confirmLabel: 'حذف المسار',
                              tone: 'danger',
                              key: `delroute-${r.id}`,
                              action: async () => {
                                await run(`delroute-${r.id}`, () => publishApi.removeRoute(r.id), 'حُذف المسار.');
                              },
                            })
                          }
                          disabled={busy === `delroute-${r.id}`}
                        >
                          حذف
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── سجل التسليمات ─────────────────────────────────────────────────── */}
      <section className="card space-y-4">
        <div>
          <h2 className="card-title">سجل التسليمات</h2>
          <p className="mt-1 text-sm text-slate-500">
            تسليم واحد لكل رسالة ولكل وجهة (بلا تكرار). الإرسال تلقائي بعد الاعتماد، والنتيجة المجهولة لا تُعاد
            تلقائياً وتنتظر دليلاً بشرياً.
          </p>
        </div>
        {deliveries.length === 0 ? (
          <EmptyState title="لا توجد تسليمات بعد" description="تُنشأ التسليمات تلقائياً عند معالجة رسالة تطابق مساراً فعّالاً." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>الوجهة</th>
                  <th>الحالة</th>
                  <th>المراجعة</th>
                  <th>سبب المراجعة</th>
                  <th>أُنشئ في</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="text-sm">{d.destinationTitle}</td>
                    <td>
                      <Badge tone={d.status === 'published' ? 'green' : d.status === 'failed' ? 'red' : d.status === 'awaiting_review' ? 'amber' : 'slate'}>
                        {labelOf(d.status)}
                      </Badge>
                    </td>
                    <td className="text-xs text-slate-600">{d.review === 'not_required' ? 'لا تحتاج' : d.review === 'pending' ? 'بانتظار المراجعة' : labelOf(d.review)}</td>
                    <td className="text-xs text-slate-500">
                      {d.reviewReason === 'message' ? 'غموض المعالجة' : d.reviewReason === 'route' ? 'سياسة المسار' : '—'}
                    </td>
                    <td className="text-xs text-slate-500">{formatDate(d.createdAt)}</td>
                    <td className="space-x-1 space-x-reverse whitespace-nowrap">
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        disabled={busy === `delivery-${d.id}`}
                        onClick={() => void openDelivery(d.id)}
                      >
                        تفصيل
                      </button>
                      {d.status === 'awaiting_review' && (
                        <>
                          <button
                            type="button"
                            className="btn-primary text-xs"
                            disabled={busy === `approve-${d.id}`}
                            onClick={() => void onApproveDelivery(d.id)}
                          >
                            اعتماد
                          </button>
                          <button
                            type="button"
                            className="btn-secondary text-xs"
                            disabled={busy === `reject-${d.id}`}
                            onClick={() => void onRejectDelivery(d.id)}
                          >
                            رفض
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selected && (
          <div className="mt-6 space-y-4 rounded-lg border border-slate-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800">تفصيل التسليم</h3>
                <p className="text-xs text-slate-500">
                  {selected.destinationTitle ?? '—'} • الخطة v{selected.planVersion}
                  {selected.approvedVersion ? ` (معتمدة v${selected.approvedVersion})` : ''} • {selected.chunkCount} جزء
                </p>
              </div>
              <button type="button" className="btn-secondary text-xs" onClick={() => setSelected(null)}>
                إغلاق
              </button>
            </div>

            <div className="space-y-2">
              {selected.parts.length === 0 ? (
                <p className="text-xs text-slate-500">لا أجزاء مخطَّطة لهذا التسليم.</p>
              ) : (
                selected.parts.map((part) => (
                  <div key={part.id} className="rounded border border-slate-100 bg-slate-50 p-3">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>الجزء {part.partIndex}</span>
                      <Badge tone={part.status === 'sent' ? 'green' : part.status === 'failed' ? 'red' : part.status === 'uncertain' ? 'amber' : 'slate'}>
                        {labelOf(part.status)}
                      </Badge>
                      <span>{part.charCount} حرفاً (بعد تحليل الكيانات)</span>
                      {part.telegramMessageId && <span>message_id: {part.telegramMessageId}</span>}
                      {part.lastErrorCode && <span className="text-red-600">{part.lastErrorCode}</span>}
                    </div>
                    <pre className="whitespace-pre-wrap break-words text-xs text-slate-700">{part.text}</pre>
                  </div>
                ))
              )}
            </div>

            {selected.status === 'awaiting_review' && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary text-xs"
                  disabled={busy === `approve-${selected.id}`}
                  onClick={() => void onApproveDelivery(selected.id)}
                >
                  اعتماد الخطة (v{selected.planVersion})
                </button>
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={busy === `reject-${selected.id}`}
                  onClick={() => void onRejectDelivery(selected.id)}
                >
                  رفض
                </button>
              </div>
            )}

            {selected.status === 'uncertain' && (
              <div className="space-y-3 rounded border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs text-amber-800">
                  نتيجة الإرسال مجهولة، ولا إعادة تلقائية. تحقّق من الوجهة يدوياً ثم سجّل الدليل.
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="طريقة التحقق">
                    <select
                      className="input"
                      value={evidenceMethod}
                      onChange={(e) => setEvidenceMethod(e.target.value as 'message_id' | 'manual_check')}
                    >
                      <option value="manual_check">فحص يدوي للقناة</option>
                      <option value="message_id">معرّف رسالة مرئية</option>
                    </select>
                  </Field>
                  <Field label="النتيجة">
                    <select
                      className="input"
                      value={evidenceDecision}
                      onChange={(e) => setEvidenceDecision(e.target.value as 'published' | 'not_published')}
                    >
                      <option value="published">ظهر المنشور</option>
                      <option value="not_published">لم يظهر المنشور</option>
                    </select>
                  </Field>
                  {evidenceMethod === 'message_id' && (
                    <Field label="معرّف الرسالة">
                      <input
                        className="input"
                        value={evidenceMessageId}
                        onChange={(e) => setEvidenceMessageId(e.target.value.replace(/[^0-9]/g, ''))}
                        inputMode="numeric"
                        placeholder="12345"
                      />
                    </Field>
                  )}
                  <Field label="ملاحظة (اختياري)">
                    <input
                      className="input"
                      value={evidenceNote}
                      onChange={(e) => setEvidenceNote(e.target.value)}
                      maxLength={200}
                    />
                  </Field>
                  <button
                    type="button"
                    className="btn-primary text-xs"
                    disabled={busy === `evidence-${selected.id}`}
                    onClick={() => void onSubmitEvidence(selected.id)}
                  >
                    تسجيل الدليل
                  </button>
                </div>
              </div>
            )}

            {selected.attemptLog.length > 0 && (
              <div>
                <h4 className="mb-1 text-xs font-semibold text-slate-700">سجل المحاولات</h4>
                <table className="table text-xs">
                  <thead>
                    <tr>
                      <th>الجزء</th>
                      <th>المحاولة</th>
                      <th>النتيجة</th>
                      <th>HTTP</th>
                      <th>الرمز</th>
                      <th>بدأت</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.attemptLog.map((attempt) => (
                      <tr key={`${attempt.partIndex}-${attempt.attemptNo}`}>
                        <td>{attempt.partIndex ?? '—'}</td>
                        <td>{attempt.attemptNo}</td>
                        <td>{attempt.outcome}</td>
                        <td>{attempt.httpStatus ?? '—'}</td>
                        <td className="text-red-600">{attempt.errorCode ?? '—'}</td>
                        <td>{formatDate(attempt.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {selected.evidence.length > 0 && (
              <div>
                <h4 className="mb-1 text-xs font-semibold text-slate-700">الأدلة المسجَّلة</h4>
                <ul className="space-y-1 text-xs text-slate-600">
                  {selected.evidence.map((item) => (
                    <li key={`${item.decidedAt}-${item.method}`}>
                      {item.method === 'message_id' ? `معرّف رسالة ${item.telegramMessageId ?? ''}` : 'فحص يدوي'} —{' '}
                      {item.decision === 'published' ? 'ظهر المنشور' : 'لم يظهر'} • {formatDate(item.decidedAt)}
                      {item.note ? ` • ${item.note}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* حوار التأكيد (P0): واحد لكل الإجراءات الخطرة، ويُغلق بالتراجع أو Escape. */}
      <ConfirmDialog
        open={confirmState !== null}
        title={confirmState?.title ?? ''}
        description={confirmState?.description ?? ''}
        {...(confirmState?.details ? { details: confirmState.details } : {})}
        confirmLabel={confirmState?.confirmLabel ?? 'تنفيذ'}
        tone={confirmState?.tone ?? 'danger'}
        busy={confirmState !== null && busy === confirmState.key}
        onCancel={() => setConfirmState(null)}
        onConfirm={() => {
          const pending = confirmState;
          if (!pending) return;
          void pending.action().finally(() => setConfirmState(null));
        }}
      />
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="card">
      <p className="text-xs font-medium text-slate-500">{title}</p>
      <p className="mt-1 text-lg font-bold text-slate-800">{value}</p>
    </div>
  );
}
