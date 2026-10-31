# 分叉 rebase 到上游 0.11.4-fix-1

> 最后更新：2026-10-27 18:05

日期：2026-10-27。旧基线 `a4f3210c`（上游 0.11.4）→ 新基线 `370be7ee`（上游 0.11.4-fix-1）。
分叉侧 19 个提交按原顺序重放，冲突 3 个文件。

## 1. 为什么跟

上游 `0.11.4-fix-1` 修的正是我们 `0.11.4-2` 踩的同一类故障（见
[0.11.4-2 发布记录](2026-10-27-release-0.11.4-2.md)），而且它还补了两处我们没做的：

- `1e8ebfa3` 驻留会话恢复期间不再把登录锁死（`AUTH_IN_PROGRESS` 的永久拒绝）。
- `cli_daemon.rs` 把 daemon 的 stderr 落到 `daemon-startup.log`，启动失败时把机器码拼进错误
  （`CLI_DAEMON_START_FAILED: AUTH_STORAGE_ACL_FAILED`）——这正是排查本次故障时最缺的一条信息。
- `2f809652` 把私有目录 ACL 的写法换成显式 .NET 构造（带 15s 超时与失败阶段标记）。

## 2. 冲突与取舍

| 文件 | 冲突内容 | 取舍 |
| --- | --- | --- |
| `.github/workflows/release.yml` | 上游新增 `--bundles nsis` 逻辑与两个步骤（校验内置运行时、记录冻结来源）；分叉要保留 fork 入口与 `ONETHU_FORK_VERSION` | 分叉分支自带 `--bundles nsis`（`build-fork.mjs` 决定），非分叉分支保留上游的 Windows 选择；`ONETHU_FORK_VERSION` 放回构建步骤 env，上游两个新步骤原样保留 |
| `apps/desktop/src/lib/update.ts` | 上游只把 `-fix-N` 当第四段，分叉要认纯数字 `-N` | 合并为一条正则 `-(?:fix-)?(\d+)$`，两者都进第四段；`isNewer` 固定比较 4 段 |
| `packages/sdk/src/node/storage.ts` | 分叉用 `icacls`，上游换成 .NET `SetAccessControl` + 超时 + 阶段标记 | 按「上游已解决就丢掉自己的补丁」采纳上游；分叉那次提交重写为只保留另外两处 |

## 3. 保留的分叉独有改动

- `cli_daemon` 的凭据文件属主检查接受 `BUILTIN\Administrators`（上游仍是 `EqualSid(owner, sid)`）。
- `onethu-calendar` 的 `sync_trace` allow 权限（上游没动这个插件）。
- 分叉身份与手动发版链路、自定义日程重复规则、Android 日历差异同步等既有提交原样重放。

## 4. 校验

- 冲突标记残留 0 处。
- `tsc -p packages/sdk/tsconfig.json --noEmit`、`pnpm --filter @onethu/desktop run typecheck`、
  `cargo check`（应用 crate）全部通过。
- 护栏：`tools/fork-build-test.mjs`、`tools/update-version-order-test.mjs`、
  `tools/release-manifest-test.mjs`、`tools/windows-session-storage-test.mjs` 全部通过。
  最后一项在 Low 完整性沙箱里会因 ACL 受限假失败，需在普通完整性环境运行。

## 5. 版本与回退

- 分叉版本 `0.11.4-2` → `0.11.4-3`：内容已不同于已发布的 0.11.4-2，同号不同内容会让更新判断失真
  （`tools/fork-build-test.mjs` 也钉住了「分叉版本不能与正式版同号」）。
- 备份分支 `backup/pre-rebase-0.11.4-fix-1`；`fork-0.11.4-2` tag 仍指向旧世系，
  回退用 `git reset --hard backup/pre-rebase-0.11.4-fix-1` 并 force push。
