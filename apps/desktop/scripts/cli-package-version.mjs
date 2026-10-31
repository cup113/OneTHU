#!/usr/bin/env node
/**
 * CLI 包的版本必须等于应用版本。
 *
 * 应用拿到 CLI 包之后按「已安装包版本 == 应用版本」判定可用（src-tauri 的
 * `cli_daemon::resource_dir` 与 `cli_package::status`），装上也永远提示要更新是最难查的
 * 那种故障。分叉包的版本在 `src-tauri/tauri.fork.conf.json`（如 `0.11.4-4`），与
 * `packages/cli/package.json` 里的上游版本（如 `0.11.4-fix-3`）不是一条序列，所以分叉构建
 * 不能用后者当 CLI 包版本。
 *
 * 解析顺序：
 *   1. `ONETHU_CLI_VERSION`：显式覆盖（排查/试装用）
 *   2. `ONETHU_FORK_VERSION`：分叉发版输入，与 build-fork.mjs 同口径
 *   3. `ONETHU_FORK=1`：读 `tauri.fork.conf.json` 的 version
 *   4. 其余形态（上游式构建）：`packages/cli/package.json` 的 version
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 分叉包版本的真源（build-fork.mjs 与 tauri.fork.conf.json 共用同一个数） */
export const FORK_CONF = join(DESKTOP, "src-tauri", "tauri.fork.conf.json");
/** 上游形态构建的 CLI 版本真源 */
export const CLI_PACKAGE = join(DESKTOP, "..", "..", "packages", "cli", "package.json");

const readPackageVersion = (file) => JSON.parse(readFileSync(file, "utf8")).version;
/** 会进 zip 文件名与 runtime.json：只接受 ASCII 版本字符，别的当场拒绝。 */
const VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

export function resolveCliPackageVersion(env = process.env, read = readPackageVersion) {
  const explicit = (env.ONETHU_CLI_VERSION ?? "").trim();
  const forkInput = (env.ONETHU_FORK_VERSION ?? "").trim();
  let version, source;
  if (explicit) {
    version = explicit;
    source = "ONETHU_CLI_VERSION";
  } else if (forkInput) {
    version = forkInput;
    source = "ONETHU_FORK_VERSION";
  } else if ((env.ONETHU_FORK ?? "") === "1") {
    version = read(FORK_CONF);
    source = "tauri.fork.conf.json";
  } else {
    version = read(CLI_PACKAGE);
    source = "packages/cli/package.json";
  }
  if (typeof version !== "string" || !VERSION_SHAPE.test(version)) {
    throw new Error(`CLI package version is not filename-safe: ${JSON.stringify(version)} (from ${source})`);
  }
  return { version, source };
}
