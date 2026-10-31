# 分叉历史再压缩：24 个实提交压成 14 个，基线换到上游 38a3aa69

> 最后更新：2026-10-31 15:30

日期：2026-10-31。改写前 `main` = `73d8e4e8`（PR #2 合并提交；其下 24 个实提交，基线
`10e7e4f7`，上游 0.11.4-fix-3）。改写后 14 个提交叠在 `upstream/main` = `38a3aa69`
（上游又走了 4 个提交）之上，随后追加 `0.11.4-6` 的版本跟进。
改写前回退点：`backup/pre-squash-2026-10-31`（=`73d8e4e8`）；压缩后、rebase 前的本地
分支 `squash/2026-10-31`（tip `b894f256`）。

## 为什么先压后换基线

沿用前两轮的做法（见 [fork-squash-rebase-0.11.4](2026-10-26-fork-squash-rebase-0.11.4.md)、
[fork-squash-rebase-0.11.4-fix-3](2026-10-29-fork-squash-rebase-0.11.4-fix-3.md)）：先在旧基线
`10e7e4f7` 上按主题把提交压成「能讲清一个决定」的单元（零冲突），再把这批单元重放到新基线，
冲突只按最终语义判定一次。

本轮上游 4 个提交（`10e7e4f7..38a3aa69`，30 文件 +9040/−16）是 NextTHULearn 插件与课程看板：
`dac5c5fe` 保留官方未读数与课表、`c000eb60` 课程看板、`47aba55c` 品牌资产与截止提醒、
`38a3aa69` 把 OneTHU 与浏览器扩展的发版说明接起来。与本仓增量重叠 5 个文件
（`README.md`、`README.en.md`、两份 i18n locale、`packages/core/src/learn/client.ts`）。

## 24 → 14 映射

| 新提交 | 覆盖的原提交 | 说明 |
| --- | --- | --- |
| `5cd00af2` feat(desktop): dev:app 入口、网关会话恢复与后台常驻保活 | `d69e0832` | 沿用 |
| `1ac0fb47` feat(build): 分叉身份、安卓包与多平台构建隔离，手动发版链路与 CI 护栏 | `d9312d51` `3a999068` | 身份隔离与发版链路本就是一条线 |
| `55ea18b0` feat(schedule): 圆钮拖动与单滚动面板、重复规则编辑器、全天事件横幅行 | `6aa2e95a` `aa43ca3a` `2d8377d5` | 同一页面的三批交互改造，合并后一次说清 |
| `58babaa4` fix(android): 系统日历同步改差异驱动 | `97ae0bfe` | 沿用 |
| `3f7e89f1` fix(desktop): 凭据文件属主接受 Administrators，补齐日历诊断权限 | `44b9340a` | 沿用 |
| `d7197655` fix(tools): Windows 文件路径改用 fileURLToPath，docs-stamp 不要在历史改写后运行 | `17fb5acc` | 沿用 |
| `2f117597` fix(build): 跨架构打包 CLI 运行时，测试不假装验过启动 | `79f98339` | 沿用 |
| `97458c12` fix(win): 私有存储 whoami/icacls 改用 System32 绝对路径，CLI 启动超时放宽 | `0f46f9e9` | 沿用 |
| `345f2e20` fix(learn): 附件失败归因与提交页被拒不再整页报错 | `8dec0ab6` | 沿用 |
| `14114ea1` fix(session): 门户错误 JSON 判会话过期，网络学堂 403 自愈不再复用死凭据 | `5505aee7` `1301ea13` `7708527e` | 三次都在「会话失效如何判定」这一条线上 |
| `ed6e1991` test: 修复离线夹具依赖与保活门面断言两处红灯 | `b1d5acd3` `41b21c3e` | 两条既有红灯的修复 |
| `9bf50991` feat(cli): 分叉包从自己的仓库取 CLI 包，版本与应用对齐 | `c94f3d18` | 沿用 |
| `424f514f` chore(release): 分叉版本跟进到 0.11.4-5，清单说明改为本版内容 | `41da0f83` `9b64a143` | 连续版本跟进与清单文案 |
| `45dcdb71` docs(reviews): 分叉发版与历史改写记录（0.11.4-1..-5） | `b43c326b` `a21574ff` `5e96fd76` `9ca46833` | 发版/改写复盘 |

压缩阶段两项校验：

- 整树等价：`git diff --quiet 73d8e4e8 squash/2026-10-31` 为 0（14 个新提交的最终树与改写前逐字节相同）。
- 单元自洽：14 个提交各自的改动文件集合，与它覆盖的原提交文件并集完全相等（无夹带、无遗漏）。

## rebase 与语义等价

`git rebase --onto 38a3aa69 10e7e4f7` 重放 14 个单元，**零冲突**。这不代表可以跳过比对：
按 `-U0` 取出改写前后两边的增删行（忽略上下文），

```bash
git diff -U0 10e7e4f7..backup/pre-squash-2026-10-31   # 9811 行
git diff -U0 38a3aa69..HEAD                            # 9811 行
```

两边逐行相同（`Compare-Object` 无差集）：换基线没有改动分叉补丁的任何一个增删行。
`packages/core/src/learn/client.ts` 之所以能自动合上，是因为上游的未读数解析与课表改动都在
另一批函数里，与本仓的 403 归因、附件归因不共享行。

## 验证

- 拓扑：`git rev-list --count upstream/main..HEAD` = 14（发版提交前）；`merge-base --is-ancestor` 为 0。
- 类型：`pnpm --filter @onethu/desktop run typecheck` 通过。
- 构建：`pnpm --filter @onethu/desktop run build` 通过（仅既有 dynamic-import 警告）。
- Rust：`cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` 通过（17 条既有 warning）。
- 用例（通过）：`pnpm run test:login`（42 登录公钥 + 8 CAS 恢复 + 67 尝试状态 + 15 账户 Cookie
  边界 + 4 会话守卫 + 10 原生 epoch + 23 网络日志隐私 + 5 组 403 自愈）；`pnpm run test:oh`；
  `schedule-allday`（42 项）；`schedule-week-swipe`（16 项）；`system-calendar-state`（29 项）；
  `cloud-calendar`（159 项）；`learn-attachment-url`（11 项）；`learn-response-recovery`（30 项）；
  `desktop-keepalive`；`i18n-test`（62 项）；`fork-build`（版本已认 0.11.4-6）、`release-manifest`、
  `update-version-order`、`fork-cli-package`（23 项）、`cli-optional-package`。
- 红区（与改写前同一基线，均非本轮引入）：`ui-copy-lint` 12 处、`docs-prose-lint` 4 处
  （都在既有 review 文档）。

## 未验证项

- 三端打包未在本机跑：交给 release workflow 的 github-hosted 三端（Windows NSIS / macOS dmg /
  Android arm64）。
- 真机未跑：403 自愈的卡面刷新、全天横幅、CLI 包下载安装只过离线用例。

## 回退

- 改写前：`git update-ref refs/heads/main 73d8e4e8`（`backup/pre-squash-2026-10-31` 同指）。
- rebase 前（压缩后）：`git update-ref refs/heads/main b894f256`。
- 已推送后：`git push --force-with-lease origin backup/pre-squash-2026-10-31:refs/heads/main`。
- 旧 tag 未动。`fork-0.11.4-6` 由 release 的 publish job 创建，本地不预先打——guard 会把
  已存在的 tag 判为发版失败。
