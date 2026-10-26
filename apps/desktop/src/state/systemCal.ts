import { t as i18n } from "../i18n/index.js";
/**
 * 系统日历原生同步状态层（learnX 模型）。
 *
 * 平台：Android（CalendarProvider 插件）/ macOS（EventKit 插件）；其他平台
 * systemCalSupported() = false（前端退 .ics 导出）。
 *
 * 模型：
 * - 专属日历「OneTHU 日程」（按原生持久化标识绑定；macOS 账户可能自行云同步）；
 * - 幂等：窗口内清旧重写（窗口 = 过去 90 天 ~ 未来 18 个月 ∪ 学期范围）；
 * - **只在日程内容变化时同步**：触发一律是"来源内容变了"的事件——云/本日程（云同步扫出
 *   added/updated/removed≠0、本地增删改）、学堂作业 DDL/提交状态、课表（校历窗口）、
 *   学期/校历、外部作业（按进日历字段去重）、提醒档位。各来源的"装载但内容没变"不发广播
 *   （data.ts/exthw.ts/cloudCal.ts 侧按内容签名去重）。防抖 5s → 重建载荷并比对
 *   **内容指纹**（时间不进指纹，见 fingerprintOf）；内容没变则整轮跳过，原生一次都不进。
 *   指纹是最后一道防线：万一某个事件漏了，下次触发会自动补写，不会静默偏旧。
 * - 另有两处**定期重建**兜底（启动一次 + 每 30 分钟一轮）：它们只重建应用内载荷，内容与
 *   上次写入完全相同就一次原生都不进。服务端（教务课表等）的改动没有推送，只能靠拉取比对
 *   发现——定期轮就是为此保留的。重建前有"数据齐备门槛"（学堂快照未装载则不重建，
 *   免得算出少了作业 DDL 块的半量载荷）；
 * - 课表/考试带提前 15 分钟提醒，手动日程保留已有提醒。
 *
 * 存储：syscal.cfg { enabled, lastSyncAt, lastCount, lastError, fingerprint, failStreak }。
 */
import { useEffect, useState } from "react";
import { caldav } from "@onethu/core";
import type { CalendarSemester } from "@onethu/core";
import { fileRead, fileWrite, info } from "../lib/clients.js";
import { getCloudEvents, getLocalEvents, buildSemesterEvents, onCloudCalChange, ensureCloudCalMirrorReady } from "./cloudCal.js";
import { parseLearnTime } from "@onethu/core";
import type { ScheduleEntry } from "@onethu/core";
import { cacheGet, cacheSet } from "./cache.js";
import { getLearnSnapshot, logPageError, subscribeCampusData, subscribeCalendarData, subscribeLearnData } from "./data.js";
import { getSecondaryEntries } from "../lib/infoLib.js";
import { http as appHttp, logLine } from "../lib/clients.js";
import { getExtHwSnapshot, subscribeExtHw, toHomework, ensureExtHwCredsLoaded } from "./exthw.js";
import { getHwRemindState, subscribeHwRemind, HW_REMIND_DEFAULT, REMIND_MIN, REMIND_MAX, type HwRemindState } from "./hwRemind.js";
import { getCachedCalendar } from "./data.js";
import { isHwIgnored, subscribeIgnoredHw } from "./hwIgnore.js";

const CFG_FILE = "syscal.cfg";
/** 与 Rust/Kotlin 侧 CALENDAR_TITLE 保持一致 */
export const CALENDAR_TITLE = "OneTHU 日程";

const DAY = 86_400_000;
/** 同步窗口：过去 90 天（滚动） */
const PAST_WINDOW = 90 * DAY;
/** 同步窗口：未来 18 个月（滚动，RRULE 展开上限） */
const FUTURE_WINDOW = 550 * DAY;
/** 事件数上限（课表 ~600 + 手动日程；超出直接中止，防止事故性大批量写入） */
const MAX_EVENTS = 4000;
/** 课表/考试提醒（learnX 同款 -15 分钟） */
const ALARM_MINUTES = 15;
/** 定期重建间隔（**只重建应用内载荷**；内容与上次写入完全相同则连原生都不进）。
 *  服务端（教务课表等）的改动没有推送，只能靠拉取比对发现；30 分钟与 learn 的后台
 *  静默刷新同频——原来"顺手发现课表变了"靠的就是它。 */
