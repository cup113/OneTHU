/**
 * 「后台常驻」（悬浮球保活 / 托盘保活二选一）的离线护栏。
 *
 * 分四段：
 *   [1] 纯函数：档位收敛（脏值必须回到 overlay）、托盘档抑制悬浮球；
 *   [2] 契约：前端事件名必须与 Rust `tray::ACTION_EVENT` 逐字一致（两边各存一份字面量，
 *       改一边忘另一边会让「托盘菜单 → 后台常驻设置」静默失效）；
 *   [3] 平台收口：设置分节只在桌面端渲染，且分节名与 SettingsGroup 的 section 一致；
 *   [4] 原生闸门：托盘档下 `overlay_show` / `overlay_set_mode` 必须先过 `orb_allowed()`。
 *
 * 跑法：node --import ./tools/ts-resolve-register.mjs tools/desktop-keepalive-test.mjs
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (p) => readFileSync(p, "utf8");

/* [1] 纯函数 */
const { normalizeKeepAliveMode, keepAliveSuppressesOrb, KEEP_ALIVE_MODES, DEFAULT_KEEP_ALIVE_MODE } =
  await import("../apps/desktop/src/lib/keepAliveMode.ts");

assert.equal(normalizeKeepAliveMode("tray"), "tray");
assert.equal(normalizeKeepAliveMode("overlay"), "overlay");
for (const bad of [undefined, null, "", "TRAY", " tray", "tray ", "both", 0, 1, {}, []]) {
  assert.equal(normalizeKeepAliveMode(bad), "overlay", `脏值必须回到默认档：${String(bad)}`);
}
assert.equal(DEFAULT_KEEP_ALIVE_MODE, "overlay", "默认档必须是引入托盘之前的悬浮球保活");
assert.deepEqual([...KEEP_ALIVE_MODES], ["overlay", "tray"]);
assert.equal(keepAliveSuppressesOrb("tray"), true, "托盘档不该出现悬浮球");
assert.equal(keepAliveSuppressesOrb("overlay"), false);

/* [2] 跨语言契约：事件名 */
const rustEvent = read("apps/desktop/src-tauri/src/tray.rs").match(/ACTION_EVENT: &str = "([^"]+)"/)?.[1];
assert.ok(rustEvent, "tray.rs 里没有 ACTION_EVENT 字面量：解析规则变了就同步改这条护栏");
const tsEvent = read("apps/desktop/src/lib/desktopKeepAlive.ts").match(/TRAY_ACTION_EVENT = "([^"]+)"/)?.[1];
assert.ok(tsEvent, "desktopKeepAlive.ts 里没有 TRAY_ACTION_EVENT 字面量");
assert.equal(tsEvent, rustEvent, `托盘事件名两端不一致：Rust=${rustEvent} TS=${tsEvent}`);

/* [3] 平台收口与分节锚点 */
const settings = read("apps/desktop/src/pages/Settings.tsx");
assert.ok(
  /section="后台常驻"/.test(settings),
  "Settings.tsx 里没有 section=\"后台常驻\"：托盘菜单「后台常驻设置」会落到空锚点",
);
assert.ok(
  /desktopKeepAliveSupported\(\) \?[\s\S]{0,400}?section="后台常驻"/.test(settings),
  "「后台常驻」分节没有被 desktopKeepAliveSupported() 收口：安卓/浏览器会渲染出空壳",
);
const section = read("apps/desktop/src/components/KeepAliveSettingsSection.tsx");
assert.ok(
  /section: "后台常驻"/.test(section),
  "检索行 section 与 SettingsGroup 的 section 必须逐字一致（否则检索落不到分节）",
);
assert.ok(
  /visible: \(\) => desktopKeepAliveSupported\(\)/.test(section),
  "检索行必须按平台 visible：非桌面端不注册这一行",
);

/* [4] 原生闸门：托盘档不得创建悬浮球 */
const overlay = read("apps/desktop/src-tauri/src/overlay_win.rs");
assert.ok(/fn orb_allowed\(\) -> bool/.test(overlay), "overlay_win.rs 缺少 orb_allowed() 闸门");
const gateCalls = [...overlay.matchAll(/if !orb_allowed\(\)/g)].length;
assert.ok(
  gateCalls >= 2,
  `orb_allowed() 只用在 ${gateCalls} 处：overlay_show 与 overlay_set_mode 都必须先过闸门（托盘档不该冒出球）`,
);

console.log(
  "后台常驻：档位收敛（脏值→overlay）✓ / 默认档 overlay ✓ / 托盘档抑制球 ✓ / " +
    `事件名两端一致（${rustEvent}）✓ / 设置分节按平台收口 ✓ / 原生 orb_allowed 闸门 ${gateCalls} 处 ✓`,
);
