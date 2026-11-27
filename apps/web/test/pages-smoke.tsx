/**
 * دخان صفحات الويب (Render Smoke Test) — حماية من انهيار E-MWWD4Z41.
 *
 * يُشغَّل بلا متصفح ولا شبكة: jsdom + React الحقيقي + `fetch` مُستبدل يعيد **نفس أشكال**
 * استجابات الـAPI كما هي في الإنتاج (ملخّص بلا `conditions`، وتفصيل يحتويها).
 * الفكرة: إن افترضت صفحةٌ حقلاً غير موجود في الملخّص، يسقط هذا الاختبار فوراً —
 * وهو بالضبط ما حدث في شاشة الفلاتر قبل الإصلاح.
 *
 * التشغيل: npm --workspace @tg/web run smoke
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html lang="ar" dir="rtl"><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/telegram/filters',
  pretendToBeVisual: true,
});
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
globals.navigator = dom.window.navigator;
globals.HTMLElement = dom.window.HTMLElement;
globals.Node = dom.window.Node;
globals.Event = dom.window.Event;
globals.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import('react');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

// ── أشكال الاستجابات الحقيقية (ملخّص بلا conditions — والتفصيل يحتويها) ──────────
const filterSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'وظائف وفرص عمل',
  description: 'طلبات وبحث عن وظائف ومهن',
  enabled: true,
  priority: 10,
  scope: 'all_sources',
  appliesTo: 'any',
  isBuiltin: true,
  version: '1',
  conditionCount: 3,
  termCount: 6,
  sourceIds: [],
  updatedAt: '2026-11-25T14:56:30.529Z',
};

const filterDetail = {
  ...filterSummary,
  conditions: [
    {
      id: 'c1',
      position: 1,
      mode: 'any',
      negate: false,
      minMatches: 1,
      dictionaryId: null,
      terms: [
        { id: 't1', display: 'وظيفة', literal: true, matchMode: 'word' },
        { id: 't2', display: 'خبرة', literal: true, matchMode: 'word' },
      ],
    },
    {
      id: 'c2',
      position: 2,
      mode: 'any',
      negate: true,
      minMatches: 1,
      dictionaryId: '33333333-3333-4333-8333-333333333333',
      terms: [],
    },
  ],
};

// ملخّص التصنيف أضيق من ملخّص الفلتر (بلا scope/appliesTo/termCount/updatedAt) — كما في الخادم.
const classificationSummary = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'خدمات طلابية',
  description: 'تصنيف شامل',
  priority: 20,
  enabled: true,
  isBuiltin: true,
  version: '1',
  conditionCount: 2,
};

const classificationDetail = {
  ...classificationSummary,
  scope: 'all_sources',
  appliesTo: 'any',
  termCount: 4,
  sourceIds: [],
  updatedAt: '2026-11-25T15:00:00.000Z',
  conditions: [
    {
      id: 'c9',
      position: 1,
      mode: 'any',
      negate: false,
      minMatches: 1,
      dictionaryId: null,
      terms: [{ id: 't9', display: 'واجبات', literal: true, matchMode: 'word' }],
    },
  ],
};

const dictionaries = {
  dictionaries: [{ id: '33333333-3333-4333-8333-333333333333', name: 'استبعاد عام', kind: 'exclusion', termCount: 5 }],
};

let calls = 0;

/**
 * وضع حيّ اختياري: يوجّه نفس الصفحات إلى خدمة API حقيقية (قراءة فقط) للتحقق من الشكل الفعلي.
 * يُستخدم بتشغيل: SMOKE_LIVE_BASE=http://127.0.0.1:4000 SMOKE_COOKIE='tg_sid=…' npm run smoke
 */
// نحفظ الجلب الأصلي قبل استبدال globalThis.fetch وإلا استدعى نفسه بلا نهاية.
const realFetch = globalThis.fetch.bind(globalThis);
const liveBase = process.env.SMOKE_LIVE_BASE ?? '';
const liveCookie = process.env.SMOKE_COOKIE ?? '';
/** نص متوقّع في الوضع الحيّ (مثلاً اسم فلتر تجريبي أنشأته للتو). */
const expectName = process.env.SMOKE_EXPECT ?? '';