const RECONCILE_INTERVAL = 30 * 60 * 1000;

/* ---------- 载荷类型（与插件 camelCase 对齐） ---------- */

interface SysCalEventArg {
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location?: string;
  notes?: string;
  alarmMinutes?: number;
}

interface SyncPayloadArg {
  calendarTitle: string;
  windowStartMs: number;
  windowEndMs: number;
  events: SysCalEventArg[];
}

interface SysCalCfg {
  enabled: boolean;
  /** 用户明确点过「停止自动同步」（手动同步成功后不再自动重新开启） */
  stopped: boolean;
  lastSyncAt: number;
  lastCount: number;
  lastError: string | null;
  fingerprint: string | null;
  /** 连续同步失败次数（成功清零）。达 FAIL_PAUSE 暂停自动跟随，防"崩→指纹未存→再试"死循环。 */
  failStreak: number;
}

/** 自动跟随熔断阈值：连续失败到此次数后暂停自动同步（手动同步不受限，成功即恢复）。 */
const FAIL_PAUSE = 3;

/** v3：所有权绑定、完整源屏障、作业事件开始时提醒。旧指纹作废。 */
const CFG_VERSION = 3;

/* ---------- 模块状态 ---------- */

let loaded = false;
let loadPromise: Promise<void> | null = null;
let cfgWrites: Promise<void> = Promise.resolve();
let policyRevision = 0;
let removePending = false;
let activeSync: Promise<SystemCalSyncOutcome> | null = null;
let changedWhileSyncing = false;
let cfg: SysCalCfg = { enabled: false, stopped: false, lastSyncAt: 0, lastCount: 0, lastError: null, fingerprint: null, failStreak: 0 };
let supportedCache: boolean | null = null;
let syncing = false;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((fn) => fn());

async function persistCfg(): Promise<void> {
  const content = JSON.stringify({ version: CFG_VERSION, ...cfg });
  const write = cfgWrites.catch(() => undefined).then(() => fileWrite(CFG_FILE, content, { strict: true }));
  cfgWrites = write;
  await write;
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const raw = await fileRead(CFG_FILE, { strict: true });
    if (raw) {
      const j = JSON.parse(raw) as Partial<SysCalCfg> & { version?: number };
      if (typeof j.enabled !== "boolean") throw new Error(i18n("state.systemcal.1af23354d905"));
      const legacy = j.version !== CFG_VERSION;
      cfg = {
        enabled: j.enabled,
        stopped: j.stopped === true,
        lastSyncAt: typeof j.lastSyncAt === "number" ? j.lastSyncAt : 0,
        lastCount: typeof j.lastCount === "number" ? j.lastCount : 0,
        lastError: typeof j.lastError === "string" ? j.lastError : null,
        fingerprint: legacy ? null : typeof j.fingerprint === "string" ? j.fingerprint : null,
        failStreak: typeof j.failStreak === "number" ? j.failStreak : 0,
      };
    }
    loaded = true;
    emit();
  })().catch((err) => {
    cfg = { ...cfg, lastError: err instanceof Error ? err.message : String(err) };
    emit();
    throw err;
  }).finally(() => { loadPromise = null; });
  return loadPromise;
}

/* ---------- 插件桥 ---------- */

async function invokePlugin<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<T>(`plugin:onethu-calendar|${cmd}`, args);
}

/** 当前平台是否支持原生系统日历读写（非 Tauri 环境也返回 false） */
export async function systemCalSupported(): Promise<boolean> {
  if (supportedCache === null) {
    try {
      supportedCache = await invokePlugin<boolean>("supported");
    } catch {
      supportedCache = false;
    }
  }
  return supportedCache;
}

/* ---------- 载荷构建 ---------- */

function parseYmd(s: string): Date {
  return new Date(s.replace(/-/g, "/"));
}

