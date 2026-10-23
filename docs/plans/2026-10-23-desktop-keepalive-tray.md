# 后台常驻：悬浮球保活 / 托盘保活二选一

需求原句：允许配置悬浮窗/托盘。落地口径为桌面端「关掉主窗口之后靠什么留在后台」的二选一：悬浮球保活（默认，与引入托盘之前一致）或托盘保活（系统托盘图标）。两档互斥，档位持久化，切换立即生效。

## 现状事实（实施前核对）

- 仓库原本没有任何托盘代码：`tauri` 未启用 `tray-icon` feature，Rust 侧无 `TrayIcon`，`tauri.conf.json` 无 `trayIcon`。
- 关窗策略只有一条判据：悬浮球可见则隐藏主窗口保活，悬浮球不可见则整进程退出（`desktop_lifecycle_policy.rs`）。
- 悬浮球窗口由前端 `overlay_show` 懒创建；启动时 `main.tsx` 无条件调用 `syncOverlayPreference()`，唯一的「开关」是 localStorage 里的关闭标记。
- 设置页签上限 8 项，实施前后均为满额；分节标题已改为 `i18n(...)`，分节↔页签断言目前是空转（实测 0 项）。
- `tray-icon` 依赖在 tauri 内按 Linux/Windows/macOS 门控，启用该 feature 不影响 Android 构建。

## 术语

- 悬浮球：用户可见的球／语音条／对话面板本体，全部界面文案使用该词。
- 悬浮窗：桌面端承载悬浮球的透明窗口 `oh-orb`，实现层名词，不进入界面文案。
- 托盘：Windows 通知区域图标／macOS 菜单栏图标。
- 后台常驻：关主窗口后应用仍然运行的机制，档位值 `overlay` 与 `tray`。

## 决策

| 决策 | 取值 | 依据 |
| --- | --- | --- |
| 载体 | 真系统托盘图标（Windows＋macOS） | 需求原句里的托盘即系统托盘 |
| 档位数 | 两档，默认 `overlay` | 升级用户行为零变化 |
| 设置位置 | 外观与布局 → 新分节「后台常驻」 | 页签硬上限 8 项，不加第九个页签 |
| 托盘交互 | 左键＝显示主窗口；右键菜单＝显示 OneTHU／后台常驻设置／退出 | 两端一致（macOS 关闭左键出菜单） |
| 缩到托盘提示 | 不提示 | 用户口径 |
| 图标 | macOS 单色模板图，Windows 应用自身彩色图 | 菜单栏常规做法 |
| 菜单语言 | 跟随应用内语言，原生侧各存一份字面量 | 原生菜单读不到前端词表 |
| 关悬浮球 | 仍退出应用 | 载体消失即退出，与现状一致 |
| 持久化 | `$APPDATA/desktop-keepalive-v1.json` | 托盘必须在 webview 起来之前创建；localStorage 会被系统驱逐 |
| 档位权威 | Rust | 前端旧逻辑／插件调用 `overlay_show` 时由原生拒掉 |
| 托盘建失败 | 不落盘、关窗即退出、设置页如实显示并可重试 | 不留无入口后台进程 |

## 改动面

原生（`apps/desktop/src-tauri`）：

- `Cargo.toml`：`tauri` 增加 `tray-icon` feature；macOS 目标增加 `png = "0.17"`（依赖树里已有，用于解码模板图，避免引入 `image` 整包）。
- `src/tray.rs`（新增）：托盘建／删／按语言重建、菜单分派、左键唤回主窗口。
- `src/desktop_keepalive.rs`（新增）：档位与语言的落盘、启动读取、读／写命令、切换时建删托盘并隐藏悬浮球。
- `src/desktop_keepalive_mobile.rs`（新增）：移动端同名命令替身，`write` 如实拒绝。
- `src/desktop_lifecycle_policy.rs`：新增 `KeepAlive` 档位与 `tray_present()` 判据，重写 `close_main`／`overlay_hidden`，补 7 条用例。
- `src/desktop_lifecycle.rs`、`src/lib.rs`：接线（`tray_present`、启动 init、两条命令注册）。
- `src/overlay_win.rs`：`orb_allowed()` 闸门，托盘档下 `overlay_show`／`overlay_set_mode` 直接返回。
- `icons/tray-template.png`（新增）：44×44 单色带透明通道。

前端（`apps/desktop/src`）：

- `lib/keepAliveMode.ts`（新增）：档位收敛纯函数。
- `lib/desktopKeepAlive.ts`（新增）：读／写／启动同步／托盘动作订阅／语言推送。
- `state/trayActions.ts`（新增）：托盘菜单动作落到设置分节，并订阅语言变更。
- `components/KeepAliveSettingsSection.tsx`（新增）：两档分段控件、失败状态与重试、检索行注册。
- `pages/Settings.tsx`：外观与布局下新增「后台常驻」分节，按平台收口。
- `components/OverlaySettingsSection.tsx`：托盘档下不给悬浮球开关，改为说明与回切按钮。
- `main.tsx`：启动改走 `syncDesktopKeepAlive()`，装托盘动作监听。
- `state/settingsMode.ts`、`i18n/locales/zh-CN.ts`、`i18n/locales/en-US.ts`：分节标签与 11 条双语文案。

护栏：

- `tools/desktop-keepalive-test.mjs`（新增）：档位收敛、事件名跨语言一致、设置分节平台收口、原生闸门处数。
- `tools/desktop-lifecycle-policy-test.mjs`：既有脚本自动覆盖新增的 7 条用例。
- `package.json` 的 `guard` 与 `.github/workflows/release.yml` 各接一行。

## 关窗矩阵

| 档位 | 悬浮球 | 关主窗口 | 退出路径 |
| --- | --- | --- | --- |
| `overlay`（默认） | 可见 | 隐藏主窗口保活 | 关掉悬浮球 |
| `overlay` | 用户已关 | 退出 | 无（与现状一致） |
| `tray` | 不创建 | 隐藏主窗口保活 | 托盘菜单退出 |
| `tray` 但托盘未建成 | 不创建 | 退出 | 设置页重试或切回悬浮球档 |

## 失败模式

- 托盘创建失败：写命令返回错误且不落盘；启动时失败只记日志，档位保持 `tray` 但载体判据为 false，关窗走退出。
- 隐藏主窗口期间载体消失：隐藏后对账一次，两个都不可见即退出，只退出一次。
- 前端读不到档位（旧构建、命令失败、浏览器预览）：按 `overlay` 处理，悬浮球照常出现。
- 并发切换：写命令串行化，最终态为最后一次成功落盘的值。
- 旧状态：localStorage 的关闭标记语义不变，悬浮球档行为逐字一致；托盘档不读它。

## 不做

- 开机自启、缩到托盘的一次性提示、托盘角标与通知、Linux 正式支持、iOS。
- 改造 Android 系统悬浮层（其保活语义不变，也不出现托盘）。
- 引入 `CONTEXT.md`／`docs/adr/` 新文档约定；继续使用 `docs/plans`＋`docs/reviews`＋模块头注。
- 修正「本次关闭悬浮球」这个名为本次、实际跨重启的旧标记语义。
