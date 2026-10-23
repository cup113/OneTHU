# 开发者构建（dev 版独立构建）

> 最后更新：2026-10-21

开发者构建指同一份源码产出的第二套可安装产物：桌面端 `onethu-dev.exe`、Android 端
`OneTHU-Dev` APK。两套产物共用源码，差别来自构建开关 `ONETHU_DEV=1`：正式版里不出现的
调试能力在开发者版进包；Android 端的应用标识、图标与签名也与正式版分开，两者可同时安装。

## 1. 产物差异

| 项 | 正式版 | 开发者版 |
|---|---|---|
| 前端开关 | 不设 `ONETHU_DEV` | `ONETHU_DEV=1` |
| 右上角 | 无 | `dev · <commit>` 徽标，工作区有未提交改动时带 `-dirty` |
| 开发者面板 | 不进包 | commit / 构建时间 / 宿主 / 视口 / 前端日志 / 导出与复制 |
| 前端日志 | 只进 webview 控制台 | 同时写入 Rust 日志链 `onethu-debug.log`，真机可导出 |
| 设置页「运行日志」行 | 隐藏 | 显示 |
| Android 包名 | `app.onethu.desktop` | `app.onethu.desktop.dev` |
| Android 应用名 | OneTHU | OneTHU-Dev |
| Android 图标 | 品牌标（黑底白字 One/THU） | 反色（白底黑字） |
| Android 签名 | 发布 keystore | 独立 dev keystore，首次构建自动生成 |

第三套产物是**分叉包**（`ONETHU_FORK=1`，见 `scripts/build-fork.mjs`），与上面两者都不同：

| 项 | 正式版 | 分叉包 |
|---|---|---|
| 前端开关 | 不设 `ONETHU_FORK` | `ONETHU_FORK=1` |
| 打包标识 | `app.onethu.desktop` | `app.onethu.desktop.fork`（`src-tauri/tauri.fork.conf.json`） |
| 应用名 / 安装目录 | OneTHU | OneTHU-Fork |
| 版本号 | `apps/desktop/package.json` | 同文件的 `version`（如 `0.11.2-1`），经 `ONETHU_VERSION` 注入前端 |
| 打包目标 | `bundle.targets: all` | 只打发布用的那个：Windows `nsis`、macOS `dmg` |
| 更新源 | 上游 GitHub Releases + 清华云盘镜像 | 只查 `cup113/OneTHU` 的 Releases，不启用上游云盘镜像 |

分叉包与正式版可以同时安装：标识不同 → 数据目录与单实例锁分开；应用名不同 → 安装目录分开。
构建命令为 `build:fork`（只出前端）与 `tauri:build:fork`（连打包，可再跟 `--target` / `--no-bundle`）。

分叉版本号的预发布段**只能是纯数字**（`0.11.2-1`、`0.11.2-2` …）。Windows MSI 打包器对带字母的
预发布段直接报错，实测原文：

```text
failed to bundle project: `optional pre-release identifier in app version must be numeric-only
and cannot be greater than 65535 for msi target`
```

所以 `0.11.2-fork.1` 这种写法在 `tauri build` 阶段就会失败；脚本与护栏都会先拦住它，
分叉构建也不再构建 MSI（发布只需要 nsis 的 exe）。


## 2. 构建

桌面端：

```bash
pnpm --filter @onethu/desktop build:dev          # 只出前端 dist
pnpm --filter @onethu/desktop tauri:build:dev    # 连 tauri 打包
```

Android 端（产出与正式版共存的 APK）：

```bash
pnpm --filter @onethu/desktop android:dev
```

两条入口都先置 `ONETHU_DEV=1`，因此不依赖 shell 的前缀赋值语法（Windows 的 cmd 与
PowerShell 不支持该写法）。Android 脚本另有环境变量覆盖，默认值全部由仓库根与 `$HOME`
推导，脚本内不含机器专属路径：

```bash
JAVA_HOME=... ANDROID_HOME=... NDK_HOME=... \
ONETHU_ANDROID_PROJ=... ONETHU_DEV_KEYSTORE=... ONETHU_APK_OUT=... \
pnpm --filter @onethu/desktop android:dev
```

| 变量 | 默认值 |
|---|---|
| `JAVA_HOME` | 由 PATH 上的 `javac` 推导（需 JDK 17 或更高） |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | `$HOME/Android/Sdk` |
| `NDK_HOME` | `$ANDROID_HOME/ndk` 下最后一个 |
| `ONETHU_ANDROID_PROJ` | `$HOME/onethu-android` |
| `ONETHU_DEV_KEYSTORE` | `$HOME/.onethu/onethu-android-dev.keystore` |
| `ONETHU_DEV_KEYSTORE_PASS` | `onethu-dev` |
| `ONETHU_APK_OUT` | `$HOME/Desktop/OneTHU-builds` |

## 3. 实现方式

