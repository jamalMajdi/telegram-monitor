import { useEffect, useState } from 'react';
import { ApiError, authApi, meApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Alert, Field, Spinner } from '../components/ui';
import { useQuery } from '../lib/useQuery';

export default function AccountPage() {
  const { user, refresh } = useAuth();
  const profile = useQuery(() => meApi.profile(), []);
  const [displayName, setDisplayName] = useState('');
  const [profileState, setProfileState] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordState, setPasswordState] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);

  useEffect(() => {
    if (profile.data) {
      setDisplayName(profile.data.user.displayName);
    }
  }, [profile.data]);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setProfileBusy(true);
    setProfileState(null);
    try {
      await meApi.updateProfile({ displayName });
      await refresh();
      setProfileState({ kind: 'success', message: 'تم تحديث الاسم.' });
    } catch (err) {
      setProfileState({ kind: 'error', message: err instanceof ApiError ? err.message : 'تعذّر الحفظ.' });
    } finally {
      setProfileBusy(false);
    }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordBusy(true);
    setPasswordState(null);
    try {
      await authApi.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setPasswordState({ kind: 'success', message: 'تم تغيير كلمة المرور وإبطال الجلسات الأخرى.' });
    } catch (err) {
      setPasswordState({ kind: 'error', message: err instanceof ApiError ? err.message : 'تعذّر تغيير كلمة المرور.' });
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">إعدادات الحساب</h1>
        <p className="mt-1 text-sm text-slate-500">بياناتك الشخصية، وسياسة الاحتفاظ، وأمان الحساب.</p>
      </div>

      {profile.loading ? <Spinner /> : null}
      {profile.error ? <Alert kind="error">{profile.error}</Alert> : null}

      <section className="card">
        <h2 className="text-lg font-bold text-slate-800">الملف الشخصي</h2>
        <form className="mt-4 space-y-4" onSubmit={saveProfile}>
          {profileState ? <Alert kind={profileState.kind}>{profileState.message}</Alert> : null}
          <Field label="الاسم المعروض">
            <input className="field-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required minLength={2} maxLength={120} />
          </Field>
          <Field label="البريد الإلكتروني" hint="تغيير البريد يحتاج مسار تحقق لاحق؛ غير متاح في هذه المرحلة.">
            <input className="field-input bg-slate-100" value={user?.email ?? ''} readOnly />
          </Field>
          <button className="btn-primary" type="submit" disabled={profileBusy}>
            {profileBusy ? 'جارٍ الحفظ…' : 'حفظ التغييرات'}
          </button>
        </form>
      </section>

      <section className="card">
        <h2 className="text-lg font-bold text-slate-800">تغيير كلمة المرور</h2>
        <p className="mt-1 text-xs text-slate-500">سيؤدي التغيير إلى إبطال كل الجلسات الأخرى مع إبقاء جلستك الحالية.</p>
        <form className="mt-4 space-y-4" onSubmit={changePassword}>
          {passwordState ? <Alert kind={passwordState.kind}>{passwordState.message}</Alert> : null}
          <Field label="كلمة المرور الحالية">
            <input className="field-input" type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
          </Field>
          <Field label="كلمة المرور الجديدة" hint="10 أحرف على الأقل، وتشمل حرفاً ورقماً.">
            <input className="field-input" type="password" autoComplete="new-password" required minLength={10} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </Field>
          <button className="btn-primary" type="submit" disabled={passwordBusy}>
            {passwordBusy ? 'جارٍ التغيير…' : 'تغيير كلمة المرور'}
          </button>
        </form>
      </section>

      <section className="card border-slate-200">
        <h2 className="text-lg font-bold text-slate-800">منطقة الخطر</h2>
        <p className="mt-1 text-xs leading-6 text-slate-500">
          حذف البيانات التشغيلية وحذف الحساب نهائياً انتقلا إلى صفحة <strong>الإعدادات</strong>، مع عبارة تأكيد حرفية
          وكلمة مرور — ولا يوجد زر سريع هنا بقصد.
        </p>
        <a className="btn-secondary mt-3 inline-flex" href="/settings">
          الانتقال إلى الإعدادات
        </a>
      </section>
    </div>
  );
}
