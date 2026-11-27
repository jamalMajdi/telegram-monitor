/**
 * مُحدِّد القالب (Template Resolver) — الخطوة 6-ب، تطبيق أولوية O02 حرفياً:
 *
 *   قالب مسار النشر (route — مؤجَّل للمرحلة الثالثة، يُمرَّر دائماً null الآن)
 *   ← تخصيص المصدر (source override)
 *   ← الفلتر (بأعلى أولوية مطابقة)
 *   ← التصنيف
 *   ← القالب الافتراضي للمستخدم
 *   ← لا قالب (none)
 *
 * القرار حتمي: لا تعادل داخل المستوى نفسه لأن كل هدف مرتبط بقالب واحد (قيد فريد في المخطط)،
 * والانتقال للمستوى التالي يحدث فقط إذا كان القالب المرشَّح غير موجود أو معطّلاً — ويُوثَّق ذلك في `details`.
 */
import type { ConfigSnapshot, TemplateConfig } from './ruleConfigRepository.js';

export type ResolvedBy = 'route' | 'source' | 'filter' | 'classification' | 'default' | 'none';

export interface TemplateSelection {
  templateId: string | null;
  templateName: string | null;
  resolvedBy: ResolvedBy;
  /** تفاصيل التدقيق: أي مرشَّح رُفض ولماذا. */
  details: {
    routeTemplateId?: string | null;
    sourceTemplateId?: string | null;
    filterTemplateId?: string | null;
    classificationTemplateId?: string | null;
    defaultTemplateId?: string | null;
    skipped?: { level: ResolvedBy; templateId: string; reason: 'missing' | 'disabled' }[];
  };
}

function usable(templates: TemplateConfig[], templateId: string | null | undefined): TemplateConfig | null {
  if (!templateId) return null;
  return templates.find((template) => template.id === templateId) ?? null;
}

export function resolveTemplate(input: {
  snapshot: ConfigSnapshot;
  sourceId: string | null;
  /** معرّفات الفلاتر المطابقة مرتَّبة بأولوية تصاعدية (كما يعيدها محرّك التقييم). */
  matchedFilterIds: string[];
  classificationId: string | null;
  /** مسار النشر — غير مستخدم في المرحلة الثانية (يُترك null صراحةً). */
  routeTemplateId?: string | null;
}): TemplateSelection {
  const templates = input.snapshot.templates;
  const skipped: NonNullable<TemplateSelection['details']['skipped']> = [];
  const bindings = input.snapshot.templateBindings;

  const candidates: { level: ResolvedBy; templateId: string | null }[] = [
    { level: 'route', templateId: input.routeTemplateId ?? null },
    { level: 'source', templateId: input.sourceId ? (bindings.source[input.sourceId] ?? null) : null },
    {
      level: 'filter',
      templateId:
        input.matchedFilterIds.map((filterId) => bindings.filter[filterId]).find((id) => Boolean(id)) ?? null,
    },
    {
      level: 'classification',
      templateId: input.classificationId ? (bindings.classification[input.classificationId] ?? null) : null,
    },
    { level: 'default', templateId: input.snapshot.defaultTemplateId },
  ];

  const details: TemplateSelection['details'] = {
    routeTemplateId: candidates[0]!.templateId,
    sourceTemplateId: candidates[1]!.templateId,
    filterTemplateId: candidates[2]!.templateId,
    classificationTemplateId: candidates[3]!.templateId,
    defaultTemplateId: candidates[4]!.templateId,
  };

  for (const candidate of candidates) {
    if (!candidate.templateId) continue;
    const template = usable(templates, candidate.templateId);
    if (!template) {
      skipped.push({ level: candidate.level, templateId: candidate.templateId, reason: 'missing' });
      continue;
    }
    if (!template.enabled) {
      skipped.push({ level: candidate.level, templateId: candidate.templateId, reason: 'disabled' });
      continue;
    }
    if (skipped.length > 0) details.skipped = skipped;
    return {
      templateId: template.id,
      templateName: template.name,
      resolvedBy: candidate.level,
      details,
    };
  }

  if (skipped.length > 0) details.skipped = skipped;
  return { templateId: null, templateName: null, resolvedBy: 'none', details };
}
