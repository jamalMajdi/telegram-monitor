import { adminApi } from '../api/client';
import { Alert, EmptyState, Spinner, formatDate } from '../components/ui';
import { useQuery } from '../lib/useQuery';

export default function AdminAuditPage() {
  const { data, error, loading } = useQuery(() => adminApi.audit(100), []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">سجل التدقيق</h1>
        <p className="mt-1 text-sm text-slate-500">
          أحداث تشغيلية (دخول، تغيير كلمة مرور، إجراءات إدارية). لا يحتوي نصوص رسائل ولا كلمات مرور ولا رموز.
        </p>
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {loading ? <Spinner /> : null}
      {data && data.events.length === 0 ? (
        <EmptyState title="السجل فارغ" description="ستظهر الأحداث هنا بعد أول عملية مسجّلة." />
      ) : null}
      {data && data.events.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-right text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">الوقت</th>
                <th className="px-4 py-3">الحدث</th>
                <th className="px-4 py-3">النتيجة</th>
                <th className="px-4 py-3">الفاعل</th>
                <th className="px-4 py-3">هدف</th>
                <th className="px-4 py-3">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2 text-slate-600">{formatDate(e.occurred_at)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-700">{e.action}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {e.outcome === 'success' ? 'نجاح' : e.outcome === 'failure' ? 'فشل' : 'رفض'}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{e.actor_user_id ?? '—'}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{e.target_type ? `${e.target_type}:${e.target_id ?? '—'}` : '—'}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{e.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