/** 今天落在哪个学期（假期则回落当前学期）；校历未加载返回 null */
function currentSemester(): CalendarSemester | null {
  const cal = getCachedCalendar();
  if (!cal) return null;
  const list: CalendarSemester[] = [{ ...cal }, ...cal.nextSemesterList];
  const now = Date.now();
  for (const s of list) {
    const start = parseYmd(s.firstDay).getTime();
    if (now >= start && now < start + s.weekCount * 7 * DAY) return s;
  }
  return cal;
}

/** 学期全量课表（learnX 式范围同步，2026-09-13 用户拍板「自动同步这学期全部」）：
 *  ≤45 天分片拉取合并去重（整学期一次大查询会撞服务端处理超时——考试接口
 *  同款教训），成功即落 schedsem:<semesterId> 持久缓存（全量镜像）；任何失
 *  败只退同学期、同起点与周数的完整缓存；周窗碎屑不能覆盖整个镜像。 */
async function fetchSemesterSchedule(sem: CalendarSemester): Promise<ScheduleEntry[]> {
  // v5：二级页面与中英文周次均须通过校验，旧的缺课结果留在原协议缓存。
  const key = `syscal-sem-v5:${sem.semesterId}`;
  const d0 = parseYmd(sem.firstDay).getTime();
  const d1 = d0 + (sem.weekCount * 7 - 1) * DAY;
  const ymd = (t: number): string => {
    const d = new Date(t);
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const sig = (e: ScheduleEntry): string =>
    `${e.courseName}|${e.date ?? ""}|${e.dayOfWeek ?? ""}|${e.startSection ?? ""}|${e.endSection ?? ""}|${e.location ?? ""}|${e.startTime ?? ""}|${e.endTime ?? ""}`;
  try {
    const merged: ScheduleEntry[] = [];
    const seen = new Set<string>();
    for (let cur = d0; cur <= d1; cur += 44 * DAY) {
      const rows = await info.getSchedule(ymd(cur), ymd(Math.min(cur + 44 * DAY, d1)));
      for (const e of rows) {
        const k2 = sig(e);
        if (seen.has(k2)) continue;
        seen.add(k2);
        merged.push(e);
      }
    }
    // 二级课表（自定义时段实验课等）并入：core InfoClient 的 JSONP 只含一级——
    // 马原跨节两段实录（2026-09-19）：一级只给第三大节，第四大节的小段在二级
    // 课表，不并入则系统日历丢段（日程页 grab 链有并所以页内正常）。与日程页
    // 同款去重：同名同日同时刻视为同一节。二级失败同样中止半量覆盖。
    {
      const sec = await getSecondaryEntries(appHttp, sem.firstDay, ymd(d0), ymd(d1));
      void logLine(`[SYSCAL] 二级并入 ${sec.length} 门: ${sec.map((c) => c.name).join(" / ").slice(0, 300)}`).catch(() => undefined);
      for (const c of sec) {
        if (merged.some((r) => r.courseName === c.name && r.date === c.date && r.startTime === c.startTime)) continue;
        merged.push({
          courseName: c.name, location: c.location, date: c.date, dayOfWeek: c.dayOfWeek,
          startTime: c.startTime, endTime: c.endTime, category: "二级课表", raw: { source: "secondary" },
        });
      }
    }
    cacheSet(key, { firstDay: sem.firstDay, weekCount: sem.weekCount, entries: merged }, true);
    return merged;
  } catch (err) {
    const hit = cacheGet<{ firstDay: string; weekCount: number; entries: ScheduleEntry[] }>(key);
    if (hit?.data.firstDay === sem.firstDay && hit.data.weekCount === sem.weekCount && Array.isArray(hit.data.entries)) {
      logPageError("SYSCAL-SWR", new Error(i18n("state.systemcal.89e7b1c563d7", { length: String(hit.data.entries.length) })));
      return hit.data.entries;
    }
    logPageError("SYSCAL-SWR", new Error(i18n("state.systemcal.8b3f14077824")));
    throw err;
  }
}

async function buildPayload(): Promise<SyncPayloadArg> {
  await ensureCloudCalMirrorReady();
  await ensureExtHwCredsLoaded();
  const sem = currentSemester();
  const learnSnap = getLearnSnapshot();
  const ext = getExtHwSnapshot();
  if (!sem) throw new Error(i18n("state.systemcal.ae887c4815af"));
  if (!Number.isFinite(parseYmd(sem.firstDay).getTime()) || !Number.isInteger(sem.weekCount) || sem.weekCount < 1 || sem.weekCount > 60) {
    throw new Error(i18n("state.systemcal.30fb8d6869b0"));
  }
  if (!learnSnap || learnSnap.semester.id !== sem.semesterId) {
    throw new Error(i18n("state.systemcal.3d8856ab74b0"));
  }
  if (ext.configured && (ext.state !== "ready" || Object.keys(ext.errors).length > 0)) {
    throw new Error(i18n("state.systemcal.ab1abc96899c"));
  }
  const now = Date.now();
  // 已导出的课程/考试/作业由下方实时源构建，不能从云镜像再导入一份。
  const generated = new Set(["course", "exam", "homework"]);
  const all = [...getCloudEvents(), ...getLocalEvents()].filter((e) => !generated.has(e.onethuSource ?? ""));

  // 窗口：滚动窗口 ∪ 学期范围 ∪ 单场事件极值（RRULE 展开上限 = 滚动上限）
  let windowStart = now - PAST_WINDOW;
  let windowEnd = now + FUTURE_WINDOW;
  if (sem) {
    windowStart = Math.min(windowStart, parseYmd(sem.firstDay).getTime());
    windowEnd = Math.max(windowEnd, parseYmd(sem.firstDay).getTime() + (sem.weekCount * 7 - 1) * DAY);
  }
  for (const e of all) {
    windowStart = Math.min(windowStart, e.start - DAY);
    windowEnd = Math.max(windowEnd, e.end + DAY);
  }

  // 云/本日程展开为单场（覆盖实例自动接管；提醒不带）
  const events: SysCalEventArg[] = [];
  for (const occ of caldav.expandEventSet(all, windowStart, windowEnd)) {
    events.push({
      title: occ.summary,
      startMs: occ.start,
      endMs: occ.end,
      allDay: !!occ.allDay,
      location: occ.location,
      notes: occ.description,
      alarmMinutes: occ.alarmMinutes,
    });
  }

  // 完整学期镜像；无日期/非法时段不能静默丢掉后再清旧。
  if (sem) {
    const semRows = await fetchSemesterSchedule(sem);
    const { events: courseEvents, skipped } = await buildSemesterEvents(sem, async () => semRows);
    if (skipped > 0) throw new Error(i18n("state.systemcal.ff52516e4a39", { skipped: String(skipped) }));
    for (const ev of courseEvents) {
      events.push({
        title: ev.summary,
        startMs: ev.start,
        endMs: ev.end,
        allDay: !!ev.allDay,
        location: ev.location,
        notes: ev.description,
        alarmMinutes: ALARM_MINUTES,
      });
    }
  }

  // 作业 DDL（learnX 模式）：learn 快照 + exthw 外部源统一 Homework（2026-09-19
  // 用户拍板：作业像课表一样不上云——系统日历的作业事件由同步时实时聚合）。
  // 所有来源均已通过完整性检查；未配置的外部源不复用旧内存残留。
  const extHw = ext.configured ? ext.items.map(toHomework) : [];
  const hwEvents = buildHwEvents(
    learnSnap ? { courses: learnSnap.courses, homework: [...learnSnap.homework, ...extHw] } : { courses: [], homework: extHw },
    getHwRemindState(),
    windowStart,
    windowEnd,
  );
  events.push(...hwEvents);
  const remind = getHwRemindState();
  const alarms = [...new Set(hwEvents.map((e) => e.alarmMinutes))].join("/");
  void logLine(
    `[SYSCAL] hw-learn=${learnSnap?.homework?.length ?? "null"} hw-ext=${extHw.length} hw-events=${hwEvents.length} course-events=${events.length - hwEvents.length} alarm(default=${remind.default} 覆盖=${Object.keys(remind.items).length}项 值=${alarms})`,
  ).catch(() => undefined);

  for (const event of events) {
    if (!Number.isFinite(event.startMs) || !Number.isFinite(event.endMs) || event.endMs <= event.startMs) {
      throw new Error(i18n("state.systemcal.746a9d1e0b2c"));
    }
    // A long homework lead can begin before the rolling DDL window. Include its
    // actual block, so native validation and later deletion use the same bounds.
    windowStart = Math.min(windowStart, event.startMs);
    windowEnd = Math.max(windowEnd, event.endMs);
  }
  events.sort((a, b) => a.startMs - b.startMs);
  if (events.length > MAX_EVENTS) throw new Error(i18n("state.systemcal.ce42fc5eaca8", { length: String(events.length), MAX_EVENTS: String(MAX_EVENTS) }));
  return { calendarTitle: CALENDAR_TITLE, windowStartMs: windowStart, windowEndMs: windowEnd, events };
}

/** 作业 DDL → 系统日历事件：未交、未忽略、非旁听才生成；提前量 = 单作业覆盖 ?? 全局默认
 *  （用户拍板：先设所有作业共用的节点，想单独改再改；改完全局/覆盖都会触发重推）。 */
export function buildHwEvents(
  snap: { courses?: Array<{ id: string; name: string }>; homework?: Array<{ id: string; courseId: string; title: string; deadline: string; submitted: boolean; audited?: boolean }> } | null,
  hwRemind: HwRemindState,
  windowStart: number,
  windowEnd: number,
): SysCalEventArg[] {
  if (!snap) return [];
  const courseName = new Map((snap.courses ?? []).map((c) => [c.id, c.name]));
  const out: SysCalEventArg[] = [];
  const seen = new Set<string>();
  for (const h of snap.homework ?? []) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    if (h.submitted || h.audited || isHwIgnored(h.id)) continue; // 已交：不占日历（写完即清）
    const dl = parseLearnTime(h.deadline)?.getTime();
    if (!dl || dl < windowStart || dl > windowEnd) continue;
    // 事件块从「提前量」起步到 DDL（对齐日程页橙色块语义）：事件开始时响铃，
    // 原生 alarm=0 才是相对该开始时间提醒；不能再次提前 N 分钟。
    const configuredLead = hwRemind.items[h.id] ?? hwRemind.default;
    const lead = Number.isFinite(configuredLead)
      ? Math.max(REMIND_MIN, Math.min(REMIND_MAX, Math.round(configuredLead))) : HW_REMIND_DEFAULT;
    out.push({
      title: `作业截止 · ${(h as { courseName?: string }).courseName || courseName.get(h.courseId) || ""} ${h.title}`.trim(),
      startMs: dl - lead * 60_000,
      endMs: dl,
      allDay: false,
      notes: `DDL ${h.deadline}（本块自截止前 ${lead >= 60 ? `${Math.floor(lead / 60)}小时${lead % 60 ? `${lead % 60}分` : ""}` : `${lead}分钟`} 开始）。提交完成后自动从日历移除。`,
      alarmMinutes: 0, // 原生提醒相对事件开始；开始已提前 lead，不能再次提前。
    });
  }
  return out;
}

