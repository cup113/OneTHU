# 分叉历史再压缩：27 个提交压成 8 个，基线换到上游 0.11.4

> 最后更新：2026-10-26 23:58

日期：2026-10-26。改写前 `main` = `edde6dc9`（27 个提交，基线 `ab0899f6`，上游 0.11.3）。
改写后 8 个提交叠在 `upstream/main` = `a4f3210c`（上游 0.11.4）之上，随后追加版本跟进与
本复盘两个提交。回退点：本地与远端 `backup/pre-squash-2026-10-26`（=`edde6dc9`）、
本地 `backup/squashed-8`（压缩后、rebase 前的 `7ee7c2e3`）。

## 为什么先压后换基线

27 个提交里 22 个是分叉发版链的连续修补（版本比较、PAT、护栏、探针、安卓图标、日历同步）。
上游 0.11.4 改动 300 个文件，其中 15 个与本仓改动重叠。逐提交重放会让同一文件被反复判定；
先在旧基线上把同主题提交压成一个（零冲突），再把 8 个单元重放到 0.11.4，冲突只按最终语义
判定一次。

## 27 → 8 映射

| 新提交 | 覆盖的原提交 | 说明 |
| --- | --- | --- |
| `abce8d27` feat(desktop): dev:app 入口、网关会话恢复与后台常驻保活 | `036666f3` `2ce26832` `c54557d4` | 桌面开发入口、网关会话短路恢复、托盘/悬浮球保活 |
| `0db5df36` feat(build): 分叉身份、安卓包与多平台构建隔离 | `92a5d5bc` | 沿用原提交，内容未改 |
| `ec8b4626` feat(ci): 分叉手动发版链路（版本比较、安卓图标、PAT 与探针结论） | `4993dd1c` `d41caeb5` `6b42abcd` `1d51ef7a` `289e4242` `9c5fa083` `f85a760c` `bf5fcd95` `bf312eaa` `bb9d2a22` `37319c91` | 版本比较、dispatch 发版、安卓图标、PAT、四组探针与复盘 |
| `b4998d41` fix(schedule): 悬浮圆钮可拖动，设置面板收成单滚动并给手机换底部 Sheet | `af365de5` | 沿用原提交 |
| `eee35f05` fix(auth): 门户错误 JSON 判为会话过期，静默重登不再空转 | `45cd40e5` | 沿用原提交 |
| `e550b17f` chore(release): 0.11.3-3 与 CI 护栏、NDK 覆盖输入 | `33ae57d1` `4c07361b` `79a72d53` `5b3b822a` | 版本记录、guard 写权限、CRLF 断言、NDK 输入 |
| `551684b3` fix(android): 系统日历同步改差异驱动（合并 0.11.3-4..-7 修复） | `3f184acd` `3f37d9d4` `61d6d818` `e26c7d7b` `dc7ddd7b` | 后台执行、三重加固、差异驱动与两次发版记录 |
| `a385abba` feat(schedule): 自定义日程编辑器支持设置重复规则 | `edde6dc9` | 沿用原提交 |

压缩阶段逐组校验：8 组的新提交树与各自末提交树逐字节相同（`git diff --quiet <new> <old-last>`
全部为 0），整树 `git diff --quiet edde6dc9 7ee7c2e3` 为 0；`git range-diff` 显示 8 行覆盖
27 个原提交。

## 冲突与判定

rebase 只出现 7 处内容冲突，集中在 6 个文件：

| 文件 | 判定 |
| --- | --- |
| `apps/desktop/src/main.tsx` | 保留本仓的 `syncDesktopKeepAlive` 门面（它内部按档位决定是否显示悬浮球），同时套用上游 0.11.4 新增的 `isPluginRuntimeOwner()` 窗口所有权门控；上游那段独立的 `syncOverlayPreference()` 已被该门面取代，删除 |
| `apps/desktop/src/pages/Settings.tsx` | 保留本仓「后台常驻」分节（外观与布局）；收藏夹分节跟随上游迁移到「功能」页签 |
| `package.json`（两处） | 版本取上游 `0.11.4`；`test:login` 取本仓 7 条命令的并集；`test:oh` 取上游新增的 `oh-app-features` 与 `oh-vault-share-guard`；`test:dark` 保留 |
| `packages/info-lib/src/lib/core.ts` | 保留本仓以 `entry.html` / `entry.finalUrl` 为输入的网关短路恢复与 5 参 `idLoginResponse`；上游新增的 `recoverLoginEntry` / `isUsableLoginEntry` / `isWebVpnGatewayPage` 是同一问题的另一套实现，未采用（见下节） |
| `tools/login-public-key-test.mjs` | 保留本仓 36–42 号网关用例；上游新增的两条 `recoverLoginEntry` 用例随该实现一并移除 |
| `tools/cloud-calendar-test.mjs` | 两边都追加了独立用例块：并集保留。上游 3 个 CLI 守卫块各自闭合，本仓重复规则块单独成块；159 项检查通过 |

