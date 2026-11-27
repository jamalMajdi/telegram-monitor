/**
 * محرّر قاعدة واحدة (فلتر أو تصنيف) — مكوّن مشترك بين شاشتَي الفلاتر والتصنيفات.
 *
 * المبدأ: نفس محرّك التقييم في الخادم، فالواجهة تُرسل **شروطًا** فقط ولا تحسب أي مطابقة بنفسها.
 * الاختبار يعمل عبر `POST /telegram/filters/test` (في الذاكرة، بلا حفظ ولا كتابة في القاعدة).
 */
import { useMemo, useState } from 'react';
import {
  ApiError,
  telegramRulesApi,
  type DictionarySummary,
  type RuleConditionInput,
  type RuleDetail,
  type RuleDraft,
  type RuleMatchMode,
  type RuleTestResult,
} from '../api/client';
import { Alert, Field } from './ui';

interface DraftCondition {
  mode: 'all' | 'any';
  negate: boolean;
  matchMode: RuleMatchMode;
  dictionaryId: string;
  termsText: string;
}

export interface RuleEditorProps {
  /** قاعدة قائمة للتعديل، أو `null` لإنشاء جديد. */
  rule: RuleDetail | null;
  kind: 'filter' | 'classification';
  dictionaries: DictionarySummary[];
  onSaved: (message: string) => void;
  onCancel: () => void;
}

function toDraftConditions(rule: RuleDetail | null): DraftCondition[] {
  // تحصين: قد يصل كائن ناقص الشروط من مسار غير متوقّع — لا نفترض وجود المصفوفة أبداً.
  if (!rule || !Array.isArray(rule.conditions) || rule.conditions.length === 0) {
    return [{ mode: 'any', negate: false, matchMode: 'word', dictionaryId: '', termsText: '' }];
  }
  return rule.conditions.map((condition) => ({
    mode: condition.mode,
    negate: condition.negate,
    matchMode: condition.terms[0]?.matchMode ?? 'word',
    dictionaryId: condition.dictionaryId ?? '',
    termsText: condition.terms.filter((term) => term.literal).map((term) => term.display).join('، '),
  }));
}