/** 载荷指纹（内容无变化则跳过原生写入）。
 *
 *  **只喂内容，绝不掺时间**：窗口是 Date.now() 派生的（now-90d / now+550d），一旦入指纹
 *  则每次调用都不同，「未变则跳过」的守卫等于失效——每次启动、每次数据回调都全量重写
 *  一遍系统日历。真机实录（2026-10-11）：三分钟内连开三次、内容同为 172 条，指纹三次
 *  全不同、lastSyncAt 三次都被推后 = 三次全量重写。
 *
 *  行内先排序：同一批事件经云/本/课表/作业多路构造，并列时刻的相对次序不保证稳定，
 *  排序后指纹只认「事件集合」，重建一次不会因为顺序抖动而误判成内容变了。
 *
 *  location / notes / allDay 一并入指纹（原版只看 title@起止!闹钟）：换教室、改备注同样是
 *  内容变化，必须重写系统日历。 */
export function fingerprintOf(p: SyncPayloadArg): string {
  let h = 5381;
  const lines = p.events
    .map(
      (e) =>
        JSON.stringify([e.title, e.startMs, e.endMs, e.alarmMinutes ?? null, e.allDay, e.location ?? "", e.notes ?? ""]),
    )
    .sort();
  const feed = `${p.calendarTitle}|${lines.join(",")}`;
  for (let i = 0; i < feed.length; i++) h = ((h << 5) + h + feed.charCodeAt(i)) >>> 0;
  return `${p.events.length}-${h.toString(36)}`;
}

