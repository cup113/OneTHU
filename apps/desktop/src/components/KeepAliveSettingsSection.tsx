import { t as i18n, useLocale as useUiLocale } from "../i18n/index.js";
/**
 * 设置 → 外观与布局 → 后台常驻：桌面端「保活方式二选一」。
 *
 * 需求 2026-10-23 口径：关掉主窗口之后，是靠**悬浮球**还是靠**系统托盘图标**留在后台。
 * 两档互斥——托盘档不创建悬浮球（原生侧 `overlay_show` 也会拒），悬浮球档没有托盘。
 *
 * 真源在原生：档位与语言写在 `$APPDATA/desktop-keepalive-v1.json`（见
 * `src-tauri/src/desktop_keepalive.rs`）。这里只做入口：读一次、改一次、把失败如实显示。
 *
 * 平台：只有桌面端渲染（Settings.tsx 侧已按 `desktopKeepAliveSupported()` 收口）；
 * 安卓的「后台常驻」仍是 OH 设置里的悬浮球开关，与托盘无关。
 */
import { defineSearchRows } from "../state/searchRows.js";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Btn, Segment, SettingsList, SettingsRow } from "@onethu/gui";
import { keepAliveSuppressesOrb, type KeepAliveMode } from "../lib/keepAliveMode.js";
import { desktopKeepAliveSupported, readKeepAlive, writeKeepAlive, type KeepAliveState } from "../lib/desktopKeepAlive.js";
import { overlayShow, setOverlayClosedByUser } from "../lib/overlay.js";

/* 检索直达：分节名与 SettingsGroup 的 section 必须逐字一致（"后台常驻"） */
defineSearchRows([
  {
    id: "set-keepalive",
    tab: "外观与布局",
    section: "后台常驻",
    get title() { return i18n("components.keepalivesettingssection.8cf5d78e86d6"); },
    aliases: ["托盘", "悬浮球", "悬浮窗", "后台", "关窗", "退出"],
    get desc() { return i18n("components.keepalivesettingssection.7c059eb8ebf7"); },
    breadcrumb: ["设置", "外观与布局", "后台常驻", "后台常驻"],
    /* 只有桌面端有这套二选一：安卓/浏览器里这一节根本不渲染，别让检索报 row 级命中。 */
    visible: () => desktopKeepAliveSupported(),
    fallbackNote: "「后台常驻」的悬浮球/托盘二选一仅桌面版可用；已到「外观与布局」。",
  },
]);

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function KeepAliveSettingsSection(): ReactNode {
  useUiLocale();

  /** null = 还没读到（首帧）或读不到（命令缺失）——两种都不显示假开关 */
  const [state, setState] = useState<KeepAliveState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setState(await readKeepAlive());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = useCallback(async (mode: KeepAliveMode): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await writeKeepAlive(mode);
      setState(next);
      if (!keepAliveSuppressesOrb(mode)) {
        // 切回悬浮球档：用户明确要求球在，清掉「本次关闭」标记再显示（原生侧已放行）。
        setOverlayClosedByUser(false);
        await overlayShow();
      }
    } catch (e) {
      setError(errorText(e));
      // 失败时以原生当前状态为准：档位没落盘，别让 UI 停在用户以为成功的位置。
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  const mode = state?.mode ?? "overlay";

  return (
    <SettingsList sub={i18n("components.keepalivesettingssection.1f1b928f3944")}>
      <SettingsRow
        id="row-keepalive-mode"
        title={i18n("components.keepalivesettingssection.8cf5d78e86d6")}
        sub={
          mode === "tray"
            ? i18n("components.keepalivesettingssection.0ea9418b1ae8")
            : i18n("components.keepalivesettingssection.4f366e7b1c85")
        }
        control={
          <Segment
            size="sm"
            value={mode}
            /* 标签用字面量键：i18n 检查禁止 i18n(变量)（tools/i18n-test.mjs 的 undeclared dynamic message） */
            options={[
              { value: "overlay", label: i18n("components.keepalivesettingssection.202becb75fd8") },
              { value: "tray", label: i18n("components.keepalivesettingssection.cae188296c46") },
            ]}
            onChange={(value) => {
              const next: KeepAliveMode = value === "tray" ? "tray" : "overlay";
              if (next === mode) return;
              void apply(next);
            }}
          />
        }
      />
      {state && keepAliveSuppressesOrb(state.mode) && !state.trayReady ? (
        <SettingsRow
          id="row-keepalive-tray-failed"
          title={i18n("components.keepalivesettingssection.63295bdd487f")}
          sub={error ?? undefined}
          control={
            <Btn variant="outline" size="sm" disabled={busy} onClick={() => void apply("tray")}>
              {i18n("components.keepalivesettingssection.b8784c8dd563")}
            </Btn>
          }
        />
      ) : error ? (
        <SettingsRow id="row-keepalive-error" title={error} />
      ) : null}
    </SettingsList>
  );
}
