#!/usr/bin/env node
import { fileURLToPath } from "node:url";
/* ════════════════════════════════════════════════════════════════════════════
 * OneGUI 护栏 —— 唯一风格裁判
 *
 * 数据层有「所有校园服务走同一条会话管线」，样式层对应的是这份检查：
 * 应用的界面只能来自 @onethu/gui，旁路样式一律拦下。规则原文见 docs/onegui/10-contract.md。
 *
 * 六条规则（换血期用「基线棘轮」：只拦新增，逐页迁移时基线一起下调）：
 *   R1 库内纯度    packages/gui/src/** 的组件 CSS 只许引用 --og-* 令牌（字面色值/px 违规）
 *   R2 应用内联样式 apps/desktop/src 的 TSX 不许新增带外观属性的 style={{…}}
 *   R3 应用字面色值 apps/desktop/src 的 TSX 不许新增 #rgb / rgba( 字面色
 *   R4 应用裸控件  页面/组件不许出现裸 <button|input|select|textarea>（白名单外）
 *   R5 令牌引用    库内引用的 --og-*（含 var(--x, fallback)）必须真的有定义
 *   R6 画廊登记    src/index.ts 导出的组件必须在 gallery 里出现（新组件不许"偷偷加"）
 *
 * 用法：
 *   node tools/onegui-guard.mjs                  # 检查（CI/guard）
 *   node tools/onegui-guard.mjs --write-baseline # 重新播种基线（迁移一批后下调）
 *   node tools/onegui-guard.mjs --report         # 只打印，不因基线超标失败
 * ══════════════════════════════════════════════════════════════════════════ */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const GUI = join(ROOT, "packages/gui");
const APP = join(ROOT, "apps/desktop/src");
const BASELINE = join(ROOT, "tools/onegui-baseline.json");
const GALLERY = join(APP, "gallery/OneGUIGallery.tsx");

const args = new Set(process.argv.slice(2));
const WRITE_BASELINE = args.has("--write-baseline");
const REPORT_ONLY = args.has("--report");

/* ── 工具 ─────────────────────────────────────────────────────────────── */

/** 递归收集文件（跳过 AppleDouble ._* 与 node_modules） */
function walk(dir, exts) {
  const out = [];
  const visit = (d) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith("._") || name === "node_modules" || name === ".git") continue;
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

const rel = (p) => relative(ROOT, p).split(sep).join("/");

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const failures = [];
const notes = [];

/* ── R1：库内纯度（组件 CSS 只许用令牌） ────────────────────────────── */

const TOKEN_FILES = ["tokens/", "skins/"];
/** 基座样式表里的浏览器伪元素细节（滚动条命中区、::selection）允许字面值，已在本文件注明 */
const PURITY_EXEMPT = ["styles/base.css"];
const LITERAL_ALLOW = [
  /^\s*0(px)?\s*$/,
  /^1px\s*$/,
  /^100%\s*$/,
  /^0(px)?\s+0(px)?\s+0(px)?\s+0(px)?$/,
];

