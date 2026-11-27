/**
 * إدارة مصادر المراقبة (المرحلة الثانية — الخطوة الثالثة).
 *
 * - كل مصدر مربوط بحساب تيليجرام يملكه المستخدم؛ ولا تُعرض مصادر غيره إطلاقاً.
 * - الإضافة إمّا باختيار قناة/مجموعة من محادثات الحساب (قائمة وصفية فقط)، أو بإدخال معرّف.
 * - لا تُقرأ رسائل ولا يُستورد تاريخ: هذه الشاشة تدير الإعدادات والحالة فقط (لا نشر ولا توجيه).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  telegramApi,
  type AvailableTelegramSource,
  type TelegramAccount,
  type TelegramSource,
} from '../api/client';
import { Alert, Badge, EmptyState, Field, Spinner, formatDate } from '../components/ui';
import { useQuery } from '../lib/useQuery';

const statusLabels: Record<TelegramSource['status'], { label: string; tone: 'green' | 'amber' }> = {
  active: { label: 'مراقبة نشطة', tone: 'green' },
  paused: { label: 'موقوفة مؤقتاً', tone: 'amber' },
};

const peerTypeLabels: Record<TelegramSource['peerType'], string> = {
  channel: 'قناة',
  group: 'مجموعة',
};

const accountStatusHints: Record<string, string> = {
  needs_reauth: 'الحساب يحتاج إعادة مصادقة قبل تنفيذ أي عملية.',
  revoked: 'الحساب مفصول؛ أعد ربطه لإدارة مصادره.',
  suspended: 'الحساب موقوف من الإدارة.',
  pending_login: 'لم يكتمل ربط الحساب بعد.',
};

const errorHints: Record<string, string> = {
  SOURCE_NOT_MEMBER: 'غادر الحساب المصدر أو أُزيل منه.',
  SOURCE_KICKED: 'تم حظر الحساب من المصدر.',
  SOURCE_UNAVAILABLE: 'تعذّر الوصول إلى المصدر من تيليجرام.',
};

export default function TelegramSourcesPage() {
  const sources = useQuery(() => telegramApi.sources(), []);
  const accounts = useQuery(() => telegramApi.accounts(), []);
  const [message, setMessage] = useState<{ kind: 'error' | 'success' | 'info' | 'warning'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [identifier, setIdentifier] = useState('');
  const [available, setAvailable] = useState<AvailableTelegramSource[] | null>(null);
  const [availableError, setAvailableError] = useState<string | null>(null);
  const [availableLoading, setAvailableLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const accountList: TelegramAccount[] = accounts.data?.accounts ?? [];
  const usables = useMemo(() => accountList.filter((a) => a.status === 'active'), [accountList]);

  useEffect(() => {
    if (!selectedAccountId && usables.length > 0) setSelectedAccountId(usables[0]!.id);
    if (selectedAccountId && !usables.some((a) => a.id === selectedAccountId)) setSelectedAccountId(usables[0]?.id ?? '');
  }, [selectedAccountId, usables]);

  const fail = (err: unknown, fallback: string) => {
    setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : fallback });
  };

  const reload = () => {
    sources.reload();
    accounts.reload();
  };

  const loadAvailable = async (accountId: string) => {
    if (!accountId) return;
    setAvailableLoading(true);
    setAvailableError(null);
    setAvailable(null);
    try {
      const result = await telegramApi.availableSources(accountId);
      setAvailable(result.sources);
    } catch (err) {
      setAvailableError(err instanceof ApiError ? err.message : 'تعذّر جلب محادثات الحساب.');
    } finally {
      setAvailableLoading(false);
    }
  };

  const add = async (body: { identifier?: string; peerId?: string }) => {
    if (!selectedAccountId) return;
    setBusy('add');
    setMessage(null);
    try {
      const result = await telegramApi.addSource({ accountId: selectedAccountId, ...body });
      setIdentifier('');
      setMessage({ kind: 'success', text: `أُضيف المصدر «${result.source.title}» إلى المراقبة.` });
      reload();
      if (available) await loadAvailable(selectedAccountId);
    } catch (err) {
      fail(err, 'تعذّرت إضافة المصدر.');
    } finally {
      setBusy(null);
    }
  };

  const act = async (sourceId: string, action: 'pause' | 'resume' | 'refresh' | 'delete') => {
    setBusy(`${action}:${sourceId}`);
    setMessage(null);
    try {
      if (action === 'pause') {
        await telegramApi.pauseSource(sourceId);
        setMessage({ kind: 'info', text: 'أُوقفت المراقبة مؤقتاً؛ الفترة الحالية أُغلقت.' });
      } else if (action === 'resume') {
        await telegramApi.resumeSource(sourceId);
        setMessage({ kind: 'success', text: 'استُؤنفت المراقبة وبدأت فترة جديدة.' });
      } else if (action === 'refresh') {
        const result = await telegramApi.refreshSource(sourceId);
        setMessage({
          kind: result.source.status === 'active' ? 'success' : 'warning',
          text:
            result.source.status === 'active'
              ? 'حُدِّثت بيانات المصدر وتأكّد الوصول.'
              : 'فقد الحساب الوصول إلى المصدر؛ أُوقفت المراقبة تلقائياً.',
        });
      } else {
        await telegramApi.removeSource(sourceId);
        setMessage({ kind: 'info', text: 'حُذف المصدر من قائمتك.' });
      }
      setConfirmDelete(null);
      reload();
    } catch (err) {
      fail(err, 'تعذّر تنفيذ العملية.');
    } finally {
      setBusy(null);
    }
  };

  const toggleOwnMessages = async (source: TelegramSource) => {
    setBusy(`own:${source.id}`);
    setMessage(null);
    try {
      await telegramApi.updateSource(source.id, { includeOwnMessages: !source.includeOwnMessages });
      reload();
    } catch (err) {
      fail(err, 'تعذّر تحديث الإعداد.');
    } finally {
      setBusy(null);
    }
  };

  const ready = sources.data?.ready ?? accounts.data?.ready ?? false;
  const list = sources.data?.sources ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">مصادر تيليجرام</h1>
          <p className="mt-1 text-sm text-slate-500">
            أضف القنوات والمجموعات التي تريد مراقبتها من حساب تيليجرام مرتبط. تُدار الحالة والإعدادات فقط، ولا تُقرأ
            الرسائل في هذه المرحلة.
          </p>
        </div>
        <button className="btn-secondary" onClick={reload} disabled={sources.loading || accounts.loading}>
          تحديث
        </button>
      </div>

      {!ready ? (
        <Alert kind="warning">
          تكامل تيليجرام غير مهيأ على الخادم. يجب ضبط بيانات تطبيق Telegram ومفتاح تشفير الجلسات من مسؤول النظام أولاً.
        </Alert>
      ) : null}

      {message ? <Alert kind={message.kind}>{message.text}</Alert> : null}
      {sources.error ? <Alert kind="error">{sources.error}</Alert> : null}
      {accounts.error ? <Alert kind="error">{accounts.error}</Alert> : null}

      {/* الإضافة */}
      <section className="card space-y-4">
        <h2 className="text-lg font-semibold text-slate-800">إضافة مصدر</h2>

        {usables.length === 0 ? (
          <EmptyState
            title="لا يوجد حساب تيليجرام مرتبط وجاهز"
            description="اربط حساباً من صفحة «حسابات تيليجرام» وأكمل التحقق ليتمكن من قراءة المصادر."
          />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="الحساب القارئ" hint="كل مصدر مرتبط بحساب واحد يملكه حسابك">
                <select
                  className="field-input"
                  value={selectedAccountId}
                  onChange={(e) => {
                    setSelectedAccountId(e.target.value);
                    setAvailable(null);
                    setAvailableError(null);
                  }}
                >
                  {usables.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label}
                      {account.telegramUsername ? ` (@${account.telegramUsername})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="إضافة بمعرّف" hint="مثال: @channel_name أو https://t.me/channel_name">
                <div className="flex gap-2">
                  <input
                    className="field-input"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="@channel_name"
                    dir="ltr"
                    maxLength={200}
                  />
                  <button
                    className="btn-primary whitespace-nowrap"
                    onClick={() => void add({ identifier: identifier.trim() })}
                    disabled={busy !== null || identifier.trim().length < 3}
                  >
                    {busy === 'add' ? 'جارٍ الإضافة…' : 'إضافة'}
                  </button>
                </div>
              </Field>
            </div>

            <div className="space-y-3 border-t border-slate-200 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-700">أو اختر من محادثات الحساب</h3>
                <button
                  className="btn-secondary"
                  onClick={() => void loadAvailable(selectedAccountId)}
                  disabled={availableLoading || !selectedAccountId}
                >
                  {availableLoading ? 'جارٍ الجلب…' : available ? 'إعادة الجلب' : 'عرض المحادثات'}
                </button>
              </div>

              {availableError ? <Alert kind="error">{availableError}</Alert> : null}
              {availableLoading ? <Spinner label="جارٍ قراءة قائمة محادثات الحساب…" /> : null}

              {available && available.length === 0 && !availableLoading ? (
                <EmptyState
                  title="لا توجد قنوات أو مجموعات"
                  description="لم يُعثر على قنوات أو مجموعات في محادثات هذا الحساب. يمكنك الإضافة بالمعرّف."
                />
              ) : null}

              {available && available.length > 0 ? (
                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {available.map((item) => (
                    <li
                      key={`${item.peerType}:${item.peerId}`}
                      className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-800">{item.title}</p>
                        <p className="text-xs text-slate-500">
                          {peerTypeLabels[item.peerType]}
                          {item.username ? (
                            <>
                              {' — '}
                              <span dir="ltr">@{item.username}</span>
                            </>
                          ) : null}
                        </p>
                      </div>
                      {item.alreadyMonitored ? (
                        <Badge tone="slate">مضاف بالفعل</Badge>
                      ) : (
                        <button
                          className="btn-secondary"
                          onClick={() => void add({ peerId: item.peerId })}
                          disabled={busy !== null}
                        >
                          إضافة للمراقبة
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </>
        )}
      </section>

      {/* القائمة */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">المصادر ({list.length})</h2>
        </div>

        {sources.loading ? <Spinner /> : null}

        {!sources.loading && list.length === 0 ? (
          <EmptyState title="لا توجد مصادر بعد" description="أضف أول قناة أو مجموعة من النموذج أعلاه لبدء إدارة المراقبة." />
        ) : null}

        {list.length > 0 ? (
          <div className="space-y-3">
            {list.map((source) => {
              const accountHint = accountStatusHints[source.accountStatus];
              const offline = source.connectionPhase !== 'connected';
              return (
                <article key={source.id} className="card space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-base font-semibold text-slate-800">{source.title}</h3>
                        <Badge tone={statusLabels[source.status].tone}>{statusLabels[source.status].label}</Badge>
                        <Badge tone="blue">{peerTypeLabels[source.peerType]}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {source.username ? (
                          <span dir="ltr">@{source.username}</span>
                        ) : (
                          <span>معرّف: <span dir="ltr">{source.peerId}</span></span>
                        )}
                        {' — '}
                        الحساب: {source.accountLabel} ({offline ? 'غير متصل' : 'متصل'})
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {source.status === 'active' ? (
                        <button
                          className="btn-secondary"
                          onClick={() => void act(source.id, 'pause')}
                          disabled={busy !== null}
                        >
                          {busy === `pause:${source.id}` ? 'جارٍ الإيقاف…' : 'إيقاف مؤقت'}
                        </button>
                      ) : (
                        <button
                          className="btn-secondary"
                          onClick={() => void act(source.id, 'resume')}
                          disabled={busy !== null}
                        >
                          {busy === `resume:${source.id}` ? 'جارٍ الاستئناف…' : 'استئناف'}
                        </button>
                      )}
                      <button
                        className="btn-secondary"
                        onClick={() => void act(source.id, 'refresh')}
                        disabled={busy !== null}
                      >
                        {busy === `refresh:${source.id}` ? 'جارٍ التحقق…' : 'التحقق من الوصول'}
                      </button>
                      {confirmDelete === source.id ? (
                        <>
                          <button
                            className="btn-primary"
                            onClick={() => void act(source.id, 'delete')}
                            disabled={busy !== null}
                          >
                            {busy === `delete:${source.id}` ? 'جارٍ الحذف…' : 'تأكيد الحذف'}
                          </button>
                          <button className="btn-secondary" onClick={() => setConfirmDelete(null)} disabled={busy !== null}>
                            إلغاء
                          </button>
                        </>
                      ) : (
                        <button className="btn-secondary" onClick={() => setConfirmDelete(source.id)} disabled={busy !== null}>
                          حذف
                        </button>
                      )}
                    </div>
                  </div>

                  <dl className="grid gap-2 text-xs text-slate-600 sm:grid-cols-3">
                    <div>
                      <dt className="text-slate-500">بدء المراقبة</dt>
                      <dd>{formatDate(source.monitoringStartedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">آخر تحقق</dt>
                      <dd>{formatDate(source.lastVerifiedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">حالة اتصال الحساب</dt>
                      <dd>{source.connectionPhase === 'connected' ? 'متصل' : source.connectionPhase}</dd>
                    </div>
                  </dl>

                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300"
                      checked={source.includeOwnMessages}
                      onChange={() => void toggleOwnMessages(source)}
                      disabled={busy !== null}
                    />
                    تضمين رسائلي التي أكتبها في هذا المصدر
                  </label>

                  {accountHint ? <Alert kind="warning">{accountHint}</Alert> : null}
                  {source.lastErrorCode ? (
                    <Alert kind="warning">
                      {errorHints[source.lastErrorCode] ?? 'آخر خطأ مسجّل من تيليجرام.'}{' '}
                      <span className="font-mono text-xs" dir="ltr">{source.lastErrorCode}</span>
                    </Alert>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : null}
      </section>
    </div>
  );
}
