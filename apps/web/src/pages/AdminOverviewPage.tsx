import { adminApi } from '../api/client';
import { Alert, Spinner } from '../components/ui';
import { useQuery } from '../lib/useQuery';

export default function AdminOverviewPage() {
  const { data, error, loading } = useQuery(() => adminApi.overview(), []);

  const cards = [
    { key: 'users_total', label: 'إجمالي المستخدمين' },
    { key: 'users_active', label: 'حسابات نشطة' },
    { key: 'users_suspended', label: 'حسابات موقوفة' },
    { key: 'admins_active', label: 'مديرو النظام النشطون' },
    { key: 'sessions_active', label: 'جلسات ويب نشطة' },
    { key: 'pending_notifications', label: 'إشعارات بانتظار التسليم' },
  ] as const;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">نظرة عامة تشغيلية</h1>
        <p className="mt-1 text-sm text-slate-500">أرقام فعلية من قاعدة البيانات، دون أي محتوى رسائل (D07).</p>
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {loading ? <Spinner /> : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <div key={card.key} className="card">
            <p className="text-sm text-slate-500">{card.label}</p>
            <p className="mt-2 text-3xl font-bold text-slate-800">
              {data ? data.overview[card.key] : '—'}
            </p>
          </div>
        ))}
      </div>
      <div className="card">
        <h2 className="text-lg font-bold text-slate-800">ما لا تعرضه هذه الصفحة</h2>
        <p className="mt-2 text-sm leading-7 text-slate-600">
          لا تُعرض رسائل المستخدمين أو مستخلصاتها أو معايناتها، ولا رموز الجلسات أو تجزئات كلمات المرور. الاطلاع على
          محتوى أي مستخدم يتطلب إذناً مستقلاً محدداً ومدققاً لم يُنفّذ بعد (بند لاحق وفق D07/O07).
        </p>
      </div>
    </div>
  );
}
