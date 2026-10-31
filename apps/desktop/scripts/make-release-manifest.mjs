#!/usr/bin/env node
/**
 * 生成更新清单 `latest.json`（发布资产）。
 *
 * 消费方是 `apps/desktop/src/lib/updater.ts` 的 `pickAsset`：它先看 `assets[平台]`，再退回顶层
 * `url`；`sha256` 存在时由 Rust 侧流式校验，不符就丢弃文件。所以清单必须按平台给键
 * （`windows` / `macos` / `android`），`url` 用资产文件名（客户端按
 * `releases/latest/download/<name>` 解析），`size` 与 `sha256` 与真实字节一致。
 *
 * 用法（CI 与本地一致）：
 *   node apps/desktop/scripts/make-release-manifest.mjs \
 *     --dir release-artifacts --version 0.11.3-2 --out dist-release/latest.json
 *
 * 硬失败条件（都不允许「先发出去再说」）：
 *   - 三个平台各缺一个产物；
 *   - Android 只有未签名包（`*-unsigned.apk`）——未签名包装不上，也不能当发布物；
 *   - 版本号不是 `<主>.<次>.<补丁>-<纯数字>`（分叉包版本形状，见 tauri.fork.conf.json）。
 *
 * `buildManifest` / `writeManifest` 单独导出：护栏 `tools/release-manifest-test.mjs` 在进程内
 * 调用它们，不经过子进程（沙箱里 spawn 会被拒，测试也就跑不起来）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const VERSION_RE = /^\d+\.\d+\.\d+-\d+$/;

/** 每个平台「哪个文件才是发布物」，以及要排除的干扰项 */
const PLATFORM_RULES = {
  windows: {
    // 目录里还有便携 exe（cargo 的 bin 名 onethu.exe）：发布物是 NSIS 安装包
    match: (name) => name.toLowerCase().endsWith("-setup.exe"),
    hint: "NSIS 安装包（*-setup.exe）",
  },
  macos: { match: (name) => name.toLowerCase().endsWith(".dmg"), hint: "dmg 镜像" },
  android: { match: (name) => name.toLowerCase().endsWith(".apk"), hint: "apk 安装包" },
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildManifest({ dir, version, notes, releasedAt }) {
  if (!dir) throw new Error("缺少 --dir（产物目录）");
  if (!existsSync(dir)) throw new Error(`产物目录不存在：${dir}`);
  if (!version || !VERSION_RE.test(version)) {
    throw new Error(`版本必须是 <主>.<次>.<补丁>-<纯数字>（如 0.11.3-2），当前是「${version ?? ""}」`);
  }

  const all = walk(dir);
  const unsignedApks = all.filter((p) => basename(p).toLowerCase().endsWith("-unsigned.apk"));
  if (unsignedApks.length > 0) {
    throw new Error(
      `产物里有未签名 APK：${unsignedApks.map((p) => basename(p)).join(", ")}。\n` +
        "  未签名包无法安装，也不会被更新校验接受；检查签名 secret 是否注入到构建步骤。",
    );
  }

  const assets = {};
  const missing = [];
  for (const [key, rule] of Object.entries(PLATFORM_RULES)) {
    const hits = all.filter((p) => rule.match(basename(p)));
    if (hits.length === 0) {
      missing.push(`${key}（${rule.hint}）`);
      continue;
    }
    if (hits.length > 1) {
      throw new Error(`${key} 命中多个产物，无法判断发布哪一份：${hits.map((p) => basename(p)).join(", ")}`);
    }
    const file = hits[0];
    assets[key] = { url: basename(file), size: statSync(file).size, sha256: sha256(file) };
  }
  if (missing.length > 0) throw new Error(`缺少发布产物：${missing.join("、")}`);

  return { version, notes, releasedAt, assets };
}

export function writeManifest(manifest, out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return out;
}

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

function main() {
  const version = arg("--version");
  const out = arg("--out", "latest.json");
  try {
    const manifest = buildManifest({
      dir: arg("--dir"),
      version,
      notes: arg("--notes", `基于上游构建的分叉包 ${version ?? ""}`.trim()),
      releasedAt: arg("--releasedAt", new Date().toISOString().slice(0, 10)),
    });
    writeManifest(manifest, out);
    for (const [key, asset] of Object.entries(manifest.assets)) {
      console.log(`${key.padEnd(8)} ${asset.url}  ${asset.size} bytes  ${asset.sha256.slice(0, 16)}…`);
    }
    console.log(`✓ ${out}（版本 ${manifest.version}）`);
    return 0;
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && basename(process.argv[1]) === "make-release-manifest.mjs") {
  process.exit(main());
}
