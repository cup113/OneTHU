# 分叉构建：与上游发布链路隔离

本仓是 `smartThise/OneTHU` 的临时 fork（`cup113/OneTHU`，ADMIN）。开发分支上要能发自己的包，同时不能和上游的发布链路互相干扰。两个具体风险：

1. **tag 撞车**：`.github/workflows/release.yml` 原来监听 `push: tags: ["v*"]`。fork 里打同名 tag 会与上游将来的 `v0.11.3` 之类冲突，也会在 Actions 里产出一套看着像正式发布的东西。
2. **自动更新相撞**：`lib/updater.ts` 的清单地址写死上游 `smartThise/OneTHU`，备用源是上游的清华云盘分享。分叉包一检查更新，会把用户带到上游安装包；打包标识又与原版相同，装上去直接把分叉顶掉。

## 决策

| 决策 | 取值 | 理由 |
| --- | --- | --- |
| 发布触发 | 只留 `workflow_dispatch`，删掉 `v*` tag 触发器 | fork 里不需要 tag 驱动；手动 dispatch 已够用，且现有 `only_windows` / `no_bundle` 输入可继续用 |
| tag 命名 | 不在 fork 里打 `v*`；需要标记时用 `fork/…` 前缀或不打 | 只有 `push --tags` / `--follow-tags` 会真正制造冲突，前缀让误操作也不可能命中上游命名 |
| 拉上游 | `git fetch upstream --no-tags` | tag 与分支无关，rebase 不受影响；避免把上游 tag 引进 fork |
| 打包标识 | 分叉包 `app.onethu.desktop.fork`，应用名 `OneTHU-Fork` | 标识决定数据目录与单实例锁，应用名决定安装目录；两者都改才谈得上「并存」 |
| 版本号 | 分叉包 `0.11.2-1`（`tauri.fork.conf.json` 单点定义，经 `ONETHU_VERSION` 注入前端） | 不与上游同号；界面版本与安装包版本是同一个字符串；预发布段必须是纯数字（见下） |
| 打包目标 | 分叉构建只打发布用的那个：Windows `nsis`、macOS `dmg` | 发布链路从不使用 MSI；少打一个目标既避开它的版本限制，也省一半打包时间 |
| 更新源 | 分叉包只查 `cup113/OneTHU` 的 Releases，关闭上游云盘镜像 | 上游镜像里的包是上游构建，装上去等于回退分叉 |
| 正式版 | 一行不改（默认 `__ONETHU_FORK__` 为 false） | 分叉能力对正式构建零影响 |

## 实施

- `apps/desktop/src-tauri/tauri.fork.conf.json`（新增）：`productName` / `version` / `identifier` 三项覆盖，用 `tauri build --config` 合并到基础配置。
- `apps/desktop/scripts/build-fork.mjs`（新增）：置 `ONETHU_FORK=1` 与 `ONETHU_VERSION`，调用 `tauri build --config`；末尾在 `dist` 里复核「分叉更新源标记 + 分叉版本号」，开关没生效直接失败。
- `apps/desktop/vite.config.ts`：注入 `__ONETHU_FORK__`；`__APP_VERSION__` 支持 `ONETHU_VERSION` 覆盖。
- `apps/desktop/src/globals.d.ts`：声明 `__ONETHU_FORK__`。
- `apps/desktop/src/lib/updater.ts`：仓库地址按开关切换；新增 `CLOUD_MIRROR_ENABLED`，分叉构建的源列表只有 GitHub 一条。
- `apps/desktop/package.json`：`build:fork` 与 `tauri:build:fork`。
- `.github/workflows/release.yml`：删 tag 触发器，新增 `fork` 布尔输入，构建步骤按输入切换脚本，产物名带 `-fork`。
- `tools/fork-build-test.mjs`（新增）：四条护栏（触发器形状、标识/版本分离、开关链路、构建入口）。

## 验证

- `node tools/fork-build-test.mjs` 通过；三处注入（加回 tag 触发器、标识改回正式版、关掉云盘镜像开关）各自变红，还原后字节一致。
- `pnpm --filter @onethu/desktop run build:fork` 通过，脚本自校验命中分叉标记与分叉版本号。
- `pnpm --filter @onethu/desktop run build` 通过，产物里只有上游地址、没有分叉地址与分叉版本号（正式构建未被影响）。

## 首次真实 CI 运行（2026-10-23，run 39953455037）

`workflow_dispatch` + `fork=true` + `only_windows` 跑通了所有检查步骤与 Rust 编译，在打包阶段失败：

```text
failed to bundle project: `optional pre-release identifier in app version must be numeric-only
and cannot be greater than 65535 for msi target`
```

原因是初版选了 `0.11.2-fork.1`：MSI 目标的预发布段只接受纯数字数值。两处修正：

1. 分叉版本改为 `0.11.2-1`（脚本与护栏都只接受 `<主>.<次>.<补丁>-<纯数字≤65535>`）；
2. 分叉构建只打发布实际使用的目标（Windows `nsis`、macOS `dmg`），不再陪跑 MSI。

`tauri build --config` 这条新路径本身是通的（配置合并、`ONETHU_FORK` 注入、产物自校验都已执行到打包前），
失败点只在那条版本规则。

## Android 分叉包（同日补）

