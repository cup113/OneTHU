#!/usr/bin/env node
/**
 * 让 packages/info-lib/dist 跟得上 src。
 *
 * 为什么需要：桌面端通过包导出消费 `@onethu/info-lib` → `dist/index.js`，而不是 src。
 * 只改 src 时，`pnpm dev`、`dev:app`、甚至 `pnpm --filter @onethu/desktop build`
 * 都会继续打包**旧 dist**，改动静默不生效。2026-10-23 实录：网关登录修复提交后
 * 重新构建、重启、复测仍报原错误，原因就是 dist 停在两小时前（src 12:44 / dist 10:35）。
 *
 * 判据只看 mtime：src 里有比 dist 更新的文件才跑一次 tsc（新鲜时约 10ms 就返回）。
 * 挂在 apps/desktop 的 predev / prebuild 上，dev 与打包都不会再拿到过期产物。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // tools
const pkg = resolve(here, "..", "packages", "info-lib");
const src = join(pkg, "src");
const dist = join(pkg, "dist");

/** 目录树里最新的 mtime（毫秒）；缺目录返回 0。 */
function newest(dir) {
  let latest = 0;
  const walk = (at) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        try {
          const mtime = statSync(path).mtimeMs;
          if (mtime > latest) latest = mtime;
        } catch {
          /* 竞态删除忽略 */
        }
      }
    }
  };
  walk(dir);
  return latest;
}

const srcTime = newest(src);
const distTime = newest(dist);
if (srcTime === 0) {
  console.log("· info-lib：没有 src，跳过");
  process.exit(0);
}
if (distTime >= srcTime) process.exit(0);

console.log("· info-lib：src 比 dist 新，重新构建 dist …");
const tsc = join(pkg, "node_modules", "typescript", "bin", "tsc");
execFileSync(process.execPath, [tsc, "-p", "."], { cwd: pkg, stdio: "inherit" });
