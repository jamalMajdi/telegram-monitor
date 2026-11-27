import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useEffect, useState } from 'react';
import { notificationsApi } from '../api/client';
import { ErrorBoundary } from './ErrorBoundary';

const userLinks = [
  { to: '/', label: 'لوحة التحكم', end: true },
  { to: '/notifications', label: 'التنبيهات' },
  { to: '/account', label: 'إعدادات الحساب' },
  { to: '/telegram', label: 'حسابات تيليجرام', end: true },
  { to: '/telegram/sources', label: 'مصادر تيليجرام', end: true },
  { to: '/telegram/ingest', label: 'حالة الالتقاط' },
  { to: '/telegram/filters', label: 'الفلاتر', end: true },
  { to: '/telegram/classifications', label: 'التصنيفات', end: true },
  { to: '/telegram/results', label: 'النتائج والمراجعة', end: true },
  { to: '/telegram/publish', label: 'النشر إلى تيليجرام' },
  { to: '/logs', label: 'السجلات والأخطاء' },
  { to: '/settings', label: 'الإعدادات' },
  { to: '/sessions', label: 'الجلسات والأمان' },
];

const adminLinks = [
  { to: '/admin', label: 'نظرة عامة', end: true },
  { to: '/admin/users', label: 'المستخدمون' },
  { to: '/admin/system', label: 'التشغيل والمقاييس' },
  { to: '/admin/logs', label: 'أخطاء النظام والاحتفاظ' },
  { to: '/admin/settings', label: 'إعدادات النظام' },
  { to: '/admin/audit', label: 'سجل التدقيق' },
];

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  // شارة التنبيهات: تُقرأ عند التنقّل ثم كل 60 ثانية. فشلها لا يُزعج المستخدم (صمت مقصود).
  const [unacknowledged, setUnacknowledged] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void notificationsApi
        .counts()
        .then((result) => {
          if (!cancelled) setUnacknowledged(result.counts.unacknowledged);
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [location.pathname]);

  const onLogout = async () => {
    setBusy(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } finally {
      setBusy(false);
    }
  };

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `block rounded-lg px-3 py-2 text-sm font-medium transition ${
      isActive ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'
    }`;

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">ت</div>
            <div>
              <p className="text-sm font-bold text-slate-800">نظام مراقبة رسائل تيليجرام</p>
              <p className="text-xs text-slate-500">الالتقاط والمعالجة والنشر</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <NavLink
              to="/notifications"
              className="relative rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
              aria-label={unacknowledged > 0 ? `التنبيهات: ${unacknowledged} غير معترَف به` : 'التنبيهات'}
            >
              التنبيهات
              {unacknowledged > 0 ? (
                <span className="absolute -top-1 -end-1 min-w-5 rounded-full bg-rose-600 px-1 text-center text-xs font-bold text-white">
                  {unacknowledged > 99 ? '99+' : unacknowledged}
                </span>
              ) : null}
            </NavLink>
            <div className="text-left">
              <p className="text-sm font-semibold text-slate-800">{user?.displayName}</p>
              <p className="text-xs text-slate-500">
                {user?.email} · {user?.role === 'admin' ? 'مدير نظام' : 'مستخدم'}
              </p>
            </div>
            <button className="btn-secondary" onClick={() => void onLogout()} disabled={busy}>
              خروج
            </button>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl gap-6 px-4 py-6">
        <aside className="w-56 shrink-0 space-y-6">
          <nav className="space-y-1">
            <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">مساحتي</p>
            {userLinks.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} className={linkClass}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          {user?.role === 'admin' ? (
            <nav className="space-y-1">
              <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">إدارة النظام</p>
              {adminLinks.map((l) => (
                <NavLink key={l.to} to={l.to} end={l.end} className={linkClass}>
                  {l.label}
                </NavLink>
              ))}
            </nav>
          ) : null}
          <div className="rounded-lg bg-slate-100 p-3 text-xs leading-6 text-slate-600">
            النشر يُنشئ تسليمات مسجّلة فقط في هذه المرحلة؛ الإرسال الفعلي إلى تيليجرام والمراجعة التشغيلية في الدفعة التالية.
          </div>
        </aside>
        <main className="min-w-0 flex-1">
          {/* حدود صفحة واحدة: فشل صفحة لا يُسقط التنقّل ولا بقية التطبيق (P4-و). */}
          <ErrorBoundary key={location.pathname} resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