function checkGuiPurity() {
  const files = walk(join(GUI, "src"), [".css"])
    .filter((f) => !TOKEN_FILES.some((t) => rel(f).includes(t)))
    .filter((f) => !PURITY_EXEMPT.some((t) => rel(f).endsWith(t)));
  let colorHits = 0;
  let pxHits = 0;
  const details = [];
  for (const f of files) {
    const css = stripComments(readFileSync(f, "utf8"));
    const lines = css.split("\n");
    lines.forEach((line, i) => {
      // 媒体查询断点是布局语义（单一来源在 state/platform.ts），允许字面值
      if (/@media/.test(line)) return;
      // 字面色值：只允许出现在背景图 data-uri 之外
      const colorMatches = line.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g);
      if (colorMatches) {
        // 白名单：rgba(var(…)) 之类由令牌拼装的写法
        const real = colorMatches.filter((m) => !/var\(/.test(m));
        if (real.length > 0) {
          colorHits += real.length;
          details.push(`${rel(f)}:${i + 1} 字面色值 ${real.join(", ")}`);
        }
      }
      // 字面 px：只允许 0 / 1px / 100%（其余必须走令牌）
      const pxMatches = line.match(/(?<![\w.-])(\d+(?:\.\d+)?)px/g);
      if (pxMatches) {
        const real = pxMatches.filter((m) => !LITERAL_ALLOW.some((re) => re.test(m)));
        // calc()/var() 里由令牌决定的不算（那些是 1px 之类的常量算术）
        if (real.length > 0 && !/var\(/.test(line)) {
          pxHits += real.length;
          details.push(`${rel(f)}:${i + 1} 字面尺寸 ${real.join(", ")}`);
        }
      }
    });
  }
  if (colorHits + pxHits > 0) {
    failures.push(`R1 库内纯度：${colorHits} 处字面色值 + ${pxHits} 处字面尺寸（组件 CSS 只许引用 --og-* 令牌）`);
    for (const d of details.slice(0, 12)) notes.push("   " + d);
  } else {
    notes.push(`R1 库内纯度 ✓（${files.length} 个组件样式表，零字面色/尺寸）`);
  }
}

/* R9: even skins and semantic layers cannot introduce a second palette. */
function checkPaletteOwnership() {
  const offenders = [];
  for (const f of walk(join(GUI, "src"), [".css"])) {
    if (rel(f).endsWith("tokens/reference.css")) continue;
    const css = stripComments(readFileSync(f, "utf8"));
    if (/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/.test(css)) offenders.push(rel(f));
  }
  if (offenders.length) failures.push("R9 调色板单源：颜色字面值只能在 tokens/reference.css：" + offenders.join(", "));
  else notes.push("R9 调色板单源 ✓（语义/结构/材质/组件/宿主配方零字面色）");
}

/* ── R2/R3：应用侧内联样式与字面色值（棘轮） ────────────────────────── */

/** 已有 OneGUI 替代品的旧类名族：应用侧出现次数只许下降（迁一页掉一批） */
const LEGACY_CLASSES = [
  "card", "empty", "section-head", "error-note", "skeleton", "page-head", "setting-row", "setting-title", "switch",
];

function legacyClassCounts() {
  const out = {};
  for (const f of walk(APP, [".tsx"])) {
    const src = readFileSync(f, "utf8");
    let count = 0;
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const value = m[1] ?? m[2] ?? "";
      const tokens = value.split(/[\s"'`+${}()?:]+/).filter(Boolean);
      for (const t of tokens) if (LEGACY_CLASSES.includes(t)) count += 1;
    }
    if (count > 0) out[rel(f)] = count;
  }
  return out;
}

/** 旧样式表（apps/desktop/src/styles/*.css）总行数：只许下降 —— 换血完成时归零 */
function legacyCssLines() {
  const dir = join(APP, "styles");
  let total = 0;
  const per = {};
  for (const f of walk(dir, [".css"])) {
    // 过渡桥不算旧样式：它是 TEMP 桥（把旧令牌名指到 OneGUI 令牌），换血收尾时与旧 CSS 一起删
    if (f.endsWith("onegui-bridge.css")) continue;
    const n = readFileSync(f, "utf8").split("\n").length;
    per[rel(f)] = n;
    total += n;
  }
  return { total, per };
}

const APPEARANCE_PROPS = /(color|background|border|boxShadow|font|padding|margin|borderRadius|opacity|transform)\s*:/;

function appCounts() {
  const files = walk(APP, [".tsx", ".ts"]).filter(f => !f.startsWith(join(APP, "i18n/locales") + "/"));
  const inline = {};
  const colors = {};
  const rawControls = {};
  const CONTROL_RE = /<(button|input|select|textarea)(?=[\s/>])/g;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const key = rel(f);
    // 内联样式：只看"带外观属性"的 style={{…}}（纯几何/变量透传不算）
    let count = 0;
    const styleRe = /style=\{\{([\s\S]*?)\}\}/g;
    let m;
    while ((m = styleRe.exec(src)) !== null) {
      const body = m[1];
      if (APPEARANCE_PROPS.test(body)) count += 1;
    }
    if (count > 0) inline[key] = count;
    const colorMatches = src.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g);
    if (colorMatches) colors[key] = colorMatches.length;
    const controls = src.match(CONTROL_RE);
    if (controls) rawControls[key] = controls.length;
  }
  return { inline, colors, rawControls };
}

