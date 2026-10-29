/**
 * 更新清单生成器的行为护栏（`apps/desktop/scripts/make-release-manifest.mjs`）。
 *
 * 清单是客户端唯一的升级入口：`lib/updater.ts` 的 `pickAsset` 按平台取 `assets[平台]`，
 * `sha256` 不符时 Rust 侧直接丢弃文件。所以这条护栏验的不是「脚本没崩」，而是：
 *   [1] 三个平台各自命中正确的发布物（Windows 取 NSIS 安装包而不是便携 exe）；
 *   [2] `size` / `sha256` 与磁盘上的字节一致（清单写错等于把用户挡在升级之外）；
 *   [3] 未签名 APK、缺平台、版本形状不对都必须硬失败；
 *   [4] 键名与 `PlatformKey` 的取值集合一致（消费方按这个集合取资产）。
 *
 * 生成器导出 `buildManifest` / `writeManifest`，这里在进程内调用：沙箱里 spawn 子进程
 * 会被拒（EPERM），命令行路径无法在受限环境里测。
 *
 * 跑法：node tools/release-manifest-test.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const { buildManifest, writeManifest } = await import(
  new URL("../apps/desktop/scripts/make-release-manifest.mjs", import.meta.url).href
);

function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), "onethu-manifest-"));
  for (const [rel, bytes] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  }
  return dir;
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const OPTS = { notes: "fixture", releasedAt: "2026-10-24" };

/* [1][2] 真实形态：Windows 目录里同时有便携 exe 与 NSIS 安装包，只发后者 */
const winSetup = Buffer.from("fake-nsis-installer");
const winPortable = Buffer.from("fake-portable-exe");
const dmg = Buffer.from("fake-disk-image");
const apk = Buffer.from("fake-apk");
const dir = makeTree({
  "onethu-windows-latest-fork/bundle/nsis/OneTHU-Fork_0.11.3-2_x64-setup.exe": winSetup,
  "onethu-windows-latest-fork/onethu.exe": winPortable,
  "onethu-macos-latest-fork/aarch64-apple-darwin/release/bundle/dmg/OneTHU-Fork_0.11.3-2_aarch64.dmg": dmg,
  "onethu-android-fork/OneTHU-Fork-0.11.3-2-arm64-v8a.apk": apk,
});
try {
  const manifest = buildManifest({ dir, version: "0.11.3-2", ...OPTS });

  assert.equal(manifest.version, "0.11.3-2", "清单版本必须取传入值");
  assert.equal(
    manifest.assets.windows.url,
    "OneTHU-Fork_0.11.3-2_x64-setup.exe",
    "windows 必须取 NSIS 安装包，而不是便携 exe",
  );
  assert.equal(manifest.assets.macos.url, "OneTHU-Fork_0.11.3-2_aarch64.dmg", "macos 必须取 dmg");
  assert.equal(manifest.assets.android.url, "OneTHU-Fork-0.11.3-2-arm64-v8a.apk", "android 必须取 apk");
  assert.equal(manifest.assets.windows.size, winSetup.length, "windows size 与文件不一致");
  assert.equal(manifest.assets.macos.size, dmg.length, "macos size 与文件不一致");
  assert.equal(manifest.assets.android.size, apk.length, "android size 与文件不一致");
  assert.equal(manifest.assets.windows.sha256, sha(winSetup), "windows sha256 与文件不一致");
  assert.equal(manifest.assets.macos.sha256, sha(dmg), "macos sha256 与文件不一致");
  assert.equal(manifest.assets.android.sha256, sha(apk), "android sha256 与文件不一致");

  /* 写盘后的内容必须能被解析回来（CLI 与护栏走同一个写入函数） */
  const out = join(dir, "out", "latest.json");
  writeManifest(manifest, out);
  const round = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(round.assets, manifest.assets, "写盘后的清单与内存里的不一致");

  /* [4] 键集合必须与消费方的 PlatformKey 一致（updater.ts 里按平台取资产） */
  const updater = readFileSync(join(REPO, "apps", "desktop", "src", "lib", "updater.ts"), "utf8");
  const declared = /export type PlatformKey =([^;]+);/.exec(updater);
  assert.ok(declared, "updater.ts 里找不到 PlatformKey：护栏的判据要跟着改");
  const platformKeys = new Set([...declared[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
  for (const key of Object.keys(manifest.assets)) {
    assert.ok(platformKeys.has(key), `清单里的 ${key} 不是 PlatformKey 的取值（${[...platformKeys].join(", ")}）`);
  }
  for (const key of ["windows", "macos", "android"]) {
    assert.ok(manifest.assets[key], `清单缺少 ${key}：客户端在 ${key} 上会取不到资产`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/** 断言某种产物布局会被硬拒绝，并命中指定原因 */
function expectReject(name, files, version, pattern) {
  const bad = makeTree(files);
  try {
    assert.throws(() => buildManifest({ dir: bad, version, ...OPTS }), pattern, name);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
}

/* [3] 未签名 APK：装不上，也不能当发布物 */
expectReject(
  "未签名 APK 必须被拒绝",
  {
    "onethu-windows-latest-fork/OneTHU-Fork_0.11.3-2_x64-setup.exe": winSetup,
    "onethu-macos-latest-fork/OneTHU-Fork_0.11.3-2_aarch64.dmg": dmg,
    "onethu-android-fork/OneTHU-Fork-0.11.3-2-arm64-v8a-unsigned.apk": apk,
  },
  "0.11.3-2",
  /未签名 APK/,
);

/* 缺平台：宁可失败，也不发一份残缺清单 */
expectReject(
  "缺产物必须失败",
  { "onethu-windows-latest-fork/OneTHU-Fork_0.11.3-2_x64-setup.exe": winSetup },
  "0.11.3-2",
  /缺少发布产物/,
);

/* 同一平台命中两份：发布哪份都不对 */
expectReject(
  "同平台多份产物必须失败",
  {
    "a/OneTHU-Fork_0.11.3-2_x64-setup.exe": winSetup,
    "b/OneTHU-Fork_0.11.3-2_x64-setup.exe": winSetup,
    "onethu-macos-latest-fork/OneTHU-Fork_0.11.3-2_aarch64.dmg": dmg,
    "onethu-android-fork/OneTHU-Fork-0.11.3-2-arm64-v8a.apk": apk,
  },
  "0.11.3-2",
  /命中多个产物/,
);

/* 版本形状：tag 与下载 URL 都依赖它 */
expectReject(
  "版本形状必须校验",
  {
    "onethu-windows-latest-fork/OneTHU-Fork_0.11.3_x64-setup.exe": winSetup,
    "onethu-macos-latest-fork/OneTHU-Fork_0.11.3_aarch64.dmg": dmg,
    "onethu-android-fork/OneTHU-Fork-0.11.3-arm64-v8a.apk": apk,
  },
  "0.11.3",
  /版本必须是/,
);

console.log("更新清单：平台取件 / size 与 sha256 一致 / 未签名与缺产物与版本形状拦截 ✓");