export function RuleEditor({ rule, kind, dictionaries, onSaved, onCancel }: RuleEditorProps) {
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [scope, setScope] = useState<'all_sources' | 'bound_sources'>(rule?.scope ?? 'all_sources');
  const [conditions, setConditions] = useState<DraftCondition[]>(toDraftConditions(rule));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<RuleTestResult | null>(null);

  const buildDraft = useMemo(
    () =>
      (): RuleDraft => ({
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
        priority: Number(priority) || 0,
        enabled,
        ...(kind === 'filter' ? { scope, appliesTo: 'any' as const } : {}),
        conditions: conditions
          .map((condition): RuleConditionInput => {
            const terms = condition.termsText
              .split(/[،,\n]/)
              .map((term) => term.trim())
              .filter(Boolean);
            return {
              mode: condition.mode,
              negate: condition.negate,
              matchMode: condition.matchMode,
              ...(condition.dictionaryId ? { dictionaryId: condition.dictionaryId } : {}),
              ...(terms.length > 0 ? { terms } : {}),
            };
          })
          // شرط بلا مصطلحات وبلا قاموس يُسقط نفسه (لا معنى له في المحرّك).
          .filter((condition) => (condition.terms && condition.terms.length > 0) || condition.dictionaryId),
      }),
    [name, description, priority, enabled, scope, conditions, kind],
  );

  const updateCondition = (index: number, patch: Partial<DraftCondition>) => {
    setConditions((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const onSave = async () => {
    setError(null);
    const draft = buildDraft();
    if (draft.name.length === 0) return setError('الاسم مطلوب.');
    if (draft.conditions.length === 0) return setError('أضف شرطاً واحداً على الأقل (مصطلحات أو قاموس).');
    setBusy(true);
    try {
      if (kind === 'filter') {
        if (rule) await telegramRulesApi.updateFilter(rule.id, draft);
        else await telegramRulesApi.createFilter(draft);
      } else {
        if (rule) await telegramRulesApi.updateClassification(rule.id, draft);
        else await telegramRulesApi.createClassification(draft);
      }
      onSaved(rule ? 'حُفظت التعديلات.' : 'أُنشئت القاعدة الجديدة.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذّر الحفظ. تحقّق من الاتصال.');
    } finally {
      setBusy(false);
    }
  };

  const onTest = async () => {
    setError(null);
    if (testText.trim() === '') return setError('أدخل نصاً تجريبياً.');
    setBusy(true);
    try {
      const draft = { ...buildDraft(), name: name.trim() || 'مسوّدة' };
      const { result } = await telegramRulesApi.testDraft({ definition: draft, text: testText });
      setTestResult(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذّر تنفيذ الاختبار.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-4">
      <h2 className="text-lg font-semibold text-slate-800">
        {rule ? `تعديل: ${rule.name}` : kind === 'filter' ? 'فلتر جديد' : 'تصنيف جديد'}
      </h2>
      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="الاسم">
          <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <Field label="الأولوية" hint="الأصغر يُقيَّم أولاً ويُرجَّح عند التعادل">
          <input
            className="field-input"
            type="number"
            min={0}
            max={10000}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            dir="ltr"
          />
        </Field>
      </div>

      <Field label="الوصف (اختياري)">
        <input
          className="field-input"
          value={description ?? ''}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={300}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          مفعّل
        </label>
        {kind === 'filter' ? (
          <Field label="نطاق التطبيق">
            <select
              className="field-input"
              value={scope}
              onChange={(e) => setScope(e.target.value as 'all_sources' | 'bound_sources')}
            >
              <option value="all_sources">كل المصادر</option>
              <option value="bound_sources">المصادر المربوطة فقط</option>
            </select>
          </Field>
        ) : null}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">الشروط</h3>
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              setConditions((current) => [
                ...current,
                { mode: 'any', negate: false, matchMode: 'word', dictionaryId: '', termsText: '' },
              ])
            }
          >
            + شرط
          </button>
        </div>
        <p className="text-xs text-slate-500">
          القاعدة تُطابق فقط إذا تحقّقت <strong>كل</strong> شروطها. الشرط «أي» يكفي فيه مصطلح واحد، و«كل» يطلب
          جميع مصطلحات الشرط. الشرط المنفيّ يمنع المطابقة عند وجود كلماته.
        </p>

        {conditions.map((condition, index) => (
          <div key={index} className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="النمط">
                <select
                  className="field-input"
                  value={condition.mode}
                  onChange={(e) => updateCondition(index, { mode: e.target.value as 'all' | 'any' })}
                >
                  <option value="any">أي مصطلح (any)</option>
                  <option value="all">كل المصطلحات (all)</option>
                </select>
              </Field>
              <Field label="مطابقة الكلمة">
                <select
                  className="field-input"
                  value={condition.matchMode}
                  onChange={(e) => updateCondition(index, { matchMode: e.target.value as RuleMatchMode })}
                >
                  <option value="word">كلمة كاملة</option>
                  <option value="phrase">عبارة</option>
                  <option value="contains">احتواء جزء</option>
                </select>
              </Field>
              <Field label="قاموس (اختياري)">
                <select
                  className="field-input"
                  value={condition.dictionaryId}
                  onChange={(e) => updateCondition(index, { dictionaryId: e.target.value })}
                >
                  <option value="">— بلا قاموس —</option>
                  {(Array.isArray(dictionaries) ? dictionaries : []).map((dictionary) => (
                    <option key={dictionary.id} value={dictionary.id}>
                      {dictionary.name} ({dictionary.termCount})
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={condition.negate}
                  onChange={(e) => updateCondition(index, { negate: e.target.checked })}
                />
                منفيّ (استبعاد)
              </label>
              <button
                type="button"
                className="btn-secondary mb-0.5"
                onClick={() => setConditions((current) => current.filter((_, i) => i !== index))}
                disabled={conditions.length === 1}
              >
                حذف الشرط
              </button>
            </div>
            <div className="mt-3">
              <Field label="المصطلحات" hint="افصل بينها بفاصلة، أو أفلتها بسطر جديد">
                <textarea
                  className="field-input"
                  rows={2}
                  value={condition.termsText}
                  onChange={(e) => updateCondition(index, { termsText: e.target.value })}
                  placeholder="مثال: حل، واجبات، اختبار"
                />
              </Field>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <button className="btn-primary" onClick={() => void onSave()} disabled={busy}>
          {busy ? 'جارٍ الحفظ…' : 'حفظ'}
        </button>
        <button className="btn-secondary" onClick={onCancel} disabled={busy}>
          إلغاء
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <h3 className="text-sm font-semibold text-slate-700">اختبار فوري (بلا حفظ)</h3>
        <p className="mt-1 text-xs text-slate-500">
          يُقيَّم النص على الخادم بنفس محرّك الإنتاج، ولا يُخزَّن النص ولا تُكتب أي نتيجة في القاعدة.
        </p>
        <textarea
          className="field-input mt-2"
          rows={3}
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
          placeholder="الصق نص رسالة لاختبارها…"
        />
        <div className="mt-2 flex flex-wrap gap-3">
          <button className="btn-secondary" onClick={() => void onTest()} disabled={busy}>
            اختبار
          </button>
          {testResult ? (
            <span className="text-sm text-slate-700">
              {testResult.matched ? '✅ مطابقة' : '❌ غير مطابقة'} · شروط محقَّقة:{' '}
              {testResult.matches.reduce(
                (total, match) => total + match.hits.filter((hit) => hit.satisfied).length,
                0,
              )}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
