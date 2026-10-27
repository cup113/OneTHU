#!/usr/bin/env node
import { fileURLToPath } from "node:url";
/* AST 级把 <select className="input|field"> 改成 OneGUI <Select>：
 *  - 只动属性：丢 className（外观交 variant）、丢 style（库组件不接受）、type；
 *  - onChange 由 (e) => …e.target.value… 改成 (value) => …value…（用 AST 取到箭头函数的精确文本再改写）；
 *  - 保留 children（<option> 原样）。
 * 用法：node tools/onegui-select-rewrite.mjs [--apply]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const APP = join(ROOT, "apps/desktop/src");
const APPLY = process.argv.includes("--apply");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith("._")) continue;
    const p = join(dir, name);
    statSync(p).isDirectory() ? walk(p, out) : name.endsWith(".tsx") && out.push(p);
  }
  return out;
}

function rewriteArrow(text, param) {
  let out = text.replace(/^\s*\(?\s*[\w,\s]*\s*\)?\s*=>/, "(value) =>");
  out = out.replaceAll(`${param}.target.value`, "value");
  return out;
}

/** Input/TextArea 允许的属性白名单：不在表里的一律不转换（保证编译干净） */
const INPUT_OK = new Set([
  "className", "style", "type", "value", "defaultValue", "onChange", "placeholder", "name", "disabled",
  "readOnly", "autoFocus", "maxLength", "inputMode", "autoComplete", "spellCheck", "onKeyDown",
  "onEnter", "onEscape", "aria-label", "title", "invalid", "size", "id",
]);

const isTextField = (tag, attrs, sf) => {
  const cls = attrs.find((a) => a.name?.getText(sf) === "className");
  const clsText = cls?.initializer?.getText(sf) ?? "";
  if (!/\b(input|field)\b/.test(clsText)) return null;
  const typeAttr = attrs.find((a) => a.name?.getText(sf) === "type");
  if (typeAttr) {
    const t = typeAttr.initializer?.getText(sf) ?? "";
    if (!/"(text|email|tel|url|search|password|number)"/.test(t)) return null;
  }
  for (const a of attrs) {
    const name = a.name?.getText(sf) ?? "";
    if (name === "ref" || name === "key") return null;
    // style 一律允许：纯宽度丢掉（输入默认整宽），参与排版的转成"几何外壳 div"（见 buildAttrs 返回值）
    if (!INPUT_OK.has(name)) return null;
  }
  return tag === "textarea" ? "TextArea" : "Input";
};

function buildAttrs(attrs, sf) {
  const kept = [];
  let wrapper = null;
  for (const a of attrs) {
    const name = a.name?.getText(sf) ?? "";
    if (name === "className" || name === "id") continue;
    let text = a.getText(sf);
    if (name === "style") {
      const init = a.initializer?.getText(sf) ?? "";
      if (/flex|position|margin|float|top|left|right|bottom|textAlign/.test(init)) wrapper = init;  // 参与排版 → 外壳承担
      continue;   // 组件本身永远不接 style
    }
    if (name === "title") text = "titleAttr" + text.slice(5);
    if (name === "onChange") {
      const init = a.initializer;
      if (init && ts.isJsxExpression(init) && init.expression && ts.isArrowFunction(init.expression)) {
        const arrow = init.expression;
        const param = arrow.parameters[0]?.name?.getText(sf) ?? "e";
        text = `onChange={${rewriteArrow(arrow.getText(sf), param)}}`;
      }
    }
    kept.push(text);
  }
  return { kept, wrapper };
}

const BUTTON_OK = new Set([
  "className", "type", "disabled", "onClick", "onMouseDown", "onMouseUp", "onContextMenu", "title",
  "aria-label", "aria-pressed", "aria-expanded", "aria-haspopup", "role", "tabIndex", "autoFocus", "style",
]);

const buttonVariant = (cls) => {
  const c = cls.split(/\s+/);
  if (c.includes("btn-primary")) return { variant: "solid", tone: "brand" };
  if (c.includes("btn-danger") || c.includes("plg-danger")) return { variant: "solid", tone: "error" };
  if (c.includes("btn-ghost")) return { variant: "ghost" };
  return { variant: "outline" };
};

