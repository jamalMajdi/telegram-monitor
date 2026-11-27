import type { ReactNode } from 'react';

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-100 to-slate-200 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-xl font-bold text-white">
            ت
          </div>
          <h1 className="text-xl font-bold text-slate-800">{title}</h1>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        </div>
        <div className="card">{children}</div>
        {footer ? <div className="mt-4 text-center text-sm text-slate-600">{footer}</div> : null}
        <p className="mt-6 text-center text-xs text-slate-400">
          المرحلة الأولى: الحسابات والصلاحيات فقط. وظائف تيليجرام والفلاتر والنشر غير مفعّلة بعد.
        </p>
      </div>
    </div>
  );
}