## 未采用的上游网关恢复实现

上游 0.11.4 在 `login()` 里加了 `recoverLoginEntry`：入口页面不可用时直接登出网关、重取一次、
再回落到公开 ID 表单。本仓 0.11.3 起走的是宿主钩子 `onStaleGatewaySession`：只有宿主确认能
清会话时才登出并重取，清不动或没接钩子时保留原分类（`unexpected-page`），并新增
`gateway-session-pinned` 区分「清过仍被钉住」。两者对「没有宿主钩子」的语义相反：
上游会主动登出并回落，本仓保持原行为等待宿主修复。

本次保留本仓语义，理由是它带着更明确的诊断与真机验证，且桌面宿主已经实现该钩子。代价是
没有该钩子的宿主（OH/CLI 路径）暂时拿不到上游的直接 ID 兜底；这一取舍记录在此，若后续需要
该兜底，应在「钩子缺失」分支单独议定，不夹带在历史改写里。

## 验证

- 拓扑：`git rev-list --count upstream/main..main` = 10（8 + 版本跟进 + 本复盘）；
  `git merge-base --is-ancestor upstream/main main` 为 0；无冲突标记。
- 内容无损：改写前后分叉 delta 文件集合都是 81 个，双向差集为空；`git range-diff`
  8 行中 4 行 `=`（逐字节相同）、4 行 `!`（仅因上游上下文调整）。
- 类型：`pnpm --filter @onethu/desktop run typecheck` 通过（上游 0.11.4 给 `packages/gui`
  补了 `@types/react`，改写前本机 tsc 的 React 解析失败一并消失）。
- 用例：`pnpm run test:login` 42 项、`node tools/cloud-calendar-test.mjs` 159 项、
  `pnpm run test`（core 三组 smoke）、`node tools/i18n-test.mjs`（双语 7688 键）全部通过。
- 构建：`pnpm --filter @onethu/desktop run build`、`build:fork` 通过；分叉产物
  `OneTHU-Fork 0.11.4-1`，标识 `app.onethu.desktop.fork`，更新源 `cup113/OneTHU`。
- Rust：`cargo check`（含 harness 与五个 tauri 插件）通过。首次失败是缺少
  `resources/cli-runtime`，该目录由 `apps/desktop/scripts/build-cli-runtime.mjs` 生成，
  cargo 直接跑不会触发 prebuild，生成后复跑通过。
- 守卫：`fork-build-test`、`release-manifest-test`、`update-version-order-test`、
  `desktop-keepalive-test`、`settings-ia-test` 通过。
- 既有红灯（非本次引入，逐条归因）：
  - `pnpm run guard` 在本机于 `tools/contrast-guard.mjs` 停下，报
    `ENOENT D:\D:\Projects\...`。该文件用 `new URL("..", import.meta.url).pathname` 拼路径，
    Windows 上得到 `/D:/...`，再拼一次盘符；同一写法在 5 个工具里存在，CI 走 Linux 不受影响。
  - 逐条跑 guard 链剩余 60 条脚本，22 条红：多数是上述同一路径拼接问题；`ui-copy-lint`
    的 12 处违规在改写前已存在；`icon-test` 与 `board-drag-test` 涉及的源码文件与改写前
    逐字节相同（`git diff edde6dc9 main -- <files>` 为空），红灯不属于本次改写；
    `docs-prose-lint` 的 2 处来自上游新增文档
    `docs/reviews/2026-10-26-oh-app-capabilities.md`。
  - `pnpm run test:oh` 在 `phone-oh-policy-test` 被同一路径拼接问题拦下；
    `schedule-dock-browser-test` 需要 `playwright`，本机未安装。

## 未验证项

- 三端打包未跑：本次只做 `cargo check` 与前端构建，未产出 NSIS/DMG/APK。
- 真机未跑：托盘保活、系统日历同步、重复规则均只过离线用例与构建。
- 上游的直接 ID 兜底未采用，OH/CLI 的网关短路路径未在真机复测。

## 回退

- rebase 前：`git update-ref refs/heads/main 7ee7c2e3`（压缩后、重放前）。
- 改写前：`git update-ref refs/heads/main edde6dc9`（本地与远端都有
  `backup/pre-squash-2026-10-26`）。
- 已推送后：以 `backup/pre-squash-2026-10-26` 为源做一次 `--force-with-lease` 推送。
- 旧 tag `fork-0.11.3-1..7` 未动，仍指向旧提交；`main` 不再包含这些提交，但通过 tag
  仍可追溯已发布版本。本地 `fork-0.11.3-2` 的指向与远端不一致属既有状态，本次未推 tag，
  不受影响。
