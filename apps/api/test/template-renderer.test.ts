/**
 * اختبارات وحدة لباني المنشور من القالب (6-ب): حذف الحقول الغائبة (§7.4)،
 * ترتيب الحقول، والحجب الإلزامي لوسائل التواصل (O03).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contactsLine, renderTemplate } from '../src/modules/processing/templateRenderer.js';
import type { TemplateConfig } from '../src/modules/processing/ruleConfigRepository.js';

const template: TemplateConfig = {
  id: 't1',
  name: 'الوظائف',
  isBuiltin: true,
  enabled: true,
  fields: [
    { fieldKey: 'role', label: 'المسمى الوظيفي', position: 0, enabled: true },
    { fieldKey: 'location', label: 'الموقع', position: 1, enabled: true },
    { fieldKey: 'budget', label: 'الراتب', position: 2, enabled: true },
    { fieldKey: 'contact', label: 'وسيلة التواصل', position: 3, enabled: true },
  ],
};

describe('باني المنشور (6-ب)', () => {
  it('يُدرج الحقول الموجودة بترتيب القالب وبتسمياته', () => {
    const rendered = renderTemplate({
      template,
      extracted: [
        { fieldKey: 'budget', value: '500 دولار', confidence: 0.8, ambiguous: false },
        { fieldKey: 'role', value: 'مبرمج', confidence: 0.7, ambiguous: false },
      ],
      contacts: [],
    });
    assert.deepEqual(
      rendered.fields.map((field) => field.key),
      ['role', 'budget'],
      'الترتيب من القالب لا من ترتيب الاستخراج',
    );
    assert.equal(rendered.text, 'المسمى الوظيفي: مبرمج\nالراتب: 500 دولار');
  });

  it('يحذف الحقول الغائبة ولا يكتب «غير متوفر» (§7.4)', () => {
    const rendered = renderTemplate({
      template,
      extracted: [{ fieldKey: 'role', value: 'مبرمج', confidence: 0.7, ambiguous: false }],
      contacts: [],
    });
    assert.ok(!rendered.text.includes('غير متوفر'));
    assert.ok(!rendered.text.includes('الراتب'));
    assert.deepEqual(
      rendered.missingFields.map((field) => field.key),
      ['location', 'budget', 'contact'],
    );
  });

  it('يخفي حقل التواصل إن لم توجد وسيلة تواصل (لا اخترع)', () => {
    const rendered = renderTemplate({ template, extracted: [], contacts: [] });
    assert.equal(rendered.fields.length, 0);
    assert.equal(rendered.text, '');
  });

  it('يبني حقل التواصل من القيم المحجوبة فقط وبلا تكرار', () => {
    const rendered = renderTemplate({
      template,
      extracted: [],
      contacts: [
        { kind: 'phone', masked: '967•••••67', confidence: 0.9 },
        { kind: 'phone', masked: '967•••••67', confidence: 0.9 },
        { kind: 'username', masked: '@a•••z', confidence: 0.85 },
      ],
    });
    const contact = rendered.fields.find((field) => field.key === 'contact');
    assert.ok(contact);
    assert.equal(contact!.masked, true);
    assert.equal(contact!.value, '967•••••67 • @a•••z');
  });

  it('يتجاهل الحقول المعطّلة في القالب', () => {
    const rendered = renderTemplate({
      template: { ...template, fields: template.fields.map((field) => (field.fieldKey === 'budget' ? { ...field, enabled: false } : field)) },
      extracted: [
        { fieldKey: 'role', value: 'مبرمج', confidence: 0.7, ambiguous: false },
        { fieldKey: 'budget', value: '500', confidence: 0.8, ambiguous: false },
      ],
      contacts: [],
    });
    assert.deepEqual(rendered.fields.map((field) => field.key), ['role']);
  });

  it('يختار أعلى ثقة لكل حقل عند تعدّد القيم', () => {
    const rendered = renderTemplate({
      template,
      extracted: [
        { fieldKey: 'role', value: 'مبرمج', confidence: 0.6, ambiguous: true },
        { fieldKey: 'role', value: 'مبرمج أول', confidence: 0.85, ambiguous: false },
      ],
      contacts: [],
    });
    assert.equal(rendered.fields[0]!.value, 'مبرمج أول');
    assert.equal(rendered.fields[0]!.ambiguous, false);
  });

  it('يعيد معاينة فارغة بلا قالب', () => {
    const rendered = renderTemplate({ template: null, extracted: [{ fieldKey: 'role', value: 'مبرمج', confidence: 0.7, ambiguous: false }], contacts: [] });
    assert.equal(rendered.templateId, null);
    assert.deepEqual(rendered.fields, []);
    assert.equal(rendered.text, '');
  });

  it('contactsLine لا يعيد قيمة غير محجوبة أبداً', () => {
    const line = contactsLine([{ kind: 'phone', masked: '077•••••67', confidence: 0.8 }]);
    assert.equal(line, '077•••••67');
    assert.ok(!/\d{9}/.test(line));
  });
});