/* ---------- 同步动作 ---------- */

export interface SystemCalSyncOutcome {
  added: number;
  removed: number;
  /** 指纹未变跳过了原生写入 */
  skipped: boolean;
}

/** 只读导出，与原生同步使用同一份完整载荷；不申请日历权限。 */
export async function exportSystemCalendarIcs(): Promise<string> {
  const payload = await buildPayload();
  return caldav.serializeCalendar(payload.events.map((e, index) => ({
    uid: `onethu-system-${e.startMs}-${index}@onethu`,
    summary: e.title, start: e.startMs, end: e.endMs, allDay: e.allDay,
    location: e.location, description: e.notes, alarmMinutes: e.alarmMinutes,
  })));
}

function runSync(opts?: { silent?: boolean; enable?: boolean }): Promise<SystemCalSyncOutcome> {
  if (syncing || removePending) return Promise.reject(new Error(i18n("state.systemcal.b170ef2db7ca")));
  syncing = true;
  const revision = policyRevision;
  emit();
  const run = (async (): Promise<SystemCalSyncOutcome> => {
    try {
      await ensureLoaded();
      if (!(await systemCalSupported())) throw new Error(i18n("state.systemcal.854aca2c0e1f"));
      const payload = await buildPayload();
      if (revision !== policyRevision || removePending) throw new Error(i18n("state.systemcal.fe90aa1936ae"));
      const fingerprint = fingerprintOf(payload);
      if (opts?.silent && cfg.fingerprint === fingerprint) {
        cfg = { ...cfg, lastError: null, failStreak: 0 };
        await persistCfg();
        return { added: 0, removed: 0, skipped: true };
      }
      const granted = await invokePlugin<boolean>("request_permission");
      if (!granted) throw new Error(i18n("state.systemcal.d2d00f793981"));
      if (revision !== policyRevision || removePending) throw new Error(i18n("state.systemcal.fe90aa1936ae"));
      // 原生段取证：正式包里 log_debug 落 onethu-debug.log 并镜像 logcat（tag=onethu），
      // 崩溃死在原生时"最后一行 = 同步开始"即是死区证据
      void logLine(`[SYSCAL] 原生同步开始 events=${payload.events.length} fp=${fingerprint}`).catch(() => undefined);
      const t0 = Date.now();
      const r = await invokePlugin<{ added: number; removed: number; warning?: string }>("sync", { payload });
      cfg = {
        ...cfg,
        enabled: revision === policyRevision && !removePending ? (opts?.enable || !cfg.stopped ? true : cfg.enabled) : cfg.enabled,
        stopped: opts?.enable && revision === policyRevision && !removePending ? false : cfg.stopped,
        lastSyncAt: Date.now(), lastCount: payload.events.length,
        lastError: r.warning ?? null, fingerprint,
        failStreak: 0,
      };
      await persistCfg();
      autoPausedLogged = false;
      void logLine(`[SYSCAL] 原生同步完成 +${r.added}/-${r.removed} ${Date.now() - t0}ms`).catch(() => undefined);
      return { added: r.added, removed: r.removed, skipped: false };
    } catch (err) {
      const streak = (cfg.failStreak ?? 0) + 1;
      const raw = err instanceof Error ? err.message : String(err);
      cfg = {
        ...cfg,
        lastError: streak >= FAIL_PAUSE && streak - 1 < FAIL_PAUSE
          ? `${i18n("state.systemcal.0a936b980101", { length: String(streak) })} · ${raw}`
          : raw,
        failStreak: streak,
      };
      if (loaded) await persistCfg().catch(() => undefined);
      void logLine(`[SYSCAL] 原生同步失败 streak=${streak}: ${raw.slice(0, 160)}`).catch(() => undefined);
      throw err;
    } finally {
      syncing = false;
      activeSync = null;
      emit();
      if (changedWhileSyncing) {
        changedWhileSyncing = false;
        if (cfg.enabled && !removePending) scheduleAutoPush();
      }
    }
  })();
  activeSync = run;
  return run;
}

