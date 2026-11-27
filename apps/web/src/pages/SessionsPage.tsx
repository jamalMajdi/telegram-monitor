import { useState } from 'react';
import { ApiError, meApi } from '../api/client';
import { Alert, EmptyState, Spinner, formatDate } from '../components/ui';
import { useQuery } from '../lib/useQuery';

export default function SessionsPage() {
  const sessions = useQuery(() => meApi.sessions(), []);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const revoke = async (id: string) => {
    setBusyId(id);
    setMessage(null);
    try {
      await meApi.revokeSession(id);
      setMessage({ kind: 'success', message: 'تم إبطال الجلسة.' });
      sessions.reload();
    } catch (err) {
      setMessage({ kind: 'error', message: err instanceof ApiError ? err.message : 'تعذّر إبطال الجلسة.' });
    } finally {
      setBusyId(null);
    }
  };

  const revokeOthers = async () => {
    setBusyId('others');
    setMessage(null);
    try {
      const result = await meApi.revokeOthers();
      setMessage({ kind: 'success', message: `تم إبطال ${result.revoked} جلسة أخرى.` });
      sessions.reload();
    } catch (err) {
      setMessage({ kind: 'error', message: err instanceof ApiError ? err.message : 'تعذّر إبطال الجلسات.' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">الجلسات والأمان</h1>
          <p className="mt-1 text-sm text-slate-500">
            الجلسات النشطة لمتصفحاتك. الرموز لا تُعرض أبداً؛ يُحفظ في الخادم بصمة فقط.
          </p>
        </div>
        <button className="btn-secondary" onClick={() => void revokeOthers()} disabled={busyId !== null}>
          إبطال كل الجلسات الأخرى
        </button>
      </div>

      {message ? <Alert kind={message.kind}>{message.message}</Alert> : null}
      {sessions.error ? <Alert kind="error">{sessions.error}</Alert> : null}
      {sessions.loading ? <Spinner /> : null}

      {sessions.data && sessions.data.sessions.length === 0 ? (
        <EmptyState title="لا توجد جلسات نشطة" description="ستظهر الجلسات هنا بعد تسجيل الدخول من أي متصفح." />
      ) : null}

      {sessions.data && sessions.data.sessions.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-right text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">الجهاز / المتصفح</th>
                <th className="px-4 py-3">عنوان IP</th>
                <th className="px-4 py-3">آخر نشاط</th>
                <th className="px-4 py-3">تنتهي</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sessions.data.sessions.map((s) => (
                <tr key={s.id}>
                  <td className="max-w-xs px-4 py-3">
                    <span className="line-clamp-1 text-slate-700">{s.userAgent ?? 'غير معروف'}</span>
                    {s.current ? <span className="badge mt-1 bg-emerald-100 text-emerald-800">هذه الجلسة</span> : null}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{s.ip ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{formatDate(s.lastSeenAt)}</td>
                  <td className="px-4 py-3 text-slate-600">{formatDate(s.expiresAt)}</td>
                  <td className="px-4 py-3 text-left">
                    <button
                      className="text-xs font-semibold text-rose-600 hover:underline disabled:opacity-50"
                      onClick={() => void revoke(s.id)}
                      disabled={busyId !== null}
                    >
                      إبطال
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
