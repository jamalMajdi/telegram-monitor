/**
 * صفحة الإعدادات (P4-د): الاحتفاظ + منطقة الخطر.
 *
 * مبادئ هذه الصفحة:
 * - **لا حذف بنقرة**: كل عملية تدميرية تتطلب كتابة عبارة التأكيد الحرفية التي يرسلها الخادم،
 *   وحذف الحساب يطلب كلمة المرور أيضاً.
 * - **أثر معلن قبل الفعل**: كل عملية تشرح بالضبط ما يُحذف وما يبقى، وبلا كلمات مطمئنة كاذبة.
 * - **تقرير بعد الفعل**: الأعداد المحذوفة تُعرض كما أعادها الخادم، لا كما نتمناها.
 */
import { useEffect, useState } from 'react';
import { ApiError, meApi, type AttributionBaseMode, type AttributionSettings } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Alert, Field, Spinner, formatDate } from '../components/ui';
import { useQuery } from '../lib/useQuery';

const PURGE_ITEMS = [
  'نصوص الرسائل المطابقة',
  'الاستخراج والتصنيف',
  'المطابقات ونتائج الفلترة',
  'التسليمات وأجزاؤها ومحاولاتها وأدلتها',
  'أحداث الأخطاء الخاصة بك',
];

const PURGE_KEEPS = ['الحساب وكلمة المرور', 'حسابات تيليجرام المرتبطة', 'المصادر والفلاتر والقوالب', 'الوجهات والمسارات', 'الإعدادات والجلسات', 'سجل التدقيق'];

const DELETE_ITEMS = [
  'حسابك وبيانات الدخول',
  'حسابات تيليجرام وجلساتها وأسرارها',
  'رموز البوتات',
  'المصادر والفلاتر والقوالب والوجهات والمسارات',
  'الرسائل والتسليمات وكل سجلاتها',
  'جلسات الويب والإعدادات',
];

const ATTRIBUTION_MODES: { value: AttributionBaseMode; label: string; hint: string }[] = [
  { value: 'both', label: 'المصدر والمرسل', hint: 'سطران أسفل المنشور: القناة/المجموعة ومن كتب الرسالة.' },
  { value: 'source', label: 'المصدر فقط', hint: 'سطر واحد: القناة أو المجموعة التي جاءت منها الرسالة.' },
  { value: 'sender', label: 'المرسل فقط', hint: 'سطر واحد: من كتب الرسالة داخل المصدر.' },
];

/** معاينة حيّة لما سيظهر أسفل المنشور تماماً كما يُبنى على الخادم. */
function attributionPreview(settings: AttributionSettings): string[] {
  if (!settings.enabled) return [];
  const rows: string[] = [];
  if (settings.mode === 'source' || settings.mode === 'both') {
    const parts = ['**المصدر:** قناة السوق العام'];
    if (settings.showUsername) parts.push('@public_market');
    if (settings.showId) parts.push('1001234567890');
    rows.push(`📣 ${parts[0]} · ${parts.slice(1).join(' · ')}`);
  }
  if (settings.mode === 'sender' || settings.mode === 'both') {
    const parts = ['**المرسل:** محمد عبدالله'];
    if (settings.showUsername) parts.push('@mohammed_a');
    if (settings.showId) parts.push('782139465');
    rows.push(`👤 ${parts[0]} · ${parts.slice(1).join(' · ')}`);
  }
  return rows;
}

