#!/usr/bin/env node
/**
 * أداة إدارة سطر الأوامر لمحرّك الفلترة والتصنيف (V1).
 *
 * لماذا وُجدت؟ محرّك الفلترة مكشوف كاملًا في واجهة الـAPI (إنشاء/تعديل/اختبار/ربط/قواميس)،
 * لكن شاشات الواجهة في V1 لا تعرض تحرير الفلاتر بعد. هذه الأداة تسدّ الفجوة تشغيلياً
 * بلا انتظار واجهة: نفس نقاط الـAPI ونفس الصلاحيات والتدقيق.
 *
 * الاستخدام:
 *   node scripts/tg-cli.mjs login --email admin@example.com --password '...'
 *   node scripts/tg-cli.mjs filters list
 *   node scripts/tg-cli.mjs filters test --text "أبحث عن شقة للإيجار في عدن 777123456"
 *   node scripts/tg-cli.mjs filters create --name "خدمات أكاديمية" --terms "حل واجبات,تلخيص,بحث تخرج" --priority 60
 *   node scripts/tg-cli.mjs filters update <id> --enabled false
 *   node scripts/tg-cli.mjs filters bind <id> --sources <sourceId>,<sourceId>
 *   node scripts/tg-cli.mjs filters delete <id>
 *   node scripts/tg-cli.mjs dictionaries list
 *   node scripts/tg-cli.mjs classifications list
 *   node scripts/tg-cli.mjs templates list
 *
 * ملاحظات أمان: لا تُطبع كلمة المرور ولا ملف الجلسة؛ الجلسة تُخزَّن في ملف بصلاحية 600
 * داخل مجلد المستخدم (~/.tg-cli-session.json) ويُحذف عند `logout`.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_FILE = join(homedir(), '.tg-cli-session.json');
const BASE = (process.env.TG_API_BASE ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else out._.push(token);
  }
  return out;
}

function loadSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveSession(session) {
  writeFileSync(SESSION_FILE, JSON.stringify(session), { mode: 0o600 });
  try {
    chmodSync(SESSION_FILE, 0o600);
  } catch {
    /* بعض الأنظمة لا تدعم chmod — الملف أُنشئ بـ600 أصلًا */
  }
}

async function request(method, path, body, session = loadSession()) {
  const headers = { accept: 'application/json', origin: BASE };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (session?.cookie) headers.cookie = session.cookie;
  if (session?.csrf && method !== 'GET') headers['x-csrf-token'] = session.csrf;
  if (session?.accessToken) headers['x-session-token'] = session.accessToken;

  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = payload?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`${res.status}: ${message}`);
  }
  return { payload, setCookie: res.headers.get('set-cookie') };
}

function conditionsFromTerms(terms, matchMode = 'word', mode = 'any') {
  return [{ mode, terms, matchMode }];
}

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const group = process.argv[2];
// الكلمة الثانية فعلٌ فرعي فقط إن لم تبدأ بشرطة (filters list / login --email ...).
const hasSubcommand = process.argv[3] !== undefined && !process.argv[3].startsWith('--');
const action = hasSubcommand ? process.argv[3] : undefined;
const args = parseArgs(process.argv.slice(hasSubcommand ? 4 : 3));