构建期常量：`apps/desktop/vite.config.ts` 用 Vite 的 `define` 注入 `__ONETHU_DEV__`、
`__ONETHU_COMMIT__`、`__ONETHU_BUILD_TIME__`。commit 取自 `git rev-parse --short HEAD`，
工作区有未提交改动时追加 `-dirty`，仓库无 `.git` 时取 `unknown`。

正式版剔除：`__ONETHU_DEV__` 在正式构建里折叠为 `false`，因此
`Layout.tsx` 的 `const DevPanel = __ONETHU_DEV__ ? lazy(...) : null` 与 `main.tsx` 的
条件动态 `import` 被 rollup 静态删除，开发者面板与日志桥整块不进产物。

Android 变体：`tools/patch-android-dev.py` 幂等改写 `app/build.gradle.kts` 与
`AndroidManifest.xml`（`devBuild` 读 `-PonethuDev` 或 `ORG_GRADLE_PROJECT_onethuDev`），
并从 `apps/desktop/src-tauri/icons/icon.png` 同步各密度图标，另生成反色 dev 图标。不传
开关时 `applicationId`、应用名、图标与版本名与改动前一致。

正式版与开发者版共用 `tools/android-icons.py` 同步原版 Logo，包含普通、圆形及 Android 8+
自适应资源；需要 PATH 中有 FFmpeg。正式版构建在签名后使用 SDK 的 `aapt2` 核对最终 APK
中各密度图标的像素与 Manifest/自适应引用，默认 Tauri 图标会阻断发布。不能只检查源目录。

工程位置：Tauri 生成的 `src-tauri/gen/android` 不入库。`build-dev-apk.sh` 用
`ONETHU_ANDROID_PROJ` 指向仓库外的工程目录并建立符号链接，脚本退出时恢复原链接；工程
不存在时先执行 `tauri android init --ci` 生成再移出仓库。

日志桥：`apps/desktop/src/lib/devlog.ts` 采用有界环形缓冲（300 条上限、单行 400 字符截断、
1.2 秒批量、单次最多 20 行、连续 3 次失败熔断），经既有 Rust 命令 `log_debug` 写入日志文件；
自身行与 `log_debug` 相关行不回灌，避免递归。

## 4. 守卫

```bash
node tools/devtools-test.mjs
```

断言覆盖：dev 分支的加载方式、日志桥的有界性、正式版构建入口不设开关、以及 dev 相关文件
不含机器专属路径。构建脚本另在产物层面复核：开发者包必须含 `/assets/DevPanel-`，正式版
包必须不含。

## 5. 正式版不含 dev 能力的复核

```bash
pnpm --filter @onethu/desktop build
grep -rl "onethu.dev.badge.hidden" apps/desktop/dist/assets || echo "正式版产物无 dev 面板"
```

## 6. 已知限制

- `ONETHU_DEV=1` 影响前端与 Android 应用标识；Rust 命令 `log_debug`、`debug_log_export` 为
  两种构建共有，正式版设置页的入口隐藏但命令仍在。
- dev keystore 不入库。更换机器或删除该文件后，已安装的 dev 包需先卸载再安装新包。
- 正式版与开发者版共用 `apps/desktop/dist`，两种构建交替执行时以最后一次为准。
- 三套产物（正式 / dev / 分叉）共用同一个 `dist`，交替构建时同样以最后一次为准；构建脚本
  末尾会在产物层面复核对应开关是否生效，未生效直接失败，不会静默产出错误的一套。

## 7. 分叉包的发布

- **不打 tag**：本仓是 `smartThise/OneTHU` 的临时 fork，`.github/workflows/release.yml` 只保留
  `workflow_dispatch`。分叉里打 `v*` 会与上游将来的同名 tag 撞车，也会在 Actions 里产出一套
  看着像正式发布的东西。出包一律手动 dispatch，并勾上 `fork`。
- 拉上游用 `git fetch upstream --no-tags`；`git push --tags` / `--follow-tags` 会把上游同名 tag
  推进 fork，是唯一会主动制造冲突的操作。
- 分叉包的更新源是自己仓库的 Releases（`latest.json`），要在自己仓库里维护这份清单，否则
  「检查更新」只会报「没查到」。上游的清华云盘镜像在分叉包里被刻意关闭。清单是**发布资产**，
  名字必须叫 `latest.json`，形状见 `apps/desktop/src/lib/updater.ts` 文件头：版本、`minVersion`、
  `url`（可写相对名，按 `releases/latest/download/` 解析）、`size`、`sha256`、说明与
  `assets.android`；`sha256` 由 Rust 侧流式校验，不符直接丢弃文件。
- 分叉版本形如 `0.11.3-N`，`N` 是分叉自己的发版序号，每次发版加一。版本比较
  （`lib/update.ts` 的 `isNewer`）把数字预发布段算作第四段，否则 `0.11.3-2` 会被判成与
  `0.11.3-1` 相等、更新检查静默失效（护栏：`tools/update-version-order-test.mjs`）。
  正式版 `x.y.z` 的三段语义不变。
