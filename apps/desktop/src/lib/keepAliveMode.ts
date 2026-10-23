/**
 * 后台常驻档位的纯函数部分（零依赖：不 import Tauri / React / i18n）。
 *
 * 需求口径（2026-10-23）：桌面端「后台保活方式」二选一——悬浮球保活 / 托盘保活。
 * 档位真源在原生侧（`apps/desktop/src-tauri/src/desktop_keepalive.rs`），前端只做两件事：
 * 把原生报回来的原始值收敛成这两档，以及把用户的选择推回去。
 *
 * 为什么"未知值一律回到 overlay"：overlay 是引入托盘之前的既有行为。读到脏数据/旧版本
 * 命令缺失时，让应用继续按今天的方式工作，比让用户"球没了、托盘也没有"安全得多。
 *
 * `tools/desktop-keepalive-test.mjs` 直测这两个函数（不启动 Tauri）。
 */

/** 后台常驻载体：悬浮球（默认）或系统托盘图标。 */
export type KeepAliveMode = "overlay" | "tray";

/** 展示顺序即设置页里的顺序。 */
export const KEEP_ALIVE_MODES: readonly KeepAliveMode[] = Object.freeze(["overlay", "tray"]);

/** 默认档：悬浮球保活（引入托盘之前的行为，升级用户零变化）。 */
export const DEFAULT_KEEP_ALIVE_MODE: KeepAliveMode = "overlay";

/** 把原生/持久化的原始值收敛成合法档位；任何非 "tray" 的值都是 overlay。 */
export function normalizeKeepAliveMode(raw: unknown): KeepAliveMode {
  return raw === "tray" ? "tray" : DEFAULT_KEEP_ALIVE_MODE;
}

/** 该档位是否要求「不出现悬浮球」（托盘档下前端启动不应去创建球窗）。 */
export function keepAliveSuppressesOrb(mode: KeepAliveMode): boolean {
  return mode === "tray";
}