export default function SettingsPage() {
  const { refresh } = useAuth();
  const profile = useQuery(() => meApi.profile(), []);
  const settings = useQuery(() => meApi.settings(), []);

  const [contentHours, setContentHours] = useState(48);
  const [deliveryDays, setDeliveryDays] = useState(90);
  const [saveState, setSaveState] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);

  const [attribution, setAttribution] = useState<AttributionSettings>({
    enabled: true,
    mode: 'both',
    showUsername: true,
    showId: false,
  });
  const [attributionBusy, setAttributionBusy] = useState(false);
  const [attributionState, setAttributionState] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  const [purgePhrase, setPurgePhrase] = useState('');
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeState, setPurgeState] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [purgeReport, setPurgeReport] = useState<{ total: number; report: Record<string, number> } | null>(null);

  const [deletePassword, setDeletePassword] = useState('');
  const [deletePhrase, setDeletePhrase] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteState, setDeleteState] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  useEffect(() => {
    if (settings.data) {
      setContentHours(settings.data.settings.contentRetentionHours);
      setDeliveryDays(settings.data.settings.deliveryRetentionDays);
      if (settings.data.settings.attribution) setAttribution(settings.data.settings.attribution);
    }
  }, [settings.data]);

  const requiredPurge = profile.data?.dangerZone.purgePhrase ?? 'احذف بياناتي';
  const requiredDelete = profile.data?.dangerZone.deletePhrase ?? 'احذف حسابي نهائياً';

  const saveRetention = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaveBusy(true);
    setSaveState(null);
    try {
      const result = await meApi.updateSettings({
        contentRetentionHours: contentHours,
        deliveryRetentionDays: deliveryDays,
      });
      setContentHours(result.settings.contentRetentionHours);
      setDeliveryDays(result.settings.deliveryRetentionDays);
      setSaveState({ kind: 'success', message: `حُفظت السياسة عند ${formatDate(result.settings.updatedAt)}.` });
    } catch (err) {
      setSaveState({ kind: 'error', message: err instanceof ApiError ? err.message : 'تعذّر الحفظ.' });
    } finally {
      setSaveBusy(false);
    }
  };

  /**
   * حفظ فوري بلا زر: كل نقرة تُطبَّق على الرسائل القادمة والمسارات التي لا تتجاوز الإعداد.
   * عدم التوفيق في الحفظ يُظهر الخطأ ويترك الواجهة على القيمة السابقة المؤكدة.
   */
  const applyAttribution = async (patch: Partial<AttributionSettings>) => {
    const next = { ...attribution, ...patch };
    setAttribution(next);
    setAttributionBusy(true);
    setAttributionState(null);
    try {
      const result = await meApi.updateSettings({
        attributionEnabled: next.enabled,
        attributionMode: next.mode,
        attributionShowUsername: next.showUsername,
        attributionShowId: next.showId,
      });
      setAttribution(result.settings.attribution);
      setAttributionState({ kind: 'success', message: 'حُفظ. يسري على الرسائل القادمة فوراً.' });
    } catch (err) {
      setAttributionState({ kind: 'error', message: err instanceof ApiError ? err.message : 'تعذّر الحفظ.' });
    } finally {
      setAttributionBusy(false);
    }
  };

  const purgeData = async (event: React.FormEvent) => {
    event.preventDefault();
    setPurgeBusy(true);
    setPurgeState(null);
    setPurgeReport(null);
    try {
      const result = await meApi.purgeData({ confirmation: purgePhrase });
      setPurgePhrase('');
      setPurgeReport({ total: result.total, report: result.report });
      setPurgeState({ kind: 'success', message: `حُذف ${result.total} صفاً تشغيلياً. الإعدادات والحساب سليمان.` });
    } catch (err) {
      setPurgeState({ kind: 'error', message: err instanceof ApiError ? err.message : 'تعذّر حذف البيانات.' });
    } finally {
      setPurgeBusy(false);
    }
  };

  const deleteAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    setDeleteBusy(true);
    setDeleteState(null);
    try {
      await meApi.deleteAccount({ password: deletePassword, confirmation: deletePhrase });
      await refresh().catch(() => undefined);
      window.location.href = '/login';
    } catch (err) {
      setDeleteState({ kind: 'error', message: err instanceof ApiError ? err.message : 'تعذّر حذف الحساب.' });
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">الإعدادات</h1>
        <p className="mt-1 text-sm text-slate-500">
          سياسات الاحتفاظ، وأمان الحساب، ومنطقة الخطر. كل حذف هنا نهائي — لا سلة محذوفات ولا استرجاع.
        </p>
      </div>

      {profile.loading || settings.loading ? <Spinner /> : null}
      {profile.error ? <Alert kind="error">{profile.error}</Alert> : null}
      {settings.error ? <Alert kind="error">{settings.error}</Alert> : null}

      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-800">هوية المصدر والمرسل</h2>
            <p className="mt-1 text-xs leading-6 text-slate-500">
              تُضاف أسفل كل منشور بخط فاصل رقيق، من بيانات تيليجرام نفسها — بلا طلبات إضافية وبلا اختراع بيانات.
              المفعّل افتراضياً (Opt-out): يعمل فوراً على كل الرسائل والمسارات، ويمكن لكل مسار تجاوزه أو إيقافه وحده.
            </p>
          </div>
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={attribution.enabled}
              disabled={attributionBusy}
              onChange={(e) => void applyAttribution({ enabled: e.target.checked })}
            />
            <span className="text-sm font-semibold text-slate-700">{attribution.enabled ? 'مفعّلة' : 'موقوفة'}</span>
          </label>
        </div>

        <div className={`mt-4 grid gap-4 lg:grid-cols-2 ${attribution.enabled ? '' : 'opacity-50'}`}>
          <div className="space-y-3">
            <p className="text-xs font-semibold text-slate-700">ما يُعرض</p>
            {ATTRIBUTION_MODES.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${
                  attribution.mode === option.value ? 'border-sky-300 bg-sky-50/50' : 'border-slate-200'
                }`}
              >
                <input
                  type="radio"
                  name="attribution-mode"
                  className="mt-1 h-4 w-4"
                  checked={attribution.mode === option.value}
                  disabled={!attribution.enabled || attributionBusy}
                  onChange={() => void applyAttribution({ mode: option.value })}
                />
                <span>
                  <span className="block text-sm font-semibold text-slate-800">{option.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-slate-500">{option.hint}</span>
                </span>
              </label>
            ))}
            <div className="space-y-2 rounded-lg border border-slate-200 p-3">
              <p className="text-xs font-semibold text-slate-700">تفاصيل العناصر</p>
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={attribution.showUsername}
                  disabled={!attribution.enabled || attributionBusy}
                  onChange={(e) => void applyAttribution({ showUsername: e.target.checked })}
                />
                إظهار @username كرابط (إن وُجد)
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={attribution.showId}
                  disabled={!attribution.enabled || attributionBusy}
                  onChange={(e) => void applyAttribution({ showId: e.target.checked })}
                />
                إظهار المعرّف الرقمي (افتراضياً مخفي)
              </label>
              <p className="text-[11px] leading-5 text-slate-400">
                الأسماء تُفحص قبل العرض: أي رقم أو يوزر تواصل داخل الاسم يُحجب تلقائياً.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-700">معاينة</p>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="rounded-lg bg-white p-3 shadow-sm">
                <p className="text-xs leading-6 text-slate-700">… نص المنشور كما يصل إلى الوجهة …</p>
                {attribution.enabled ? (
                  <div className="mt-2 border-t border-dashed border-slate-200 pt-2">
                    <p className="text-center text-[11px] tracking-[0.3em] text-slate-300">· · ·</p>
                    {attributionPreview(attribution).map((line) => (
                      <p key={line} className="mt-1 text-[11px] leading-5 text-slate-500">
                        {line.split('**').map((chunk, index) =>
                          index % 2 === 1 ? (
                            <strong key={index} className="font-semibold text-slate-700">
                              {chunk}
                            </strong>
                          ) : (
                            <span key={index}>{chunk}</span>
                          ),
                        )}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 border-t border-dashed border-slate-200 pt-2 text-[11px] text-slate-400">
                    بلا هوية — المنشور كما هو.
                  </p>
                )}
              </div>
            </div>
            {attributionState ? <Alert kind={attributionState.kind}>{attributionState.message}</Alert> : null}
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="text-lg font-bold text-slate-800">سياسات الاحتفاظ</h2>
        <p className="mt-1 text-xs leading-6 text-slate-500">
          الاحتفاظ يُطبَّق بمهمة تنظيف دورية واحدة. تقصير المدة يحذف الأقدم عند الدورة التالية، ولا يُمدَّد ما انتهى.
        </p>
        <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={saveRetention}>
          <Field label="احتفاظ محتوى الرسائل (ساعات)" hint="من 1 إلى 2160 ساعة. الافتراضي 48.">
            <input
              className="field-input"
              type="number"
              min={1}
              max={2160}
              value={contentHours}
              onChange={(e) => setContentHours(Number(e.target.value))}
            />
          </Field>
          <Field label="احتفاظ سجلات النشر (أيام)" hint="من 1 إلى 3650 يوماً. الافتراضي 90.">
            <input
              className="field-input"
              type="number"
              min={1}
              max={3650}
              value={deliveryDays}
              onChange={(e) => setDeliveryDays(Number(e.target.value))}
            />
          </Field>
          <div className="sm:col-span-2 space-y-3">
            {saveState ? <Alert kind={saveState.kind}>{saveState.message}</Alert> : null}
            <button className="btn-primary" type="submit" disabled={saveBusy}>
              {saveBusy ? 'جارٍ الحفظ…' : 'حفظ السياسات'}
            </button>
          </div>
        </form>
      </section>

      <section className="card border-amber-200">
        <h2 className="text-lg font-bold text-amber-800">حذف بياناتي التشغيلية</h2>
        <p className="mt-1 text-xs leading-6 text-slate-600">
          يمسح كل ما يخص رسائلك ومنشوراتك الآن، ويُبقي حسابك وإعداداتك كما هي. لا يمكن التراجع.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold text-slate-700">يُحذف</p>
            <ul className="mt-1 space-y-1 text-xs leading-6 text-slate-600">
              {PURGE_ITEMS.map((item) => (
                <li key={item}>• {item}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-700">يبقى</p>
            <ul className="mt-1 space-y-1 text-xs leading-6 text-slate-600">
              {PURGE_KEEPS.map((item) => (
                <li key={item}>• {item}</li>
              ))}
            </ul>
          </div>
        </div>
        <form className="mt-4 space-y-3" onSubmit={purgeData}>
          {purgeState ? <Alert kind={purgeState.kind}>{purgeState.message}</Alert> : null}
          {purgeReport ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              <p className="font-semibold text-slate-700">تقرير الأثر</p>
              <p className="mt-1 leading-6">
                تسليمات: {purgeReport.report.deliveries ?? 0} · أجزاء: {purgeReport.report.deliveryParts ?? 0} ·
                محاولات: {purgeReport.report.deliveryAttempts ?? 0} · رسائل: {purgeReport.report.messageIdentities ?? 0} ·
                مطابقات: {purgeReport.report.messageMatches ?? 0} · أخطاء: {purgeReport.report.errorEvents ?? 0}
              </p>
            </div>
          ) : null}
          <Field label={`اكتب العبارة حرفياً: ${requiredPurge}`} hint="لن يعمل الزر قبل مطابقة العبارة تماماً.">
            <input className="field-input" value={purgePhrase} onChange={(e) => setPurgePhrase(e.target.value)} />
          </Field>
          <button className="btn-danger" type="submit" disabled={purgeBusy || purgePhrase.trim() !== requiredPurge}>
            {purgeBusy ? 'جارٍ الحذف…' : 'حذف بياناتي التشغيلية'}
          </button>
        </form>
      </section>

      <section className="card border-rose-300 bg-rose-50/40">
        <h2 className="text-lg font-bold text-rose-800">حذف الحساب نهائياً</h2>
        <p className="mt-1 text-xs leading-6 text-rose-900/80">
          حذف فوري ونهائي في معاملة واحدة. تُبطَل كل الجلسات، وتُمسح أسرار تيليجرام والبوتات، ويُحذف كل ما يخصك. يبقى
          حدث تدقيق واحد <strong>بلا هوية</strong> (بلا بريد ولا اسم). لا رجعة.
        </p>
        <ul className="mt-3 space-y-1 text-xs leading-6 text-slate-600">
          {DELETE_ITEMS.map((item) => (
            <li key={item}>• {item}</li>
          ))}
        </ul>
        <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={deleteAccount}>
          {deleteState ? (
            <div className="sm:col-span-2">
              <Alert kind={deleteState.kind}>{deleteState.message}</Alert>
            </div>
          ) : null}
          <Field label="كلمة المرور الحالية">
            <input
              className="field-input"
              type="password"
              autoComplete="current-password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
            />
          </Field>
          <Field label={`اكتب العبارة حرفياً: ${requiredDelete}`}>
            <input className="field-input" value={deletePhrase} onChange={(e) => setDeletePhrase(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <button
              className="btn-danger"
              type="submit"
              disabled={deleteBusy || deletePhrase.trim() !== requiredDelete || deletePassword.length === 0}
            >
              {deleteBusy ? 'جارٍ الحذف…' : 'حذف حسابي نهائياً'}
            </button>
          </div>
        </form>
        <p className="mt-3 text-xs text-slate-500">
          لا ينجح هذا الزر إن كان لديك حساب تيليجرام في طور الربط؛ أكمل الربط أو أوقفه أولاً.
        </p>
      </section>

      <section className="card">
        <h2 className="text-lg font-bold text-slate-800">أمان الحساب</h2>
        <p className="mt-1 text-xs leading-6 text-slate-500">
          تغيير كلمة المرور في صفحة الإعدادات القديمة لا يزال متاحاً هناك، مع نظرة على الجلسات.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a className="btn-secondary" href="/account">
            الملف الشخصي وكلمة المرور
          </a>
          <a className="btn-secondary" href="/sessions">
            الجلسات والأمان
          </a>
        </div>
      </section>
    </div>
  );
}