try {
  if (group === 'login') {
    if (!args.email || !args.password) throw new Error('مطلوب --email و --password');
    const { payload, setCookie } = await request(
      'POST',
      '/auth/login',
      { email: args.email, password: args.password },
      null,
    );
    const cookie = String(setCookie ?? '').split(';')[0];
    saveSession({ cookie, csrf: payload.csrfToken, accessToken: payload.accessToken ?? null, email: args.email });
    console.log(`تم الدخول: ${payload.user.email} (${payload.user.role})`);
  } else if (group === 'logout') {
    try {
      await request('POST', '/auth/logout', {});
    } catch {
      /* الخروج المحلي يكفي */
    }
    if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE);
    console.log('تم الخروج وحُذف ملف الجلسة المحلي.');
  } else if (group === 'whoami') {
    const { payload } = await request('GET', '/auth/session');
    console.log(payload.authenticated ? `${payload.user.email} (${payload.user.role})` : 'غير مسجّل الدخول');
  } else if (group === 'filters' && action === 'list') {
    const { payload } = await request('GET', '/telegram/filters');
    for (const filter of payload.filters) {
      console.log(`${filter.id}  أولوية=${String(filter.priority).padStart(4)}  ${filter.enabled ? 'مفعّل ' : 'معطّل '}  ${filter.name}`);
    }
  } else if (group === 'filters' && action === 'show') {
    const { payload } = await request('GET', `/telegram/filters/${args._[0]}`);
    console.log(JSON.stringify(payload.filter, null, 2));
  } else if (group === 'filters' && action === 'create') {
    const terms = splitList(args.terms);
    if (!args.name || terms.length === 0) throw new Error('مطلوب --name و --terms');
    const { payload } = await request('POST', '/telegram/filters', {
      name: args.name,
      description: args.description ? String(args.description) : null,
      priority: args.priority ? Number(args.priority) : 50,
      scope: args.scope === 'bound' ? 'bound_sources' : 'all_sources',
      appliesTo: 'any',
      enabled: true,
      conditions: conditionsFromTerms(terms, args['match-mode'] ?? 'word'),
    });
    console.log(`أُنشئ الفلتر: ${payload.filter.id} — ${payload.filter.name}`);
  } else if (group === 'filters' && action === 'update') {
    const body = {};
    if (args.name) body.name = String(args.name);
    if (args.priority) body.priority = Number(args.priority);
    if (args.enabled !== undefined) body.enabled = args.enabled !== 'false' && args.enabled !== false;
    if (args.terms) body.conditions = conditionsFromTerms(splitList(args.terms), args['match-mode'] ?? 'word');
    const { payload } = await request('PATCH', `/telegram/filters/${args._[0]}`, body);
    console.log(`حُدِّث الفلتر: ${payload.filter.id}`);
  } else if (group === 'filters' && action === 'delete') {
    await request('DELETE', `/telegram/filters/${args._[0]}`);
    console.log('حُذف الفلتر.');
  } else if (group === 'filters' && action === 'bind') {
    const sourceIds = splitList(args.sources);
    await request('POST', `/telegram/filters/${args._[0]}/sources`, { sourceIds });
    console.log(`رُبط الفلتر بـ${sourceIds.length} مصدراً.`);
  } else if (group === 'filters' && action === 'test') {
    const definition = {
      name: args.name ? String(args.name) : 'مسوّدة',
      scope: 'all_sources',
      appliesTo: 'any',
      priority: 50,
      enabled: true,
      conditions: conditionsFromTerms(splitList(args.terms ?? 'حل واجبات'), args['match-mode'] ?? 'word'),
    };
    const { payload } = await request('POST', '/telegram/filters/test', {
      text: String(args.text ?? ''),
      ...(args.caption ? { caption: String(args.caption) } : {}),
      definition,
    });
    console.log(JSON.stringify(payload.result, null, 2));
  } else if (group === 'dictionaries' && action === 'list') {
    const { payload } = await request('GET', '/telegram/dictionaries');
    for (const dictionary of payload.dictionaries ?? []) {
      console.log(`${dictionary.id}  ${dictionary.name}  (${dictionary.termsCount ?? '?'} مصطلح)`);
    }
  } else if (group === 'classifications' && action === 'list') {
    const { payload } = await request('GET', '/telegram/classifications');
    for (const item of payload.classifications) {
      console.log(`أولوية=${String(item.priority).padStart(4)}  ${item.enabled ? 'مفعّل ' : 'معطّل '}  ${item.name}  (شروط: ${item.conditionCount})`);
    }
  } else if (group === 'templates' && action === 'list') {
    const { payload } = await request('GET', '/telegram/templates');
    for (const item of payload.templates ?? payload.items ?? []) {
      console.log(`${item.id}  ${item.isDefault ? '[افتراضي] ' : ''}${item.name}`);
    }
  } else {
    console.log(`أوامر متاحة:
  login --email --password | logout | whoami
  filters list | show <id> | create --name --terms [--priority] [--scope bound] [--match-mode word|phrase|contains]
  filters update <id> [--name] [--terms] [--priority] [--enabled false] | bind <id> --sources <ids> | delete <id>
  filters test [--text] [--terms "..."] [--name "..."]
  dictionaries list | classifications list | templates list`);
    process.exitCode = group ? 1 : 0;
  }
} catch (error) {
  console.error(`خطأ: ${error.message}`);
  process.exitCode = 1;
}
