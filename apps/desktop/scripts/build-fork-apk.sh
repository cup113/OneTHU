#!/usr/bin/env bash
# 分叉版 Android APK 构建器（Linux 构建机 / CI 专用）。
#
# 与 build-release-apk.sh 的差别（为什么不能直接复用那个脚本）：
#   工程   release 脚本假定仓库在一卷 exFAT 外置盘上、Android 工程被搬到内盘再用符号链接
#          挂回来，还带一整套 rootDirRel 绝对路径改写。CI 的 Ubuntu runner 是普通 ext4，
#          那套搬迁逻辑只会引入无关的失败面，所以这里每次从零生成工程。
#   标识   app.onethu.desktop.fork（与正式版并存、互不覆盖、升级链互不相干）。
#   版本   取 tauri.fork.conf.json 的 version（`0.11.2-1` 这类数字预发布段）。
#   签名   keystore 由 workflow 从 secret 落盘到临时目录；**没有 secret 时只出未签名包**，
#          文件名带 -unsigned，绝不会被当成发布包传出去。
#
# 用法（CI 与本地一致）：
#   ANDROID_HOME=... NDK_HOME=... \
#   ONETHU_KEYSTORE=... ONETHU_KS_PASS=... ONETHU_KEY_PASS=... ONETHU_KEY_ALIAS=... \
#   bash apps/desktop/scripts/build-fork-apk.sh
#
# 环境变量覆盖：JAVA_HOME / ANDROID_HOME / NDK_HOME / ONETHU_APK_OUT /
#               ONETHU_ANDROID_API（NDK clang 的 API level，缺省 24）。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DESKTOP="$REPO/apps/desktop"
GEN="$DESKTOP/src-tauri/gen/android"
FORK_CONF="$DESKTOP/src-tauri/tauri.fork.conf.json"
BASE_CONF="$DESKTOP/src-tauri/tauri.conf.json"
FORK_CONF_REL="src-tauri/tauri.fork.conf.json"
OUT_DIR="${ONETHU_APK_OUT:-$REPO/.tmp-build/apk}"
API="${ONETHU_ANDROID_API:-24}"

die() { echo "✗ $*" >&2; exit 1; }

# JSON 取字段用 node（本仓主语言，CI 必有），不引入 python 依赖
conf_get() {
  node -p "const c=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));String(process.argv[2].split('.').reduce((v,k)=>(v==null?v:v[k]),c) ?? '')" "$1" "$2"
}

# ---------- 1. 工具链 ----------
[ -f "$FORK_CONF" ] || die "找不到分叉配置：$FORK_CONF"
if [ -z "${JAVA_HOME:-}" ]; then
  JAVAC="$(command -v javac || true)"
  [ -n "$JAVAC" ] || die "找不到 javac：请设 JAVA_HOME 指向 JDK 17"
  JAVA_HOME="$(cd "$(dirname "$JAVAC")/.." && pwd)"
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
[ -x "$JAVA_HOME/bin/java" ] || die "JAVA_HOME 下没有 java：$JAVA_HOME"

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$ANDROID_HOME" ] && [ -d "$ANDROID_HOME" ] || die "找不到 Android SDK：请设 ANDROID_HOME"
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"

NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1 || true)}"
[ -n "${NDK_HOME:-}" ] && [ -d "$NDK_HOME" ] || die "找不到 NDK：请设 NDK_HOME，或装到 \$ANDROID_HOME/ndk/ 下"
export NDK_HOME

PREBUILT="$(ls -d "$NDK_HOME"/toolchains/llvm/prebuilt/* 2>/dev/null | head -1 || true)"
[ -n "$PREBUILT" ] && [ -d "$PREBUILT" ] || die "NDK 缺少 llvm 工具链：$NDK_HOME"
TC="$PREBUILT/bin"
CLANG="$TC/aarch64-linux-android${API}-clang"
[ -x "$CLANG" ] || die "找不到 NDK clang：$CLANG"

# QuickJS 的 Android 绑定要用 NDK sysroot 生成（上游没有随包的 Android 绑定），
# 而 cc 与链接器必须显式指到 NDK 的交叉工具链，否则会拿宿主 gcc 去链 Android 目标。
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android="--sysroot=$PREBUILT/sysroot -I$PREBUILT/sysroot/usr/include/aarch64-linux-android"
export CC_aarch64_linux_android="$CLANG"
export AR_aarch64_linux_android="$TC/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CLANG"

BT="$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$BT" ] && [ -x "$BT/aapt2" ] || die "找不到 build-tools（需要 aapt2 / zipalign / apksigner）"

echo "· JDK $(java -version 2>&1 | head -1)"
echo "· SDK $ANDROID_HOME"
echo "· NDK $(basename "$NDK_HOME")（API $API）"