function compareBaseline(name, current, limit, label) {
  const over = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = limit[file] ?? 0;
    if (count > allowed) over.push(`${file}: ${count}（基线 ${allowed}）`);
  }
  if (over.length > 0) {
    failures.push(`${name}：${label}新增 ${over.length} 个文件超标`);
    for (const o of over.slice(0, 12)) notes.push("   " + o);
  } else {
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    notes.push(`${name} ✓（当前 ${total} 处，基线 ${Object.values(limit).reduce((a, b) => a + b, 0)} 处）`);
  }
}

/* ── R5：令牌引用必须存在 ───────────────────────────────────────────── */

function checkTokenRefs() {
  const defs = new Set();
  for (const f of walk(join(GUI, "src"), [".css"])) {
    const css = stripComments(readFileSync(f, "utf8"));
    for (const m of css.matchAll(/(--og-[\w-]+)\s*:/g)) defs.add(m[1]);
  }
  const missing = new Map();
  for (const f of walk(join(GUI, "src"), [".css", ".tsx", ".ts"])) {
    const src = stripComments(readFileSync(f, "utf8"));
    for (const m of src.matchAll(/var\((--og-[\w-]+)\s*(,|\))/g)) {
      const name = m[1];
      const hasFallback = m[2] === ",";
      // 组件私有令牌（--og-c-*）常由 JS/内联变量在运行时注入，不做"必须静态定义"的要求
      if (!defs.has(name) && !hasFallback && !name.startsWith("--og-c-")) {
        const list = missing.get(rel(f)) ?? [];
        list.push(name);
        missing.set(rel(f), list);
      }
    }
  }
  if (missing.size > 0) {
    failures.push(`R5 令牌引用：${missing.size} 个文件引用了未定义的令牌`);
    for (const [f, names] of [...missing].slice(0, 10)) notes.push(`   ${f}: ${[...new Set(names)].join(", ")}`);
  } else {
    notes.push(`R5 令牌引用 ✓（定义 ${defs.size} 个 --og-* 令牌，引用全部有定义）`);
  }
}

/* ── R6：画廊登记 ───────────────────────────────────────────────────── */

function checkGallery() {
  const index = readFileSync(join(GUI, "src/index.ts"), "utf8");
  const exported = new Set();
  for (const m of index.matchAll(/^export \{([\s\S]*?)\} from/gm)) {
    for (const piece of m[1].split(",")) {
      const name = piece.trim().split(/\s+as\s+/).pop();
      if (name && /^[A-Z]/.test(name)) exported.add(name);
    }
  }
  for (const m of index.matchAll(/^export \* from .*icons.*$/gm)) {
    // 图标集整体导出，逐个登记不现实：只要画廊引用了图标即可
    void m;
  }
  if (!existsSync(GALLERY)) {
    failures.push("R6 画廊登记：gallery/OneGUIGallery.tsx 不存在");
    return;
  }
  const gallery = readFileSync(GALLERY, "utf8");
  // Providers and static message catalogs expose no visual component to showcase.
  // Keep this explicit: an uppercase component constant must still be registered.
  const API_NAMES = new Set([
    "OneGUIProvider", "Scope", "StyleDirector", "SCOPE_TOKENS", "OneStyle", "DataRow",
    "OneGUILocaleProvider", "ONE_GUI_ZH_CN", "ONE_GUI_EN_US", "ONE_GUI_MESSAGE_KEYS",
  ]);
  const missing = [...exported].filter((name) =>
    !API_NAMES.has(name) && !/^Icon/.test(name) && !new RegExp(`\\b${name}\\b`).test(gallery));
  const iconUsed = /\bIcon[A-Z]/.test(gallery);
  if (missing.length > 0) {
    failures.push(`R6 画廊登记：${missing.length} 个导出组件没在画廊出现`);
    notes.push("   " + missing.join(", "));
  } else {
    notes.push(`R6 画廊登记 ✓（${exported.size} 个导出组件，图标集${iconUsed ? "已" : "未"}引用）`);
  }
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */

checkGuiPurity();
checkPaletteOwnership();
checkTokenRefs();
checkGallery();

const counts = appCounts();
let baseline = { inline: {}, colors: {}, rawControls: {}, note: "" };
if (existsSync(BASELINE) && !WRITE_BASELINE) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    notes.push("基线文件损坏，按全零处理（请 --write-baseline 重播种）");
  }
}

