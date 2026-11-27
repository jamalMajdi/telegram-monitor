/**
 * حالة الالتقاط (الخطوة الرابعة) — قراءة فقط.
 *
 * تعرض: التشغيل، مدة الاحتفاظ بهويات منع التكرار، عدّاداً عاماً للتحديثات غير المرتبطة،
 * ومؤشرات كل مصدر (مُلتقطة/مكررة/مستبعدة/آخر رسالة/حالة اتصال الحساب).
 * لا تُعرض أي نصوص رسائل: النظام لا يخزّنها أصلاً في هذه المرحلة.
 */
import { telegramApi, type TelegramSourceIngestStats } from '../api/client';
import { Alert, Badge, EmptyState, Spinner, formatDate } from '../components/ui';
import { useQuery } from '../lib/useQuery';

const statusLabels: Record<TelegramSourceIngestStats['status'], { label: string; tone: 'green' | 'amber' }> = {
  active: { label: 'مراقبة نشطة', tone: 'green' },
  paused: { label: 'موقوفة', tone: 'amber' },
};

const phaseLabels: Record<string, string> = {
  connected: 'متصل',
  connecting: 'جارٍ الاتصال',
  reconnecting: 'يعيد المحاولة',
  needs_reauth: 'يحتاج إعادة مصادقة',
  stopped: 'متوقف',
  idle: 'غير متصل',
  unknown: 'غير معروف',
};

