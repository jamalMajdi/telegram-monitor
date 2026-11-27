import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 text-center">
      <p className="text-5xl font-black text-slate-300">404</p>
      <h1 className="text-xl font-bold text-slate-800">الصفحة غير موجودة</h1>
      <Link className="btn-primary" to="/">
        العودة إلى لوحة التحكم
      </Link>
    </div>
  );
}
