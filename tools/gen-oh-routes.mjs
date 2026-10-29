import { fileURLToPath } from "node:url";
/**
 * 离线生成 OH/检索直达的**路由表资产**（2026-10-12 task-22）：
 *
 *   数据 → plugins/OneTHU-Harness/assets/routes.json（include_str! 进 harness 核心，
 *   webview 不在场 / 应用退后台时，OH 的 ui_route_table / ui_navigate 匹配仍有兜底）。
 *
 * 唯一真源 = apps/desktop/src/state/searchRows.ts + 各 section 的 defineSearchRows 字面量。
 * **改动检索行后必须重跑本脚本**（`node tools/gen-oh-routes.mjs`）；
 * 护栏 tools/oh-routes-sync-test.mjs 会对照最新 parse 与 assets 同步、防脱同。
 * 例：`node tools/gen-oh-routes.mjs`　→ 成功时打印行数 + 家族分布，写带 atom 抖动后别忘了
 * `find plugins/OneTHU-Harness/assets -name '._*' -delete`（exFAT 伴生文件会伤 build.rs）。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { parseSearchRows, SEARCH_ROW_FILES } from "./lib/search-rows-parse.mjs";

const rows = parseSearchRows();
const OUT = "plugins/OneTHU-Harness/assets/routes.json";
mkdirSync(fileURLToPath(new URL("../plugins/OneTHU-Harness/assets", import.meta.url)), { recursive: true });

/** kind：tab 唯一决定家族（OneTHU Harness → oh；插件 → plugins；其余设置为设置页行）；
 *  tier/view 把「二级切档」表达成数据（OH 行带 basic/advanced；插件行带 mine/market）。 */
const table = rows.map((r) => {
  const kind = r.tab === "OneTHU Harness" ? "oh" : r.tab === "插件" ? "plugins" : "settings";
  const tier = kind === "oh" && r.breadcrumb[2] === "高级配置" ? "advanced" : kind === "oh" ? "basic" : "";
  const view = kind === "plugins" ? (r.section === "插件市场" ? "market" : "mine") : "";
  return {
    id: r.id,
    title: r.title,
    desc: r.desc,
    aliases: r.aliases,
    breadcrumb: r.breadcrumb.length ? r.breadcrumb : (kind === "settings" ? ["设置", r.tab, r.section, r.title] : ["插件", r.tab, r.section, r.title]),
    kind,
    tier,
    view,
    tab: r.tab,
    section: r.section,
    note: r.note || (r.landOn ? r.landOn.note : ""),
  };
});

writeFileSync(OUT, JSON.stringify(table, null, 2) + "\n", "utf8");
const by = (k) => table.filter((x) => x.kind === k).length;
console.log(`routes.json 生成：${table.length} 行（设置 ${by("settings")} / 插件 ${by("plugins")} / OH ${by("oh")}）→ ${OUT}`);
if (SEARCH_ROW_FILES.length !== 9) throw new Error("SEARCH_ROW_FILES 清单变了？同步 coverage/landing 护栏");
