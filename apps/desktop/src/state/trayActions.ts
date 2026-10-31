/**
 * 托盘菜单动作的前端落地（桌面端，主窗口里装一次）。
 *
 * 原生侧（`src-tauri/src/tray.rs`）只负责「把主窗口唤回 + 派一个事件」，落哪一页由这里决定：
 * 后台常驻设置 = 设置 → 外观与布局 → 后台常驻。
 *
 * 顺便在这里挂语言变更的推送：托盘菜单是原生菜单，前端切语言时要让它跟着变
 * （`syncKeepAliveLocale` 只在不同语言时写一次，不会每次启动都写盘）。
 */
import { subscribeLocale } from "../i18n/index.js";
import { desktopKeepAliveSupported, onTrayAction, syncKeepAliveLocale } from "../lib/desktopKeepAlive.js";
import { openSettings } from "./explorer.js";
import { requestSettingsSection, requestSettingsTab } from "./settingsMode.js";

/** 与 Settings.tsx 的 `<SettingsGroup tab=… section=…>` 逐字一致 */
export const KEEPALIVE_SETTINGS_TAB = "外观与布局";
export const KEEPALIVE_SETTINGS_SECTION = "后台常驻";

/** 落到「后台常驻」分节：先写过页签/分节请求，再打开设置浮层（与更新提示同一条路）。 */
export function openKeepAliveSettings(): void {
  requestSettingsTab(KEEPALIVE_SETTINGS_TAB);
  requestSettingsSection(KEEPALIVE_SETTINGS_SECTION);
  openSettings("settings");
}

/** 装托盘动作监听；不支持的平台/环境返回空函数（调用方不必判断）。 */
export function installTrayActions(): () => void {
  if (!desktopKeepAliveSupported()) return () => undefined;

  let disposed = false;
  let offTray: (() => void) | null = null;

  const offLocale = subscribeLocale(() => {
    void syncKeepAliveLocale();
  });

  void (async () => {
    const off = await onTrayAction((action) => {
      if (action.type === "open-keepalive-settings") openKeepAliveSettings();
    });
    if (disposed) off();
    else offTray = off;
  })();

  return () => {
    disposed = true;
    offLocale();
    offTray?.();
    offTray = null;
  };
}
