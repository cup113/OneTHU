#!/usr/bin/env node
/**
 * 分叉构建入口（跨平台）：产出一个能和正式版**并存**、且不去顶正式版更新源的分叉包。
 *
 * 三件事一起做（缺一件就会出事）：
 *  1. 打包标识换成 `app.onethu.desktop.fork` + 应用名 `OneTHU-Fork`（`src-tauri/tauri.fork.conf.json`）
 *     —— 与正式版同 identifier 会共用数据目录与单实例锁，同 productName 会共用安装目录；
 *  2. 版本号带分叉尾巴（同文件的 `version`，如 `0.11.2-fork.1`），并通过 `ONETHU_VERSION`
 *     注入前端，让「界面显示的版本」与「安装包版本」一致；
 *  3. 打开 `ONETHU_FORK=1` → `__ONETHU_FORK__` → `lib/updater.ts` 的更新源换成分叉自己的仓库，
 *     不再退回上游的清华云盘镜像（否则用户会被带去装上游包）。
 *
 * 用法：
 *   pnpm --filter @onethu/desktop build:fork         # 只出前端 dist
 *   pnpm --filter @onethu/desktop tauri:build:fork   # 连 tauri 打包（可再跟 --target / --no-bundle）
 *
 * 版本覆盖：`ONETHU_FORK_VERSION=0.11.3-2`（CI 的手动发版输入走这条）。覆盖时脚本把分叉配置
 * 复制一份到临时目录、只改 version 再传给 tauri —— 不改工作区文件，也不依赖 `--config`
 * 的合并顺序（后者在 Windows 下还要跟 shell 引号纠缠）。
 *
 * 守卫：tools/fork-build-test.mjs（配置与开关的形状），以及本脚本末尾的产物校验。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORK_CONF = join(DESKTOP, "src-tauri", "tauri.fork.conf.json");
const FORK_CONF_REL = "src-tauri/tauri.fork.conf.json";
/** 只在分叉构建里才会出现在产物中的字符串（更新源仓库名）——用来证明开关真的生效 */
const FORK_MARKER = "cup113/OneTHU";

const argv = process.argv.slice(2);
const frontendOnly = argv.includes("--frontend");
const passthrough = argv.filter((a) => a !== "--frontend");

const conf = JSON.parse(readFileSync(FORK_CONF, "utf8"));
const override = (process.env.ONETHU_FORK_VERSION ?? "").trim();
const version = override || String(conf.version ?? "");
/* 预发布段只能是数字（Windows MSI 的硬限制，实测报错：
 * "optional pre-release identifier in app version must be numeric-only and cannot be greater than 65535
 *  for msi target"）。所以分叉版本形如 0.11.2-1、0.11.2-2，不能写 0.11.2-fork.1。 */
const versionMatch = /^\d+\.\d+\.\d+-(\d+)$/.exec(version);
if (!versionMatch) {
  console.error(
    `✗ ${FORK_CONF_REL} 的 version 必须是 <主>.<次>.<补丁>-<纯数字>（如 0.11.2-1），当前是「${version}」\n` +
      "  Windows MSI 只接受数字预发布段；`-fork.1` 这种会在打包阶段直接失败。",
  );
  process.exit(1);
}
if (Number(versionMatch[1]) > 65535) {
  console.error(`✗ 预发布段必须 ≤ 65535（Windows MSI 限制），当前是 ${versionMatch[1]}`);
  process.exit(1);
}
if (String(conf.identifier ?? "") === "app.onethu.desktop") {
  console.error("✗ 分叉包不能沿用正式版的 identifier（会共用数据目录与单实例锁）");
  process.exit(1);
}

const ENV = { ...process.env, ONETHU_FORK: "1", ONETHU_VERSION: version };

/** 版本被覆盖时给 tauri 一份临时配置：整份复制分叉配置，只换 version */
function configArg() {
  if (!override || override === String(conf.version ?? "")) return FORK_CONF_REL;
  const dir = mkdtempSync(join(tmpdir(), "onethu-fork-conf-"));
  const runtime = join(dir, "tauri.fork.conf.json");
  writeFileSync(runtime, `${JSON.stringify({ ...conf, version: override }, null, 2)}\n`, "utf8");
  console.log(`· 分叉版本按输入覆盖：${conf.version} → ${override}（临时配置 ${runtime}）`);
  return runtime;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: DESKTOP,
    env: ENV,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/* 只打我们真正要发的那个包：Windows 的 MSI 目标对版本号有额外限制（预发布段必须纯数字且
 * ≤65535），而 release.yml 从来只上传 nsis 的 exe；macOS 同理只发 dmg。少打一个目标既避开
 * 那类限制，也省掉一半打包时间。调用方自己给了 --bundles / --no-bundle 时不插手。 */
function defaultBundles() {
  if (process.platform === "win32") return "nsis";
  if (process.platform === "darwin") return "dmg";
  return "";
}

const explicitBundles = passthrough.some((a) => a === "--bundles" || a === "-b" || a.startsWith("--bundles="));
const noBundle = passthrough.includes("--no-bundle");
const bundleArgs = explicitBundles || noBundle || !defaultBundles() ? [] : ["--bundles", defaultBundles()];

if (frontendOnly) {
  run("pnpm", ["exec", "vite", "build"]);
} else {
  run("pnpm", ["exec", "tauri", "build", "--config", configArg(), ...bundleArgs, ...passthrough]);
}

/* 开关没生效就等于编了个正式版（更新源还指向上游）：这里直接拦下。
 * 注意 beforeBuildCommand 会重跑 vite build，所以校验必须放在构建之后。 */
const assets = join(DESKTOP, "dist", "assets");
const bundles = existsSync(assets)
  ? readdirSync(assets).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(assets, f), "utf8"))
  : [];
if (!bundles.some((code) => code.includes(FORK_MARKER))) {
  console.error("✗ 产物里没有分叉更新源标记：ONETHU_FORK 未生效（检查 vite.config.ts 的 define）");
  process.exit(1);
}
if (!bundles.some((code) => code.includes(version))) {
  console.error(`✗ 产物里没有分叉版本号 ${version}：ONETHU_VERSION 未生效`);
  process.exit(1);
}
console.log(`✓ 分叉构建完成：${conf.productName} ${version}（标识 ${conf.identifier}，更新源 ${FORK_MARKER}）`);
