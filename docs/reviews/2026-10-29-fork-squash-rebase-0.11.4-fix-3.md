# 分叉历史再压缩：35 个提交压成 15 个，基线换到上游 0.11.4-fix-3

> 最后更新：2026-10-29 22:10

日期：2026-10-29。改写前 `main` = `47c00aa9`（35 个提交 + 1 个 PR 合并，基线 `370be7ee`，
上游 0.11.4-fix-1）。改写后 15 个提交叠在 `upstream/main` = `10e7e4f7`（上游 0.11.4-fix-3）之上，
随后追加两条红灯修复、CLI 分叉化、复盘与版本跟进（`0.11.4-5`），共 21 个提交。
回退点：`backup/pre-squash-2026-10-29`（=`47c00aa9`，本地与远端都有）、本地
`squash/2026-10-29`（压缩后、rebase 前，tip `375f4d9e`）。已按人工核验推送：
`47c00aa9...9b64a143 main -> main (forced update)`。

## 为什么先压后换基线

上游这 7 个提交里有一个 163 文件的巨提交（`c1b3e394`，+25649/−23866），与本仓 12 个文件重叠。
逐提交重放会让同一批文件被反复判定；先在旧基线上把同主题提交压成一个（零冲突），再把 15 个
单元重放到 `10e7e4f7`，冲突只按最终语义判定一次。上一轮同样的做法见
[fork-squash-rebase-0.11.4](2026-10-26-fork-squash-rebase-0.11.4.md)。

## 35 → 15 映射

| 新提交 | 覆盖的原提交 | 说明 |
| --- | --- | --- |
| `d69e0832` feat(desktop): dev:app 入口、网关会话恢复与后台常驻保活 | `4c86a50a` | 沿用 |
| `d9312d51` feat(build): 分叉身份、安卓包与多平台构建隔离 | `4b286f7b` | 沿用 |
| `3a999068` feat(ci): 分叉手动发版链路、CI 护栏与 macOS 构建机覆盖 | `6e6a86ae` `a882061d` `344a3fbf` | 发版链路 + CI 护栏/NDK 覆盖 + 构建机覆盖本就是一条线 |
| `6aa2e95a` fix(schedule): 悬浮圆钮可拖动，设置面板收成单滚动并给手机换底部 Sheet | `f6923de6` | 沿用 |
| `5505aee7` fix(auth): 门户错误 JSON 判为会话过期，静默重登不再空转 | `d92840f7` | 沿用 |
| `97ae0bfe` fix(android): 系统日历同步改差异驱动 | `18146354` | 沿用 |
| `aa43ca3a` feat(schedule): 自定义日程编辑器支持设置重复规则 | `8612f9e8` | 沿用 |
| `44b9340a` fix(desktop): 凭据文件属主接受 Administrators，补齐日历诊断权限 | `1df1d016` | 沿用 |
| `17fb5acc` fix(tools): Windows 文件路径改用 fileURLToPath，docs-stamp 不要在历史改写后运行 | `550e370c` `c7f39580` | 同一处 Windows 路径拼接问题的修与说明 |
| `79f98339` fix(build): 跨架构打包 CLI 运行时，测试不假装验过启动 | `31b6a077` `814a7899` | 补丁与它的用例是同一条取舍 |
| `0f46f9e9` fix(win): 私有存储 whoami/icacls 改用 System32 绝对路径，CLI 启动超时放宽 | `dde1b8b9` `93ace932` | 两处都是 Windows 平台适配 |
| `8dec0ab6` fix(learn): 附件失败归因与提交页被拒不再整页报错 | `0661fc26` `c91207f3`（含 PR #1 合并） | 同一批网络学堂失败归因 |
| `2d8377d5` feat(schedule): 全天事件改为星期列对齐的横幅行（方案 A）与可交互 Demo | `721b4a41` `cc4fb551` `47c00aa9` | Demo 与实现同一条方案 |
| `41da0f83` chore(release): 分叉版本跟到 0.11.4-4，清单说明改为本版内容 | `9f7503f2` `9c4bcd8a` `cb14b34d` `c2afd8a0` `c4029d05` `b42f0705` | 连续版本跟进与清单文案 |
| `b43c326b` docs(reviews): 分叉发版与历史改写记录（0.11.4-1..-4） | `82e1d30a` `5c0ea470` `9ef476f3` `925b092b` `d9db5cde` `d76aa085` `7dd81d9e` | 发版/改写复盘 |