let files = 0, count = 0, textCount = 0, btnCount = 0, iconBtnCount = 0;
for (const file of walk(APP)) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const visit = (node) => {
    // <button className="btn…">…</button>
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === "button") {
      const attrs = node.openingElement.attributes.properties;
      const cls = attrs.find((a) => a.name?.getText(sf) === "className");
      const clsText = cls?.initializer?.getText(sf) ?? "";
      const tokens = clsText.replace(/["']/g, "").split(/\s+/).filter(Boolean);
      // 只认"按钮族"：btn / btn-*（chip-btn、icon-btn、ex-btn 等派生族不在此列，它们各自成族）
      const isBtnFamily = tokens.some((t) => t === "btn" || t.startsWith("btn-"));
      if (isBtnFamily && attrs.every((a) => BUTTON_OK.has(a.name?.getText(sf) ?? ""))) {
        const { variant, tone } = buttonVariant(clsText.replace(/["']/g, ""));
        const kept = [`variant="${variant}"`];
        if (tone) kept.push(`tone="${tone}"`);
        for (const a of attrs) {
          const name = a.name?.getText(sf) ?? "";
          if (name === "className" || name === "type" || name === "style") continue;
          let text = a.getText(sf);
          if (name === "title") text = "titleAttr" + text.slice(5);
          kept.push(text);
        }
        const children = node.children.map((c) => c.getText(sf)).join("");
        edits.push([node.getStart(sf), node.getEnd(), `<Btn ${kept.join(" ")}>${children}</Btn>`, "Btn"]);
      }
    }

    // 页面私有"小按钮族" → IconBtn（单图标 + 有标签）或 Btn（文字）
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === "button") {
      const SMALL = ["ex-bbar-btn", "dock-btn", "hs-dock-btn", "hs-detail-btn", "dl-open-btn", "fav-tile-btn",
        "filter-dd-btn", "heb-btn", "ex-btn", "gitlab-code-btn", "plg-repo-btn", "collect-new-btn", "course-card-btn"];
      const attrs = node.openingElement.attributes.properties;
      const cls = attrs.find((a) => a.name?.getText(sf) === "className");
      const tokens = (cls?.initializer?.getText(sf)?.replace(/["']/g, "") ?? "").split(/\s+/).filter(Boolean);
      const family = tokens.find((t) => SMALL.includes(t));
      const labelAttr = attrs.find((a) => ["aria-label", "title"].includes(a.name?.getText(sf) ?? ""));
      const labelText = labelAttr?.initializer?.getText(sf) ?? "";
      const kids = node.children.map((c) => c.getText(sf)).join("").trim();
      const okAttrs = attrs.every((a) => [
        "className", "onClick", "onMouseDown", "disabled", "title", "aria-label", "aria-pressed",
        "aria-expanded", "aria-haspopup", "role", "tabIndex", "type",
      ].includes(a.name?.getText(sf) ?? ""));
      if (family && okAttrs) {
        const extra = [];
        for (const a of attrs) {
          const name = a.name?.getText(sf) ?? "";
          if (["className", "title", "aria-label", "type"].includes(name)) continue;
          extra.push(a.getText(sf));
        }
        const tail = extra.length ? " " + extra.join(" ") : "";
        if (kids.startsWith("<") && !kids.includes("</") + "" && labelAttr) {
          edits.push([node.getStart(sf), node.getEnd(), `<IconBtn label=${labelText} icon={${kids}}${tail} />`, "IconBtn"]);
        } else if (kids && !kids.startsWith("<")) {
          edits.push([node.getStart(sf), node.getEnd(), `<Btn variant="ghost" size="sm"${tail}>${kids}</Btn>`, "Btn"]);
        }
      }
    }

    // <button className="icon-btn…"> 单图标无文字钮 → IconBtn
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === "button") {
      const attrs = node.openingElement.attributes.properties;
      const cls = attrs.find((a) => a.name?.getText(sf) === "className");
      const clsText = cls?.initializer?.getText(sf)?.replace(/["']/g, "") ?? "";
      const tokens = clsText.split(/\s+/).filter(Boolean);
      const isIconBtn = tokens.includes("icon-btn");
      const labelAttr = attrs.find((a) => ["aria-label", "title"].includes(a.name?.getText(sf) ?? ""));
      const labelText = labelAttr?.initializer?.getText(sf) ?? "";
      const kids = node.children.map((c) => c.getText(sf)).join("").trim();
      const okAttrs = attrs.every((a) => [
        "className", "onClick", "disabled", "title", "aria-label", "aria-pressed", "aria-expanded",
        "aria-haspopup", "role", "tabIndex", "type",
      ].includes(a.name?.getText(sf) ?? ""));
      if (isIconBtn && labelAttr && /^"|\{"/.test(labelText) && okAttrs && kids.startsWith("<") && !kids.includes("<span")) {
        const extra = [];
        for (const a of attrs) {
          const name = a.name?.getText(sf) ?? "";
          if (name === "className" || name === "title" || name === "aria-label" || name === "type") continue;
          extra.push(a.getText(sf));
        }
        edits.push([
          node.getStart(sf), node.getEnd(),
          `<IconBtn label=${labelText} icon={${kids}}${extra.length ? " " + extra.join(" ") : ""} />`,
          "IconBtn",
        ]);
      }
    }

    // <input … /> 与 <textarea>…</textarea>
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      const tagName = open.tagName.getText(sf);
      if (tagName === "input" || tagName === "textarea") {
        const attrs = open.attributes.properties;
        const comp = isTextField(tagName, attrs, sf);
        if (comp) {
          const { kept, wrapper } = buildAttrs(attrs, sf);
          const selfClose = ts.isJsxSelfClosingElement(node);
          const children = selfClose ? "" : node.children.map((c) => c.getText(sf)).join("");
          const inner = selfClose
            ? `<${comp}${kept.length ? " " + kept.join(" ") : ""} />`
            : `<${comp}${kept.length ? " " + kept.join(" ") : ""}>${children}</${comp}>`;
          const next = wrapper ? `<div style=${wrapper}>{${inner}}</div>` : inner;
          edits.push([node.getStart(sf), node.getEnd(), next, comp]);
        }
      }
    }
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText(sf);
      if (tag === "select") {
        const attrs = node.openingElement.attributes.properties;
        const cls = attrs.find((a) => a.name?.getText(sf) === "className");
        const clsText = cls?.initializer?.getText(sf) ?? "";
        if (/\b(input|field)\b/.test(clsText)) {
          const kept = [];
          for (const a of attrs) {
            const name = a.name?.getText(sf) ?? "";
            if (name === "className" || name === "style" || name === "type") continue;
            let text = a.getText(sf);
            if (name === "title") text = "titleAttr" + text.slice(5);
            if (name === "onChange") {
              const init = a.initializer;
              if (init && ts.isJsxExpression(init) && init.expression && ts.isArrowFunction(init.expression)) {
                const arrow = init.expression;
                const param = arrow.parameters[0]?.name?.getText(sf) ?? "e";
                text = `onChange={${rewriteArrow(arrow.getText(sf), param)}}`;
              }
            }
            kept.push(text);
          }
          const children = node.children.map((c) => c.getText(sf)).join("");
          const next = `<Select${kept.length ? " " + kept.join(" ") : ""}>${children}</Select>`;
          edits.push([node.getStart(sf), node.getEnd(), next, "Select"]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!edits.length) continue;
  let out = src;
  for (const [a, b, text] of edits.reverse()) out = out.slice(0, a) + text + out.slice(b);
  const comps = [...new Set(edits.map((e) => e[3]))];
  const missing = comps.filter((c) => !new RegExp(`import\\s*\\{[^}]*\\b${c}\\b[^}]*\\}\\s*from\\s*"@onethu/gui"`).test(out));
  if (missing.length) out = `import { ${missing.join(", ")} } from "@onethu/gui";\n` + out;
  if (APPLY) writeFileSync(file, out);
  files += 1;
  count += edits.filter((e) => e[3] === "Select").length;
  textCount += edits.filter((e) => e[3] === "Input" || e[3] === "TextArea").length;
  btnCount += edits.filter((e) => e[3] === "Btn").length;
  iconBtnCount = edits.filter((e) => e[3] === "IconBtn").length;
}
console.log(`${APPLY ? "已改写" : "可改写"}：<select> ${count}，<input>/<textarea> ${textCount}，<button.btn> ${btnCount}，<button.icon-btn> ${iconBtnCount} / ${files} 个文件`);
