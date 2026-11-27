import { useState } from 'react';
import { ApiError, adminApi, type AdminUser } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, EmptyState, Spinner, formatDate } from '../components/ui';
import { useQuery } from '../lib/useQuery';

export default function AdminUsersPage() {
  const { user: me } = useAuth();
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState({ query: '', status: '', role: '' });
  const [offset, setOffset] = useState(0);
  const limit = 20;
  const { data, error, loading, reload } = useQuery(
    () => adminApi.users({ ...applied, limit, offset }),
    [applied, offset],
  );
  const [actionState, setActionState] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (fn: () => Promise<void>, success: string, id: string) => {
    setBusyId(id);
    setActionState(null);
    try {
      await fn();
      setActionState({ kind: 'success', message: success });
      reload();
    } catch (err) {
      setActionState({ kind: 'error', message: err instanceof ApiError ? err.message : 'تعذّر تنفيذ الإجراء.' });
    } finally {
      setBusyId(null);
    }
  };

  const toggleStatus = (user: AdminUser) => {
    const next = user.status === 'active' ? 'suspended' : 'active';
    const reason = window.prompt(next === 'suspended' ? 'سبب إيقاف الحساب (مطلوب):' : 'سبب إعادة التفعيل (مطلوب):');
    if (!reason || reason.trim().length < 3) return;
    void act(
      () => adminApi.setStatus(user.id, { status: next, reason: reason.trim() }),
      next === 'suspended' ? 'تم إيقاف الحساب وإبطال جلساته.' : 'تم إعادة تفعيل الحساب.',
      user.id,
    );
  };

  const toggleRole = (user: AdminUser) => {
    const next = user.role === 'admin' ? 'user' : 'admin';
    const reason = window.prompt(
      next === 'admin' ? 'سبب ترقية المستخدم إلى مدير نظام:' : 'سبب إزالة دور المدير:',
    );
    if (!reason || reason.trim().length < 3) return;
    void act(
      () => adminApi.setRole(user.id, { role: next, reason: reason.trim() }),
      next === 'admin' ? 'تمت الترقية إلى مدير نظام.' : 'أُزيل دور المدير.',
      user.id,
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">إدارة المستخدمين</h1>
        <p className="mt-1 text-sm text-slate-500">
          بيانات تعريفية وتشغيلية فقط. لا تُعرض كلمات مرور ولا تجزئات ولا رموز جلسات.
        </p>
      </div>

      <form
        className="card flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setApplied((prev) => ({ ...prev, query }));
        }}
      >
        <label className="flex-1">
          <span className="field-label">بحث بالبريد أو الاسم</span>
          <input className="field-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="اكتب للبحث…" />
        </label>
        <label>
          <span className="field-label">الحالة</span>
          <select
            className="field-input"
            value={applied.status}
            onChange={(e) => {
              setOffset(0);
              setApplied((prev) => ({ ...prev, status: e.target.value }));
            }}
          >
            <option value="">الكل</option>
            <option value="active">نشط</option>
            <option value="suspended">موقوف</option>
          </select>
        </label>
        <label>
          <span className="field-label">الدور</span>
          <select
            className="field-input"
            value={applied.role}
            onChange={(e) => {
              setOffset(0);
              setApplied((prev) => ({ ...prev, role: e.target.value }));
            }}
          >
            <option value="">الكل</option>
            <option value="user">مستخدم</option>
            <option value="admin">مدير نظام</option>
          </select>
        </label>
        <button className="btn-primary" type="submit">بحث</button>
      </form>

      {actionState ? <Alert kind={actionState.kind}>{actionState.message}</Alert> : null}
      {error ? <Alert kind="error">{error}</Alert> : null}
      {loading ? <Spinner /> : null}

      {data && data.users.length === 0 ? (
        <EmptyState title="لا توجد نتائج" description="جرّب تعديل معايير البحث أو الحالة." />
      ) : null}

      {data && data.users.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[720px] text-right text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">المستخدم</th>
                <th className="px-4 py-3">الدور</th>
                <th className="px-4 py-3">الحالة</th>
                <th className="px-4 py-3">جلسات نشطة</th>
                <th className="px-4 py-3">آخر دخول</th>
                <th className="px-4 py-3">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-800">{u.displayName}</p>
                    <p className="text-xs text-slate-500">{u.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={u.role === 'admin' ? 'blue' : 'slate'}>{u.role === 'admin' ? 'مدير' : 'مستخدم'}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={u.status === 'active' ? 'green' : u.status === 'suspended' ? 'amber' : 'red'}>
                      {u.status === 'active' ? 'نشط' : u.status === 'suspended' ? 'موقوف' : 'محذوف'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{u.activeSessions}</td>
                  <td className="px-4 py-3 text-slate-600">{formatDate(u.lastLoginAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="text-xs font-semibold text-brand-600 hover:underline disabled:opacity-40"
                        disabled={busyId !== null || u.id === me?.id}
                        onClick={() => toggleStatus(u)}
                      >
                        {u.status === 'active' ? 'إيقاف' : 'إعادة تفعيل'}
                      </button>
                      <button
                        className="text-xs font-semibold text-slate-600 hover:underline disabled:opacity-40"
                        disabled={busyId !== null || u.id === me?.id}
                        onClick={() => toggleRole(u)}
                      >
                        {u.role === 'admin' ? 'إزالة دور المدير' : 'ترقية إلى مدير'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            <span>
              عرض {offset + 1}–{Math.min(offset + limit, data.total)} من {data.total}
            </span>
            <div className="flex gap-2">
              <button className="btn-secondary px-3 py-1" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
                السابق
              </button>
              <button
                className="btn-secondary px-3 py-1"
                disabled={offset + limit >= data.total}
                onClick={() => setOffset(offset + limit)}
              >
                التالي
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
