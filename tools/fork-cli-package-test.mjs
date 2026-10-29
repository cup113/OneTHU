#!/usr/bin/env node
/**
 * 分叉 CLI 包：来源、tag 与版本对齐的守卫（静态断言 + 版本解析行为）。
 *
 * 应用按「已安装 CLI 包版本 == 应用版本」判定可用（src-tauri/src/cli_daemon.rs 的 resource_dir、
 * cli_package.rs 的 status）。包的来源写成上游仓库 + `v<version>` 时，分叉包永远装不上——分叉
 * 版本号（0.11.4-4）在上游没有对应 release。这条守卫钉住三件事：
 *   1. cli_package.rs 的分叉开关是编译期常量，仓库名与 tag 都跟着它走，且不退回云盘镜像；
 *   2. CLI 包版本跟随分叉配置，并真的写进包内 package.json（否则 CLI 自报上游版本，握手仍失败）；
 *   3. 发版链路把 CLI 包一起发出去，且构建 CLI 包时传了分叉开关与版本。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveCliPackageVersion, FORK_CONF, CLI_PACKAGE } from '../apps/desktop/scripts/cli-package-version.mjs';

let checks = 0;
const check = (value, name) => { assert.ok(value, name); checks++; };
const read = (path) => readFileSync(path, 'utf8');
const versionOf = (path) => JSON.parse(read(path)).version;

/* 1. Rust 侧：编译期开关、仓库与 tag、镜像边界 */
const rust = read('apps/desktop/src-tauri/src/cli_package.rs');
check(/option_env!\("ONETHU_FORK"\)/.test(rust), '分叉开关必须是编译期常量（运行时装出来的应用没有这个 env）');
check(/FORK_REPO: &str = "cup113\/OneTHU"/.test(rust), '分叉仓库名写死在本仓');
check(/OFFICIAL_REPO: &str = "smartThise\/OneTHU"/.test(rust), '上游仓库名保留');
check(/format!\("fork-\{version\}"\)/.test(rust), '分叉 tag 必须是 fork-<version>（与 publish 一致）');
check(/Err\(error\) if FORK_BUILD => return Err\(error\)/.test(rust), '分叉不退回上游校园云盘镜像');
check(!/releases\/tags\/v\{version\}/.test(rust), 'API 路径不能再写死 v<version>（分叉必然 404）');
check(/release_asset_url\(&version, &filename\)/.test(rust), '下载 URL 必须与仓库/tag 同源校验');

/* 2. 版本解析：分叉构建跟 tauri.fork.conf.json，上游形态跟 packages/cli */
const forkVersion = versionOf(FORK_CONF);
check(/^\d+\.\d+\.\d+-\d+$/.test(forkVersion), '分叉版本形如 0.11.4-4（Windows MSI 的预发布段只能纯数字）');
const cases = [
  [{ ONETHU_CLI_VERSION: '9.9.9-1', ONETHU_FORK: '1' }, '9.9.9-1', 'ONETHU_CLI_VERSION'],
  [{ ONETHU_FORK_VERSION: '0.11.5-2', ONETHU_FORK: '1' }, '0.11.5-2', 'ONETHU_FORK_VERSION'],
  [{ ONETHU_FORK: '1' }, forkVersion, 'tauri.fork.conf.json'],
  [{}, versionOf(CLI_PACKAGE), 'packages/cli/package.json'],
  [{ ONETHU_FORK: '0' }, versionOf(CLI_PACKAGE), 'packages/cli/package.json'],
];
for (const [env, want, source] of cases) {
  const got = resolveCliPackageVersion(env);
  check(got.version === want && got.source === source, `CLI 包版本解析：${JSON.stringify(env)} → ${want}（${source}）`);
}
assert.throws(() => resolveCliPackageVersion({ ONETHU_CLI_VERSION: '0.11.4-4 ../evil' }), /not filename-safe/);
checks++;

/* 3. 构建脚本把版本写进包内 package.json 与 SDK bundle */
const build = read('apps/desktop/scripts/build-cli-runtime.mjs');
check(/resolveCliPackageVersion\(\)/.test(build), 'build-cli-runtime 必须解析应用版本');
check(/staged\.version\s*=\s*packageVersion/.test(build), 'build-cli-runtime 必须改写包内 package.json 的版本');
check(/SDK_INDEX=path\.join\(root,'packages\/sdk\/src\/index\.ts'\)/.test(build), 'daemon.status 报的是 SDK 里的 VERSION 常量，打包时要替换它');
check(/withSdkVersion\(packageVersion/.test(build), 'SDK 版本注入必须用解析出的包版本');
check(/^export const VERSION = '[^']+';$/m.test(read('packages/sdk/src/index.ts')), 'packages/sdk/src/index.ts 的 VERSION 常量形状变了（注入会失效）');

/* 4. 发版链路 */
const yml = read('.github/workflows/release.yml');
check(/name: Build optional CLI package[\s\S]{0,800}?ONETHU_FORK: \$\{\{ inputs\.fork && '1' \|\| '' \}\}/.test(yml), '构建 CLI 包时要传分叉开关');
check(/ONETHU_FORK_VERSION: \$\{\{ inputs\.fork && inputs\.version \|\| '' \}\}/.test(yml), '构建 CLI 包时要传分叉版本');
check(/-name 'OneTHU-CLI_\*\.zip'/.test(yml), '发布 CLI 包（应用按资产名精确匹配，缺了就装不上）');
check(/tools\/fork-cli-package-test\.mjs/.test(yml), '本守卫要进 CI');

console.log(`fork CLI package: ${checks} checks passed`);
