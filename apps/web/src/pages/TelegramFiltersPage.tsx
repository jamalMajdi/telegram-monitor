/**
 * شاشة إدارة الفلاتر — تحرير كامل من الواجهة.
 *
 * ملاحظة صلابة (إصلاح انهيار E-MWWD4Z41): قائمة الـAPI تعيد **ملخّصات** لا تحتوي `conditions`.
 * لذلك تُعرض الشرائح من التفاصيل التي تُجلب بشكل كسول (Lazy) لكل فلتر، وتُستعمل أعداد الملخّص
 * كبديل آمن إن تعذّر الجلب. لا يُفترض وجود أي حقل غير موثّق في النوع `RuleSummary`.
 */
import { useEffect, useState } from 'react';
import { ApiError, telegramRulesApi, type RuleDetail, type RuleSummary } from '../api/client';
import { Alert, Badge, EmptyState, Spinner, formatDate } from '../components/ui';
import { RuleEditor } from '../components/RuleEditor';
import { useQuery } from '../lib/useQuery';

type Notice = { kind: 'error' | 'success' | 'info' | 'warning'; text: string } | null;

export default function TelegramFiltersPage() {
  const filters = useQuery(() => telegramRulesApi.filters(), []);
  const dictionaries = useQuery(() => telegramRulesApi.dictionaries(), []);
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState<RuleDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** تفاصيل كسولة لكل فلتر — تُستخدم لعرض الشروط دون تحميلها في القائمة نفسها. */
  const [details, setDetails] = useState<Record<string, RuleDetail>>({});

  const list: RuleSummary[] = filters.data?.filters ?? [];

  // جلب تفاصيل الشروط بعد وصول القائمة (كل فشل فردي لا يُسقط الشاشة).
  useEffect(() => {
    if (list.length === 0) return;
    let live = true;
    void Promise.all(
      list
        .slice(0, 30)
        .map((item) => telegramRulesApi.filter(item.id).then((res) => res.filter).catch(() => null)),
    ).then((rows) => {
      if (!live) return;
      const next: Record<string, RuleDetail> = {};
      for (const row of rows) if (row) next[row.id] = row;
      setDetails(next);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.data]);

  const reload = () => {
    filters.reload();
    dictionaries.reload();
  };

  const startEdit = async (filter: RuleSummary) => {
    setBusyId(filter.id);
    setNotice(null);
    try {
      const { filter: full } = await telegramRulesApi.filter(filter.id);
      setCreating(false);
      setEditing(full);
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'تعذّر تحميل الفلتر.' });
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (filter: RuleSummary) => {
    setBusyId(filter.id);
    setNotice(null);
    try {
      await telegramRulesApi.deleteFilter(filter.id);
      setNotice({ kind: 'success', text: `حُذف الفلتر «${filter.name}».` });
      reload();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'تعذّر الحذف.' });
    } finally {
      setBusyId(null);
    }
  };

  const onToggle = async (filter: RuleSummary) => {
    setBusyId(filter.id);
    setNotice(null);
    try {
      await telegramRulesApi.updateFilter(filter.id, { enabled: !filter.enabled });
      setNotice({
        kind: 'success',
        text: filter.enabled ? `أُوقف الفلتر «${filter.name}».` : `فُعّل الفلتر «${filter.name}».`,
      });
      reload();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'تعذّر التعديل.' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">الفلاتر</h1>
          <p className="text-sm text-slate-500">
            الفلتر يجيب: «هل تهمّني هذه الرسالة؟» — الرسالة التي لا تطابق أي فلتر تُهمل قبل التصنيف.
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={() => {
            setEditing(null);
            setCreating(true);
          }}
        >
          + فلتر جديد
        </button>
      </header>

      {notice ? <Alert kind={notice.kind}>{notice.text}</Alert> : null}
      {filters.error ? <Alert kind="error">{filters.error}</Alert> : null}

      {creating || editing ? (
        <RuleEditor
          rule={editing}
          kind="filter"
          dictionaries={dictionaries.data?.dictionaries ?? []}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(text) => {
            setCreating(false);
            setEditing(null);
            setNotice({ kind: 'success', text });
            reload();
          }}
        />
      ) : null}

      {filters.loading ? <Spinner /> : null}

      {!filters.loading && list.length === 0 ? (
        <EmptyState title="لا فلاتر بعد" description="أنشئ فلتراً بكلمات مفتاحية لتبدأ مطابقة الرسائل." />
      ) : null}

      <section className="space-y-3">
        {list.map((filter) => {
          const conditions = details[filter.id]?.conditions ?? [];
          return (
            <article key={filter.id} className="card space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-lg font-semibold text-slate-800">{filter.name}</p>
                  <p className="text-sm text-slate-500">{filter.description ?? 'بلا وصف'}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    أولوية {filter.priority} · {filter.conditionCount} شرط
                    {typeof filter.termCount === 'number' ? ` · ${filter.termCount} مصطلح` : ''} ·{' '}
                    {filter.scope === 'bound_sources'
                      ? `مربوط (${(filter.sourceIds ?? []).length})`
                      : 'كل المصادر'}
                    {filter.updatedAt ? ` · آخر تحديث ${formatDate(filter.updatedAt)}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={filter.enabled ? 'green' : 'amber'}>{filter.enabled ? 'مفعّل' : 'معطّل'}</Badge>
                  <button className="btn-secondary" onClick={() => void startEdit(filter)} disabled={busyId === filter.id}>
                    تعديل
                  </button>
                  <button className="btn-secondary" onClick={() => void onToggle(filter)} disabled={busyId === filter.id}>
                    {filter.enabled ? 'إيقاف' : 'تفعيل'}
                  </button>
                  <button className="btn-secondary" onClick={() => void onDelete(filter)} disabled={busyId === filter.id}>
                    حذف
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {conditions.length > 0 ? (
                  conditions.map((condition) => (
                    <span
                      key={condition.id}
                      className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700"
                      title={`النمط: ${condition.mode}${condition.negate ? ' · منفيّ' : ''}`}
                    >
                      {condition.negate ? '🚫 ' : ''}
                      {condition.dictionaryId
                        ? `قاموس (${dictionaries.data?.dictionaries?.find((d) => d.id === condition.dictionaryId)?.name ?? '—'})`
                        : condition.terms
                            .slice(0, 4)
                            .map((term) => term.display)
                            .join('، ') || '—'}
                      {condition.terms.length > 4 ? ` +${condition.terms.length - 4}` : ''}
                    </span>
                  ))
                ) : (
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700">
                    {filter.conditionCount} شرط — افتح «تعديل» لعرض التفاصيل
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
