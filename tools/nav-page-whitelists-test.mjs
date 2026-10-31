/**
 * 页面白名单一致性：导航注册表里的每个一级页，都必须在三张白名单里。
 * 2026-10-31 验收实录：清单页漏了 KNOWN_PAGES → 点入口直接回首页（"点了没反应"）。
 * 运行：node tools/nav-page-whitelists-test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const registry = read("apps/desktop/src/state/navigation.ts");
const pages = [...new Set([...registry.matchAll(/page:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]))]
  /* 设置与插件是浮层，不进标签页白名单（openTab 会把它们转成 openSettings） */
  .filter((page) => page !== "settings" && page !== "plugins");
assert.ok(pages.length > 20, "导航注册表解析失败");

function block(path, pattern, label) {
  const match = read(path).match(pattern);
  assert.ok(match, `${label} 白名单没找到`);
  return match[0];
}

const whitelists = [
  ["标签页", block("apps/desktop/src/state/explorer.ts", /const KNOWN_PAGES[\s\S]*?\]\);/, "KNOWN_PAGES"), pages],
  /* hash/返回只认一级页：learn-* 子页会经 topLevelPage 落回 learn，本表不需要逐个登记 */
  ["hash/返回", block("apps/desktop/src/state/app.tsx", /const TOP_PAGES = \[[\s\S]*?\] as const;/, "TOP_PAGES"), pages.filter((page) => !page.startsWith("learn-"))],
  ["插件/OH 开页", block("apps/desktop/src/plugins/facade.ts", /const TOP_PAGES = new Set\(\[[\s\S]*?\]\);/, "TOP_PAGES"), pages],
];

for (const [label, source, expected] of whitelists) {
  for (const page of expected) {
    assert.ok(source.includes(`"${page}"`), `${label}白名单缺少页面 "${page}"（nav 注册表里存在）`);
  }
}

assert.ok(pages.includes("lists"), "清单页必须登记在导航注册表里");
console.log(`✓ 页面白名单：${pages.length} 个注册页 × 3 张表全部命中`);