# ---------- 2. 签名材料预检（必须早于编译）----------
# 口令不对的代价原本是「编译二十分钟之后 apksigner 才报
# UnrecoverableKeyException: Given final block not properly padded」（2026-10-23 实测）。
# jarsigner 与 apksigner 走同一条 KeyStore.getKey 路径，1 秒就能把这个错误前移到这里。
KS="${ONETHU_KEYSTORE:-}"
if [ -n "$KS" ]; then
  [ -f "$KS" ] || die "ONETHU_KEYSTORE 指向的文件不存在：$KS"
  : "${ONETHU_KS_PASS:?已给 keystore 但缺少 ONETHU_KS_PASS}"
  : "${ONETHU_KEY_PASS:?已给 keystore 但缺少 ONETHU_KEY_PASS}"
  : "${ONETHU_KEY_ALIAS:?已给 keystore 但缺少 ONETHU_KEY_ALIAS}"
  JARSIGNER="$JAVA_HOME/bin/jarsigner"
  [ -x "$JARSIGNER" ] || JARSIGNER="$(command -v jarsigner || true)"
  [ -n "$JARSIGNER" ] || die "找不到 jarsigner（需要完整 JDK，不只是 JRE）"
  PROBE_DIR="$OUT_DIR/.signing-probe"
  mkdir -p "$PROBE_DIR"
  PROBE_JAR="$PROBE_DIR/probe.jar"
  python3 - "$PROBE_JAR" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\n\r\n")
    z.writestr("probe.txt", "onethu signing probe\n")
PY
  # 口令只以变量名的形式出现（进程列表看不到值）
  export ONETHU_APK_SIGN_STORE_PASS="$ONETHU_KS_PASS"
  export ONETHU_APK_SIGN_KEY_PASS="$ONETHU_KEY_PASS"
  SIGN_RC=0
  SIGN_OUT="$("$JARSIGNER" -J-Duser.language=en -J-Duser.country=US \
      -keystore "$KS" -storepass:env ONETHU_APK_SIGN_STORE_PASS \
      -keypass:env ONETHU_APK_SIGN_KEY_PASS "$PROBE_JAR" "$ONETHU_KEY_ALIAS" 2>&1)" || SIGN_RC=$?
  unset ONETHU_APK_SIGN_STORE_PASS ONETHU_APK_SIGN_KEY_PASS
  rm -rf "$PROBE_DIR"
  [ "$SIGN_RC" -eq 0 ] \
    || die "签名材料不可用（apksigner 会以同一个错误失败）：$(printf '%s' "$SIGN_OUT" | tail -2 | tr '\n' ' ')"
  echo "· 签名材料自检通过（私钥可解密，别名 $ONETHU_KEY_ALIAS）"
fi

# ---------- 3. 分叉不变量（在编译之前拦住，别白烧十分钟）----------
VERSION="$(conf_get "$FORK_CONF" version)"
PRODUCT="$(conf_get "$FORK_CONF" productName)"
IDENTIFIER="$(conf_get "$FORK_CONF" identifier)"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$ ]] \
  || die "分叉版本必须形如 <主>.<次>.<补丁>-<纯数字>（如 0.11.2-1），当前是「$VERSION」"
[ "$(conf_get "$BASE_CONF" identifier)" = "app.onethu.desktop" ] \
  || die "正式版 identifier 变了：分叉判据要跟着改（脚本与 tools/fork-build-test.mjs）"
[ "$IDENTIFIER" != "app.onethu.desktop" ] \
  || die "分叉包不能沿用正式版 identifier（同包名换签名会安装失败）"
# Android 包名只能是 [a-zA-Z][a-zA-Z0-9_]* 段用点连接；带连字符的标识在 gradle 阶段才会炸。
[[ "$IDENTIFIER" =~ ^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$ ]] \
  || die "分叉 identifier「$IDENTIFIER」不是合法的 Android 包名"
echo "· 分叉不变量通过：$PRODUCT $VERSION / $IDENTIFIER"

# ---------- 4. 工程就位：每次从零生成 ----------
# 入库的 gen/android 是指向外置盘的符号链接（本机发布线用），CI 上必须清掉再生成，
# 否则 tauri 会往一个不存在的目标里写，或者复用上一轮的旧 applicationId。
if [ -e "$GEN" ] || [ -L "$GEN" ]; then
  rm -rf "$GEN"
fi
echo "· 生成 Android 工程（tauri android init，配置 $FORK_CONF_REL）"
( cd "$DESKTOP" && pnpm exec tauri android init --ci --skip-targets-install --config "$FORK_CONF_REL" )

GRADLE_APP="$GEN/app/build.gradle.kts"
[ -f "$GRADLE_APP" ] || die "工程没生成出来：$GRADLE_APP 不存在"
grep -q "applicationId = \"$IDENTIFIER\"" "$GRADLE_APP" \
  || die "生成的工程 applicationId 不是 $IDENTIFIER（fork 配置没有传进 android init）：$(grep -m1 'applicationId' "$GRADLE_APP")"
