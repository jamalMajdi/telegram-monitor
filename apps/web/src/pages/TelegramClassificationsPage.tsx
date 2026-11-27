/**
 * شاشة إدارة التصنيفات — تحرير قواعد التصنيف من الواجهة.
 *
 * التصنيف يجيب: «ما نوع هذه الرسالة؟». تطابق أكثر من تصنيف واحد يجعل الرسالة **غامضة**
 * فتُوقف للمراجعة؛ لذلك تعرض الشاشة القاعدة صريحة وتتيح تضييق الشروط.
 *
 * ملاحظة صلابة: ملخّص التصنيف من الـAPI لا يحتوي `conditions` ولا `termCount` ولا `updatedAt`،
 * فلا يُفترض أي منها؛ تُجلب التفاصيل بشكل كسول ويُعرض الملخّص وحده إن تعذّر الجلب.
 */
import { useEffect, useState } from 'react';
import { ApiError, telegramRulesApi, type RuleDetail, type RuleSummary } from '../api/client';
import { Alert, Badge, EmptyState, Spinner, formatDate } from '../components/ui';
import { RuleEditor } from '../components/RuleEditor';
import { useQuery } from '../lib/useQuery';

type Notice = { kind: 'error' | 'success' | 'info' | 'warning'; text: string } | null;

export default function TelegramClassificationsPage() {
  const classifications = useQuery(() => telegramRulesApi.classifications(), []);
  const dictionaries = useQuery(() => telegramRulesApi.dictionaries(), []);
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState<RuleDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, RuleDetail>>({});

  const list: RuleSummary[] = classifications.data?.classifications ?? [];

  useEffect(() => {
    if (list.length === 0) return;
    let live = true;
    void Promise.all(
      list
        .slice(0, 30)
        .map((item) => telegramRulesApi.classification(item.id).then((res) => res.classification).catch(() => null)),
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
  }, [classifications.data]);

  const reload = () => {
    classifications.reload();
    dictionaries.reload();
  };

  const startEdit = async (item: RuleSummary) => {
    setBusyId(item.id);
    setNotice(null);
    try {
      const { classification } = await telegramRulesApi.classification(item.id);
      setCreating(false);
      setEditing(classification);
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'تعذّر تحميل التصنيف.' });
    } finally {
      setBusyId(null);
    }
  };

  const onToggle = async (item: RuleSummary) => {
    setBusyId(item.id);
    setNotice(null);
    try {
      await telegramRulesApi.updateClassification(item.id, { enabled: !item.enabled });
      setNotice({
        kind: 'success',
        text: item.enabled ? `أُوقف التصنيف «${item.name}».` : `فُعّل التصنيف «${item.name}».`,
      });
      reload();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'تعذّر التعديل.' });
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (item: RuleSummary) => {
    setBusyId(item.id);
    setNotice(null);
    try {
      await telegramRulesApi.deleteClassification(item.id);
      setNotice({ kind: 'success', text: `حُذف التصنيف «${item.name}».` });
      reload();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'تعذّر الحذف.' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">التصنيفات</h1>
          <p className="text-sm text-slate-500">
            تطابق تصنيفين مع الرسالة الواحدة يجعلها غامضة فتُوقف للمراجعة. اضبط الشروط بحيث يكون الفائز واحداً.
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={() => {
            setEditing(null);
            setCreating(true);
          }}
        >
          + تصنيف جديد
        </button>
      </header>

      {notice ? <Alert kind={notice.kind}>{notice.text}</Alert> : null}
      {classifications.error ? <Alert kind="error">{classifications.error}</Alert> : null}

      {creating || editing ? (
        <RuleEditor
          rule={editing}
          kind="classification"
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

      {classifications.loading ? <Spinner /> : null}

      {!classifications.loading && list.length === 0 ? (
        <EmptyState title="لا تصنيفات" description="أنشئ تصنيفاً بشروط لبدء تصنيف الرسائل المطابقة." />
      ) : null}

      <section className="space-y-3">
        {list.map((item) => {
          const conditions = details[item.id]?.conditions ?? [];
          const termCount = details[item.id]?.termCount ?? item.termCount;
          const updatedAt = details[item.id]?.updatedAt ?? item.updatedAt;
          return (
            <article key={item.id} className="card space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-lg font-semibold text-slate-800">{item.name}</p>
                  <p className="text-sm text-slate-500">{item.description ?? 'بلا وصف'}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    أولوية {item.priority} · {item.conditionCount} شرط
                    {typeof termCount === 'number' ? ` · ${termCount} مصطلح` : ''}
                    {updatedAt ? ` · آخر تحديث ${formatDate(updatedAt)}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={item.enabled ? 'green' : 'amber'}>{item.enabled ? 'مفعّل' : 'معطّل'}</Badge>
                  {item.isBuiltin ? <Badge tone="slate">مبذور</Badge> : null}
                  <button className="btn-secondary" onClick={() => void startEdit(item)} disabled={busyId === item.id}>
                    تعديل
                  </button>
                  <button className="btn-secondary" onClick={() => void onToggle(item)} disabled={busyId === item.id}>
                    {item.enabled ? 'إيقاف' : 'تفعيل'}
                  </button>
                  <button className="btn-secondary" onClick={() => void onDelete(item)} disabled={busyId === item.id}>
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
                    {item.conditionCount} شرط — افتح «تعديل» لعرض التفاصيل
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