/** 幂等同步；手动写入不会复活用户明确停止的自动跟随。 */
export function syncSystemCalendar(opts?: { silent?: boolean }): Promise<SystemCalSyncOutcome> {
  return runSync(opts);
}

/** 明确开启：完整同步成功后才开启自动跟随。 */
export async function enableSystemCalendar(): Promise<void> {
  await runSync({ enable: true });
}

/** 保留已写入事件；正在执行的原生事务完成后也不能重新开启。 */
export async function disableSystemCalendar(): Promise<void> {
  policyRevision++;
  await ensureLoaded();
  cfg = { ...cfg, enabled: false, stopped: true };
  if (autoTimer !== null) { clearTimeout(autoTimer); autoTimer = null; }
  await persistCfg();
  emit();
}

/** 等待正在执行的原生事务结束，再只删除本机绑定日历，避免删后被在途同步重建。 */
export async function removeSystemCalendar(): Promise<void> {
  if (removePending) throw new Error(i18n("state.systemcal.fb7404386af9"));
  removePending = true;
  policyRevision++;
  try {
    await ensureLoaded();
    cfg = { ...cfg, enabled: false, stopped: true };
    await persistCfg();
    if (activeSync) await activeSync.catch(() => undefined);
    syncing = true;
    emit();
    if (!(await systemCalSupported())) throw new Error(i18n("state.systemcal.5a93b270a6f9"));
    await invokePlugin<unknown>("remove_calendar");
    cfg = { ...cfg, enabled: false, stopped: true, lastSyncAt: 0, lastCount: 0, lastError: null, fingerprint: null };
    await persistCfg();
  } catch (err) {
    cfg = { ...cfg, lastError: err instanceof Error ? err.message : String(err) };
    if (loaded) await persistCfg().catch(() => undefined);
    throw err;
  } finally {
    removePending = false;
    syncing = false;
    emit();
  }
}