grep -q "namespace = \"$IDENTIFIER\"" "$GRADLE_APP" \
  || die "生成的工程 namespace 不是 $IDENTIFIER：$(grep -m1 'namespace' "$GRADLE_APP")"
echo "· 工程 applicationId/namespace = $IDENTIFIER ✓"

# ---------- 5. 构建 ----------
mkdir -p "$OUT_DIR"
# 前端开关链：ONETHU_FORK 决定更新源指向本 fork，ONETHU_VERSION 让界面版本与安装包一致。
export ONETHU_FORK=1
export ONETHU_VERSION="$VERSION"
echo "· 开始构建（aarch64，release）"
( cd "$DESKTOP" && pnpm exec tauri android build --apk --target aarch64 --config "$FORK_CONF_REL" )

UNSIGNED="$(find "$GEN/app/build/outputs/apk" -name '*-unsigned.apk' 2>/dev/null | head -1 || true)"
[ -n "$UNSIGNED" ] || die "没找到未签名 APK（$GEN/app/build/outputs/apk）"

# ---------- 6. 对齐 + 签名 ----------
ALIGNED="$OUT_DIR/.onethu-fork-aligned.apk"
"$BT/zipalign" -p -f 4 "$UNSIGNED" "$ALIGNED"

# KS 与三个口令已在第 2 步预检过（私钥真解开过一次），这里不再重复校验
if [ -n "$KS" ]; then
  OUT="$OUT_DIR/$PRODUCT-$VERSION-arm64-v8a.apk"
  mv "$ALIGNED" "$OUT"
  # 口令只以变量名的形式出现在 argv 里（进程列表看不到值）
  export ONETHU_APK_SIGN_STORE_PASS="$ONETHU_KS_PASS"
  export ONETHU_APK_SIGN_KEY_PASS="$ONETHU_KEY_PASS"
  "$BT/apksigner" sign --ks "$KS" --ks-key-alias "$ONETHU_KEY_ALIAS" \
    --ks-pass env:ONETHU_APK_SIGN_STORE_PASS --key-pass env:ONETHU_APK_SIGN_KEY_PASS "$OUT"
  unset ONETHU_APK_SIGN_STORE_PASS ONETHU_APK_SIGN_KEY_PASS
  "$BT/apksigner" verify --verbose "$OUT" >/dev/null || die "签名校验失败：$OUT"
  echo "· 已签名（证书 SHA-256）："
  "$BT/apksigner" verify --print-certs "$OUT" | sed -n 's/.*certificate SHA-256 digest: /  /p'
else
  OUT="$OUT_DIR/$PRODUCT-$VERSION-arm64-v8a-unsigned.apk"
  mv "$ALIGNED" "$OUT"
  echo "⚠ 没有 ONETHU_KEYSTORE：产物是未签名包，只用于验证构建链，不能安装或发布"
fi

# ---------- 7. 产物复核（包名/版本对不上就等于发错了包）----------
BADGE="$OUT_DIR/.onethu-fork-badging.txt"
# 不要用管道把 aapt2 接到 grep -q：pipefail 下 grep 命中即退出会让 aapt2 收到 SIGPIPE
# （退出码 141），整条管道判为失败，正确的包名也会被误报。落文件再查。
"$BT/aapt2" dump badging "$OUT" > "$BADGE" 2>/dev/null || true
grep -qF "package: name='$IDENTIFIER'" "$BADGE" \
  || die "产物的包名不是 $IDENTIFIER：$(head -1 "$BADGE")"
grep -qF "versionName='$VERSION'" "$BADGE" \
  || die "产物的 versionName 不是 $VERSION：$(head -1 "$BADGE")"
VC="$(sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p" "$BADGE" | head -1)"
[ -n "$VC" ] && [ "$VC" -gt 0 ] || die "产物没有有效的 versionCode：$(head -1 "$BADGE")"
head -1 "$BADGE"
rm -f "$BADGE"

# dev 面板是开发者版专属，正式/分叉包里出现就是开关泄漏。
# 必须解压 .so 再查：lib 条目可以被压缩存放，直接扫整包字节会漏报（护栏形同虚设）。
python3 - "$OUT" <<'PY'
import hashlib, os, sys, zipfile
p = sys.argv[1]
with zipfile.ZipFile(p) as z:
    leak = any(b"/assets/DevPanel-" in z.read(n) for n in z.namelist() if n.endswith(".so"))
print("开发者面板: " + ("泄漏进分叉包" if leak else "分叉包中确认不存在"))
h = hashlib.sha256()
with open(p, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
print("SHA-256: " + h.hexdigest())
print("大小: %.1f MB" % (os.path.getsize(p) / 1048576))
sys.exit(1 if leak else 0)
PY

echo
echo "✓ 分叉 APK：$OUT"
