import { fileURLToPath } from "node:url";
/**
 * OH 路由表**防脱同**护栏（2026-10-12 task-22）：
 *
 * 唯一真源 = apps/desktop/src/state/searchRows.ts（各 section 的 defineSearchRows 字面量）；
 * 资产副本 = plugins/OneTHU-Harness/assets/routes.json（include_str! 进 harness 核心，
 * 供 OH 的 ui_navigate / ui_route_table 在 webview 不在场时仍能匹配）。
 * gen = tools/gen-oh-routes.mjs。**改动任意检索行 → 重跑 gen**，否则本护栏 exit 1。
 */
import { readFileSync } from "node:fs";
import { parseSearchRows } from "./lib/search-rows-parse.mjs";

const ASSET = fileURLToPath(new URL("../plugins/OneTHU-Harness/assets/routes.json", import.meta.url));
const parse = parseSearchRows();
let asset = [];
try {
  asset = JSON.parse(readFileSync(ASSET, "utf8"));
} catch {
  console.error(`✗ routes.json 读不了（${ASSET}）——先跑 node tools/gen-oh-routes.mjs`);
  process.exit(1);
}
const fails = [];
if (asset.length !== parse.length) {
  fails.push(`行数不一致：asset ${asset.length} vs 注册表 ${parse.length}（重跑 node tools/gen-oh-routes.mjs）`);
}
const pMap = new Map(parse.map((r) => [r.id, r]));
const ids = new Set();
const kindOf = (tab) => (tab === "OneTHU Harness" ? "oh" : tab === "插件" ? "plugins" : "settings");
for (const a of asset) {
  if (ids.has(a.id)) fails.push("asset 重复 id: " + a.id);
  ids.add(a.id);
  const p = pMap.get(a.id);
  if (!p) {
    fails.push(`asset 里多出的行: ${a.id}（注册表已删？重跑 gen）`);
    continue;
  }
  for (const k of ["title", "tab", "section"]) {
    if ((a[k] ?? "") !== (p[k] ?? "")) fails.push(`${a.id}.${k} 不一致：asset「${a[k]}」vs 注册表「${p[k]}」`);
  }
  if (JSON.stringify(a.aliases) !== JSON.stringify(p.aliases)) fails.push(`${a.id}.aliases 不一致（重跑 gen）`);
  const bc = p.breadcrumb.length ? p.breadcrumb : [kindOf(p.tab) === "settings" ? "设置" : "插件", p.tab, p.section, p.title];
  if (JSON.stringify(a.breadcrumb) !== JSON.stringify(bc)) fails.push(`${a.id}.breadcrumb 不一致（重跑 gen）`);
  if (a.kind !== kindOf(p.tab)) fails.push(`${a.id}.kind 不一致`);
  /* note：fallbackNote 或 landOn.note；两路取合后必须完全一致 */
  const wantNote = p.note || (p.landOn ? p.landOn.note : "");
  if ((a.note ?? "") !== (wantNote ?? "")) fails.push(`${a.id}.note 不一致（asset「${(a.note ?? "").slice(0, 18)}」/ 注册表「${(wantNote ?? "").slice(0, 18)}」）重跑 gen`);
}
for (const p of parse) {
  if (!ids.has(p.id)) fails.push(`注册表里多出的行: ${p.id}（asset 没跟上，重跑 gen）`);
}
console.log(`路由表同步护栏：asset ${asset.length} 行 vs 注册表 ${parse.length} 行`);
if (fails.length === 0) {
  console.log("✅ routes.json 与 searchRows 完全同源（改动检索行后已重跑 gen-oh-routes）");
  process.exit(0);
}
console.error(`✗ ${fails.length} 项脱同：`);
for (const f of fails.slice(0, 20)) console.error("   " + f);
console.error("→ 修复：node tools/gen-oh-routes.mjs && find plugins/OneTHU-Harness/assets -name '._*' -delete");
process.exit(1);