- 分叉包**不能**沿用正式版签名与包名发布 Android 包：同包名换签名会安装失败，升级链也会断。
- Android 分叉包在 CI 上构建：`.github/workflows/release.yml` 勾 `android` 输入，走
  `apps/desktop/scripts/build-fork-apk.sh`。runner 上从零生成 Android 工程
  （`tauri android init --config src-tauri/tauri.fork.conf.json`），生成的 `applicationId`
  与 `namespace` 在**编译前**校验一次，产物再用 `aapt2 dump badging` 复核包名与 `versionName`
  一次；两处任一不符即失败，不会静默产出一个包名正确的正式版。
- 本机发布线继续用 `build-release-apk.sh`，两套脚本刻意不合并：前者处理 exFAT 外置盘
  （内盘工程 + 符号链接 + `rootDirRel` 绝对路径改写），CI 的 ext4 上这些前提都不存在。

## 8. Android 发布签名凭据

`build-release-apk.sh` 的签名读 4 个环境变量：`ONETHU_KEYSTORE`、`ONETHU_KS_PASS`、
`ONETHU_KEY_PASS`、`ONETHU_KEY_ALIAS`。手填容易出错，统一由脚本生成：

```bash
python3 tools/android-signing.py                     # 生成到 ~/.onethu/android-signing
python3 tools/android-signing.py --dir /path/to/dir  # 换目录（凭据应跟着出发布包的构建机走）
python3 tools/android-signing.py --self-test         # 临时目录自检，不碰真实凭据
```

产物：`onethu-release.keystore` 加三份等价的环境变量文件（`android-signing.env` / `.ps1` /
`.cmd`）。用法：

```bash
source "<目录>/android-signing.env"          # bash
. "<目录>/android-signing.ps1"               # PowerShell
call "<目录>\android-signing.cmd"            # cmd
```

约束：

- 口令只写在本机文件里，不进命令行参数、不进仓库、不回显；文件权限收到只有当前用户可读写
  （`icacls` 在受限环境会失败，脚本会如实报出来，此时手工确认）。
- 脚本**拒绝覆盖**已有 keystore：换库会让已安装的安卓包无法覆盖升级。要沿用旧库只重写环境
  变量文件时用 `--reuse`（口令从 `ONETHU_KS_PASS` 读，缺省交互式询问）。
- **PKCS12 只有一个口令**：`ONETHU_KEY_PASS` 与 `ONETHU_KS_PASS` 必须同值。keytool 对
  `-keypass` 是「忽略并警告」而不是报错，两个口令分开写时生成阶段一切正常，直到 apksigner
  真去解私钥才报 `UnrecoverableKeyException: Given final block not properly padded`
  （2026-10-23 分叉包 CI 实测，见 `docs/plans/2026-10-23-fork-build-isolation.md`）。
  生成器在落盘前用 jarsigner 真解一次私钥，生成与 `--reuse` 两条路径都验。
- keystore 与口令要备份。丢失后只能换新库，届时已装用户必须先卸载再安装。
- 脚本打印的证书 SHA-256 应与已发布包的证书一致：
  `apksigner verify --print-certs <apk>`。不一致说明这次用的不是同一套签名库。

### CI 上的签名（GitHub Secrets）

`release.yml` 的 android job 读 4 个 secret，名字与上面 4 个环境变量一一对应：

| secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `onethu-release.keystore` 的 base64 |
| `ANDROID_KS_PASS` | keystore 口令 |
| `ANDROID_KEY_PASS` | 私钥口令 |
| `ANDROID_KEY_ALIAS` | 私钥别名 |

写入方式（口令走 stdin，不进 argv、不回显）：

```bash
source "<目录>/android-signing.env"
printf '%s' "$ONETHU_KS_PASS"  | gh secret set ANDROID_KS_PASS  --repo cup113/OneTHU
printf '%s' "$ONETHU_KEY_PASS" | gh secret set ANDROID_KEY_PASS --repo cup113/OneTHU
printf '%s' "$ONETHU_KEY_ALIAS" | gh secret set ANDROID_KEY_ALIAS --repo cup113/OneTHU
base64 -w0 "<目录>/onethu-release.keystore" | gh secret set ANDROID_KEYSTORE_BASE64 --repo cup113/OneTHU
```

约束：

- 缺 `ANDROID_KEYSTORE_BASE64` 时 android job 仍然成功，但产物名带 `-unsigned`：未签名 APK
  无法安装，也没有证书可比对，仅用于验证构建链。这个后缀由构建脚本决定，workflow 不另行
  改名，因此未签名包不会顶着发布包的名字出现。
- 构建脚本在**编译前**先用 jarsigner 解一次私钥：口令不对会在一秒内失败并指明是哪一步，
  而不是等十几分钟编译之后才在 apksigner 报加密异常。
- keystore 一旦上传就固定下来：同包名换签名会触发 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，
  已装用户必须先卸载。换库时 4 个 secret 要一起换。
- 构建机不需要保留 keystore 副本；CI 每次从 secret 还原到 runner 的临时目录，job 结束即消失。