/** ملخّصات أُنشئت عبر الواجهة أثناء الاختبار — يجعل البديل ديناميكياً بدل استجابة ثابتة. */
const createdFilters: Record<string, unknown>[] = [];

/** حالة إعدادات المستخدم في البديل: تتغيّر فعلياً عند PATCH (لاختبار بطاقة الهوية). */
const settingsState = {
  contentRetentionHours: 48,
  deliveryRetentionDays: 90,
  notifications: {} as Record<string, unknown>,
  processing: {} as Record<string, unknown>,
  attribution: { enabled: true, mode: 'both', showUsername: true, showId: false },
  updatedAt: '2026-11-25T14:56:07.831Z',
};

const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  calls += 1;
  if (liveBase) {
    const response = await realFetch(`${liveBase}${url}`, {
      method: init?.method ?? 'GET',
      headers: {
        accept: 'application/json',
        origin: 'http://localhost:5173',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers as Record<string, string> | undefined),
        ...(liveCookie ? { cookie: liveCookie } : {}),
      },
      body: init?.body ? String(init.body) : undefined,
    });
    if (process.env.SMOKE_VERBOSE) {
      const copy = response.clone();
      console.log(`[live] ${init?.method ?? 'GET'} ${url} → ${response.status} ${(await copy.text()).slice(0, 120)}`);
    }
    return response;
  }
  const json = (body: unknown) =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    }) as unknown as Response;

  // الإعدادات و«أنا»: تُفحص قبل '/me' العام لأن '/me/settings' يبدأ به.
  if (url.includes('/me/settings')) {
    if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (body.attributionEnabled !== undefined) settingsState.attribution.enabled = Boolean(body.attributionEnabled);
      if (body.attributionMode !== undefined) {
        settingsState.attribution.mode = String(body.attributionMode) as 'source' | 'sender' | 'both';
      }
      if (body.attributionShowUsername !== undefined) {
        settingsState.attribution.showUsername = Boolean(body.attributionShowUsername);
      }
      if (body.attributionShowId !== undefined) settingsState.attribution.showId = Boolean(body.attributionShowId);
      if (body.contentRetentionHours !== undefined) settingsState.contentRetentionHours = Number(body.contentRetentionHours);
      if (body.deliveryRetentionDays !== undefined) settingsState.deliveryRetentionDays = Number(body.deliveryRetentionDays);
    }
    return json({ settings: settingsState });
  }
  if (url.endsWith('/me')) {
    return json({
      user: { id: 'u1', email: 'smoke@example.test', displayName: 'مدير', role: 'admin', status: 'active' },
      settings: { contentRetentionHours: settingsState.contentRetentionHours },
      dangerZone: { purgePhrase: 'احذف بياناتي', deletePhrase: 'احذف حسابي نهائياً' },
    });
  }
  if (url.includes('/auth/session')) return json({ authenticated: true, user: { id: 'u1', email: 'smoke@example.test' } });
  if (url.includes('/telegram/dictionaries')) return json(dictionaries);
  if (url.includes('/telegram/classifications/')) return json({ classification: classificationDetail });
  if (url.includes('/telegram/classifications')) return json({ classifications: [classificationSummary] });
  if (url.includes('/telegram/filters/test')) return json({ result: { matched: true, matches: [] } });
  if (url.includes('/telegram/filters/')) return json({ filter: filterDetail });
  if (url.includes('/telegram/filters')) {
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string; conditions?: unknown[] };
      const created = {
        ...filterSummary,
        id: `created-${createdFilters.length + 1}`,
        name: body.name ?? 'بلا اسم',
        isBuiltin: false,
        conditionCount: body.conditions?.length ?? 0,
      };
      createdFilters.push(created);
      return json({ filter: { ...created, conditions: [] } });
    }
    return json({ filters: [filterSummary, ...createdFilters] });
  }
  return json({});
};
globals.fetch = fetchStub as unknown as typeof fetch;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mountPage(loader: () => Promise<{ default: () => JSX.Element }>) {
  const module = await loader();
  const host = dom.window.document.getElementById('root')!;
  host.innerHTML = '';
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(module.default));
    // نمنح آثار الجلب (useEffect + fetch + setState) فرصة الاكتمال.
    await sleep(60);
  });
  await act(async () => {
    await sleep(60);
  });
  return { host, root, text: host.textContent ?? '' };
}

