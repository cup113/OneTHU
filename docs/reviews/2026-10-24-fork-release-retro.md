# 分叉发版这一轮：改历史、接自动化、修图标

日期：2026-10-24。覆盖 `9029e7c1`（0.11.2 基线）到 `f85a760c`（自动化补完）这一段工作：
把 14 个提交压成 4 个并 rebase 到上游 0.11.3、把手动发版接进 workflow、修掉 Android
默认图标、以及一轮「分叉仓库能不能写 Release」的探针实验。

## 一、踩到的坑

### GitHub Actions

- **Windows runner 的默认 shell 是 pwsh**：多行 `run:` 只有最后一条命令决定退出码。
  实测同一步骤在 Windows 上同样断言失败、step 却是绿的，只有 macOS（bash）报红。
  现在 desktop job 统一 `defaults.run.shell: bash`，鉴权守卫收成 `pnpm run test:login`。
- **`setup-android@v3` 的 `packages` 默认值含 `tools`**，该包已从 SDK 仓库移除，job 在第一步
  就失败。改成 `packages: ""` + 显式装 `platforms;android-36` / `build-tools` / `ndk;…`。
- **`gh release delete` 默认保留 tag**：删了 Release 再发同版本仍报 tag 已存在，要 `--cleanup-tag`。
- **`releases/latest/download/*` 有时序**：刚建完 Release，`latest` 可能还指向上一个版本。
  回读校验要重试，并核对清单版本号。

### 护栏

- **文本断言会被注释喂饱**：`/-unsigned\.apk/` 命中的是 `find -name '*-unsigned.apk'`（输入），
  `/apksigner" verify/` 命中的是 `verify --print-certs`，`/jarsigner/`、`/ONETHU_FORK_VERSION/`
  也都先命中注释。断言要落在真正执行的那一行。
- **否定断言不该读注释**：`!/permissions\.push/` 被自己新增的注释绊倒。现在先剥注释行再匹配。
- **「查不了」不能当成「没有」**：`git ls-remote --exit-code origin …` 在没有 checkout 的 job 里
  必以 128 失败，`if` 判假就静默放行——等到 publish 才发现 tag 已存在，一轮三端构建作废。
  改成 `gh api`，只有 404 算「不存在」，其它失败一律红。

### Android

- **`tauri android init` 只生成模板默认图标**，不会把仓库 logo 编译进工程。发布线脚本里有
  「同步 + 产物校验」两步，分叉脚本漏了——这就是这次图标问题的全部原因。现在构建前同步、
  产物出来后像素级复核（15 张编译进包的 PNG 比对规范 logo + launcher/adaptive 绑定）。
- **PKCS12 只有一个口令**，`keytool -keypass` 是「忽略并警告」而不是报错，只有 `getKey` 才炸。
  用 `jarsigner` 做同路径预检，1 秒替代一整轮编译。
- `tools/android-icons.py` 按 locale 解码 aapt2 输出（Windows=GBK）→ `UnicodeDecodeError`；
  强制 UTF-8 后它在 Windows 上也能用来复核。

### 版本与更新源

- Windows MSI 只接受**纯数字**预发布段（≤65535），所以分叉版本是 `x.y.z-N`。
- 真正的坑在应用自己的比较器：`isNewer` 原来只比前三段，`0.11.3-2` 与 `0.11.3-1` 相等 →
  **下一次分叉发版静默不升级**。新版本方案必须用应用自己的比较器验证。

### Git 历史改写

- `git cherry-pick -n A B C` 中途冲突后 `--continue` 会被拒（工作树脏）→ 一条一处 `-n`，
  冲突后 `--quit` 再继续。
- **先压后 rebase**：先在旧基线把同主题提交压成一个（零冲突），再把 4 个压好的提交重放到
  上游——冲突只出现 4 次而不是 14 次。
- force push 被工具桥拒绝，需要一次提权；先建 `backup/pre-rebase-*` 引用。

## 二、一次归因事故

线上出现一个「不是我主动触发」的 `fork-0.11.3-2` Release，当时的推理是「自动化在我不知情的
情况下发了版」，并据此展开调查。实际情况是**用户在界面上点的**。

教训：归因不明时先问一句，或先看 run 的 `event` 与 actor，再决定要不要调查。把「我没触发」
当成「没人触发」，会把一次正常操作写成一场事故。

## 三、探针实验：分叉仓库能不能写 Release

`publish` 曾报 `HTTP 403: Resource not accessible by integration`，当时给出并写进文档的解释是
「fork 封死了 `GITHUB_TOKEN` 的写权限，job 级 `permissions` 也救不了」。四组对照
（`probe-fork-token.yml`，只建 draft release，建完即删）把这条解释推翻了：

| 对照 | 结果 |
| --- | --- |
| job 声明 `permissions: contents: write` + `gh api POST /releases` | **成功**（draft 建成） |
| 同一 job 不声明 permissions | 403 |
| 同权限 + `gh release create --draft --target` | **成功** |
| 同权限 + `rerun --failed` 之后（`run_attempt=2`） | **成功** |

另外发现：`GET /repos/<repo>` 的 `.permissions.push` 在**能建 Release 的 token 上也是 false**。
拿它做写权限预检会误拦正确发布——这是当时 guard 里的真实缺陷，已改成「真建一个 draft 再删」。

未解释的遗留：那次 `publish` 重跑的 403 至今没有查明原因（同样的声明在探针里可用）。
若再次出现，先看 guard 的写权限自检是否通过：通过就说明问题不在权限。

## 四、其它未验证项

- 「早期那版 `fork-0.11.3-2` 也是默认图标」只是按 APK 大小与 0.11.3-1 相同推断的，没有跑过
  校验器（包已删除重发）。
- `shell: bash` 只在 github-hosted runner 上验证过，自建 Windows runner 的 Git Bash 没试。

## 五、结果

- 历史：`main` 上 4 个提交叠在上游 0.11.3 之上；回退点 `backup/pre-rebase-0.11.2`。
- 自动化：手动触发可选 `version` 与 `release`，`publish` 生成 `latest.json` 并建
  `fork-<version>` Release，最后回读清单复核。
- 线上：`fork-0.11.3-2` 的三端产物都来自图标修复后的构建（CI 日志
  `APK logo verified: 15 compiled PNGs match canonical pixels`），清单三端 sha256 与服务端
  digest 一致。
