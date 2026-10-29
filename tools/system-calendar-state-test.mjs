/** Actual systemCal state module + actual ICS codec; all native and network I/O isolated. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import "./ts-resolve-register.mjs";
const i18n = await import("../apps/desktop/src/i18n/index.ts");
import * as caldav from "../packages/core/src/caldav/ics.ts";
import { parseLearnTime } from "../packages/core/src/learn/time.ts";

const source = fs.readFileSync(new URL("../apps/desktop/src/state/systemCal.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const epoch = Date.parse("2026-10-20T10:00:00+08:00");
const day = 86400000;
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setImmediate(r));
const event = (uid, source) => ({ uid, summary: uid, start: epoch + day, end: epoch + day + 3600000, onethuSource: source, alarmMinutes: 12 });
function fixture(options = {}) {
  const calls = [], writes = [], snapshots = [], timers = [], subscriptions = {};
  const cache = new Map();
  const state = {
    cloud: [event("manual-cloud")], local: [event("manual-local")],
    semester: { semesterId: "2026-2027-1", firstDay: "2026-09-07", weekCount: 20, nextSemesterList: [] },
    learn: { semester: { id: "2026-2027-1" }, courses: [{ id: "c1", name: "课程甲" }], homework: [
      { id: "h1", courseId: "c1", title: "作业甲", deadline: "2026-10-22 20:00:00", submitted: false },
      { id: "h2", courseId: "c1", title: "已交作业", deadline: "2026-10-22 20:00:00", submitted: true },
    ] },
    ext: { configured: false, state: "idle", errors: {}, items: [] },
    remind: { default: 120, items: {} },
    native: async (_cmd, args) => ({ added: args?.payload?.events?.length ?? 0, removed: 2 }),
    supported: true,
    schedule: async (start) => [{ courseName: "课程甲", date: start, startTime: "08:00", endTime: "09:35" }],
    secondary: async () => [],
    skipped: 0, ignored: new Set(),
    ...options,
  };
  let persisted = options.config ?? { version: 3, enabled: true, stopped: false, lastCount: 9, lastSyncAt: 123, fingerprint: null, lastError: null };
  let readCount = 0;
  const exports = {};
  const register = (key) => (fn) => { subscriptions[key] = fn; return () => {}; };
  const imports = {
    "../i18n/index.js": i18n,
    react: { useState: (init) => [init(), (s) => snapshots.push(s)], useEffect: (fn) => fn() },
    "@onethu/core": { caldav, parseLearnTime },
    "../lib/clients.js": { fileRead: async (_name, opts) => { assert.equal(opts?.strict, true); readCount++; if (state.readGate) await state.readGate.promise; if (state.readError) throw state.readError; return persisted ? JSON.stringify(persisted) : null; }, fileWrite: async (_f, v, opts) => { assert.equal(opts?.strict, true); if (state.writeError) throw state.writeError; persisted = JSON.parse(v); writes.push(persisted); }, info: { getSchedule: (...args) => state.schedule(...args) }, http: {}, logLine: async () => {} },
    "./cloudCal.js": { getCloudEvents: () => state.cloud, getLocalEvents: () => state.local, ensureCloudCalMirrorReady: async () => { if (state.cloudGate) await state.cloudGate.promise; if (state.cloudError) throw state.cloudError; }, onCloudCalChange: register("cloud"), buildSemesterEvents: async (_sem, fetch) => ({ skipped: state.skipped, events: (await fetch()).map((e, i) => ({ uid: `course-${i}`, summary: e.courseName, start: Date.parse(`${e.date}T${e.startTime}:00+08:00`), end: Date.parse(`${e.date}T${e.endTime}:00+08:00`) })) }) },
    "./cache.js": { cacheGet: (key) => cache.has(key) ? { data: cache.get(key) } : null, cacheSet: (key, data) => cache.set(key, data) },
    "./data.js": { getLearnSnapshot: () => state.learn, getCachedCalendar: () => state.semester, logPageError: () => {}, subscribeCampusData: register("campus"), subscribeCalendarData: register("calendar"), subscribeLearnData: register("learn") },
    "../lib/infoLib.js": { getSecondaryEntries: (...args) => state.secondary(...args) },
    "./exthw.js": { ensureExtHwCredsLoaded: async () => { if (state.extGate) await state.extGate.promise; }, getExtHwSnapshot: () => state.ext, subscribeExtHw: register("ext"), toHomework: (h) => h },
    "./hwIgnore.js": { isHwIgnored: (id) => state.ignored.has(id), subscribeIgnoredHw: register("ignore") },
    "./hwRemind.js": { HW_REMIND_DEFAULT: 120, REMIND_MIN: 10, REMIND_MAX: 43200, getHwRemindState: () => state.remind, subscribeHwRemind: register("remind") },
    "@tauri-apps/api/core": { invoke: async (name, args) => { const command = name.split("|")[1]; calls.push({ command, args }); if (command === "supported") return state.supported; if (command === "request_permission") return state.permission !== false; return state.native(command, args); } },
  };
  const context = vm.createContext({ exports, module: { exports }, require: (id) => { assert.ok(id in imports, `Unexpected import ${id}`); return imports[id]; }, Date: class extends Date { static now() { return epoch; } }, setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimeout: (t) => { t.cleared = true; }, setInterval: () => 0, console });
  vm.runInContext(code, context, { filename: "systemCal.fixture.cjs" });
  return { api: exports, state, calls, writes, snapshots, timers, subscriptions, cache, persisted: () => persisted, reads: () => readCount, nativeWrites: () => calls.filter((c) => c.command === "sync") };
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`✓ ${name}`); }

await test("full payload includes courses, unsubmitted homework, manual cloud/local and retains manual reminder", async () => {
  const f = fixture(); await f.api.syncSystemCalendar();
  const events = f.nativeWrites()[0].args.payload.events;
  for (const title of ["课程甲", "manual-cloud", "manual-local"]) assert.ok(events.some((e) => e.title === title));
  assert.ok(events.some((e) => e.title.includes("作业甲")));
  assert.ok(!events.some((e) => e.title.includes("已交作业")));
  assert.equal(events.find((e) => e.title === "manual-cloud").alarmMinutes, 12);
  assert.equal(f.persisted().enabled, true);
});
await test("homework alarm fires at deadline minus lead, not twice the lead", async () => {
  const f = fixture({ remind: { default: 120, items: { h1: 30 } } }); await f.api.syncSystemCalendar();
  const e = f.nativeWrites()[0].args.payload.events.find((e) => e.title.includes("作业甲"));
  assert.equal(e.endMs - e.startMs, 30 * 60000);
  assert.equal(e.alarmMinutes, 0);
  assert.equal(e.startMs - e.alarmMinutes * 60000, e.endMs - 30 * 60000);
});
await test("generated cloud mirrors are not duplicated; external homework participates once ready", async () => {
  const f = fixture({ cloud: [event("old-course", "course"), event("old-exam", "exam"), event("old-hw", "homework"), event("ordinary")], ext: { configured: true, state: "ready", errors: {}, items: [{ id: "ext:1", title: "外部作业", courseId: "ext:tuoj", deadline: "2026-10-23 20:00:00", submitted: false }] } });
  await f.api.syncSystemCalendar(); const events = f.nativeWrites()[0].args.payload.events;
  assert.ok(!events.some((e) => e.title.startsWith("old-")));
  assert.ok(events.some((e) => e.title.includes("外部作业")));
});
for (const [name, patch] of [
  ["missing semester", { semester: null }], ["missing learn", { learn: null }],
  ["historical learn semester", { learn: { semester: { id: "old-sem" }, courses: [], homework: [] } }],
  ["external source loading", { ext: { configured: true, state: "loading", errors: {}, items: [] } }],
  ["external source failed", { ext: { configured: true, state: "ready", errors: { tuoj: "offline" }, items: [] } }],
  ["cloud cache I/O failed", { cloudError: new Error("disk offline") }],
  ["partially parsed semester", { skipped: 1 }],
]) await test(`${name} cannot clear an existing calendar`, async () => { const f = fixture(patch); await assert.rejects(f.api.syncSystemCalendar()); assert.equal(f.nativeWrites().length, 0); });
await test("manual export awaits cloud/local hydration and never invokes a native command", async () => {
  const gate = deferred(), f = fixture({ cloudGate: gate }); let done = false;
  const p = f.api.exportSystemCalendarIcs().then((v) => { done = true; return v; }); await tick(); assert.equal(done, false);
  gate.resolve(); const ics = await p; assert.ok(ics.includes("BEGIN:VALARM")); assert.ok(ics.includes("作业甲")); assert.equal(f.calls.length, 0);
});
await test("config hydration is single-flight; late read cannot undo stop", async () => {
  const gate = deferred(), f = fixture({ readGate: gate }); f.api.useSystemCal(); const disable = f.api.disableSystemCalendar();
  await tick(); assert.equal(f.reads(), 1); assert.equal(f.snapshots.at(-1).ready, false);
  gate.resolve(); await disable; assert.equal(f.persisted().enabled, false); assert.equal(f.persisted().stopped, true); assert.equal(f.snapshots.at(-1).ready, true);
});
await test("sync emits busy and final idle on success and failure", async () => {
  const f = fixture(); f.api.useSystemCal(); await tick(); await f.api.syncSystemCalendar(); assert.ok(f.snapshots.some((s) => s.syncing)); assert.equal(f.snapshots.at(-1).syncing, false);
  f.state.native = async () => { throw new Error("native fixture failure"); }; await assert.rejects(f.api.syncSystemCalendar()); assert.equal(f.snapshots.at(-1).syncing, false); assert.match(f.persisted().lastError, /fixture failure/);
});
await test("unsupported/denied platforms never write", async () => {
  for (const patch of [{ supported: false }, { permission: false }]) { const f = fixture(patch); await assert.rejects(f.api.syncSystemCalendar()); assert.equal(f.nativeWrites().length, 0); }
});
await test("a stop during preparation aborts native mutation and enable intent", async () => {
  const gate = deferred(), f = fixture({ cloudGate: gate }); const run = f.api.enableSystemCalendar(); await tick(); await f.api.disableSystemCalendar(); gate.resolve(); await assert.rejects(run, /停止/); assert.equal(f.nativeWrites().length, 0); assert.equal(f.persisted().enabled, false);
});
await test("stop during native work stays stopped after completion and manual sync", async () => {
  const gate = deferred(), f = fixture({ native: async () => gate.promise }); const run = f.api.enableSystemCalendar(); await tick(); assert.equal(f.nativeWrites().length, 1); await f.api.disableSystemCalendar(); gate.resolve({ added: 1, removed: 1 }); await run; assert.equal(f.persisted().enabled, false); assert.equal(f.persisted().stopped, true);
  f.state.native = async () => ({ added: 1, removed: 1 }); await f.api.syncSystemCalendar(); assert.equal(f.persisted().enabled, false);
});
await test("remove waits for active native write, rejects overlapping write, then clears once", async () => {
  const gate = deferred(), trace = [], f = fixture({ native: async (cmd) => { trace.push(cmd); return cmd === "sync" ? gate.promise : {}; } });
  const sync = f.api.syncSystemCalendar(); await tick(); const remove = f.api.removeSystemCalendar(); await tick(); assert.deepEqual(trace, ["sync"]);
  await assert.rejects(f.api.syncSystemCalendar(), /同步或移除/);
  gate.resolve({ added: 1, removed: 1 }); await Promise.all([sync, remove]); assert.deepEqual(trace, ["sync", "remove_calendar"]); assert.equal(f.persisted().lastCount, 0); assert.equal(f.persisted().enabled, false);
});
await test("no partial week cache fallback; secondary failure also preserves previous calendar", async () => {
  for (const key of ["schedule", "secondary"]) { const f = fixture({ [key]: async () => { throw new Error("offline"); } }); f.cache.set("schedsem:2026-2027-1", [{ courseName: "legacy partial" }]); await assert.rejects(f.api.syncSystemCalendar()); assert.equal(f.nativeWrites().length, 0); }
});
await test("legacy v3/v4 caches with missing secondary courses stay outside complete-cache fallback", async () => {
  for (const version of [3, 4]) {
    const f = fixture({ secondary: async () => { throw new Error("secondary page unavailable"); } });
    f.cache.set(`syscal-sem-v${version}:2026-2027-1`, {
      firstDay: f.state.semester.firstDay, weekCount: f.state.semester.weekCount,
      entries: [{ courseName: "legacy primary-only", date: "2026-10-20", startTime: "08:00", endTime: "09:35" }],
    });
    await assert.rejects(f.api.syncSystemCalendar(), /secondary page unavailable/);
    assert.equal(f.nativeWrites().length, 0);
  }
});
await test("complete same-semester cache including an empty semester is valid fallback", async () => {
  const f = fixture(); await f.api.syncSystemCalendar(); const count = f.nativeWrites()[0].args.payload.events.length; f.state.schedule = async () => { throw new Error("offline"); }; await f.api.syncSystemCalendar(); assert.equal(f.nativeWrites()[1].args.payload.events.length, count);
  f.state.semester.weekCount++; await assert.rejects(f.api.syncSystemCalendar(), /offline/); assert.equal(f.nativeWrites().length, 2);
  const empty = fixture({ schedule: async () => [] }); await empty.api.syncSystemCalendar(); empty.state.schedule = async () => { throw new Error("offline"); }; await empty.api.syncSystemCalendar(); assert.equal(empty.nativeWrites().length, 2);
});
await test("fingerprint ignores wall-clock but distinguishes absent vs zero reminder and location edits", async () => {
  const f = fixture(); await f.api.syncSystemCalendar(); const p = f.nativeWrites()[0].args.payload; const hash = f.api.fingerprintOf(p);
  assert.equal(f.api.fingerprintOf({ ...p, windowStartMs: 1, windowEndMs: 2 }), hash);
  const base = { ...p, events: [{ ...p.events[0], alarmMinutes: undefined }] }; const zero = { ...base, events: [{ ...base.events[0], alarmMinutes: 0 }] }; assert.notEqual(f.api.fingerprintOf(base), f.api.fingerprintOf(zero));
  await f.api.syncSystemCalendar({ silent: true }); assert.equal(f.nativeWrites().length, 1);
  f.state.local[0].location = "新地点"; await f.api.syncSystemCalendar({ silent: true }); assert.equal(f.nativeWrites().length, 2);
});
await test("source change during active native work schedules one follow-up instead of being lost", async () => {
  const gate = deferred(), f = fixture({ native: async () => gate.promise }); f.api.initSystemCalAutoSync(); await tick(); const sync = f.api.syncSystemCalendar(); await tick(); f.subscriptions.cloud(); f.subscriptions.learn(); gate.resolve({ added: 1, removed: 1 }); await sync;
  assert.equal(f.timers.filter((t) => t.ms === 5000 && !t.cleared).length, 1);
});
await test("three-mode independence: state has no mode branch or destructive mode persistence", async () => {
  assert.ok(!source.includes("experienceMode")); const f = fixture(); await f.api.disableSystemCalendar(); assert.equal(f.persisted().stopped, true); await f.api.enableSystemCalendar(); assert.equal(f.persisted().enabled, true);
});
await test("ignored/audited/submitted homework and repeated IDs never create duplicate reminders", async () => {
  const f = fixture(); const hw = f.state.learn.homework[0];
  f.state.learn.homework = [hw, { ...hw }, { ...hw, id: "ignored", title: "忽略项" }, { ...hw, id: "audit", title: "旁听项", audited: true }];
  f.state.ignored.add("ignored"); await f.api.syncSystemCalendar();
  assert.equal(f.nativeWrites()[0].args.payload.events.filter((e) => e.title.includes("作业截止")).length, 1);
  f.api.initSystemCalAutoSync(); await tick(); f.state.ignored.add("h1"); f.subscriptions.ignore();
  await f.timers.findLast((t) => t.ms === 5000).fn(); await tick();
  assert.equal(f.nativeWrites()[1].args.payload.events.filter((e) => e.title.includes("作业截止")).length, 0);
});
await test("zero/negative/NaN/oversized reminder values cannot produce invalid native ranges", async () => {
  for (const [value, expected] of [[0, 10], [-1, 10], [NaN, 120], [Infinity, 120], [999999, 43200]]) {
    const f = fixture({ remind: { default: value, items: {} } }); await f.api.syncSystemCalendar();
    const e = f.nativeWrites()[0].args.payload.events.find((e) => e.title.includes("作业截止")); assert.equal((e.endMs - e.startMs) / 60000, expected);
  }
});
await test("config read failure never replaces persisted settings with empty defaults; retry remains possible", async () => {
  const f = fixture({ readError: new Error("disk unavailable") }); f.api.initSystemCalAutoSync(); await tick();
  await assert.rejects(f.api.syncSystemCalendar(), /disk unavailable/); assert.equal(f.writes.length, 0); assert.equal(f.nativeWrites().length, 0);
  f.state.readError = null; await f.api.syncSystemCalendar(); assert.equal(f.persisted().enabled, true);
  assert.equal(typeof f.subscriptions.cloud, "function");
});
await test("native success followed by config disk failure is reported as failure, never stuck busy", async () => {
  const f = fixture({ writeError: new Error("disk full") }); f.api.useSystemCal(); await tick();
  await assert.rejects(f.api.syncSystemCalendar(), /disk full/); assert.equal(f.nativeWrites().length, 1); assert.equal(f.snapshots.at(-1).syncing, false);
  f.state.writeError = null; await f.api.syncSystemCalendar(); assert.equal(f.nativeWrites().length, 2);
});
await test("long reminder lead remains inside the declared native window", async () => {
  const f = fixture({ remind: { default: 43200, items: {} } });
  f.state.learn.homework[0].deadline = new Date(epoch - 89 * day).toISOString(); await f.api.syncSystemCalendar();
  const p = f.nativeWrites()[0].args.payload; const hw = p.events.find((e) => e.title.includes("作业截止"));
  assert.ok(hw.startMs >= p.windowStartMs); assert.ok(hw.endMs <= p.windowEndMs);
});
await test("recurring manual events expand into flat instances inside the rolling window", async () => {
  // 编辑器创作侧（每周三、永不截止）经 systemCal 的既定路径：18 个月滚动窗口内平铺展开，
  // 不写原生 RRULE（ADR-0001）；实例数以真实窗口边界自洽计算。
  const first = Date.parse("2026-10-21T08:00:00+08:00"); // 周三
  const weekly = { uid: "weekly-flat", summary: "weekly-flat", start: first, end: first + 3600000, onethuSource: "manual", rrule: { freq: "WEEKLY", interval: 1, byDay: ["WE"] } };
  const f = fixture({ local: [event("manual-local"), weekly] }); await f.api.syncSystemCalendar();
  const p = f.nativeWrites()[0].args.payload;
  const flat = p.events.filter((e) => e.title === "weekly-flat");
  let expected = 0; for (let t = first; t <= p.windowEndMs; t += 7 * day) expected++;
  assert.equal(flat.length, expected, "flat instance count matches the actual window bound");
  assert.ok(flat.length > 70 && flat.length < 90, `instance count sane (${flat.length})`);
  assert.ok(flat.every((e) => e.startMs <= p.windowEndMs && e.endMs >= p.windowStartMs), "every instance inside the window");
  assert.ok(p.events.length < 4000, "MAX_EVENTS headroom holds with an endless series");
});
console.log(`\n${passed} system calendar tests passed; native/network writes were mocked.`);