if (WRITE_BASELINE) {
  const payload = {
    note: "换血期的应用侧基线：只许下调。每迁完一页，用 --write-baseline 重新播种。",
    inline: counts.inline,
    colors: counts.colors,
    rawControls: counts.rawControls,
    legacyClasses: legacyClassCounts(),
    legacyCssLines: legacyCssLines().total,
    legacyCssPerFile: legacyCssLines().per,
  };
  writeFileSync(BASELINE, JSON.stringify(payload, null, 2) + "\n");
  console.log(`OneGUI 护栏：基线已更新 → ${rel(BASELINE)}`);
  const legacy = legacyClassCounts();
  console.log(`  旧样式表 ${legacyCssLines().total} 行`);
  console.log(`  内联样式 ${Object.values(counts.inline).reduce((a, b) => a + b, 0)} 处 / 字面色 ${Object.values(counts.colors).reduce((a, b) => a + b, 0)} 处 / 裸控件 ${Object.values(counts.rawControls).reduce((a, b) => a + b, 0)} 处 / 旧 UI 类名 ${Object.values(legacy).reduce((a, b) => a + b, 0)} 处`);
  process.exit(0);
}

{
  const css = legacyCssLines();
  const allowed = baseline.legacyCssLines ?? Number.POSITIVE_INFINITY;
  if (css.total > allowed) {
    failures.push(`R8 旧样式表行数：${css.total} 行（基线 ${allowed}）—— 换血只许把这个数往下压`);
    const over = Object.entries(css.per).filter(([f, n]) => n > (baseline.legacyCssPerFile?.[f] ?? Number.POSITIVE_INFINITY));
    for (const [f, n] of over.slice(0, 8)) notes.push(`   ${f}: ${n} 行（基线 ${baseline.legacyCssPerFile?.[f]}）`);
  } else {
    notes.push(`R8 旧样式表行数 ✓（${css.total} 行 / 基线 ${Number.isFinite(allowed) ? allowed : "未播种"} 行）`);
  }
}

compareBaseline("R7 旧 UI 类名", legacyClassCounts(), baseline.legacyClasses ?? {}, "旧 UI 类名（card/empty/section-head/…）");

compareBaseline("R2 应用内联样式", counts.inline, baseline.inline ?? {}, "带外观属性的 style={{…}}");
compareBaseline("R3 应用字面色值", counts.colors, baseline.colors ?? {}, "TSX 里的 #rgb/rgba()");
compareBaseline("R4 应用裸控件", counts.rawControls, baseline.rawControls ?? {}, "裸 <button|input|select|textarea>");

console.log("OneGUI 护栏（唯一风格裁判）：");
for (const n of notes) console.log("  " + n);
if (failures.length === 0) {
  console.log("  ✓ 专项护栏通过 —— 库与宿主配方符合单源契约；应用存量受棘轮约束");
  process.exit(0);
}
console.log("");
for (const f of failures) console.log("  ✗ " + f);
console.log("");
console.log("  规则原文：docs/onegui/10-contract.md；迁移一批后用 --write-baseline 下调基线。");
process.exit(REPORT_ONLY ? 0 : 1);
