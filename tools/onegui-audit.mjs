#!/usr/bin/env node
import { fileURLToPath } from "node:url";
/* ════════════════════════════════════════════════════════════════════════════
 * OneGUI 全量审计 —— 找出「一切不是 OneGUI 或其派生的可见样式」
 *
 * 用户定案：**所有可见对象必须来自 OneGUI 或它的派生**，不允许任何独立手写的样式。
 * 本工具把那句话变成一张可核查的清单：把仓库里所有"外观的写法"逐条定位，
 * 按文件给出条数，生成 docs/onegui/04-legacy-ledger.md（迁移工作单 + 完成判据）。
 *
 * 清点的六类"独立样式源"：
 *   A 旧样式表：apps/desktop/src/styles/*.css 的类名与规则（含每类被引用次数）
 *   B 组件内嵌 CSS：TSX 里 <style> 块 / 模板字符串里的 CSS（此前发现的 ohaa-、ohf- 前缀那一族就是这类）
 *   C 内联样式：TSX 里 style={{…}}（分"外观属性"与"纯几何"两类）
 *   D 字面色值：TSX 里的 #rgb / rgba() / hsl()
 *   E 裸控件：TSX 里的 <button|input|select|textarea>（应改用 Btn/Input/Select…）
 *   F 运行时注入：document.createElement("style") / innerHTML 里塞 CSS
 *
 * 跑法：node tools/onegui-audit.mjs            # 生成台账 + 打印汇总
 *      node tools/onegui-audit.mjs --print     # 只打印，不写文件
 * ══════════════════════════════════════════════════════════════════════════ */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const APP = join(ROOT, "apps/desktop/src");
const OUT = join(ROOT, "docs/onegui/04-legacy-ledger.md");
const PRINT_ONLY = process.argv.includes("--print");

const rel = (p) => relative(ROOT, p).split(sep).join("/");

function walk(dir, exts) {
  const out = [];
  const visit = (d) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith("._") || name === "node_modules") continue;
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) visit(p);
      else if (exts.some((e) => name.endsWith(e))) out.push(p);
    }
  };
  visit(dir);
  return out;
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/* ── A 旧样式表 ───────────────────────────────────────────────────────── */

const cssFiles = walk(join(APP, "styles"), [".css"]);
const tsxFiles = walk(APP, [".tsx", ".ts"]);

// 全仓源码文本：判断某个类名是否还被引用
const srcText = tsxFiles.map((f) => readFileSync(f, "utf8")).join("\n");
const isBridge = (f) => f.endsWith("onegui-bridge.css");