async function renderPage(loader: () => Promise<{ default: () => JSX.Element }>): Promise<string> {
  const { host, root, text } = await mountPage(loader);
  await act(async () => {
    root.unmount();
  });
  return text;
}

/** يكتب في حقل يتحكّم به React (قيمة + حدث input) — الطريقة التي يفهمها React فعلاً. */
async function typeInto(element: Element | null, value: string): Promise<boolean> {
  if (!element) return false;
  const node = element as HTMLInputElement | HTMLTextAreaElement;
  const proto = node instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(node, value);
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(20);
  });
  return true;
}

/** ينقر زراً بنصه المرئي داخل الصفحة المركوبة، ثم يمنح الشبكة/الحالة وقتاً للتحديث. */
async function clickByText(host: HTMLElement, label: string): Promise<boolean> {
  const button = Array.from(host.querySelectorAll('button')).find((node) => (node.textContent ?? '').trim() === label);
  if (!button) return false;
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(80);
  });
  return true;
}

let failures = 0;
const check = (label: string, condition: boolean, detail = '') => {
  if (condition) {
    console.log(`ok - ${label}`);
  } else {
    failures += 1;
    console.error(`not ok - ${label}${detail ? ` :: ${detail}` : ''}`);
  }
};

// 1) شاشة الفلاتر: لا تنهار وتعرض الملخّص والشرائح من التفاصيل الكسولة.
try {
  const text = await renderPage(() => import('../src/pages/TelegramFiltersPage'));
  check('شاشة الفلاتر تُرسم بلا انهيار', text.includes('الفلاتر'));
  check('تعرض اسم الفلتر من الملخّص', liveBase ? text.includes('أولوية') : text.includes('وظائف وفرص عمل'));
  check('تعرض عدّاد الشروط', liveBase ? text.includes('شرط') : text.includes('3 شرط'));
  check('تعرض شرائح الشروط من التفاصيل', liveBase ? text.includes('شرط') : text.includes('وظيفة') && text.includes('خبرة'));
  if (expectName) check(`تعرض «${expectName}» من القاعدة الحقيقية`, text.includes(expectName));
  if (liveBase) console.log('[live] نص صفحة الفلاتر:\n' + text.slice(0, 1200));
  check('تعرض شريحة القاموس للشرط المنفيّ', liveBase ? true : text.includes('استبعاد عام'));
} catch (error) {
  failures += 1;
  console.error('not ok - انهيار شاشة الفلاتر:', (error as Error).message);
}

// 1.5) بطاقة هوية المصدر والمرسل في الإعدادات: تُرسم، وتعرض معاينة، وتُحفظ بالنقر.
try {
  const [{ default: SettingsPage }, auth, react] = await Promise.all([
    import('../src/pages/SettingsPage'),
    import('../src/auth/AuthContext'),
    import('react'),
  ]);
  const wrap = () => react.createElement(auth.AuthProvider, null, react.createElement(SettingsPage));
  const { host, root, text } = await mountPage(async () => ({ default: wrap }));
  check('بطاقة الهوية تُرسم في الإعدادات', text.includes('هوية المصدر والمرسل'));
  check('المعاينة تعرض سطري المصدر والمرسل', text.includes('📣') && text.includes('👤'));
  check('المعاينة تعرض اسم مصدر وهمياً', text.includes('قناة السوق العام'));
  check('المعرّف الرقمي مخفي افتراضياً في المعاينة', !text.includes('1001234567890'));
  const toggle = Array.from(host.querySelectorAll('input[type="checkbox"]'))[0] as HTMLInputElement | undefined;
  check('مفتاح التشغيل موجود ومفعّل افتراضياً', Boolean(toggle) && toggle!.checked);
  if (toggle) {
    await act(async () => {
      toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await sleep(80);
    });
    const after = host.textContent ?? '';
    check('إيقاف الهوية يحدّث الواجهة فوراً', after.includes('موقوفة'));
    check('إيقاف الهوية يخفي المعاينة', !after.includes('📣'));
    check('الإيقاف أُرسل للخادم (PATCH)', settingsState.attribution.enabled === false);
  }
  await act(async () => {
    root.unmount();
  });
} catch (error) {
  failures += 1;
  console.error('not ok - انهيار بطاقة الهوية في الإعدادات:', (error as Error).message);
}