Android 不能沿用正式版的包名与签名（同包名换签名会 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`），
所以分叉发布同时需要独立包名与独立 keystore。实现：

- `apps/desktop/scripts/build-fork-apk.sh`（新增）：Linux 构建机专用。每次从零生成 Android
  工程，`tauri android init/build` 都带 `--config src-tauri/tauri.fork.conf.json`；编译前校验
  生成的 `applicationId`/`namespace`，产物再用 `aapt2 dump badging` 复核包名与 `versionName`。
  签名材料从 `ONETHU_KEYSTORE` 等 4 个环境变量读；缺 keystore 时产物名带 `-unsigned`。
- `.github/workflows/release.yml` 新增 `android` 输入与 `android` job（ubuntu-latest、JDK 17、
  SDK 36、NDK 28.2.13676358、`aarch64-linux-android`）。
- `tools/fork-build-test.mjs` 扩到九条护栏；九处注入各自变红，还原后字节一致（SHA-256 比对）。

本机实测（探针工程跑 `tauri android init --config`，不碰入库的 `gen/android`）：

- `--config` 确实把包名带进生成工程：`applicationId`/`namespace` 都是 `app.onethu.desktop.fork`；
- 生成工程是 AGP 8.11.0 + Gradle 8.14.3，`compileSdk`/`targetSdk` = 36、`minSdk` = 24
  （NDK clang 包装器因此用 `aarch64-linux-android24-clang`）；
- 模板里没有 `ndkVersion`，AGP 不校验 NDK 版本，NDK 只提供 clang/sysroot（rquickjs 的 bindgen
  与链接器要用）；
- `versionCode` 不由版本号推导：`tauri.conf.json` 的 `bundle.android.versionCode` = 11011 固定，
  `versionName` 取配置版本（`0.11.2-1` 在 Android 上合法，与 MSI 的限制无关）。

分叉 Android 签名库（`tools/android-signing.py` 生成，入库为 4 个 secret，keystore 本体只在
`~/.onethu/android-signing` 与 GitHub 之间流转）：

```text
证书 SHA-256：67:54:DF:98:4A:0B:B3:3E:E9:55:C9:FE:51:84:20:6A:CA:A8:43:26:1A:B2:FF:84:54:47:B7:D6:88:92:89:A2
别名：onethu-release
```

`apksigner verify --print-certs <apk>` 与上表不一致，说明这次不是同一套签名库。换库等于已装用户
必须卸载重装，因此 keystore 与两份口令要单独备份。

## 第二次真实 CI 运行（2026-10-23，run 39964971728）

android job 前面全部通过（SDK 36、NDK 28.2、`aarch64-linux-android`、rquickjs 的 bindgen、
cargo 交叉编译、Gradle 打包），在签名阶段失败：

```text
Caused by: java.security.UnrecoverableKeyException: Get Key failed: Given final block not
properly padded. Such issues can arise if a bad key is used during decryption.
```

根因是 `tools/android-signing.py` 给 store 与 key 各生成了一个随机口令，而 keystore 是
**PKCS12**（JDK 9 起的默认类型）：PKCS12 **只有一个口令**，keytool 对 `-keypass` 明确忽略并
警告，不报错。于是生成阶段一切正常，写出去的 `ONETHU_KEY_PASS` 却是打不开私钥的假凭据，
只有 apksigner 真去 `KeyStore.getKey(alias, keyPass)` 时才暴露。

本机复现（用同一份 keystore、同一个 apksigner）：

```text
A. --key-pass 用文件里的 ONETHU_KEY_PASS   → PBES2Core / PKCS12KeyStore.internalGetKey → BadPadding
B. --key-pass 用 ONETHU_KS_PASS             → 私钥解开（后续才因探针 APK 不是真 APK 报错）
```

三处修正：

1. 生成器只生成一个口令，两个环境变量写同值；`--reuse` 把旧文件里的 `ONETHU_KEY_PASS` 收敛到
   store 口令。
2. 生成器在落盘前用 **jarsigner** 真解一次私钥（与 apksigner 同一条 `KeyStore.getKey` 路径），
   生成 / `--reuse` 两条路径都验；`--self-test` 增加「错口令的私钥必须被拦下」与「旧文件口令
   不一致要收敛」两条断言（把自检改成空操作即变红，还原字节一致）。
3. `build-fork-apk.sh` 在**编译前**做同样的 jarsigner 预检：口令不对 1 秒失败，不再等一整轮
   编译。`tools/fork-build-test.mjs` 钉住「预检存在、真的调用 `$JARSIGNER`、且早于
   `android init`」，以及生成器的两条自检路径与单口令形状。

同一轮还修掉另一处：`android-actions/setup-android@v3` 的 `packages` 默认值是
`tools platform-tools`，而遗留 `tools` 包已从 SDK 仓库移除（`Failed to find package 'tools'`），
第一次 android job（run 39962500491）在第一个 step 就失败。现在 `packages` 留空，由显式包名安装。

## 不做

- 不上传分叉自己的 GitHub Release：清单（`latest.json`）与安装包的分发方式由发布者决定，脚本只保证构建与源指向正确。
- 不改 `packages/*` 的版本号：它们是独立的内部包，与安装包版本无关。
- 不在 android job 里构建 harness sidecar：移动端把 `onethu-harness-core` 直接编进 App，桌面端才走 sidecar 进程（见 `src-tauri/Cargo.toml`）。