压缩阶段两项校验：

- 整树等价：`git diff --quiet 47c00aa9 squash/2026-10-29` 为 0（15 个新提交的最终树与改写前逐字节相同）。
- 单元自洽：15 个提交各自的改动文件集合，与它覆盖的原提交文件并集完全相等（无夹带、无遗漏）。

## 冲突与判定

rebase 只出现 3 处冲突，集中在 2 个文件：

| 位置 | 判定 |
| --- | --- |
| `.github/workflows/release.yml` | 采用上游新的三步（`cli-optional-package-test` → `package-cli.mjs` → `bundled-cli-startup-test`），保留本仓给 `Build desktop bundles` 的 `ONETHU_FORK_VERSION` 覆盖；产物清单两侧自动合并后同时含 `output/cli-package/*.zip` 与分叉的 `OneTHU-Fork.exe` |
| `apps/desktop/src/pages/Schedule.tsx`（U4） | 以上游为基线（`schedule-week` 包裹、百分比几何、`moveAnchor` 周滑动、`windowResult` 缓存优先），再套本仓的设置面板重构：`panelBody` 单一正文、桌面 Popover / 手机 Sheet 二选一、首行「＋ 添加日程」、圆钮拖动与位置记忆、`og-schedule-pop` 样式锚点 |
| `apps/desktop/src/pages/Schedule.tsx` + `schedule.css`（U13） | 全天横幅整块留在上游的 `schedule-week` 内层：表头与横幅一起吸顶（`.schedule-head { flex: none }` + sticky），画布继续走上游的百分比几何；`+N` 弹层与空周判定取本仓语义（有全天横幅不算空周） |

面板合并时出过一次失误并当场修正：`panelBody` 的切片按子串 `  );` 定位，误截到嵌套调用的
`    );` 上，面板后半（筛选/跳转/同步/收藏）整段丢失；`tsc` 报 `JSX element 'div' has no
corresponding closing tag` 后按整段重放修回，并复跑类型检查。

## 上游那个「巨大提交」是什么

`c1b3e394 fix: unify OH services and calendar data with optional CLI distribution for fix-2`，
163 文件 +25649/−23866，实际构成：

| 分组 | 文件 | 占变更行数 |
| --- | --- | --- |
| `docs/i18n/batches/*.json` | 96 | 95.0% |
| `docs/` 其他（catalog、发布说明、ADR） | 10 | 2.1% |
| `apps/desktop/src-tauri/` | 9 | 1.0% |
| 桌面前端 TS/TSX | 16 | 0.8% |
| 其他（tools、README、CI） | 32 | 1.1% |

i18n 批次那 96 个文件的语义差异只有两样：`sourceHash` 变化、`locations[].line` 因源码行移动而
整体漂移（抽样 `001.json`：80 条消息里 43 条完全未变、23 条只差 `locations`、14 加 14 删来自
重新分批）。**这批文件是 `tools/i18n/build-handoff.mjs` 的再生成物，不应当手写合并**；本仓对
`docs/i18n/` 只有 `extracted.json` 一处改动，冲突为零。真正的代码改动是两件事：

1. **CLI 运行时可分离安装**（`cli_package.rs` +407 行）：应用包不再内嵌 Node 运行时。
   `tauri.windows.conf.json` 的 `resources/cli-runtime/` 被删空，`prebuild.mjs` 只在
   `ONETHU_BUILD_CLI_PACKAGE=1` 时才构建运行时，发版流程改为单独产出
   `output/cli-package/OneTHU-CLI_<version>_<platform>_<arch>.zip`。`cli_daemon.rs` 的
   `resource_dir()` 随之改成「装好的包 + 版本必须等于应用版本」，否则报
   `CLI_PACKAGE_NOT_INSTALLED` / `CLI_PACKAGE_UPDATE_REQUIRED`。