export default function TelegramIngestPage() {
  const status = useQuery(() => telegramApi.ingestStatus(), []);

  const data = status.data;
  const sources = data?.sources ?? [];
  const captured = sources.reduce((sum, s) => sum + Number(s.ingestedCount), 0);
  const matched = sources.reduce((sum, s) => sum + Number(s.matchedCount ?? 0), 0);
  const ignored = sources.reduce((sum, s) => sum + Number(s.ignoredCount ?? 0), 0);
  const repeats = sources.reduce((sum, s) => sum + Number(s.repeatCount ?? 0), 0);
  const extracted = sources.reduce((sum, s) => sum + Number(s.extractedCount ?? 0), 0);
  const classified = sources.reduce((sum, s) => sum + Number(s.classifiedCount ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">حالة الالتقاط</h1>
          <p className="mt-1 text-sm text-slate-500">
            مراقبة وصول الرسائل الجديدة من المصادر المفعّلة. يُحفظ معرّف كل رسالة لمنع التكرار، ولا يُحفظ نص إلا
            للرسائل المطابقة لفلتر ولمدة احتفاظ المحتوى فقط. لا تُنزَّل الوسائط ولا تُخزَّن.
          </p>
        </div>
        <button className="btn-secondary" onClick={() => status.reload()} disabled={status.loading}>
          تحديث
        </button>
      </div>

      {status.error ? <Alert kind="error">{status.error}</Alert> : null}
      {status.loading ? <Spinner /> : null}

      {data && !data.enabled ? (
        <Alert kind="warning">محرّك الالتقاط معطّل على الخادم (TG_INGEST_ENABLED=false).</Alert>
      ) : null}

      {data ? (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="card">
            <p className="text-xs text-slate-500">رسائل مُلتقطة (كل المصادر)</p>
            <p className="mt-1 text-2xl font-bold text-slate-800">{captured}</p>
          </div>
          <div className="card">
            <p className="text-xs text-slate-500">رسائل مطابقة لفلتر</p>
            <p className="mt-1 text-2xl font-bold text-slate-800">{matched}</p>
            <p className="mt-1 text-xs text-slate-500">يُحفظ نصها وحدها لمدة احتفاظ المحتوى (48 ساعة افتراضياً).</p>
          </div>
          <div className="card">
            <p className="text-xs text-slate-500">رسائل متجاهلة</p>
            <p className="mt-1 text-2xl font-bold text-slate-800">{ignored}</p>
            <p className="mt-1 text-xs text-slate-500">لا يُحفظ لها نص (لا فلتر مطابق أو نوع محتوى غير مدعوم).</p>
          </div>
          <div className="card">
            <p className="text-xs text-slate-500">رسائل مُستخرَجة (حقول + تواصل)</p>
            <p className="mt-1 text-2xl font-bold text-slate-800">{extracted}</p>
            <p className="mt-1 text-xs text-slate-500">
              كل قيمة مستخرجة مرتبطة بموضعها في النص الأصلي؛ وفئات التواصل تُخزَّن بصيغة محجوبة.
            </p>
          </div>
          <div className="card">
            <p className="text-xs text-slate-500">رسائل مُصنَّفة (قالب مختار)</p>
            <p className="mt-1 text-2xl font-bold text-slate-800">{classified}</p>
            <p className="mt-1 text-xs text-slate-500">
              تصنيف حتمي بالقواعد + اختيار قالب بالأولوية (المصدر ← الفلتر ← التصنيف ← الافتراضي).
            </p>
          </div>
          <div className="card">
            <p className="text-xs text-slate-500">محتوى مكرّر (is_repeat)</p>
            <p className="mt-1 text-2xl font-bold text-slate-800">{repeats}</p>
            <p className="mt-1 text-xs text-slate-500">تعليم فقط في هذه المرحلة؛ منع النشر مؤجَّل للمرحلة الثالثة.</p>
          </div>
          <div className="card">
            <p className="text-xs text-slate-500">تحديثات غير مرتبطة بمصدر</p>
            <p className="mt-1 text-2xl font-bold text-slate-800">{data.unmatchedUpdates}</p>
          </div>
          <div className="card">
            <p className="text-xs text-slate-500">فشل حفظ الهوية</p>
            <p className="mt-1 text-2xl font-bold text-slate-800">{data.failedMessages}</p>
            {data.failedMessages > 0 ? (
              <p className="mt-1 text-xs text-amber-700">نقطة الاستئناف مثبّتة عند الرسالة الفاشلة حتى تُحسم.</p>
            ) : null}
          </div>
          <div className="card">
            <p className="text-xs text-slate-500">احتفاظ معرّفات منع التكرار</p>
            <p className="mt-1 text-2xl font-bold text-slate-800">{data.identityRetentionDays} يوماً</p>
            <p className="mt-1 text-xs text-slate-500">بعد انتهاء المدة لا يُضمن منع تكرار الرسالة نفسها.</p>
          </div>
        </section>
      ) : null}

      {data && sources.length === 0 && !status.loading ? (
        <EmptyState
          title="لا توجد مصادر بعد"
          description="أضف مصدراً من صفحة «مصادر تيليجرام» ليبدأ الالتقاط تلقائياً بعد اتصال الحساب."
        />
      ) : null}

      {sources.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3 text-start font-medium">المصدر</th>
                <th className="px-4 py-3 text-start font-medium">الحالة</th>
                <th className="px-4 py-3 text-start font-medium">الحساب</th>
                <th className="px-4 py-3 text-start font-medium">مُلتقطة</th>
                <th className="px-4 py-3 text-start font-medium">مكررة</th>
                <th className="px-4 py-3 text-start font-medium">مستبعدة</th>
                <th className="px-4 py-3 text-start font-medium">مطابقة</th>
                <th className="px-4 py-3 text-start font-medium">متجاهلة</th>
                <th className="px-4 py-3 text-start font-medium">مكرّرة</th>
                <th className="px-4 py-3 text-start font-medium">فاشلة</th>
                <th className="px-4 py-3 text-start font-medium">مُستخرَجة</th>
                <th className="px-4 py-3 text-start font-medium">مُصنَّفة</th>
                <th className="px-4 py-3 text-start font-medium">آخر رسالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sources.map((source) => (
                <tr key={source.sourceId}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">{source.title}</p>
                    <p className="text-xs text-slate-500">
                      {source.username ? (
                        <span dir="ltr">@{source.username}</span>
                      ) : (
                        <span>
                          معرّف: <span dir="ltr">{source.peerId}</span>
                        </span>
                      )}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={statusLabels[source.status].tone}>{statusLabels[source.status].label}</Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {source.accountLabel}
                    <br />
                    <span className="text-slate-500">{phaseLabels[source.connectionPhase] ?? source.connectionPhase}</span>
                  </td>
                  <td className="px-4 py-3 font-mono" dir="ltr">
                    {source.ingestedCount}
                  </td>
                  <td className="px-4 py-3 font-mono" dir="ltr">
                    {source.duplicateCount}
                  </td>
                  <td className="px-4 py-3 font-mono" dir="ltr">
                    {source.excludedCount}
                  </td>
                  <td className="px-4 py-3 font-mono" dir="ltr">
                    {source.matchedCount ?? '0'}
                  </td>
                  <td className="px-4 py-3 font-mono" dir="ltr">
                    {source.ignoredCount ?? '0'}
                  </td>
                  <td className="px-4 py-3 font-mono" dir="ltr">
                    {source.repeatCount ?? '0'}
                  </td>
                  <td className="px-4 py-3 font-mono" dir="ltr">
                    {source.failedCount ?? '0'}
                  </td>
                  <td className="px-4 py-3 font-mono" dir="ltr">
                    {source.extractedCount ?? '0'}
                  </td>
                  <td className="px-4 py-3 font-mono" dir="ltr">
                    {source.classifiedCount ?? '0'}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">{formatDate(source.lastMessageAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data && data.failedMessages > 0 ? (
        <Alert kind="warning">
          تعذّر حفظ هوية بعض الرسائل. النظام لا يتجاوزها ولا يتقدّم على نقطة الاستئناف: تُعاد الرسالة من تيليجرام بعد
          إعادة التشغيل أو بعد زوال سبب الفشل.
        </Alert>
      ) : null}

      {data ? (
        <p className="text-xs text-slate-500">
          منذ بدء الخادم: {formatDate(data.since)} — محاولات إعادة الحفظ: {data.retries}. العدّادات تُصفَّر عند إعادة
          التشغيل، أما مؤشرات كل مصدر فمحفوظة في قاعدة البيانات.
        </p>
      ) : null}
    </div>
  );
}
