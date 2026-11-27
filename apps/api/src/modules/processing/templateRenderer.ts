/**
 * باني المنشور من القالب (الخطوة 6-ب، §7.2–§7.4).
 *
 * - الحقول الغائبة **تُحذف** من العرض ولا تُملأ بقيمة افتراضية ولا تُكتب «غير متوفر» (§7.4).
 * - ترتيب الحقول هو ترتيب القالب، وتسمياتها قابلة للتعديل (§7.3).
 * - الحقل `contact` يُبنى من فئات التواصل **المحجوبة فقط** (O03): لا يعبر أي رقم خام إلى العرض.
 * - النتيجة لا تُخزَّن: تُبنى عند العرض من النتائج المخزَّنة، فيبقى المصدر الأصلي سليماً (D04).
 */
import type { TemplateConfig } from './ruleConfigRepository.js';

export interface RenderInputField {
  fieldKey: string;
  value: string;
  confidence: number;
  ambiguous: boolean;
}

export interface RenderInputContact {
  kind: string;
  masked: string;
  confidence: number;
}

export interface RenderedField {
  key: string;
  label: string;
  value: string;
  /** هل القيمة محجوبة؟ (مجال التواصل) — الواجهة تعرض شارة «محجوب». */
  masked: boolean;
  confidence?: number;
  ambiguous?: boolean;
}

export interface RenderedPost {
  templateId: string | null;
  templateName: string | null;
  fields: RenderedField[];
  /** حقول القالب التي لا توجد لها قيمة في هذه الرسالة (محذوفة من العرض). */
  missingFields: { key: string; label: string }[];
  /** النص الجاهز للعرض/النشر (سطور «التسمية: القيمة») — بلا حقول غائبة. */
  text: string;
}

/** يختار أفضل قيمة لكل حقل (أعلى ثقة، ثم أول ظهور). */
function bestFieldValues(fields: RenderInputField[]): Map<string, RenderInputField> {
  const best = new Map<string, RenderInputField>();
  for (const field of fields) {
    const current = best.get(field.fieldKey);
    if (!current || field.confidence > current.confidence) best.set(field.fieldKey, field);
  }
  return best;
}

/** يبني نص وسيلة التواصل من القيم المحجوبة فقط، بلا تكرار. */
export function contactsLine(contacts: RenderInputContact[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const contact of contacts) {
    const key = `${contact.kind}:${contact.masked}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(contact.masked);
  }
  return parts.join(' • ');
}

export function renderTemplate(input: {
  template: TemplateConfig | null;
  extracted: RenderInputField[];
  contacts: RenderInputContact[];
}): RenderedPost {
  const best = bestFieldValues(input.extracted);
  const contactValue = contactsLine(input.contacts);

  if (!input.template) {
    return {
      templateId: null,
      templateName: null,
      fields: [],
      missingFields: [],
      text: '',
    };
  }

  const fields: RenderedField[] = [];
  const missingFields: { key: string; label: string }[] = [];

  for (const field of input.template.fields) {
    if (!field.enabled) continue;
    if (field.fieldKey === 'contact') {
      if (!contactValue) {
        missingFields.push({ key: field.fieldKey, label: field.label });
        continue;
      }
      fields.push({ key: field.fieldKey, label: field.label, value: contactValue, masked: true });
      continue;
    }
    const value = best.get(field.fieldKey);
    if (!value || !value.value.trim()) {
      missingFields.push({ key: field.fieldKey, label: field.label });
      continue;
    }
    fields.push({
      key: field.fieldKey,
      label: field.label,
      value: value.value,
      masked: false,
      confidence: value.confidence,
      ambiguous: value.ambiguous,
    });
  }

  const text = fields.map((field) => `${field.label}: ${field.value}`).join('\n');

  return {
    templateId: input.template.id,
    templateName: input.template.name,
    fields,
    missingFields,
    text,
  };
}
