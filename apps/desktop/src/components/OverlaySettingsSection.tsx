import { t as i18n, useLocale as useUiLocale } from "../i18n/index.js";
/**
 * 全局悬浮球设置（需求 5）：开关 + 授权状态 + 「本次关闭」说明。
 * 真源在原生侧（SharedPreferences，安卓系统悬浮层）/ 悬浮球窗口（桌面），
 * 这里只做入口：打开 = overlayShow()（同时清掉前端的「本次已关闭」标记）。
 *
 * 2026-10-14 换血：骨架换成 OneGUI（SettingsList / SettingsRow / Switch / Btn）。
 * 检索直达锚点从自定义的 data-set-id 改用标准 id（`row-开启悬浮球`），
 * focusSettingsTarget() 两族都认 —— 行为不变。
 */
import { defineSearchRows } from "../state/searchRows.js";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Btn, SettingsList, SettingsRow, Switch } from "@onethu/gui";
import { isOverlayClosedByUser, overlayHide, setOverlayClosedByUser, overlayShow, overlaySupported, syncOverlayPreference } from "../lib/overlay.js";
import { hasOverlayPermission, requestOverlayPermission } from "../lib/overlayAndroid.js";
import { isAndroidNavigator } from "../lib/androidHost.js";
import { readKeepAlive, writeKeepAlive } from "../lib/desktopKeepAlive.js";
import type { KeepAliveMode } from "../lib/keepAliveMode.js";
import { goOhRow } from "./OhSettingsPage.js";


/* task-19/22：悬浮球设置行注册。
   双形态：开关行的标题是「在其他应用上层显示 OH 悬浮球」（JSX 已钉 id="row-overlay-on"），
   平台不支持时该开关不出现 → visible 条件隐藏：落 OH 基础档根（TierSwitch 锚点）+ 一句解释。 */
defineSearchRows([
  {
    id: "overlay-on", tab: "OneTHU Harness", section: "悬浮球", get title() { return i18n("components.overlaysettingssection.905c17e31387"); }, aliases: ["悬浮球", "浮窗", "overlay", "权限"], get desc() { return i18n("components.overlaysettingssection.49a3266d6fc6"); } , breadcrumb: ["插件", "OneTHU Harness", "基础设置", "悬浮球", "开启悬浮球"], displayRoot: "设置",
    visible: () => isAndroidNavigator(typeof navigator !== "undefined" ? navigator : undefined),
    fallbackNote: "当前平台不支持在其他应用上层显示悬浮球（仅安卓可用）；已带到 OH「悬浮球」分节。",
    /* 落点=OH 基础档的档位按钮（OhSettingsPage 的 TierSwitch，data-set-id=`row-基础设置`）。
       注意：focusSettingsTarget 会自己补 `row-`/`sec-` 前缀 —— 这里传**档位名**，不是锚点全名
       （旧值 "oh-tier-basic" 会被拼成 `row-oh-tier-basic`，谁都命中不了）。 */
    root: "基础设置",
    go: () => goOhRow("overlay-on", "basic"),
  },
]);

export function OverlaySettingsSection(): ReactNode {
  const uiLocale = useUiLocale();

  const [supported, setSupported] = useState<boolean | null>(null);
  const [open, setOpen] = useState<boolean>(!isOverlayClosedByUser());
  const [perm, setPerm] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  void busy; // 开关本身不做禁用态（并发点击由 toggle 内的 await 自然串行）
  /* 后台常驻档位（桌面端二选一）。托盘保活档下悬浮球整个不参与：这里只给一条说明与
     「改用悬浮球保活」，不给一个点了也不会有球的开关。安卓/浏览器读到 null → 行为不变。 */
  const [keepalive, setKeepalive] = useState<KeepAliveMode | null>(null);

  useEffect(() => {
    void (async () => {
      setKeepalive((await readKeepAlive())?.mode ?? null);
      const sup = await overlaySupported();
      setSupported(sup);
      setPerm(await hasOverlayPermission().catch(() => null));
      /* 开关默认按偏好显示「开」，但原生端不会自己 show：进来时补一次真正的显示，
         并把状态回写（安卓未授权 → 如实显示为关，避免「开了却看不见」）。 */
      if (sup && !isOverlayClosedByUser()) {
        const shown = await syncOverlayPreference();
        setOpen(shown);
      }
    })();
  }, []);

  const toggle = useCallback(async (next: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (next) {
        if (!(await hasOverlayPermission().catch(() => false))) {
          await requestOverlayPermission().catch(() => undefined);
        }
        setOverlayClosedByUser(false);
        await overlayShow();
        setOpen(true);
      } else {
        setOverlayClosedByUser(true);
        await overlayHide();
        setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  if (supported === false) {
    return (
      <SettingsList>
        <SettingsRow
          title={i18n("components.overlaysettingssection.53c53ec1d550")}
          sub={i18n("components.overlaysettingssection.8eed0df5580d")}
        />
      </SettingsList>
    );
  }

  /* 托盘保活档：球不参与后台常驻。这里不显示开关，只给回切入口（用户可能就想找回球）。 */
  if (keepalive === "tray") {
    return (
      <SettingsList>
        <SettingsRow
          id="row-overlay-tray-mode"
          title={i18n("components.keepalivesettingssection.669e934e4e26")}
          control={
            <Btn
              variant="outline"
              size="sm"
              onClick={() => {
                void (async () => {
                  try {
                    await writeKeepAlive("overlay");
                    setKeepalive("overlay");
                    setOverlayClosedByUser(false);
                    await overlayShow();
                    setOpen(true);
                  } catch {
                    /* 原生拒绝（托盘档没落盘）：下次进设置页会重新读真实档位，别在这里猜 */
                  }
                })();
              }}
            >
              {i18n("components.keepalivesettingssection.7a535c93b575")}
            </Btn>
          }
        />
      </SettingsList>
    );
  }

  return (
    <SettingsList>
      {/* task-22 检索直达：注册表按「开启悬浮球」检索，这里钉标准 id，让这条行无论叫什么都落点唯一 */}
      <SettingsRow
        id="row-overlay-on"
        title={i18n("components.overlaysettingssection.46fe6b9d4522")}
        sub={i18n("components.overlaysettingssection.39b8579b7eb8", { value: String(perm === false ? i18n("components.overlaysettingssection.ca35c0484565") : "") })}
        control={<Switch checked={open} aria-label={i18n("components.overlaysettingssection.46fe6b9d4522")} onChange={(v) => void toggle(v)} />}
      />
      {open ? (
        <SettingsRow
          title={i18n("components.overlaysettingssection.5c2c170b5e1d")}
          sub={i18n("components.overlaysettingssection.e322a9564c88")}
          control={<Btn variant="ghost" size="sm" onClick={() => void toggle(false)}>{i18n("components.overlaysettingssection.512a854aacf2")}</Btn>}
        />
      ) : null}
    </SettingsList>
  );
}
