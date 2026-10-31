#!/usr/bin/env node
/** Offline integration: real cloudCal + CalDavClient + ICS, injected in-memory files/DAV only. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import './ts-resolve-register.mjs';
const i18n = await import('../apps/desktop/src/i18n/index.ts');
let checks = 0;
const check = (v, name) => { assert.ok(v, name); checks++; };
const eq = (a, b, name) => { assert.deepEqual(a, b, name); checks++; };
const rejects = async (fn, pattern, name) => { await assert.rejects(fn, pattern, name); checks++; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const compile = path => ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const ics = await import(dataUrl(compile('packages/core/src/caldav/ics.ts')));
const { CalDavClient } = await import(dataUrl(compile('packages/core/src/caldav/client.ts')));
const host = 'https://mails.tsinghua.edu.cn';
const item = (uid, summary = '测试日程') => ({ uid, summary, start: Date.UTC(2026, 9, 20, 1), end: Date.UTC(2026, 9, 20, 2), onethuSource: 'manual' });
const xml = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
let instance = 0;
async function fixture({ files = new Map(), readGate } = {}) {
  const accounts = new Map(), requests = [], reads = [];
  let intercept = null, failWrite = null, failDelete = null, failRead = null;
  const store = email => { if (!accounts.has(email)) accounts.set(email, new Map()); return accounts.get(email); };
  const root = email => `${host}/dav/${encodeURIComponent(email)}/`;
  const add = (email, events, resource = events[0].uid) => {
    const href = `${root(email)}default/${encodeURIComponent(resource)}.ics`;
    store(email).set(href, { body: ics.serializeCalendar(events), etag: '"v1"' });
    return href;
  };
  const fetch = async (url, init = {}) => {
    const email = atob(init.headers.Authorization.slice(6)).split(':')[0];
    const method = init.method ?? 'GET';
    const request = { method, url, email, headers: { ...init.headers, Authorization: undefined } };
    requests.push(request);
    const intercepted = await intercept?.(request);
    if (intercepted) return intercepted;
    const resources = store(email), home = root(email), calendar = `${home}default/`;
    if (url.endsWith('/.well-known/caldav')) return new Response(null, { status: 302, headers: { Location: home } });
    if (method === 'PROPFIND' && url === home && init.headers.Depth === '0') return new Response(`<D:multistatus><D:response><C:calendar-home-set><D:href>${home}</D:href></C:calendar-home-set></D:response></D:multistatus>`, { status: 207 });
    if (method === 'PROPFIND' && url === home) return new Response(`<D:multistatus><D:response><D:href>${calendar}</D:href><D:resourcetype><C:calendar></C:calendar></D:resourcetype><D:displayname>Calendar</D:displayname></D:response></D:multistatus>`, { status: 207 });
    if (method === 'PROPFIND' && url === calendar) return new Response(`<D:multistatus>${[...resources].map(([href, r]) => `<D:response><D:href>${href}</D:href><D:getetag>${xml(r.etag)}</D:getetag></D:response>`).join('')}</D:multistatus>`, { status: 207 });
    const before = resources.get(url);
    if (method === 'GET') return before ? new Response(before.body, { headers: { ETag: before.etag } }) : new Response('', { status: 404 });
    if (method === 'PUT' || method === 'DELETE') {
      if ((init.headers['If-Match'] && init.headers['If-Match'] !== before?.etag) || (init.headers['If-None-Match'] === '*' && before)) return new Response('', { status: 412 });
      if (method === 'DELETE') { resources.delete(url); return new Response(null, { status: before ? 204 : 404 }); }
      const etag = `"v${Number(before?.etag.match(/\d+/)?.[0] ?? 0) + 1}"`;
      resources.set(url, { body: init.body, etag });
      return new Response(null, { status: before ? 204 : 201, headers: { ETag: etag } });
    }
    throw new Error(`unexpected fake DAV request: ${method}`);
  };
  const deps = {
    '../i18n/index.js': i18n,
    react: { useEffect() {}, useState() {} },
    '@onethu/core': { CalDavClient, caldav: ics },
    '../lib/transport.js': { universalFetch: fetch },
    '../lib/clients.js': {
      fileRead: async (key, options) => { assert.equal(options?.strict, true); reads.push(key); const value = files.get(key) ?? null; await readGate?.promise; if (failRead?.(key)) throw new Error('mock disk read failure'); return value; },
      fileWrite: async (key, value, options) => { assert.equal(options?.strict, true); if (failWrite?.(key)) throw new Error('mock disk write failure'); files.set(key, value); },
      fileDelete: async (key, options) => { assert.equal(options?.strict, true); if (failDelete?.(key)) throw new Error('mock disk delete failure'); files.delete(key); },
      obfuscateSecret: value => value, deobfuscateSecret: value => value,
      info: { getSchedule: async () => [] },
    },
    './data.js': { getCalendarSnapshot: () => null },
    // 上游 c1b3e394 把日历文档读写挪进了 sharedCalendar，并引入 CLI 共享运行时的探测。
    // 离线夹具没有 CLI，探测恒为 false（走本地文件分支）；真要走共享分支就大声失败，
    // 免得"以为测过共享路径"。
    '../lib/sharedRuntime.js': {
      usesSharedRuntime: () => false,
      isCliTransferBusy: () => false,
      sharedAccountGuard: async () => { throw new Error('CLI_SHARED_RUNTIME_UNEXPECTED'); },
      sharedRuntimeRequest: async () => { throw new Error('CLI_SHARED_RUNTIME_UNEXPECTED'); },
    },
  };
  const key = `__cloudCalendarTest${instance++}`; globalThis[key] = deps;
  const sharedSource = compile('apps/desktop/src/state/sharedCalendar.ts').replace(/import \{([^}]+)\} from ["']([^"']+)["'];/g, (_all, names, path) => `const {${names.replace(/\s+as\s+/g, ": ")}} = globalThis[${JSON.stringify(key)}][${JSON.stringify(path)}];`);
  deps['./sharedCalendar.js'] = await import(dataUrl(`${sharedSource}\n// ${key}-shared`));
  const source = compile('apps/desktop/src/state/cloudCal.ts').replace(/import \{([^}]+)\} from "([^"]+)";/g, (_all, names, path) => `const {${names.replace(/\s+as\s+/g, ": ")}} = globalThis[${JSON.stringify(key)}][${JSON.stringify(path)}];`);
  const mod = await import(dataUrl(`${source}\n// ${key}`));
  const mailCalls = [];
  const loadMail = async () => {
    deps['./cloudCal.js'] = mod;
    deps['@tauri-apps/api/core'] = { invoke: async (method) => {
      mailCalls.push(method);
      assert.equal(method, 'mail_list');
      return { total: 1, minSeq: 1, heads: [{ uid: 1, subject: 'isolated inbox', from: 'sender@test', dateMs: 1, seen: false }] };
    } };
    const mailSource = compile('apps/desktop/src/state/mail.ts').replace(/import \{([^}]+)\} from "([^"]+)";/g, (_all, names, path) => `const {${names.replace(/\s+as\s+/g, ": ")}} = globalThis[${JSON.stringify(key)}][${JSON.stringify(path)}];`);
    return import(dataUrl(`${mailSource}\n// ${key}`));
  };
  return { mod, files, requests, reads, add, store, fetch, loadMail, mailCalls, setIntercept: value => { intercept = value; }, setFailWrite: value => { failWrite = value; }, setFailDelete: value => { failDelete = value; }, setFailRead: value => { failRead = value; } };
}

// Actual codec: long values must fold with whitespace and retain recurrence exclusions/overrides.
const text = '长备注，标点;\n' + String.raw`literal\n and \slash` + '内容'.repeat(120);
const start = item('r').start;
const series = [{ ...item('series'), description: text, rrule: { freq: 'WEEKLY', interval: 1 }, exdates: [start + 7 * 86400000] }, { ...item('series', '单次改期'), recurrenceId: start + 14 * 86400000, start: start + 15 * 86400000, end: start + 15 * 86400000 + 3600000 }];
const roundTrip = ics.parseIcs(ics.serializeCalendar(series));
eq(roundTrip[0].description, text, 'long escaped text round trips without truncation');
eq(roundTrip[0].exdates, series[0].exdates, 'EXDATE retained on write');
eq(roundTrip[1].recurrenceId, series[1].recurrenceId, 'RECURRENCE-ID retained on write');
const allDay = ics.parseIcs('BEGIN:VEVENT\r\nUID:day\r\nDTSTART;VALUE=DATE:20261020\r\nSUMMARY:全天\r\nEND:VEVENT')[0];
eq(allDay.end - allDay.start, 86400000, 'all-day without DTEND lasts one day');
eq(ics.parseIcs('BEGIN:VEVENT\nUID:epoch\nDTSTART:19700101T000000Z\nEND:VEVENT')[0].start, 0, 'Unix epoch is a valid DTSTART');

{
  const gate = deferred();
  const files = new Map([['caldav.cfg', JSON.stringify({ email: 'a@test', secret: 'fake' })], ['caldav.cache', JSON.stringify({ email: 'b@test', events: [item('wrong-account')], savedAt: 1 })], ['caldav.local', JSON.stringify({ events: [item('local')] })]]);
  const f = await fixture({ files, readGate: gate });
  let configured = 0; f.mod.onCloudCalConfigChange(() => configured++);
  let finished = false;
  const first = f.mod.ensureCloudCalLoaded(), second = f.mod.ensureCloudCalLoaded().then(() => { finished = true; });
  await Promise.resolve(); check(!finished, 'second load caller waits for I/O');
  gate.resolve(); await Promise.all([first, second]);
  eq(f.reads.length, 3, 'parallel initialization reads each file only once');
  eq(f.mod.getCloudEvents(), [], 'another account cache never becomes current');
  eq(f.mod.getLocalEvents()[0].uid, 'local', 'local events retained across cloud account change');
  eq(configured, 1, 'configuration initialization emits one dedicated event');
}
{
  const f = await fixture({ files: new Map([['caldav.local', '{broken']]) });
  await rejects(() => f.mod.ensureCloudCalLoaded(), SyntaxError, 'corrupt local file rejects rather than empty success');
  f.files.set('caldav.local', JSON.stringify({ events: [item('recovered')] }));
  await f.mod.ensureCloudCalLoaded(); eq(f.mod.getLocalEvents()[0].uid, 'recovered', 'failed initialization can retry');
}
{
  const f = await fixture(); let configEvents = 0, contentEvents = 0;
  f.mod.onCloudCalConfigChange(() => configEvents++); f.mod.onCloudCalChange(() => contentEvents++);
  await f.mod.configureCloudCal('a@test', 'fake');
  const href = f.add('a@test', series, 'server-resource-not-uid');
  const gate = deferred(), started = deferred(); let listing = 0;
  f.setIntercept(async request => { if (request.method === 'PROPFIND' && request.url.endsWith('/default/')) { listing++; started.resolve(); await gate.promise; } });
  const first = f.mod.syncCloudCal(); await started.promise;
  const second = f.mod.syncCloudCal(); gate.resolve();
  const [a, b] = await Promise.all([first, second]); eq(a, b, 'concurrent sync callers share actual result'); eq(listing, 1, 'single scan for concurrent refresh');
  f.setIntercept(null);
  eq(f.mod.getCloudEvents().length, 2, 'same resource master plus override both loaded');
  const changes = contentEvents, gets = f.requests.filter(r => r.method === 'GET').length;
  await f.mod.syncCloudCal(); eq(f.mod.getCloudEvents().length, 2, 'unchanged second scan keeps all recurrence components');
  eq(f.requests.filter(r => r.method === 'GET').length, gets, 'same ETag avoids redundant GET');
  eq(contentEvents, changes, 'unchanged scan does not notify content followers');
  eq(configEvents, 1, 'scans never wake credential consumers');
  const old = { ...f.mod.getCloudEvents()[0] };
  await f.mod.putCloudEvent({ ...old, summary: '编辑主事件' });
  const put = f.requests.findLast(r => r.method === 'PUT'); eq(put.url, href, 'edit uses actual server href'); eq(put.headers['If-Match'], '"v1"', 'edit uses full original ETag');
  const written = ics.parseIcs(f.store('a@test').get(href).body);
  eq(written.length, 2, 'edit keeps override in same calendar resource'); eq(written[1].recurrenceId, series[1].recurrenceId, 'override remains override after editing master');
  const current = { ...f.mod.getCloudEvents()[0] }; f.store('a@test').get(href).etag = '"v99"';
  await rejects(() => f.mod.putCloudEvent({ ...current, summary: '不应覆盖' }), /其他设备/, 'external edit yields explicit conflict');
  await rejects(() => f.mod.deleteCloudEvent('series'), /其他设备/, 'external edit cannot be silently deleted');
  eq(f.mod.getCloudEvents()[0].summary, '编辑主事件', 'conflict retains local event');
  await f.mod.syncCloudCal();
  await rejects(() => f.mod.putCloudEvent(old), /其他设备/, 'stale editor ETag stays stale after background sync');
  await rejects(() => f.mod.deleteCloudEvent('series', old.etag), /其他设备/, 'stale delete draft does not borrow newer synchronized ETag');
  await f.mod.deleteCloudEvent('series'); eq(f.store('a@test').size, 0, 'current version can delete entire resource');
  await f.mod.putCloudEvent(item('new'));
  eq(f.requests.findLast(r => r.method === 'PUT').headers['If-None-Match'], '*', 'new event cannot overwrite unknown remote UID');
  eq(f.mod.getCloudEvents()[0].etag, '"v1"', 'PUT response version stored');
  await f.mod.disconnectCloudCal(); eq(configEvents, 2, 'disconnect notifies credentials without requiring existing content');
}
{
  const f = await fixture(); await f.mod.configureCloudCal('a@test', 'fake'); f.add('a@test', [item('from-a')]);
  const gate = deferred(), started = deferred();
  f.setIntercept(async r => { if (r.method === 'GET') { started.resolve(); await gate.promise; } });
  const sync = f.mod.syncCloudCal(); const stale = rejects(() => sync, /账号已变更/, 'in-flight old account response rejected'); await started.promise;
  const change = f.mod.configureCloudCal('b@test', 'fake');
  while (f.mod.getCloudCalEmail() !== 'b@test') await new Promise(r => setImmediate(r));
  gate.resolve(); await Promise.all([change, stale]);
  eq(f.mod.getCloudEvents(), [], 'old account request cannot repopulate new state');
  check(!f.files.has('caldav.cache'), 'credential replacement does not manufacture an empty account mirror');
  eq(JSON.parse(f.files.get('caldav.cfg')).email, 'b@test', 'durable credentials belong to current account');
}
{
  const f = await fixture(); await f.mod.configureCloudCal('a@test', 'fake'); await f.mod.putLocalEvent(item('move'));
  f.setIntercept(r => r.method === 'PUT' ? new Response('', { status: 503 }) : null);
  await rejects(() => f.mod.saveCalendarEvent(item('move'), { cloud: true, originalCloud: false }), /503/, 'cloud destination failure reported');
  eq(f.mod.getLocalEvents().length, 1, 'failed cloud move leaves original local event');
  f.setIntercept(null); await f.mod.saveCalendarEvent(item('move'), { cloud: true, originalCloud: false });
  eq(f.mod.getLocalEvents().length, 0, 'successful move removes local source only after upload'); eq(f.mod.getCloudEvents().length, 1, 'uploaded destination exists');
  f.setFailWrite(key => key === 'caldav.local');
  await rejects(() => f.mod.saveCalendarEvent(item('move'), { cloud: false, originalCloud: true }), /disk write/, 'failed local destination reported');
  eq(f.mod.getCloudEvents().length, 1, 'disk failure leaves cloud source intact'); eq(f.mod.getLocalEvents().length, 0, 'failed disk write not published as local success');
  f.setFailWrite(null); f.setIntercept(r => r.method === 'DELETE' ? new Response('', { status: 503 }) : null);
  await rejects(() => f.mod.saveCalendarEvent(item('move'), { cloud: false, originalCloud: true }), /两侧日程均保留/, 'source cleanup failure explains retained copies');
  eq(f.mod.getCloudEvents().length, 1, 'cleanup failure leaves cloud original'); eq(f.mod.getLocalEvents().length, 1, 'cleanup failure preserves durable new local copy');
  const count = f.requests.length; await f.mod.syncHwToCloud(); eq(f.requests.length, count, 'retired HW sync makes no destructive remote request');
}
{
  const f = await fixture(); await f.mod.configureCloudCal('a@test', 'fake');
  const old = { ...item('old-course'), onethuSource: 'course' }; f.add('a@test', [old]);
  f.setIntercept(r => r.method === 'PUT' ? new Response('', { status: 503 }) : null);
  const semester = { firstDay: '2026-09-01', weekCount: 16 };
  const schedule = [{ date: '2026-10-20', courseName: '课程', startTime: '08:00', endTime: '09:35', location: '六教' }];
  await rejects(() => f.mod.exportSemesterToCloud(semester, async () => schedule), /503/, 'semester write failure is visible');
  check([...f.store('a@test').values()].some(e => e.body.includes('old-course')), 'old semester kept when new upload fails');
  check(!f.requests.some(r => r.method === 'DELETE'), 'no delete before all new semester entries succeed');
  f.setIntercept(null); const result = await f.mod.exportSemesterToCloud(semester, async () => schedule);
  eq(result, { written: 1, removed: 1, skipped: 0 }, 'explicit semester reconciliation adds new then removes stale');
  const generated = (await f.mod.buildSemesterEvents(semester, async () => schedule)).events[0];
  eq(ics.epochToWall('Asia/Shanghai', generated.start).h, 8, 'campus class clock unaffected by host timezone');
  const invalid = await f.mod.buildSemesterEvents(semester, async () => [{ ...schedule[0], startTime: '99:00' }, { courseName: 'missing date' }]);
  eq(invalid.skipped, 2, 'invalid source entries reported instead of silently dropped');
}
{
  let calls = 0;
  const client = new CalDavClient(async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://other.invalid/dav/' } }); }, { email: 'a@test', authCode: 'fake' });
  await rejects(() => client.discover(), /其他站点/, 'cross-origin DAV discovery cannot carry Basic credentials');
  eq(calls, 1, 'no request to redirected credential origin');
}
{
  const f = await fixture();
  await f.mod.putLocalEvent(series[0]); await f.mod.putLocalEvent(series[1]);
  eq(f.mod.getLocalEvents().length, 2, 'local resource keeps master and exception');
  await f.mod.saveCalendarEvent({ ...series[0], summary: '只改主事件' }, { cloud: false, originalCloud: false });
  eq(f.mod.getLocalEvents().length, 2, 'same-side local edit preserves exception');
  eq(f.mod.getLocalEvents().find(e => e.recurrenceId !== undefined).summary, '单次改期', 'exception content unchanged');
  await rejects(() => f.mod.saveCalendarEvent(series[0], { cloud: true, originalCloud: false }), /重复日程/, 'single-item move cannot destroy a recurring resource');
  const expanded = ics.expandEventSet([{ ...series[0], alarmMinutes: 15 }, { ...series[1], alarmMinutes: 35 }], start, start + 22 * 86400000);
  eq(expanded.find(e => e.override).alarmMinutes, 35, 'override keeps its own reminder');
  eq(expanded.find(e => !e.override).alarmMinutes, 15, 'master reminder reaches normal occurrences');
}
{
  const f = await fixture(); await f.mod.configureCloudCal('a@test', 'fake'); f.add('a@test', [item('pending')]);
  const gate = deferred(), started = deferred();
  f.setIntercept(async r => { if (r.method === 'GET') { started.resolve(); await gate.promise; } });
  const sync = f.mod.syncCloudCal(); const stale = rejects(() => sync, /账号已变更/, 'disconnect invalidates a pending read'); await started.promise;
  const disconnect = f.mod.disconnectCloudCal();
  while (f.mod.getCloudCalConfig()) await new Promise(r => setImmediate(r));
  gate.resolve(); await Promise.all([disconnect, stale]);
  eq(f.mod.getCloudEvents(), [], 'disconnect cannot be undone by stale response');
  check(!f.files.has('caldav.cache') && !f.files.has('caldav.cfg'), 'disconnect finishes with no account files');
}
{
  const f = await fixture(); await f.mod.configureCloudCal('a@test', 'fake'); const href = f.add('a@test', [item('valid')]); await f.mod.syncCloudCal();
  f.store('a@test').get(href).etag = '"bad"'; f.store('a@test').get(href).body = '<html>login page</html>';
  await rejects(() => f.mod.syncCloudCal(), /无效日历/, 'unexpected success HTML cannot clear mirror');
  eq(f.mod.getCloudEvents()[0].uid, 'valid', 'invalid remote body keeps previous events');
  f.setIntercept(r => r.method === 'PROPFIND' && r.url.endsWith('/default/') ? new Response('<html>bad</html>', { status: 207 }) : null);
  await rejects(() => f.mod.syncCloudCal(), /无效日历清单/, 'invalid 207 body not treated as empty list');
  eq(f.mod.getCloudEvents()[0].uid, 'valid', 'invalid listing keeps previous events');
}
{
  const f = await fixture(); await f.mod.configureCloudCal('a@test', 'fake');
  const gate = deferred(), started = deferred(); let active = 0, peak = 0;
  f.setIntercept(async r => { if (r.method === 'PUT') { active++; peak = Math.max(peak, active); started.resolve(); await gate.promise; active--; } });
  const one = f.mod.putCloudEvent(item('one')); await started.promise;
  const two = f.mod.putCloudEvent(item('two')); const sync = f.mod.syncCloudCal();
  gate.resolve(); await Promise.all([one, two, sync]);
  eq(peak, 1, 'mutations never overlap each other');
  eq(f.mod.getCloudEvents().map(e => e.uid).sort(), ['one', 'two'], 'queued scan cannot overwrite concurrent saves');
  const invalid = await f.mod.buildSemesterEvents({ firstDay: '2026-09-01', weekCount: 16 }, async () => [{ date: '2026-02-31', courseName: 'bad date', startTime: '08:00', endTime: '09:00' }]);
  eq(invalid.skipped, 1, 'normalized invalid date is not exported');
}
{
  const f = await fixture({ files: new Map([['caldav.cfg', JSON.stringify({ email: 'a@test', secret: 'fake' })], ['caldav.cache', JSON.stringify({ savedAt: 1, events: [item('legacy-unknown')] })]]) });
  f.add('a@test', [item('verified-remote')]);
  await f.mod.ensureCloudCalLoaded(); eq(f.mod.getCloudEvents(), [], 'unowned legacy cache never published');
  await f.mod.ensureCloudCalMirrorReady(); eq(f.mod.getCloudEvents()[0].uid, 'verified-remote', 'destructive mirror consumer awaits verified remote contents');
  const calls = f.requests.length; await f.mod.ensureCloudCalMirrorReady(); eq(f.requests.length, calls, 'verified mirror does not cause repeated startup network requests');
  await f.mod.configureCloudCal('b@test', 'fake'); f.setIntercept(() => { throw new Error('mock offline'); });
  await rejects(() => f.mod.ensureCloudCalMirrorReady(), /mock offline/, 'new-account network failure does not become an empty verified mirror');
}
{
  const f = await fixture(); await f.mod.configureCloudCal('a@test', 'fake'); await f.mod.syncCloudCal();
  const gate = deferred(), started = deferred();
  f.setIntercept(async r => { if (r.method === 'PUT') { started.resolve(); await gate.promise; } });
  const write = f.mod.putCloudEvent(item('in-progress')); await started.promise;
  let ready = false; const barrier = f.mod.ensureCloudCalMirrorReady().then(() => { ready = true; });
  await Promise.resolve(); await Promise.resolve(); check(!ready, 'native mirror waits for queued mutation even when previous cache was complete');
  gate.resolve(); await Promise.all([write, barrier]); eq(f.mod.getCloudEvents()[0].uid, 'in-progress', 'mirror barrier exposes completed mutation');
}
for (const brokenFile of ['caldav.cache', 'caldav.local']) {
  const f = await fixture({ files: new Map([['caldav.cfg', JSON.stringify({ email: 'valid@test', secret: 'fake' })], [brokenFile, '{bad-json']]) });
  const credentials = f.mod.ensureCloudCalCredentialsLoaded();
  const calendar = rejects(() => f.mod.ensureCloudCalLoaded(), SyntaxError, `${brokenFile} corruption still blocks calendar readiness`);
  await Promise.all([credentials, calendar]);
  eq(f.mod.getCloudCalConfig().email, 'valid@test', 'valid credentials published independently of corrupt calendar content');
  eq(f.reads.filter(name => name === 'caldav.cfg').length, 1, 'mail and calendar share one credential initialization');
  const mail = await f.loadMail(); const heads = await mail.refreshMail('INBOX');
  eq(heads[0].subject, 'isolated inbox', 'real mailbox state remains usable despite corrupt calendar content');
  eq(f.mailCalls, ['mail_list'], 'mail performs only its isolated IPC list call');
  await rejects(() => f.mod.ensureCloudCalMirrorReady(), SyntaxError, 'corrupt calendar cannot be treated as complete system mirror');
  eq(f.requests.length, 0, 'credential-only mail flow never contacts DAV');
  f.files.set(brokenFile, JSON.stringify({ events: [] }));
  await f.mod.ensureCloudCalLoaded(); eq(f.reads.filter(name => name === 'caldav.cfg').length, 1, 'calendar retry reuses proven credentials without rereading config');
}
for (const configFile of ['{invalid', '{}']) {
  const f = await fixture({ files: new Map([['caldav.cfg', configFile]]) }); const mail = await f.loadMail();
  await rejects(() => f.mod.ensureCloudCalCredentialsLoaded(), /JSON|配置损坏|Expected/, 'invalid credential file remains an explicit initialization error');
  await rejects(() => mail.refreshMail('INBOX'), /连接信息读取失败/, 'invalid credential file still prevents mailbox access');
  eq(f.mailCalls.length, 0, 'bad credentials produce no mail call');
  eq(f.mod.getCloudCalConfig(), null, 'bad credentials never publish an account');
  f.files.set('caldav.cfg', JSON.stringify({ email: 'recovered@test', secret: 'fake' }));
  await mail.refreshMail('INBOX'); eq(f.mailCalls.length, 1, 'credential initialization can retry after repair');
}
for (const brokenFile of ['caldav.cfg', 'caldav.cache', 'caldav.local']) {
  const cache = JSON.stringify({ email: 'old@test', savedAt: 1, events: [item('keep-cloud')] });
  const local = JSON.stringify({ events: [item('keep-local')] });
  const files = new Map([['caldav.cfg', JSON.stringify({ email: 'old@test', secret: 'fake' })], ['caldav.cache', cache], ['caldav.local', local], [brokenFile, '{broken']]);
  const f = await fixture({ files });
  await rejects(() => f.mod.ensureCloudCalLoaded(), SyntaxError, 'damaged state initially blocks calendar');
  const beforeCache = files.get('caldav.cache'), beforeLocal = files.get('caldav.local');
  await f.mod.configureCloudCal('repaired@test', 'fake');
  eq(f.mod.getCloudCalEmail(), 'repaired@test', 'actual settings configure entry repairs credentials without parsing calendar');
  eq(files.get('caldav.cache'), beforeCache, 'explicit reconfigure never overwrites calendar mirror');
  eq(files.get('caldav.local'), beforeLocal, 'explicit reconfigure never overwrites local events');
  if (brokenFile !== 'caldav.cfg') await rejects(() => f.mod.ensureCloudCalMirrorReady(), SyntaxError, 'reconfigure does not bless damaged calendar as a complete mirror');
  await f.mod.disconnectCloudCal();
  check(!files.has('caldav.cfg') && f.mod.getCloudCalConfig() === null, 'actual settings disconnect entry removes only credentials');
  eq(files.get('caldav.cache'), beforeCache, 'disconnect preserves recoverable cloud content');
  eq(files.get('caldav.local'), beforeLocal, 'disconnect preserves local content even when damaged');
}
{
  const f = await fixture(); let notifications = 0;
  f.mod.onCloudCalConfigChange(() => notifications++);
  f.setFailWrite(key => key === 'caldav.cfg');
  await rejects(() => f.mod.configureCloudCal('new@test', 'fake'), /disk write/, 'failed first config is not reported saved');
  eq(f.mod.getCloudCalConfig(), null, 'failed config write does not publish connected');
  eq(notifications, 0, 'failed config write does not notify mailbox of phantom credentials');
  f.setFailWrite(null); await f.mod.configureCloudCal('old@test', 'fake');
  f.setFailWrite(key => key === 'caldav.cfg');
  await rejects(() => f.mod.configureCloudCal('new@test', 'fake'), /disk write/, 'failed replacement is reported');
  eq(f.mod.getCloudCalEmail(), 'old@test', 'failed replacement retains previous in-memory account');
  eq(JSON.parse(f.files.get('caldav.cfg')).email, 'old@test', 'failed replacement retains previous durable account');
  f.setFailDelete(key => key === 'caldav.cfg');
  await rejects(() => f.mod.disconnectCloudCal(), /disk delete/, 'failed disconnect persistence is reported');
  eq(f.mod.getCloudCalEmail(), 'old@test', 'failed disconnect does not claim to be disconnected');
}
{
  const f = await fixture();
  f.setFailRead(key => key === 'caldav.local');
  await f.mod.configureCloudCal('new@test', 'fake');
  await rejects(() => f.mod.ensureCloudCalMirrorReady(), /disk read/, 'credential repair cannot bypass calendar IO failure');
  await f.mod.disconnectCloudCal();
  await rejects(() => f.mod.ensureCloudCalMirrorReady(), /disk read/, 'disconnect cannot turn unreadable local events into an empty mirror');
}
{
  const gate = deferred();
  const f = await fixture({ files: new Map([['caldav.cfg', JSON.stringify({ email: 'old@test', secret: 'fake' })]]), readGate: gate });
  const load = f.mod.ensureCloudCalCredentialsLoaded();
  await f.mod.configureCloudCal('new@test', 'fake'); gate.resolve(); await load;
  eq(f.mod.getCloudCalEmail(), 'new@test', 'slow old credential load cannot overwrite a successful explicit replacement');
}
{
  const f = await fixture({ files: new Map([['caldav.cfg', JSON.stringify({ email: 'guard@test', secret: 'fake' })]]) });
  let allowed = true, checked = 0;
  f.setIntercept(request => { if (request.method === 'PROPFIND') allowed = false; });
  await rejects(() => f.mod.putCloudEvent(item('guard'), async () => { checked++; if (!allowed) throw Error('CLI_DISABLED'); }), /CLI_DISABLED/, 'revocation during DAV discovery stops final PUT');
  eq(checked, 1, 'guard executes after asynchronous calendar discovery');
  eq(f.requests.filter(request => request.method === 'PUT').length, 0, 'revoked request sends no PUT');
  eq(f.store('guard@test').size, 0, 'remote calendar unchanged after guard rejection');
}
{
  const f = await fixture({ files: new Map([['caldav.cfg', JSON.stringify({ email: 'guard@test', secret: 'fake' })]]) });
  f.add('guard@test', [item('keep')]); await f.mod.syncCloudCal();
  await rejects(() => f.mod.deleteCloudEvent('keep', undefined, async () => { throw Error('CLI_DISABLED'); }), /CLI_DISABLED/, 'delete carries a per-call guard');
  eq(f.requests.filter(request => request.method === 'DELETE').length, 0, 'rejected deletion sends no DELETE');
  eq(f.store('guard@test').size, 1, 'rejected deletion preserves remote event');
  let checked = 0;
  await rejects(() => f.mod.saveCalendarEvent(item('keep'), { cloud: false, originalCloud: true }, async () => { if (++checked === 2) throw Error('CLI_DISABLED'); }), /两侧日程均保留/, 'revocation between move stages preserves both copies');
  eq(f.mod.getLocalEvents().length, 1, 'move destination retained');
  eq(f.store('guard@test').size, 1, 'move source retained after revoked cleanup');
}
{
  const f = await fixture();
  await rejects(() => f.mod.putLocalEvent(item('blocked'), async () => { throw Error('CLI_DISABLED'); }), /CLI_DISABLED/, 'queued local calendar write has the same guard');
  eq(f.mod.getLocalEvents().length, 0, 'rejected local event never appears');
  check(!f.files.has('caldav.local'), 'rejected local event never persists');
}
{
  // 重复规则创作侧（grill 2026-10-26）：编辑器设/改/清规则经状态层与 ICS 编解码的往返。
  // 永久断言：清「重复」必须显式 rrule/exdates=undefined —— UI 侧 {...source} 的 spread
  // 会把旧值透传回来，这里守住状态层 merge 对显式清除的采纳。
  const f = await fixture(); await f.mod.configureCloudCal('a@test', 'fake'); await f.mod.syncCloudCal();
  const day = (mo, d, h = 0, mi = 0) => ics.wallToEpoch(ics.CAMPUS_TZ, { y: 2026, mo, d, h, mi, s: 0 });
  // ① 本地系列：每周三、截止 11/18（含当天）→ 10/21..11/18 间共 5 场，末场落在截止日
  const first = day(10, 21, 8); // 2026-10-21 周三
  const until = ics.wallToEpoch(ics.CAMPUS_TZ, { y: 2026, mo: 11, d: 18, h: 23, mi: 59, s: 59 });
  await f.mod.putLocalEvent({ ...item('weekly'), start: first, end: first + 3600000, rrule: { freq: 'WEEKLY', interval: 1, byDay: ['WE'], until } });
  const occ = ics.expandEventSet(f.mod.getLocalEvents(), day(10, 1), day(12, 31, 23, 59));
  eq(occ.filter(o => o.uid === 'weekly').length, 5, 'weekly with inclusive UNTIL counts the on-end-date occurrence');
  eq(occ.filter(o => o.uid === 'weekly').at(-1).start, day(11, 18, 8), 'last occurrence lands on the UNTIL day');
  // ② 未触碰的编辑（UI 透传路径：ev 由 {...source} 展开、无显式 rrule 键）→ COUNT 原样保留
  await f.mod.putLocalEvent({ ...item('counted'), rrule: { freq: 'WEEKLY', interval: 1, count: 3 } });
  const counted = f.mod.getLocalEvents().find(e => e.uid === 'counted');
  await f.mod.saveCalendarEvent({ ...counted, summary: '改名' }, { cloud: false });
  eq(f.mod.getLocalEvents().find(e => e.uid === 'counted').rrule.count, 3, 'untouched editor save passes source rrule (COUNT) through');
  // ③ 清「重复」（UI 显式 rrule/exdates=undefined）：merge 必须采纳显式清除
  await f.mod.saveCalendarEvent({ ...f.mod.getLocalEvents().find(e => e.uid === 'weekly'), rrule: undefined, exdates: undefined }, { cloud: false });
  const cleared = f.mod.getLocalEvents().find(e => e.uid === 'weekly');
  eq(cleared.rrule, undefined, 'explicit rrule:undefined defeats spread passthrough');
  eq(cleared.exdates, undefined, 'exdates cleared together with the rule');
  eq(ics.expandEventSet(f.mod.getLocalEvents(), day(10, 1), day(12, 31, 23, 59)).filter(o => o.uid === 'weekly').length, 1, 'cleared series collapses to a single event');
  const persisted = JSON.parse(f.files.get('caldav.local')).events.find(e => e.uid === 'weekly');
  check(!('rrule' in persisted) && !('exdates' in persisted), 'cleared rule does not linger in the persisted local file');
  // ④ 云侧改规则：master 换 RRULE 重写资源，同资源 override 兄弟实例保留
  const master = { ...item('cloud-series'), start: first, end: first + 3600000, rrule: { freq: 'WEEKLY', interval: 1, byDay: ['WE'] } };
  const override = { ...item('cloud-series', '单场改期'), recurrenceId: first + 14 * 86400000, start: first + 15 * 86400000, end: first + 15 * 86400000 + 3600000 };
  f.add('a@test', [master, override], 'cloud-series');
  await f.mod.syncCloudCal();
  const current = f.mod.getCloudEvents().find(e => e.uid === 'cloud-series' && e.recurrenceId === undefined);
  await f.mod.putCloudEvent({ ...current, rrule: { freq: 'DAILY', interval: 1 } });
  const href = [...f.store('a@test').keys()].find(h => h.includes('cloud-series'));
  const reparsed = ics.parseIcs(f.store('a@test').get(href).body);
  eq(reparsed.filter(e => e.recurrenceId === undefined)[0].rrule.freq, 'DAILY', 'cloud master adopts the rebuilt rule');
  check(reparsed.some(e => e.recurrenceId !== undefined), 'sibling override survives a master rule rewrite');
}
console.log(`cloud calendar: ${checks} offline integration checks passed`);
