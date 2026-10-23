# 后台常驻（悬浮球保活 / 托盘保活）实施与验收

需求：允许配置悬浮窗/托盘。实现见 `docs/plans/2026-10-23-desktop-keepalive-tray.md`。本文记录实际落地的改动、可复现的验证结果，以及**尚未验证**的部分。

## 实施要点

- 档位真源在原生：`apps/desktop/src-tauri/src/desktop_keepalive.rs` 读写在 `$APPDATA/desktop-keepalive-v1.json`（`{"mode":"overlay"|"tray","locale":"zh-CN"}`），启动时读取，托盘档在 `setup` 里就把图标建好。
- 关窗策略换成「档位 + 载体在场」双判据：`desktop_lifecycle_policy.rs` 新增 `KeepAlive` 与 `Windows::tray_present()`；载体不在场一律退出，不留无入口进程。
- 新增托盘模块 `src/tray.rs`：菜单三项（显示 OneTHU／后台常驻设置／退出）、左键显示主窗口、菜单文案按语言重建、macOS 用模板图。
- 新增前端门面 `lib/desktopKeepAlive.ts` 与设置分节 `components/KeepAliveSettingsSection.tsx`；启动同步从无条件的 `syncOverlayPreference()` 换成按档位决策的 `syncDesktopKeepAlive()`。
- 原生闸门 `overlay_win::orb_allowed()`：托盘档下 `overlay_show` 与 `overlay_set_mode` 直接返回，旧前端或插件都带不回悬浮球。

## 已验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| Rust 类型检查与链接图 | `cargo check --offline`（`apps/desktop/src-tauri`） | 通过；新增文件零警告，剩余警告均在既有文件 |
| 关窗策略用例（CI 同款） | `node tools/desktop-lifecycle-policy-test.mjs` | 15 passed（原有 8 条 + 新增 7 条） |
| 后台常驻护栏 | `node --import ./tools/ts-resolve-register.mjs tools/desktop-keepalive-test.mjs` | 通过（档位收敛／事件名两端一致／分节平台收口／原生闸门处数） |
| 前端生产构建 | `pnpm --filter @onethu/desktop run build` | 通过（含 `i18n-test` 前置检查） |
| 词典完整性 | `node tools/i18n-test.mjs` | 0 错误；zh-CN 与 en-US 各 7600 键 |
| 设置信息架构 | `node tools/settings-ia-test.mjs` | 通过；标准页签仍 8 项 |
| 文档文案 | `node tools/docs-prose-lint.mjs` | 0 处违规（185 份文档） |
| 类型检查（本仓基线） | `pnpm --filter @onethu/desktop run typecheck` | 新增文件 0 错误；3 处失败在未触碰文件（见下「既有失败」） |
| macOS 模板图解码路径 | 临时夹具 crate（`png 0.17`，不入库）编译并跑测试 | 44×44 RGBA 解码成功，透明与不透明像素均存在 |

### 防呆证明（护栏非空转）

三处注入实验，每次注入后跑对应护栏、再按字节还原并用 SHA-256 核对：

1. 把 `close_main` 的载体判据换成「悬浮球可见」→ 3 条托盘档用例变红（`tray_mode_close_keeps_running_without_any_orb` 等）。
2. 前端托盘事件名改一个字母 → 护栏报「托盘事件名两端不一致：Rust=onethu-desktop://event TS=onethu-desktop://events」。
3. 去掉 `overlay_set_mode` 的 `orb_allowed()` 闸门 → 护栏报「orb_allowed() 只用在 1 处」。

三处均还原成功（哈希一致）。

### 既有失败（与本改动无关）

- `src/state/madmodel.ts:580/586`：`unref` 不在 `number` 上（两处）。
- `packages/gui/src/components/overlay.tsx`：`react-dom` 缺类型声明——本机 `packages/gui/node_modules` 没有链接 `@types/react-dom`。临时补齐 `@types/react` 后错误总数从 40+ 降到 3，说明其余全是该链路缺类型导致的噪声。
- `node tools/ui-copy-lint.mjs`：12 处既有违规（`libraryErrorText.ts`、`VisitTab.tsx`、`Plugins.tsx`、`Settings.tsx` 的检索别名、`ImSettingsSection.tsx`）。本次新增文案不在其中。

## 未验证（需真机）

- Windows 通知区域图标的实际外观、左键与右键行为、退出后无残影。
- macOS 菜单栏模板图在浅色／深色下的表现，以及左键显示主窗口（已设 `show_menu_on_left_click(false)`）。
- Android 构建：本次只加了 `#[cfg(not(desktop))]` 的命令替身，未在本机跑 APK 构建。
- 「关主窗口 → 缩到托盘 → 托盘唤回 → 托盘退出」的完整人工路径。

## 已知限制

- Windows 资源管理器重启后托盘图标消失（`tray-icon` 行为），应用仍在运行；重新启动应用或切换一次档位即可恢复。
- 托盘创建失败时档位文件仍记录 `tray`，但载体判据为 false：关窗为退出，设置页显示失败行并可重试。
- 「本次关闭悬浮球」这个标记实际跨重启生效（名为本次），本次未改动其语义。

## 变更文件

原生：`Cargo.toml`、`Cargo.lock`、`src/tray.rs`、`src/desktop_keepalive.rs`、`src/desktop_keepalive_mobile.rs`、`src/desktop_lifecycle.rs`、`src/desktop_lifecycle_policy.rs`、`src/overlay_win.rs`、`src/lib.rs`、`icons/tray-template.png`。

前端：`lib/keepAliveMode.ts`、`lib/desktopKeepAlive.ts`、`state/trayActions.ts`、`components/KeepAliveSettingsSection.tsx`、`components/OverlaySettingsSection.tsx`、`pages/Settings.tsx`、`main.tsx`、`state/settingsMode.ts`、`i18n/locales/zh-CN.ts`、`i18n/locales/en-US.ts`。

护栏与流水线：`tools/desktop-keepalive-test.mjs`、`package.json`（`guard`）、`.github/workflows/release.yml`（「Check background keep-alive carriers」）。