/* ---------- 自动跟随 ---------- */

let autoTimer: ReturnType<typeof setTimeout> | null = null;
/** 熔断提示只记一次的闸（手动同步成功后复位，见 runSync 成功路径） */
let autoPausedLogged = false;

async function autoPush(): Promise<void> {
  if (!cfg.enabled || removePending) return;
  if (cfg.failStreak >= FAIL_PAUSE) {
    // 熔断：连续失败说明原生侧有系统性问题（如鸿蒙兼容层 provider 崩溃），继续自动重试
    // 只会每轮启动都撞一次。手动同步不受限，成功即清零恢复。
    if (!autoPausedLogged) {
      autoPausedLogged = true;
      void logLine(`[SYSCAL] 连续失败 ${cfg.failStreak} 次，自动跟随暂停（手动同步成功后恢复）`).catch(() => undefined);
    }
    return;
  }
  if (syncing) { changedWhileSyncing = true; return; }
  if (!(await systemCalSupported())) return;
  // 数据齐备门槛：学堂快照缺席时**不重建**。快照为 null = 学堂数据还没装载（App 启动后
  // 90s 才 kick 一轮，见 App.tsx；或本会话学堂没建起来），此时 buildPayload 会算出
  // 一份"少了全部作业 DDL 块"的载荷——那不是日程变化，是数据没到位。真写进去就会把
  // 截止提醒整批抹掉，等 90s 后装载完再写回来（两次无谓写入 + 一段"提醒不见了"的窗口）。
  // 快照到位的那次装载本身就是内容变化事件，会重新触发本轮。手动同步也经 buildPayload 的同一完整性检查。
  if (getLearnSnapshot() === null) {
    void logLine("[SYSCAL] 学堂快照未装载，本轮静默同步跳过（等它装载的广播）").catch(() => undefined);
    return;
  }
  try {
    await syncSystemCalendar({ silent: true });
  } catch {
    /* 已记入 lastError，Settings 可见 */
  }
}

