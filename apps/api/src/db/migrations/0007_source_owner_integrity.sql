-- 0007_source_owner_integrity
-- الغرض: ضمان أن مالك المصدر هو مالك حساب تيليجرام القارئ على مستوى قاعدة البيانات (D02، O01)،
--        بدل الاعتماد على فحص طبقة الخدمة وحده.
-- الأثر: لا تغيير في الأعمدة أو العقود؛ يُستبدل المفتاح الأجنبي الأحادي بمفتاح مركّب يحمل الملكية،
--        ويُحافظ على on delete cascade (S9)، ويُصحَّح تعليق جدول الفترات.

-- 1) فحص مسبق: لا صفوف متقاطعة الملكية. عند وجودها يتوقف الترحيل بخطأ واضح ولا يُعدَّل أي صف.
do $$
declare
  mismatched integer;
begin
  select count(*) into mismatched
    from telegram_sources s
    join telegram_accounts a on a.id = s.account_id
   where a.user_id <> s.user_id;

  if mismatched > 0 then
    raise exception
      'يوجد % صفاً في telegram_sources بمالك مختلف عن مالك حساب تيليجرام؛ أصلح البيانات يدوياً ثم أعد الترحيل.',
      mismatched;
  end if;
end $$;

-- 2) هدف صالح للمفتاح المركّب: (id, user_id) فريد بطبيعة الحال لأن id هو المفتاح الأساسي.
alter table telegram_accounts
  add constraint telegram_accounts_id_user_key unique (id, user_id);

-- 3) استبدال المفتاح الأحادي بمفتاح مركّب يفرض تطابق المالك، مع الإبقاء على الحذف المتسلسل.
alter table telegram_sources
  drop constraint telegram_sources_account_id_fkey;

alter table telegram_sources
  add constraint telegram_sources_account_owner_fkey
  foreign key (account_id, user_id)
  references telegram_accounts (id, user_id)
  on delete cascade;

comment on constraint telegram_sources_account_owner_fkey on telegram_sources is
  'قارئ المصدر يجب أن يكون حساباً يملكه مالك المصدر نفسه؛ مفروض على مستوى قاعدة البيانات.';

comment on table telegram_source_periods is
  'فترات تفعيل المصدر: تُفتح عند الإضافة/الاستئناف وتُغلق عند الإيقاف أو الفصل؛ تُحذف مع المصدر (cascade)،
   وتبقى آثارها في audit_events.';