function auditCss() {
  const rows = [];
  let totalClasses = 0;
  let totalRules = 0;
  let totalLines = 0;
  const orphan = [];
  for (const f of cssFiles) {
    const css = readFileSync(f, "utf8");
    const clean = stripComments(css);
    const classes = new Set([...clean.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
    const rules = [...clean.matchAll(/^[^\n{}\/][^\n{]*\{/gm)].length;
    const lines = css.split("\n").length;
    totalClasses += classes.size;
    totalRules += rules;
    totalLines += lines;
    const unreferenced = [...classes].filter((c) => !new RegExp(`\\b${c}\\b`).test(srcText));
    for (const c of unreferenced) orphan.push(`${rel(f)}: .${c}`);
    rows.push({ file: rel(f), classes: classes.size, rules, lines, orphan: unreferenced.length, bridge: isBridge(f) });
  }
  rows.sort((a, b) => b.lines - a.lines);
  return { rows, totalClasses, totalRules, totalLines, orphan };
}

/* ── B 组件内嵌 CSS ───────────────────────────────────────────────────── */

function auditEmbeddedCss() {
  const hits = [];
  for (const f of tsxFiles) {
    const src = readFileSync(f, "utf8");
    // <style>…</style> 块
    for (const m of src.matchAll(/<style[^>]*>\{?`?([\s\S]{40,}?)`?\}?<\/style>/g)) {
      hits.push({ file: rel(f), kind: "<style> 块", size: m[1].length });
    }
    // 模板字符串里的 CSS：形如 `const X_CSS = ` … 带 { 且含 ; 与 :
    for (const m of src.matchAll(/(?:const|let)\s+([A-Z_]*CSS[A-Z_]*)\s*=\s*`([\s\S]{80,}?)`/g)) {
      if (/[a-z-]+\s*:\s*[^;]+;/.test(m[2])) hits.push({ file: rel(f), kind: `模板字符串 ${m[1]}`, size: m[2].length });
    }
  }
  return hits;
}

/* ── C/D/E 内联样式、字面色、裸控件 ───────────────────────────────────── */

const APPEARANCE = /(color|background|border|boxShadow|font|padding|margin|borderRadius|opacity|transform|width|height|top|left|right|bottom|gap|filter|backdropFilter)\s*:/;

function auditInline() {
  const appearance = [];
  const geometry = [];
  const colors = [];
  const controls = [];
  for (const f of tsxFiles) {
    const src = readFileSync(f, "utf8");
    const key = rel(f);
    let ap = 0;
    let geo = 0;
    for (const m of src.matchAll(/style=\{\{([\s\S]*?)\}\}/g)) {
      const body = m[1];
      const isGeom = /^\s*(\{?\s*)?(-{0,2}\w+\s*:)/.test(body) && !/color|background|border|font|boxShadow/.test(body);
      if (APPEARANCE.test(body)) ap += 1;
      else if (isGeom) geo += 1;
    }
    if (ap) appearance.push({ file: key, n: ap });
    if (geo) geometry.push({ file: key, n: geo });
    const c = src.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g);
    if (c) colors.push({ file: key, n: c.length });
    const k = src.match(/<(button|input|select|textarea)(?=[\s/>])/g);
    if (k) controls.push({ file: key, n: k.length });
  }
  const sortDesc = (a, b) => b.n - a.n;
  appearance.sort(sortDesc); geometry.sort(sortDesc); colors.sort(sortDesc); controls.sort(sortDesc);
  const sum = (arr) => arr.reduce((a, b) => a + b.n, 0);
  return {
    appearance, geometry, colors, controls,
    totals: { appearance: sum(appearance), geometry: sum(geometry), colors: sum(colors), controls: sum(controls) },
  };
}

/* ── F 运行时注入 ─────────────────────────────────────────────────────── */

function auditRuntimeCss() {
  const hits = [];
  for (const f of tsxFiles) {
    const src = readFileSync(f, "utf8");
    const n = (src.match(/createElement\("style"\)|innerHTML\s*=\s*[`"'][^`"']*<style|insertRule|adoptedStyleSheets/g) ?? []).length;
    if (n > 0) hits.push({ file: rel(f), n });
  }
  return hits.sort((a, b) => b.n - a.n);
}

/* ── 生成台账 ─────────────────────────────────────────────────────────── */

const css = auditCss();
const embedded = auditEmbeddedCss();
const inline = auditInline();
const runtime = auditRuntimeCss();

const totalSources =
  css.totalRules + embedded.length + inline.totals.appearance + inline.totals.colors + inline.totals.controls + runtime.reduce((a, b) => a + b.n, 0);

const table = (rows, head, fn) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${fn(r).join(" | ")} |`)].join("\n");

const doc = `# OneGUI · 独立样式全量清点（迁移工作单）

> 生成物：\`node tools/onegui-audit.mjs\`（2026-10-14）。**用户定案：所有可见对象必须来自 OneGUI 或它的派生，
> 不允许任何独立手写的样式** —— 本清单就是那句话的执行面：清点 → 逐条消灭 → 末尾判据全部为 0。

## 0. 判据（完成 = 下列全部为 0）

| # | 独立样式源 | 当前 | 目标 |
|---|---|---:|---:|
| A | 旧样式表规则（apps/desktop/src/styles） | ${css.totalRules} | 0 |
| B | 组件内嵌 CSS（\`<style>\` 块 / \`*_CSS\` 模板字符串） | ${embedded.length} | 0 |
| C1 | 内联样式（含外观属性 \`style={{…}}\`） | ${inline.totals.appearance} | 0 |
| C2 | 内联几何（纯定位/尺寸，迁移后由组件 prop 承担） | ${inline.totals.geometry} | 0 |
| D | TSX 字面色值（\`#rgb\`/\`rgba()\`/\`hsl()\`） | ${inline.totals.colors} | 0 |
| E | 裸控件（\`<button|input|select|textarea>\`） | ${inline.totals.controls} | 0 |
| F | 运行时注入（createElement(style)/innerHTML/insertRule） | ${runtime.reduce((a, b) => a + b.n, 0)} | 0 |
| | **合计** | **${totalSources}** | **0** |

## A. 旧样式表（${cssFiles.length} 个文件 / ${css.totalLines} 行 / ${css.totalClasses} 个类名 / ${css.totalRules} 条规则）

${table(css.rows.slice(0, 20), ["文件", "行", "规则", "类名", "零引用类名", "过渡桥"], (r) => [
  `\`${r.file}\``, r.lines, r.rules, r.classes, r.orphan, r.bridge ? "是（TEMP）" : "",
])}

**零引用类名 ${css.orphan.length} 个**（可先删；注意动态拼接类名要人工确认）——前 20：
${css.orphan.slice(0, 20).map((o) => `- ${o}`).join("\n")}

## B. 组件内嵌 CSS（${embedded.length} 处）

${table(embedded.slice(0, 30), ["文件", "形态", "约字节"], (r) => [`\`${r.file}\``, r.kind, r.size])}

## C1. 内联外观样式 Top 25（共 ${inline.totals.appearance} 处 / ${inline.appearance.length} 个文件）

${table(inline.appearance.slice(0, 25), ["文件", "处数"], (r) => [`\`${r.file}\``, r.n])}

## C2. 内联几何 Top 15（共 ${inline.totals.geometry} 处）

${table(inline.geometry.slice(0, 15), ["文件", "处数"], (r) => [`\`${r.file}\``, r.n])}

## D. 字面色值 Top 25（共 ${inline.totals.colors} 处 / ${inline.colors.length} 个文件）

${table(inline.colors.slice(0, 25), ["文件", "处数"], (r) => [`\`${r.file}\``, r.n])}

## E. 裸控件 Top 25（共 ${inline.totals.controls} 处 / ${inline.controls.length} 个文件）

${table(inline.controls.slice(0, 25), ["文件", "处数"], (r) => [`\`${r.file}\``, r.n])}

## F. 运行时样式注入（${runtime.length} 个文件）

${table(runtime.slice(0, 20), ["文件", "处数"], (r) => [`\`${r.file}\``, r.n])}

## 迁移顺序（按"可见性 × 代价"排）

1. **E 裸控件 + C1 内联外观**：直接换成 OneGUI 组件（形态最明确，收益最大）。
2. **D 字面色值**：换成组件 tone/variant 或语义令牌。
3. **B 组件内嵌 CSS / F 运行时注入**：先搬进 OneGUI 的组件样式表，再删注入点。
4. **A 旧样式表**：随页面迁移逐族删除；过渡桥（TEMP）最后与旧样式表一起删。
5. **C2 内联几何**：迁到组件 prop（\`pos\`/\`Grid\`/\`Stack\`）后清零。
`;

if (!PRINT_ONLY) writeFileSync(OUT, doc);

console.log("OneGUI 全量审计：");
console.log(`  A 旧样式表      ${css.totalRules} 条规则 / ${css.totalLines} 行 / ${css.totalClasses} 类名（零引用 ${css.orphan.length}）`);
console.log(`  B 内嵌 CSS      ${embedded.length} 处`);
console.log(`  C1 内联外观     ${inline.totals.appearance} 处（${inline.appearance.length} 文件）`);
console.log(`  C2 内联几何     ${inline.totals.geometry} 处`);
console.log(`  D 字面色值      ${inline.totals.colors} 处（${inline.colors.length} 文件）`);
console.log(`  E 裸控件        ${inline.totals.controls} 处（${inline.controls.length} 文件）`);
console.log(`  F 运行时注入    ${runtime.reduce((a, b) => a + b.n, 0)} 处`);
console.log(`  合计独立样式源  ${totalSources} → 目标 0`);
if (!PRINT_ONLY) console.log(`  台账已写：${rel(OUT)}`);
