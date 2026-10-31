#!/usr/bin/env node
/**
 * 桌面端开发入口：`pnpm dev:app`（或 `pnpm --filter @onethu/desktop run dev:app`）。
 *
 * 为什么需要单独一个脚本：
 * - `dev` 只能是 vite。tauri.conf.json 的 beforeDevCommand 就是
 *   `node ./scripts/prebuild.mjs && pnpm dev`，把 `dev` 改成桌面启动器会自己递归。
 * - 桌面壳的入口历史上按平台分叉：macOS 必须走 dev-launch.sh 的 .app wrapper
 *   （TCC 只认 bundle，裸二进制拿不到定位/麦克风/日历授权），Windows/Linux 只剩
 *   裸 `tauri dev`（tauri:raw）。于是在 Windows 上先跑 `dev` 只拿到浏览器预览，
 *   桌面壳没有一条“一眼就是它”的命令。
 *
 * 本脚本把两边收成一个入口：
 *   macOS          → bash scripts/dev-launch.sh（原有 wrapper：vite + cargo build + 装壳）
 *   Windows/Linux  → tauri dev（前端由 beforeDevCommand 自己拉起：prebuild + vite）
 *
 * Windows 额外一步：给 WebView2 指一个确定可写的 user data 目录。默认的
 * %LOCALAPPDATA%\<identifier>\EBWebView 在某些机器上会让进程起来却永远不出窗口
 * （主线程卡在 WebView2 环境初始化，没有 msedgewebview2 子进程、日志一行不写）。
 * 仓库内的 node_modules/.cache 一定可写且不进版本库，dev 壳也因此与已安装版
 * 的状态互不打架。想改用默认 profile 就自己设 WEBVIEW2_USER_DATA_FOLDER。
 *
 * 额外参数原样转给下游：`pnpm --filter @onethu/desktop run dev:app -- --no-watch`。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // apps/desktop/scripts
const appDir = resolve(here, ".."); // apps/desktop
const args = process.argv.slice(2);

/** 端口有监听就算占用：tauri 的 devUrl 与本仓 vite 都钉在 5180 且 strictPort。 */
const DEV_PORT = 5180;

function portBusy(port) {
  return new Promise((settle) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (busy) => {
      socket.destroy();
      settle(busy);
    };
    socket.setTimeout(600, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** 解析本地安装的 tauri CLI 入口（pnpm 会把包软链到包自己的 node_modules）。 */
function tauriCli() {
  const local = resolve(appDir, "node_modules/@tauri-apps/cli/tauri.js");
  if (existsSync(local)) return local;
  try {
    return createRequire(resolve(appDir, "package.json")).resolve("@tauri-apps/cli/tauri.js");
  } catch {
    console.error("✗ 找不到 @tauri-apps/cli —— 先在仓库根跑 pnpm install");
    process.exit(1);
  }
}

async function main() {
  const env = { ...process.env };
  let command;
  let commandArgs;
  let cwd = appDir;

  if (process.platform === "darwin") {
    // macOS 保持既有链路：wrapper 自己拉起 vite、cargo build 并装 .app 启动，
    // 复用已在跑的 vite 也是它的正常行为，所以这里不做端口预检。
    command = "bash";
    commandArgs = [resolve(here, "dev-launch.sh"), ...args];
  } else {
    if (await portBusy(DEV_PORT)) {
      console.error(
        `✗ 端口 ${DEV_PORT} 已被占用：桌面壳的 beforeDevCommand 会自己拉 vite（strictPort），` +
          `先停掉单独跑的 pnpm dev 再重跑本命令`,
      );
      process.exit(1);
    }
    if (process.platform === "win32" && !env.WEBVIEW2_USER_DATA_FOLDER) {
      const profile = resolve(appDir, "node_modules/.cache/onethu-webview2");
      mkdirSync(profile, { recursive: true });
      env.WEBVIEW2_USER_DATA_FOLDER = profile;
      console.log(`· WebView2 user data → ${profile}`);
    }
    console.log(`· 桌面壳：tauri dev（前端由 beforeDevCommand 拉起 vite :${DEV_PORT}）`);
    command = process.execPath;
    commandArgs = [tauriCli(), "dev", ...args];
  }

  const child = spawn(command, commandArgs, { cwd, env, stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`✗ 启动失败：${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

await main();
