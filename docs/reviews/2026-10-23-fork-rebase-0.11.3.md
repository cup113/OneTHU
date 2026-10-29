# 分叉历史改写：14 个提交压成 4 个，基线换到上游 0.11.3

日期：2026-10-23。改写前 `main` = `b22d300e`（14 个提交，基线 `9029e7c1`），改写后
`main` = `92a5d5bc`（4 个提交，基线 `upstream/main` = `ab0899f6`，即上游 0.11.3）。
回退点：本地引用 `backup/pre-rebase-0.11.2`，远端历史用 force-with-lease 覆盖。

## 为什么先压再换基线

14 个提交里有 7 个是分叉构建链的连续修补（身份、安卓、签名、CI），逐个重放到
151 文件的上游发版提交上，同一个文件会被反复改判 7 次。先在本地基线上把同一主题的
提交压成一个，再把 4 个提交重放到 0.11.3 上，冲突只出现一次，且是在最终语义上判定。

## 新历史

| 提交 | 覆盖的原提交 | 说明 |
| --- | --- | --- |
| `036666f3` feat(dev): 桌面端开发收成一个入口 dev:app | `cff2ff0e` | 与本轮发版无关，保持独立 |
| `2ce26832` fix(auth): 网关会话短路恢复 + 认证页留证 + info-lib dist 新鲜度 | `1e62e668` `44fa0883` `2d484cad` `b26028f6` `5412d228` | 同一场排查的三件事，review 文档随组 |
| `c54557d4` feat(desktop): 后台常驻可配置为悬浮球或托盘保活 | `22bde266` | 含移动端替身文件（见下） |
| `92a5d5bc` feat(build): 分叉身份、安卓包与多平台构建隔离 | `e6bc13dd` `c9c594e5` `a16cb56a` `b3e630e3` `ca3fca4d` `f2b0d19b` `b22d300e` | 身份、发布链路、安卓 CI、签名预检 |

`desktop_keepalive_mobile.rs` 不拆到安卓提交：托盘特性一旦引入 `tray` 模块，移动端就
必须有同名替身才能编过，拆开会留下一个在 Android 上编不过的中间提交。

## 冲突与判断

自动合并成功、只需要核对的地方与真正需要人判断的地方分开列：

- **`apps/desktop/src/lib/loginErrors.ts`**：`reasons` 集合取并集（上游加的
  `gateway-unavailable` 与本仓的 `gateway-session-pinned` 都留）。
- **`packages/info-lib/src/utils/error.ts`**：`LoginPreparationReason` 自动合并成并集，
  上游 8 个值与 `gateway-session-pinned` 共存；`packages/info-lib/src/lib/core.ts` 里
  本仓的网关判定重试分支落在上游新增的 admission hook 与 `clearCookieHandler` 之后、
  凭据 POST 之前，语义正确（清理 → 发现网关仍在线 → 注销并重取一次）。
- **`apps/desktop/src/lib/infoLib.ts`**（两次冲突，都是 import 行）：取并集
  （`nativeCookieClearDomains`、`nativeSessionEpoch`、`isTauri`、`createAuthCookieBoundary`、
  `session`、`setLastAuthEntry`、`bytesToBase64` 全部保留）。
- **两个 locale**：`login.error.gatewaySession` 与 `login.error.gatewayUnavailable` 都留，
  按字母序排列。
- **`.github/workflows/release.yml`**：本仓的改写（去掉 `push: tags`、加 `fork`/`android`
  输入与两个 job）盖在上游新增的「Check authentication recovery and account ownership」
  之上，两道保活护栏与安卓 job 都保住了。

## 随基线走的两个值

- 分叉版本 `0.11.2-1` → **`0.11.3-1`**（`tauri.fork.conf.json`）。数字预发布段是 Windows
  MSI 的硬限制，`0.11.3-1 < 0.11.3`，不会与上游同号。
- Android `versionCode` 跟上游走 **11012**（`tauri.conf.json` 的 `bundle.android.versionCode`，
  分叉配置不覆盖它；不同包名之间不冲突）。

## 三平台跑暴露的两件事（run 39979127330）

第一轮三平台跑的结论：Windows 与 Android 绿，macOS 在「Check authentication recovery and
account ownership」红。红的位置暴露出两个独立问题：

**一、本仓用例的期望值随上游分类漂移。** 断言拿到的是 `gateway-unavailable`，期望的是
`unexpected-page`。上游 0.11.3 新增了网关壳判定（页面短于 4000 字符且含
`__vpn_hostname_data` → `gateway-unavailable`），而本仓那条用例的夹具页正是这种壳：
「网关仍在线且宿主没有重试钩子」时，兜底结论现在是 `gateway-unavailable`，
比原先的 `unexpected-page` 更准确。修的是用例而不是实现：两条断言改成新结论
（`a gateway landing without a host hook is reported as an unavailable gateway`、
`a failed gateway reset falls back instead of claiming a pinned session`），
「不重试、不发凭据、钩子仍看到入口」三条性质不变。

**二、Windows 上的多行 `run:` 会吞掉失败。** 同一个步骤在 Windows 上跑了同样的断言、
同样抛了异常，step 却是绿的：Windows runner 的默认 shell 是 pwsh，多行脚本里前面的命令
失败不会中断，step 退出码只由最后一条命令决定。也就是说这一轮 Windows 的绿是假的。
两处修正：

- desktop job 加 `defaults.run.shell: bash`，三端统一 shell，多行脚本的失败不再被吞；
- 鉴权步骤改走 `pnpm run test:login`（一条命令一个退出码），与 `test:onboarding` /
  `test:oh` 同风格，本地也能用同一条脚本复现。

`pnpm run test:login` 已在本地通过（含 `login-public-key-test.mjs`；该脚本用 tsx，
沙箱里 tsx 的子进程被拒，需在不受限环境跑）。旧期望值必然失败这一点由上一轮 macOS 的红
本身证明，无需另行注入。

## 验证

- 27 条 CI 守卫：本地 26 条通过。`tools/login-public-key-test.mjs` 走仓库自带的
  `ts-resolve-register.mjs` 时报 `ERR_MODULE_NOT_FOUND`（`constants/strings` 为无后缀导入，
  该 loader 只做 `.js→.ts` 回退）——既有工具差异，CI 用 `tsx` 解析不受影响。
- `cargo check --offline`：通过（含上游新增的会话逻辑与本仓托盘模块）。
- `pnpm --filter @onethu/info-lib run build`、`pnpm --filter @onethu/desktop run build`：通过。
- `build:fork` 产出 `OneTHU-Fork 0.11.3-1`，标识 `app.onethu.desktop.fork`，更新源
  `cup113/OneTHU`，产物自校验命中分叉标记与版本号。
- `tools/i18n/check.mjs`：0 错误（上游重生的 catalog 与本仓新增键不冲突）。
- 内容无损核对：旧历史改过的 54 个文件在新树里全部存在，其中 20 个内容不同，差异全部
  来自上游 0.11.3 与本仓有意修改（`tauri.fork.conf.json` 的版本）。

三平台打包验证见发布跑的 artifacts：Windows `onethu-windows-latest-fork`、
macOS `onethu-macos-latest-fork`、Android `onethu-android-fork`。
