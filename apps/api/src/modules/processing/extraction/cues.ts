/**
 * قاموس القرائن (cues) لحقول الاستخراج (الخطوة 5-ج، §7.1–§7.4 وF05).
 *
 * المبدأ: لا استخراج بلا قرينة صريحة في النص. كل حقل يُستخرج فقط إذا ظهر قبله
 * (أو بجانبه) لفظ دالّ عليه، والقيمة نفسها تُقتطع من النص الأصلي حرفياً — فلا اختراع.
 *
 * الحقول هنا هي الاتحاد الأدنى لحقول القوالب الجاهزة في §7.2. الخطوة السادسة (القوالب)
 * تعرض مجموعة فرعية منها لكل قالب، مع إمكانية تعديل الأسماء والترتيب.
 */

export const EXTRACTION_VERSION = 1;

export const FIELD_KEYS = [
  'request_type', // نوع الطلب / نوع العملية (بيع، إيجار، طلب مساعدة…)
  'role', // المسمى الوظيفي أو الخدمة أو نوع العقار
  'subject', // المادة الدراسية أو التخصص أو المجال
  'details', // تفاصيل المطلوب أو وصف المشروع
  'organization', // الجامعة أو جهة العمل أو الشركة
  'location', // الموقع أو المنطقة أو المدينة
  'budget', // الميزانية أو السعر أو الراتب
  'deadline', // الموعد النهائي أو موعد التسليم
  'qualifications', // المؤهلات أو الشهادة المطلوبة
  'experience', // الخبرة المطلوبة
  'apply_method', // طريقة التقديم
  'area_size', // المساحة (عقارات)
  'specs', // المواصفات
  'question_count', // عدد الأسئلة (واجبات واختبارات)
  'technologies', // التقنيات المطلوبة (مشاريع)
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

/** الحقول التي يجب أن تحمل قيمة رقمية أو دلالة زمنية — وإلا تُهمَل (لا اختراع). */
export const NUMERIC_FIELDS: ReadonlySet<FieldKey> = new Set<FieldKey>([
  'budget',
  'area_size',
  'question_count',
]);

export const DATE_FIELDS: ReadonlySet<FieldKey> = new Set<FieldKey>(['deadline']);

export interface FieldCue {
  /** القرينة كما تُكتب في النص (تُطبَّع عند المقارنة). */
  cue: string;
  /** دلالة الألفاظ النسبية: هل القيمة غالباً رقمية/زمنية؟ (تُستخدم في الثقة فقط). */
  kind?: 'text' | 'numeric' | 'date';
}

/**
 * قرائن كل حقل. الترتيب مهم: الأطول أولاً عند نفس الموضع حتى لا تخطف قرينةٌ عامة
 * قرينةً أكثر تحديداً («الموعد النهائي» قبل «الموعد»).
 */
export const FIELD_CUES: Record<FieldKey, FieldCue[]> = {
  request_type: [
    { cue: 'نوع الطلب' },
    { cue: 'نوع العملية' },
    { cue: 'نوع الإعلان' },
    { cue: 'مطلوب للبيع' },
    { cue: 'للبيع', kind: 'text' },
    { cue: 'للإيجار', kind: 'text' },
    { cue: 'للإجار', kind: 'text' },
    { cue: 'إيجار', kind: 'text' },
  ],
  role: [
    { cue: 'نبحث عن' },
    { cue: 'مطلوب' },
    { cue: 'بحاجة إلى' },
    { cue: 'المسمى الوظيفي' },
    { cue: 'الوظيفة' },
    { cue: 'شاغر' },
    { cue: 'الخدمة المطلوبة' },
    { cue: 'نوع العقار' },
  ],
  subject: [
    { cue: 'المادة الدراسية' },
    { cue: 'اسم المادة' },
    { cue: 'مادة' },
    { cue: 'التخصص' },
    { cue: 'المجال' },
  ],
  details: [
    { cue: 'تفاصيل الواجب' },
    { cue: 'تفاصيل الاختبار' },
    { cue: 'تفاصيل المطلوب' },
    { cue: 'التفاصيل' },
    { cue: 'تفاصيل' },
    { cue: 'وصف المشروع' },
    { cue: 'الوصف' },
  ],
  organization: [
    { cue: 'جهة العمل' },
    { cue: 'جامعة' },
    { cue: 'الجامعة' },
    { cue: 'الكلية' },
    { cue: 'شركة' },
    { cue: 'الشركة' },
    { cue: 'مؤسسة' },
  ],
  location: [
    { cue: 'الموقع' },
    { cue: 'المكان' },
    { cue: 'المنطقة' },
    { cue: 'العنوان' },
    { cue: 'المدينة' },
  ],
  budget: [
    { cue: 'الميزانية', kind: 'numeric' },
    { cue: 'الراتب', kind: 'numeric' },
    { cue: 'الأجرة', kind: 'numeric' },
    { cue: 'المقابل', kind: 'numeric' },
    { cue: 'السعر', kind: 'numeric' },
    { cue: 'بمبلغ', kind: 'numeric' },
  ],
  deadline: [
    { cue: 'الموعد النهائي', kind: 'date' },
    { cue: 'آخر موعد', kind: 'date' },
    { cue: 'موعد التسليم', kind: 'date' },
    { cue: 'التسليم', kind: 'date' },
    { cue: 'الموعد', kind: 'date' },
  ],
  qualifications: [
    { cue: 'المؤهلات' },
    { cue: 'المؤهل' },
    { cue: 'الشهادة' },
    { cue: 'شهادة' },
  ],
  experience: [
    { cue: 'سنوات الخبرة' },
    { cue: 'الخبرة المطلوبة' },
    { cue: 'الخبرة' },
    { cue: 'خبرة' },
  ],
  apply_method: [
    { cue: 'طريقة التقديم' },
    { cue: 'للتقديم' },
    { cue: 'التقديم' },
    { cue: 'أرسل' },
    { cue: 'ارسل' },
  ],
  area_size: [
    { cue: 'المساحة', kind: 'numeric' },
    { cue: 'مساحة', kind: 'numeric' },
  ],
  specs: [
    { cue: 'المواصفات' },
    { cue: 'مواصفات' },
  ],
  question_count: [
    { cue: 'عدد الأسئلة', kind: 'numeric' },
    { cue: 'أسئلة', kind: 'numeric' },
  ],
  technologies: [
    { cue: 'التقنيات المطلوبة' },
    { cue: 'التقنيات' },
    { cue: 'التقنية' },
    { cue: 'بلغة' },
  ],
};

/** كل القرائن مسطَّحة — تُستخدم لكشف تضارب القرائن داخل القيمة. */
export const ALL_CUES: string[] = [...new Set(Object.values(FIELD_CUES).flatMap((list) => list.map((c) => c.cue)))];
