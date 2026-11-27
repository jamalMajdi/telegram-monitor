-- 0026: دمج تصنيفات الطلبات الدراسية المتشابهة في تصنيف واحد «خدمات طلابية».
--
-- السبب: أربعة تصنيفات متقاربة (طلبات المساعدة الدراسية، واجبات واختبارات، مشاريع جامعية، خدمات)
-- كانت تتطابق مع الرسالة نفسها فتُعلَّم `ambiguous = true` وتتوقف للمراجعة اليدوية بلا حاجة.
--
-- ما يفعله الترحيل لكل مستخدم (بياناته وحدها):
--   1) ينشئ (أو يعيد استخدام) تصنيف «خدمات طلابية» بأولوية 20 — نفس أولوية أول تصنيف مدمج.
--   2) يبني شرطه الأول من **اتحاد** المصطلحات الحرفية ومصطلحات القواميس المرفقة بالتصنيفات المدمجة
--      (تسطيح القواميس إلى مصطلحات حرفية داخل شرط واحد) — فلا يشترط وجود تصنيفين معًا.
--   3) يضيف شرط النفي المعتاد «استبعاد عام» كما في بقية التصنيفات المبذورة.
--   4) يعيد توجيه صفوف `message_classification` وقد كان تصنيفها أحد المدمجات إلى التصنيف الجديد.
--   5) يعيد توجيه روابط القوالب (`template_bindings`) ثم يحذف التصنيفات القديمة (شروطها ومصطلحاتها
--      تُحذف تتابعيًا).
--
-- المبدأ: لا يُحذف أي شيء قبل إعادة توجيه كل ما يشير إليه، والترحيل قابل لإعادة التشغيل (idempotent).

do $$
declare
  owner record;
  merged_id uuid;
  terms_condition uuid;
  exclude_dictionary uuid;
  src_ids uuid[];
  src_names text[] := array['طلبات المساعدة الدراسية', 'واجبات واختبارات', 'مشاريع جامعية', 'خدمات'];
begin
  for owner in
    select distinct user_id
      from rule_sets
     where kind = 'classification'
       and name = any(src_names)
  loop
    select array_agg(id)
      into src_ids
      from rule_sets
     where user_id = owner.user_id
       and kind = 'classification'
       and name = any(src_names);

    -- 1) التصنيف الموحّد
    select id into merged_id
      from rule_sets
     where user_id = owner.user_id and kind = 'classification' and name = 'خدمات طلابية';

    if merged_id is null then
      insert into rule_sets (user_id, kind, name, description, priority, scope, applies_to, enabled, is_builtin)
      values (
        owner.user_id, 'classification', 'خدمات طلابية',
        'تصنيف شامل للطلبات الدراسية والخدمية الطلابية: شرح وتلخيص، واجبات واختبارات، مشاريع وتخرج، وخدمات طلابية',
        20, 'all_sources', 'any', true, true
      )
      returning id into merged_id;
    end if;

    -- 2) شرط الاتحاد — يُبنى مرة واحدة فقط
    if not exists (select 1 from rule_conditions where rule_set_id = merged_id) then
      insert into rule_conditions (user_id, rule_set_id, position, mode, negate, min_matches)
      values (owner.user_id, merged_id, 1, 'any', false, 1)
      returning id into terms_condition;

      -- 2-أ المصطلحات الحرفية من التصنيفات المدمجة
      insert into condition_terms (user_id, condition_id, literal, literal_normalized, match_mode)
      select distinct on (ct.literal_normalized)
             owner.user_id, terms_condition, ct.literal, ct.literal_normalized, ct.match_mode
        from condition_terms ct
        join rule_conditions rc on rc.id = ct.condition_id
       where rc.rule_set_id = any(src_ids)
         and ct.literal is not null
         and ct.literal_normalized is not null
       order by ct.literal_normalized
      on conflict do nothing;

      -- 2-ب مصطلحات القواميس **المتخصصة** المرفقة بتلك الشروط (تسطيح إلى مصطلحات حرفية).
      --     لا تُسطَّح القواميس العامة مثل «صيغ الطلب والبحث»: كلماتها (مطلوب، أريد، أحتاج…)
      --     موجودة في كل طلب تقريبًا، فتسطيحها يجعل التصنيف يطابق كل شيء ويُعيد الغموض الذي جئنا نُزيله.
      insert into condition_terms (user_id, condition_id, literal, literal_normalized, match_mode)
      select distinct on (dt.term_normalized)
             owner.user_id, terms_condition, dt.term, dt.term_normalized, dt.match_mode
        from rule_conditions rc
        join dictionaries d on d.id = rc.dictionary_id and d.user_id = rc.user_id
        join dictionary_terms dt
          on dt.dictionary_id = rc.dictionary_id and dt.user_id = rc.user_id and dt.enabled
       where rc.rule_set_id = any(src_ids)
         and rc.dictionary_id is not null
         and rc.negate = false
         and d.name in ('مصطلحات دراسية', 'مهن وخدمات')
       order by dt.term_normalized
      on conflict do nothing;

      -- 3) شرط النفي: قاموس «استبعاد عام» الخاص بالمستخدم إن وُجد
      select d.id into exclude_dictionary
        from dictionaries d
       where d.user_id = owner.user_id and d.name = 'استبعاد عام'
       limit 1;

      if exclude_dictionary is not null then
        insert into rule_conditions (user_id, rule_set_id, position, mode, negate, min_matches, dictionary_id)
        values (owner.user_id, merged_id, 2, 'any', true, 1, exclude_dictionary);
      end if;
    end if;

    -- 4) إعادة توجيه نتائج التصنيف
    update message_classification
       set classification_id = merged_id,
           classification_name = 'خدمات طلابية'
     where classification_id = any(src_ids);

    -- 5) إعادة توجيه روابط القوالب ثم حذف التصنيفات القديمة
    update template_bindings tb
       set rule_set_id = merged_id
     where tb.rule_set_id = any(src_ids)
       and not exists (
         select 1 from template_bindings other
          where other.user_id = tb.user_id and other.rule_set_id = merged_id and other.id <> tb.id
       );

    delete from template_bindings where rule_set_id = any(src_ids);
    delete from rule_sets where id = any(src_ids) and user_id = owner.user_id;

    -- رفع إصدار إعدادات المستخدم حتى تُبنى اللقطة التالية من القاعدة الجديدة
    update user_config_state
       set processing_version = processing_version + 1, updated_at = now()
     where user_id = owner.user_id;
  end loop;
end
$$;
