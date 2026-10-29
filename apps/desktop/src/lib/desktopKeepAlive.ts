/**
 * 后台常驻（悬浮球保活 / 托盘保活）的前端门面 —— 前端只认这一层，原生实现在
 * `apps/desktop/src-tauri/src/desktop_keepalive.rs`（档位落盘 + 托盘）与
 * `desktop_lifecycle_policy.rs`（关窗后果）。
 *
 * 契约：
 *   readKeepAlive()          → 原生快照 { mode, locale, trayReady }；不支持的平台返回 null
 *   writeKeepAlive(mode)     → 切换档位（立即生效：建/删托盘、隐球），失败抛错
 *   syncDesktopKeepAlive()   → 启动时按档位决定要不要显示悬浮球（取代原先无条件 syncOverlayPreference）
 *   syncKeepAliveLocale()    → 把界面语言推给原生，托盘菜单跟着变（启动/切语言各一次）
 *   onTrayAction(cb)         → 原生托盘菜单派来的动作（目前只有「后台常驻设置」）
 *
 * 红线：本文件与调用方**不得**因为档位切换去 `show/unminimize/聚焦主窗口`。托盘菜单的点击
 * 已经在原生侧走 `request_activate_main`，前端只负责落设置页与滚动定位。
 */
import { getLocale } from "../i18n/index.js";
import { isAndroidNavigator } from "./androidHost.js";
import { keepAliveSuppressesOrb, normalizeKeepAliveMode, type KeepAliveMode } from "./keepAliveMode.js";
import { syncOverlayPreference } from "./overlay.js";

/** 原生 → 前端事件名（与 Rust `tray::ACTION_EVENT` 必须逐字一致） */
export const TRAY_ACTION_EVENT = "onethu-desktop://event";

export interface KeepAliveState {
  mode: KeepAliveMode;
  locale: string;
  /** 托盘图标此刻**真的**在不在（不是档位回声）：托盘建失败时为 false */
  trayReady: boolean;
}

export interface TrayAction {
  type: string;
}

const isAndroid =
  isAndroidNavigator(typeof navigator !== "undefined" ? navigator : undefined) ||
  /Android/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "");

function inTauri(): boolean {
  const g = globalThis as unknown as Record<string, unknown>;
  return Boolean(g["__TAURI_INTERNALS__"] || g["__TAURI__"]);
}

/** 悬浮球窗口（`index.html?window=overlay`）：那里不参与档位同步，免得自己 show 自己 */
function isOverlayWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("window") === "overlay";
  } catch {
    return false;
  }
}

/** 本平台是否有「二选一」这套东西：桌面端 Tauri 才有；安卓/浏览器预览都没有。 */
export function desktopKeepAliveSupported(): boolean {
  return !isAndroid && inTauri() && !isOverlayWindow();
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return args === undefined ? await core.invoke<T>(cmd) : await core.invoke<T>(cmd, args);
}

async function log(line: string): Promise<void> {
  try {
    const { logLine } = await import("./clients.js");
    await logLine(`[keepalive] ${line}`);
  } catch {
    /* 日志失败不影响功能 */
  }
}

interface RawState {
  mode?: unknown;
  locale?: unknown;
  trayReady?: unknown;
}

function toState(raw: RawState | null | undefined): KeepAliveState | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    mode: normalizeKeepAliveMode(raw.mode),
    locale: typeof raw.locale === "string" && raw.locale ? raw.locale : getLocale(),
    trayReady: raw.trayReady === true,
  };
}

/** 读原生档位；不支持的平台或命令缺失（旧构建）返回 null，调用方按默认档走。 */
export async function readKeepAlive(): Promise<KeepAliveState | null> {
  if (!desktopKeepAliveSupported()) return null;
  try {
    return toState(await invoke<RawState>("desktop_keepalive_read"));
  } catch (e) {
    await log(`读取档位失败：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 切换档位。失败**向上抛**：设置页要把「托盘没建成」如实显示出来，不能静默。 */
export async function writeKeepAlive(mode: KeepAliveMode): Promise<KeepAliveState> {
  if (!desktopKeepAliveSupported()) {
    throw new Error("not-desktop");
  }
  const raw = await invoke<RawState>("desktop_keepalive_write", { mode, locale: getLocale() });
  const state = toState(raw);
  if (!state) throw new Error("bad-snapshot");
  await log(`档位已切换：${state.mode}（托盘=${state.trayReady}）`);
  return state;
}

/** 把界面语言推给原生（托盘菜单文案）。档位不变，只在语言真的变了时写一次。 */
export async function syncKeepAliveLocale(): Promise<void> {
  if (!desktopKeepAliveSupported()) return;
  const state = await readKeepAlive();
  if (!state) return;
  const locale = getLocale();
  if (state.locale === locale) return;
  try {
    await writeKeepAlive(state.mode);
  } catch (e) {
    await log(`同步托盘语言失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 启动时的档位同步（`main.tsx` 调一次，取代原先无条件的 `syncOverlayPreference()`）：
 *  - 托盘档 → 不碰悬浮球（原生侧 `overlay_show` 也会拒）；
 *  - 悬浮球档（默认）→ 与引入托盘之前完全一致（用户「本次关闭」则跳过）；
 *  - 读不到（浏览器预览 / 安卓 / 旧构建 / 命令失败）→ 按默认档，球照常出现。
 */
export async function syncDesktopKeepAlive(): Promise<void> {
  if (!desktopKeepAliveSupported()) {
    await syncOverlayPreference();
    return;
  }
  const state = await readKeepAlive();
  if (!state) {
    await syncOverlayPreference();
    return;
  }
  if (keepAliveSuppressesOrb(state.mode)) {
    await log("托盘保活档：启动不创建悬浮球");
  } else {
    await syncOverlayPreference();
  }
  if (state.locale !== getLocale()) await syncKeepAliveLocale();
}

/** 订阅托盘菜单动作；不支持的平台返回空函数。 */
export async function onTrayAction(cb: (action: TrayAction) => void): Promise<() => void> {
  if (!desktopKeepAliveSupported()) return () => undefined;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<TrayAction>(TRAY_ACTION_EVENT, (event) => {
      const payload = event.payload;
      if (!payload || typeof payload.type !== "string") return;
      cb(payload);
    });
  } catch (e) {
    await log(`订阅托盘动作失败：${e instanceof Error ? e.message : String(e)}`);
    return () => undefined;
  }
}