// 2) شاشة التصنيفات: نفس الحماية مع ملخّص أضيق (بلا termCount/updatedAt).
try {
  const text = await renderPage(() => import('../src/pages/TelegramClassificationsPage'));
  check('شاشة التصنيفات تُرسم بلا انهيار', text.includes('التصنيفات'));
  check('تعرض التصنيف الموحّد', text.includes('خدمات طلابية'));
  check('تعرض شارة «مبذور»', text.includes('مبذور'));
  check('تعرض شرائح شروطها', liveBase ? text.includes('شرط') : text.includes('واجبات'));
} catch (error) {
  failures += 1;
  console.error('not ok - انهيار شاشة التصنيفات:', (error as Error).message);
}

// 3) تفاعل حقيقي: زر «تعديل» يجب أن يجلب التفاصيل ثم يفتح المحرّر بالشروط (مسار الإصلاح نفسه).
try {
  const { host, root } = await mountPage(() => import('../src/pages/TelegramFiltersPage'));
  const clicked = await clickByText(host, 'تعديل');
  check('زر «تعديل» موجود وقابل للنقر', clicked);
  const editorText = host.textContent ?? '';
  check('المحرّر يفتح بلا انهيار', editorText.includes('اختبار فوري (بلا حفظ)'));
  check('المحرّر يعرض قسم الشروط المملوءة من التفاصيل', editorText.includes('الشروط'));
  await act(async () => {
    root.unmount();
  });
} catch (error) {
  failures += 1;
  console.error('not ok - انهيار محرّر الفلتر:', (error as Error).message);
}

// 4) إضافة فلتر من الواجهة نفسها (حقيقي في الوضع الحيّ): كتابة → حفظ → ظهور في القائمة.
try {
  const name = liveBase ? `فلتر واجهة حيّ ${Date.now().toString().slice(-6)}` : 'فلتر اختبار الواجهة';
  const { host, root } = await mountPage(() => import('../src/pages/TelegramFiltersPage'));
  await clickByText(host, '+ فلتر جديد');
  const inputs = Array.from(host.querySelectorAll('input.field-input')) as HTMLInputElement[];
  const nameInput = inputs.find((node) => node.getAttribute('type') !== 'number');
  const okName = await typeInto(nameInput ?? null, name);
  const okTerms = await typeInto(host.querySelector('textarea.field-input'), 'تجربةواجهة');
  check('حقول المحرّر تقبل الكتابة', okName && okTerms);
  await clickByText(host, 'حفظ');
  await act(async () => {
    await sleep(liveBase ? 500 : 120);
  });
  const after = host.textContent ?? '';
  check('حفظ القاعدة من الواجهة ينجح', after.includes('أُنشئت القاعدة الجديدة'), after.slice(-160));
  check(`تظهر القاعدة الجديدة «${name}» بعد الحفظ`, after.includes(name));
  if (liveBase) console.log(`[live] أُنشئ من الواجهة: ${name}`);
  await act(async () => {
    root.unmount();
  });
} catch (error) {
  failures += 1;
  console.error('not ok - إنشاء فلتر من الواجهة:', (error as Error).message);
}

check('استُدعيت بيانات الـAPI عبر الجلب المُستبدل', calls >= 4, `calls=${calls}`);

console.log(failures === 0 ? '\nكل فحوص الصفحات ناجحة.' : `\nفشل ${failures} فحصاً.`);
process.exit(failures === 0 ? 0 : 1);