function scheduleAutoPush(): void {
  if (syncing) { changedWhileSyncing = true; return; }
  if (autoTimer !== null) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    void autoPush();
  }, 5000);
}

/** 外部作业（雨课堂 / TUOJ 等）也进系统日历（DDL 块）。
 *  它的广播带着 lastAt（每次刷新都变）与会话健康状态（心跳每轮都变），直接订阅等于
 *  把"心跳"当"日程变了"——所以只认真正进日历的那几个字段的内容签名。 */
let lastExtHwSig: string | null = null;
function onExtHwChange(): void {
  const sig = JSON.stringify(
    [getExtHwSnapshot().configured, getExtHwSnapshot().state, getExtHwSnapshot().errors,
      getExtHwSnapshot().items.map(toHomework)
        .map((h) => [h.id, h.courseId, h.courseName ?? "", h.title, h.deadline, h.submitted, h.audited])],
  );
  if (sig === lastExtHwSig) return;
  lastExtHwSig = sig;
  scheduleAutoPush();
}

let initialized = false;

/** 应用启动时调用一次：订阅日程/课表变更 → 防抖自动重推 */
export function initSystemCalAutoSync(): void {
  if (initialized) return;
  initialized = true;
  {
    // 只认**内容变化事件**（数据源侧已按内容签名去重，装载但内容没变不发）：
    onCloudCalChange(scheduleAutoPush);   // 云/本日程：云同步扫出 added/updated/removed≠0、本地增删改
    subscribeLearnData(scheduleAutoPush); // 学堂：作业 DDL / 提交状态 / 课名变化
    subscribeCampusData(scheduleAutoPush); // 课表（校历窗口）变化
    subscribeCalendarData(scheduleAutoPush); // 学期/校历变化（决定窗口与所属学期）
    subscribeExtHw(onExtHwChange);         // 外部作业：按进日历的字段去重（滤掉心跳噪声）
    // 作业提醒档位变化 → 同样防抖重推
    subscribeHwRemind(scheduleAutoPush);
    subscribeIgnoredHw(scheduleAutoPush);
    // 两处"定期重建"兜底（用户 2026-10-11 拍板保留）：它们只重建**应用内**载荷，
    // 内容与上次写入完全相同就一次原生都不进（见 syncSystemCalendar 的指纹闸门），
    // 所以既兜住了"没有事件可等的服务端改动"（教务调课），又不会白写系统日历。
    // 关键前提是 autoPush 里的"数据齐备门槛"：学堂快照没装载时本轮直接跳过，
    // 否则会算出一份"少了作业 DDL 块"的半量载荷——那不是内容变化，是数据没到位。
    void ensureLoaded().then(() => { setTimeout(() => void autoPush(), 20_000); }).catch(() => undefined);
    setInterval(() => void autoPush(), RECONCILE_INTERVAL); // 之后每 30 分钟一轮
  }
}

/* ---------- React 绑定 ---------- */

export interface SystemCalState {
  ready: boolean;
  enabled: boolean;
  syncing: boolean;
  lastSyncAt: number;
  lastCount: number;
  lastError: string | null;
}

export function useSystemCal(): SystemCalState {
  const [snapshot, setSnapshot] = useState<SystemCalState>(() => ({
    ready: false,
    enabled: cfg.enabled,
    syncing,
    lastSyncAt: cfg.lastSyncAt,
    lastCount: cfg.lastCount,
    lastError: cfg.lastError,
  }));
  useEffect(() => {
    void ensureLoaded().catch(() => undefined);
    const update = (): void =>
      setSnapshot({
        ready: loaded,
        enabled: cfg.enabled,
        syncing,
        lastSyncAt: cfg.lastSyncAt,
        lastCount: cfg.lastCount,
        lastError: cfg.lastError,
      });
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return snapshot;
}
