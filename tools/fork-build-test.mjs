/**
 * 分叉构建（`ONETHU_FORK=1`）的形状护栏。
 *
 * 背景：本仓是 smartThise/OneTHU 的临时分叉，要同时躲开两件事——
 *   ① `v*` tag 与上游将来的同名 tag 撞车；② 分叉包沿上游更新源检查更新，把用户带去装上游包。
 * 这两件事都靠「配置 + 开关」约束，而每次从上游 rebase 都可能把它们改回去，所以钉成护栏。
 *
 * 覆盖：
 *   [1] release.yml 只手动触发（没有 tag 触发器），且有 fork 输入；
 *   [2] 分叉打包标识与版本（apps/desktop/src-tauri/tauri.fork.conf.json）真的与正式版不同；
 *   [3] 前端开关链路：vite define → globals 声明 → updater 换源并关掉上游云盘镜像；
 *   [4] 构建入口存在且带产物自校验，package.json 两个脚本都指向它；
 *   [5] Android 分叉包：job 受 android 输入控制、脚本换包名并在编译前后各校验一次、
 *       没配签名 secret 时产物必须叫 -unsigned（不能悄悄产出一个看着可发布的包）。
 *
 * 跑法：node tools/fork-build-test.mjs
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (p) => readFileSync(p, "utf8");

/* [1] 发布链路：只手动触发，不打 tag */
const wf = read(".github/workflows/release.yml");
assert.ok(!/^\s+push:\s*$/m.test(wf), "release.yml 又出现了 push 触发器：分叉里打 v* 会与上游 tag 撞车");
assert.ok(!/tags:\s*\[?"v\*"/.test(wf), "release.yml 又监听 v* tag 了");
assert.ok(/^on:\s*$/m.test(wf) && /workflow_dispatch:/.test(wf), "release.yml 必须靠 workflow_dispatch 手动触发");
assert.ok(/\bfork:\s*$/m.test(wf), "release.yml 缺少 fork 输入：分叉包没有构建入口");
assert.ok(/inputs\.fork &&/.test(wf), "release.yml 的构建步骤没有按 fork 输入切换脚本");

/* [2] 打包标识与版本 */
const base = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json"));
const fork = JSON.parse(read("apps/desktop/src-tauri/tauri.fork.conf.json"));
assert.equal(base.identifier, "app.onethu.desktop", "正式版 identifier 变了：分叉判据要跟着改");
assert.notEqual(fork.identifier, base.identifier, "分叉包不能沿用正式版 identifier（会共用数据目录与单实例锁）");
assert.ok(fork.identifier && fork.identifier.endsWith(".fork"), `分叉 identifier 应带 .fork 后缀，当前是 ${fork.identifier}`);
assert.notEqual(fork.productName, base.productName, "分叉包不能沿用正式版应用名（会共用安装目录）");
/* 预发布段只能是纯数字：Windows MSI 打包器的硬限制（实测报错见 docs/plans/2026-10-23-fork-build-isolation.md）。
 * `-fork.1` 这种带字母的写法会在 `tauri build` 的打包阶段直接失败，所以必须在护栏里挡住。 */
const forkVersion = String(fork.version);
const forkParts = /^\d+\.\d+\.\d+-(\d+)$/.exec(forkVersion);
assert.ok(forkParts, `分叉版本必须形如 <主>.<次>.<补丁>-<纯数字>（如 0.11.2-1），当前是 ${forkVersion}`);
assert.ok(Number(forkParts[1]) <= 65535, `预发布段必须 ≤ 65535（MSI 限制），当前是 ${forkParts[1]}`);
assert.notEqual(fork.version, base.version, "分叉版本不能与正式版同号（同号不同内容会让更新判断静默失真）");

/* [3] 前端开关链路 */
const vite = read("apps/desktop/vite.config.ts");
assert.ok(/__ONETHU_FORK__:/.test(vite), "vite.config.ts 没注入 __ONETHU_FORK__");
assert.ok(/ONETHU_FORK === "1"/.test(vite), "vite.config.ts 没读 ONETHU_FORK 环境变量");
assert.ok(/ONETHU_VERSION/.test(vite), "vite.config.ts 没读 ONETHU_VERSION：界面版本会与安装包版本不一致");
const globals = read("apps/desktop/src/globals.d.ts");
assert.ok(/declare const __ONETHU_FORK__: boolean;/.test(globals), "globals.d.ts 没声明 __ONETHU_FORK__");

const updater = read("apps/desktop/src/lib/updater.ts");
assert.ok(/__ONETHU_FORK__/.test(updater), "updater.ts 没读 __ONETHU_FORK__");
assert.ok(/CLOUD_MIRROR_ENABLED = !FORK_BUILD/.test(updater), "分叉构建必须关掉上游云盘镜像源");
assert.ok(/CLOUD_MIRROR_ENABLED\s*\n?\s*\?/.test(updater), "checkForUpdate 没有按 CLOUD_MIRROR_ENABLED 收缩源列表");
assert.ok(/cup113\/OneTHU/.test(updater), "分叉更新源仓库名不在 updater.ts 里");
assert.ok(!/GITHUB_MANIFEST_URL = "https:\/\/github\.com\/smartThise/.test(updater), "更新源又写死上游仓库了");

/* [4] 构建入口 */
const script = read("apps/desktop/scripts/build-fork.mjs");
assert.ok(/tauri", "build", "--config"/.test(script), "build-fork.mjs 没把 fork 配置传给 tauri build");
assert.ok(/ONETHU_FORK: "1"/.test(script), "build-fork.mjs 没打开 ONETHU_FORK");
assert.ok(/FORK_MARKER/.test(script), "build-fork.mjs 缺少产物自校验（开关没生效就等于编了个正式版）");
const pkg = JSON.parse(read("apps/desktop/package.json"));
for (const name of ["build:fork", "tauri:build:fork"]) {
  assert.ok(String(pkg.scripts?.[name] ?? "").includes("build-fork.mjs"), `package.json 缺少指向 build-fork.mjs 的 ${name}`);
}

/* [5] Android 分叉包 */
assert.ok(/\n\s{6}android:[^]*?type: boolean/.test(wf), "release.yml 缺少 android 输入：分叉包没有 Android 构建入口");
assert.ok(/if: .*inputs\.android/.test(wf), "android job 没有按 android 输入做条件：不勾也会跑，白烧 runner");
assert.ok(/build-fork-apk\.sh/.test(wf), "release.yml 的 android job 没调用 build-fork-apk.sh");
/* 四个 secret 是签名链路的地基：名字对不上，CI 会静默地只出未签名包 */
for (const secret of ["ANDROID_KEYSTORE_BASE64", "ANDROID_KS_PASS", "ANDROID_KEY_PASS", "ANDROID_KEY_ALIAS"]) {
  assert.ok(wf.includes(`secrets.${secret}`), `release.yml 没有引用 secret ${secret}`);
}
assert.ok(/if-no-files-found: error/.test(wf), "APK 上传没设 if-no-files-found: error：构建空转也能绿灯");
/* Windows runner 的默认 shell 是 pwsh：多行 run 只由最后一条命令决定退出码，前面的失败会被
 * 吞掉（实测 run 39979127330：鉴权守卫在 Windows 上同样断言失败，step 却是绿的，只有
 * macOS 的 bash 报红）。desktop job 统一 shell，多步守卫收成一条脚本。 */
assert.ok(
  /defaults:\s*\n\s+run:\s*\n\s+shell: bash/.test(wf),
  "desktop job 没有统一 shell: bash：Windows 上多行 run 的失败会被吞掉",
);
assert.ok(
  /run: pnpm run test:login/.test(wf),
  "鉴权守卫必须收成一条脚本：多行 run 在 pwsh 与 bash 下的退出码语义不一致",
);
/* setup-android 的默认 packages 含 `tools`，该包已从 SDK 仓库移除，会让 job 在第一步就失败 */
assert.ok(
  /setup-android@v3[^]*?packages:\s*""/.test(wf),
  "setup-android 的 packages 必须留空：默认值里的 `tools` 已从 SDK 仓库移除（实测 run 39962500491）",
);

const apk = read("apps/desktop/scripts/build-fork-apk.sh");
assert.ok(
  /tauri android init[^\n]*--config "\$FORK_CONF_REL"/.test(apk) || /tauri android init[^\n]*--config/.test(apk),
  "build-fork-apk.sh 的 android init 没带 --config：生成的工程会是正式版包名",
);
assert.ok(/tauri android build[^\n]*--config "\$FORK_CONF_REL"/.test(apk), "build-fork-apk.sh 的 android build 没带 --config");
assert.ok(/applicationId = \\"\$IDENTIFIER\\"/.test(apk), "build-fork-apk.sh 没有在编译前校验生成的 applicationId");
assert.ok(/grep -qF "package: name='\$IDENTIFIER'"/.test(apk), "build-fork-apk.sh 没有在产物上复核包名");
/* 签名缺失时必须改名：否则一个未签名包装着发布包的名字传出去。
 * 只认产物命名那一行 —— `-name '*-unsigned.apk'` 是去 gradle 输出里找输入，不算。 */
assert.ok(
  /\$OUT_DIR\/\$PRODUCT-\$VERSION-arm64-v8a-unsigned\.apk/.test(apk),
  "build-fork-apk.sh 缺签名时没有把产物标成 -unsigned",
);
const signedName = /OUT="\$OUT_DIR\/\$PRODUCT-\$VERSION-arm64-v8a\.apk"/.test(apk);
assert.ok(signedName, "build-fork-apk.sh 的已签名产物命名不再是 <产品>-<版本>-arm64-v8a.apk");
/* 认 `verify --verbose`：`verify --print-certs` 是打印证书，不做校验，别拿它冒充验签 */
assert.ok(/"\$BT\/apksigner" verify --verbose/.test(apk), "build-fork-apk.sh 签完不验签：签名库不对也发现不了");
assert.ok(/zipalign/.test(apk), "build-fork-apk.sh 没做 zipalign：未对齐的包装不上或运行时崩");
assert.ok(
  String(pkg.scripts?.["android:fork"] ?? "").includes("build-fork-apk.sh"),
  "package.json 缺少指向 build-fork-apk.sh 的 android:fork",
);

/* 签名材料必须在编译之前验：口令不对的代价原本是编译二十分钟之后才在 apksigner 报
 * `UnrecoverableKeyException: Given final block not properly padded`（2026-10-23 实测）。
 * 认 `-storepass:env`：签名阶段的 argv 是 `--ks-pass env:`，两者不会互相冒充。 */
const idxPreflight = apk.indexOf("-storepass:env ONETHU_APK_SIGN_STORE_PASS");
const idxInit = apk.indexOf("tauri android init");
const idxBuild = apk.indexOf("tauri android build");
assert.ok(idxPreflight > 0, "build-fork-apk.sh 没有在编译前自检签名材料（jarsigner 解私钥）");
assert.ok(
  idxPreflight < idxInit && idxInit < idxBuild,
  "签名材料自检必须早于 android init/build：放到后面就等于又白跑一轮编译",
);
/* 预检本身要被真正执行：命令行里得有 "$JARSIGNER" 与 -storepass:env 连着出现，
 * 只留一个标志串（例如改成 echo）不算。 */
assert.ok(
  /"\$JARSIGNER"[\s\S]{0,200}?-storepass:env ONETHU_APK_SIGN_STORE_PASS/.test(apk),
  "签名预检没有真的调用 jarsigner（命令行被掏空了）",
);

const signingPy = read("tools/android-signing.py");
const idxDefReuse = signingPy.indexOf("def reuse_existing(");
const idxDefInstall = signingPy.indexOf("def install(");
const idxDefScratch = signingPy.indexOf("def scratch_dir(");
assert.ok(idxDefReuse > 0 && idxDefInstall > idxDefReuse && idxDefScratch > idxDefInstall,
  "android-signing.py 的函数顺序变了：按段定位的断言要跟着改");
assert.ok(
  signingPy.slice(idxDefReuse, idxDefInstall).includes("verify_private_key(creds)"),
  "沿用已有 keystore（--reuse）的路径没真解一次私钥：打不开的凭据会被写出去",
);
assert.ok(
  signingPy.slice(idxDefInstall, idxDefScratch).includes("verify_private_key(creds)"),
  "落盘（install）路径没真解一次私钥：口令不对也要等到 apksigner 才暴露",
);
assert.ok(
  /store_pass=password,[\s\S]{0,60}?key_pass=password,/.test(signingPy),
  "generate 必须给 store/key 写同一个口令：PKCS12 只有一个口令，分开写 apksigner 解不开私钥",
);

console.log(
  `分叉构建：release.yml 仅手动触发（含 fork/android 输入）✓ / 标识 ${fork.identifier} 与正式版分离 ✓ / ` +
    `版本 ${fork.version} 带尾巴 ✓ / 更新源 ${"cup113/OneTHU"} 且无上游云盘镜像 ✓ / 构建入口与产物自校验 ✓ / ` +
    `Android 包名与签名缺省改名 ✓ / 签名材料编译前自检 + PKCS12 单口令 ✓`,
);