2. **OH 服务与日历数据统一**（`sharedCalendar.ts`、`cloudCal.ts` 改走
   `readCalendarDocument`、`desktop.dataRead/dataWrite/cloudSync` 等新 RPC）。

## 对分叉的影响（1–3 已在同日落地，见文末「后续」）

1. **分叉 CLI 会直接不可用**：`cli_package.rs` 把来源写死成
   `api.github.com/repos/smartThise/OneTHU/releases/tags/v{version}`、
   `github.com/smartThise/OneTHU/releases/download/v{version}/…` 与清华云盘的分享链接，
   `version` 取 `app.package_info().version`——分叉包是 `0.11.4-4`，上游没有 `v0.11.4-4`
   这个 tag，云盘侧的 `metadata.version` 也对不上。结果是分叉用户点「安装 CLI」永远下载失败。
2. **版本对齐还有第二处缺口**：`build-cli-runtime.mjs` 把 `packages/cli/package.json` 的版本写进
   `runtime.json`，而分叉只改 `tauri.fork.conf.json`（`0.11.4-4`）与前端注入。即使手工装上了
   上游的 `0.11.4-fix-3` CLI 包，版本比对仍然不等，应用会持续提示需要更新。
3. **发版产物少一件**：上游 `release.yml` 会构建 CLI 包并上传 artifact，但本仓的 `publish` job
   只发布 `*.exe / *.dmg / *.apk / latest.json`，CLI zip 不会被发布出去。
4. **本仓两条跨架构补丁仍然有效但落点变了**：`build-cli-runtime.mjs` 仍被 `package-cli.mjs`
   调用，`79f98339` 的「同 OS 跨架构不用宿主 Node」与启动测试的「跨架构不假装验过启动」仍成立；
   只是它现在服务的是可选 CLI 包，而不是应用内嵌运行时。

落地方式见文末「后续」；历史改写本身没有夹带这些改动。

## 验证

- 拓扑：`git rev-list --count upstream/main..HEAD` = 15；`git merge-base --is-ancestor
  upstream/main HEAD` 为 0；无冲突标记。
- 类型：`pnpm --filter @onethu/desktop run typecheck` 通过。
- 构建：`pnpm --filter @onethu/desktop run build`、`run build:fork` 通过（产物
  `OneTHU-Fork 0.11.4-4`，标识 `app.onethu.desktop.fork`，更新源 `cup113/OneTHU`）。
- Rust：`cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` 通过（17 条既有 warning）。
- 用例（通过）：`pnpm run test:login`（含 23 项网络日志隐私检查）；`i18n-test`；`schedule-allday`
  （42 项）；`schedule-week-swipe`；`cli-optional-package`；`updater-native-epoch`；
  `learn-attachment-url`、`learn-resource-enumeration`、`learn-response-recovery`；
  `yuketang-runtime-sync`；`fork-build`、`release-manifest`、`update-version-order`、
  `desktop-keepalive`、`settings-ia`、`motion`、`update-check-lifecycle`、
  `desktop-lifecycle-policy`、`cli-session-handoff`、`native-session-epoch`、`test:oh` 的前四项。
- 红区（逐条归因，均非本次改写引入；前两条随后已修，见「后续」）：
  - `tools/cloud-calendar-test.mjs` 在 fixture 处报
    `Cannot destructure property 'readCalendarDocument' of … ["./sharedCalendar.js"] as it is
    undefined`。上游 `cloudCal.ts` 已改为 `import … from "./sharedCalendar.js"`（4 处），
    但同一个提交没有给这个离线 fixture 的 `deps` 表补该项——**上游自带红灯**：上游 `release.yml`
    与本仓 CI 都不跑这个文件，所以一直没人发现。本仓在该文件末尾追加的重复规则用例因此失去执行机会。
  - `pnpm run test:oh` 中 4 项通过，`phone-oh-policy-test` 卡在
    「启动未调用 syncOverlayPreference」。这条断言自 0.11.4 起就过期了：本仓把那条独立调用
    换成了 `syncDesktopKeepAlive()` 门面（`desktopKeepAlive.ts` 内部仍调 `syncOverlayPreference`
    6 次，`main.tsx` 调门面 2 次）；改写前的 `47c00aa9` 同样直接调用 0 次，属既有红灯。
  - `ui-copy-lint` 12 处（改写前即 12 处）、`docs-prose-lint` 4 处（都在既有 review 文档）、
    `schedule-dock-browser-test` 需要 playwright（本机未安装）。

## 未验证项

- 三端打包未跑：未产出 NSIS/DMG/APK，只做前端构建与 `cargo check`。
- 真机未跑：周滑动动画、全天横幅吸顶、圆钮拖动、手机 Sheet 均只过离线用例与构建。
- CLI 包的完整链路只验证到「本机打包 + 校验和 + 启动」；真实 GitHub Release 的
  `releases/tags/fork-<version>` 查询与资产下载要在发版后才有真数据。

## 后续：CLI 分叉化与两条红灯（同日落地）

- `b1d5acd3` test(cloud-calendar)：夹具补 `./sharedCalendar.js`（按同一套 data: 模块注入）
  与 `../lib/sharedRuntime.js`（恒 false，误走共享分支就大声失败）。159 项检查恢复执行，
  其中包含本仓追加的重复规则用例。
- `41b21c3e` test(oh)：启动守卫改认 `syncDesktopKeepAlive()` 门面 + 门面内调
  `syncOverlayPreference()`。把门面调用删掉时断言当场失败（验证后按字节还原）。
- `c94f3d18` feat(cli)：
  - `cli_package.rs` 加编译期开关（`option_env!("ONETHU_FORK")`，只由 `build-fork.mjs` 设置），
    仓库与 tag 跟着构建身份走（分叉 `fork-<version>`），分叉不退回校园云盘镜像；
  - 新增 `apps/desktop/scripts/cli-package-version.mjs`：CLI 包版本 = 应用版本
    （`ONETHU_CLI_VERSION` → `ONETHU_FORK_VERSION` → `tauri.fork.conf.json` →
    `packages/cli/package.json`），并拒绝会破坏文件名/清单的版本串；
  - `build-cli-runtime.mjs` 同时改写包内 `package.json` 与 `packages/sdk/src/index.ts` 的
    `VERSION` 常量（`daemon.status` 报的就是它，只改前者会握手失败），构建完按字节还原；
  - 发版链路构建 CLI 包时传分叉开关与版本，`publish` 把 `OneTHU-CLI_*.zip` 与 `.sha256`
    一起发；守卫 `tools/fork-cli-package-test.mjs`（23 项）进 CI。

  验证：`cargo check` 两条分支都通过；`ONETHU_FORK=1` 时用 `const _: () = assert!(!FORK_BUILD)`
  探针确认编译期开关真生效（探针已按字节还原）。`ONETHU_FORK=1` 实打产出
  `OneTHU-CLI_0.11.4-4_win32_x64.zip`：包内 `package.json`、`runtime.json` 都是 `0.11.4-4`，
  资产名与 `cli_package.rs` 拼出来的完全一致；`bundled-cli-startup-test` 通过
  （`✓ packaged win32/x64 0.11.4-4`），daemon 自报版本已对齐。guard 抓违规的能力也验过：
  把 tag 改回 `v{version}` 会当场红。

## 回退

- 改写前：`git update-ref refs/heads/main 47c00aa9`（`backup/pre-squash-2026-10-29` 同指）。
- rebase 前（压缩后）：`git update-ref refs/heads/main 375f4d9e`。
- 已推送后：远端有备份分支，回退即
  `git push --force-with-lease origin backup/pre-squash-2026-10-29:refs/heads/main`。
- 旧 tag 未动。`fork-0.11.4-5` 由 release 的 publish job 创建，本地不预先打——guard 会把
  已存在的 tag 判为发版失败。
