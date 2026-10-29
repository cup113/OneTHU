import { fileURLToPath } from "node:url";
/**
 * 修改后的 searchRows：检索行注册块的**唯一离线解析器**（tools 共享；2026-10-12 task-22）。
 *
 * 为什么是它：`state/searchRows.ts` 是运行时唯一真源，而护栏（coverage / landing / gen / sync）
 * 全部离线跑 —— 若每份脚本自己解析一遍，任何 token 集合的漂移都会让 4 份口径悄悄开叉。
 * parseSearchRows：覆盖 defineSearchRows([...]) 块、识别リテラル字段与数组/嵌套对象，
 * 额外携带 breadcrumb/visible/fallbackNote/root/landOn（gen-oh-routes 用它们生成子字段）。
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { readDataFile } from "../i18n/dictionary.mjs";

/** 全部注册了定域检索行的文件（改这行清单 = 同步 coverage / landing / gen） */
export const SEARCH_ROW_FILES = [
  "apps/desktop/src/components/OhSettingsPage.tsx",
  "apps/desktop/src/components/VoiceSettingsSection.tsx",
  "apps/desktop/src/components/OverlaySettingsSection.tsx",
  "apps/desktop/src/components/ImSettingsSection.tsx",
  "apps/desktop/src/components/WidgetSettingsSection.tsx",
  "apps/desktop/src/components/NameCardSection.tsx",
  "apps/desktop/src/components/OrganizationSection.tsx",
  "apps/desktop/src/pages/Settings.tsx",
  "apps/desktop/src/pages/Plugins.tsx",
];

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Parse declarations without executing application code, getters, or translation modules. */
export function parseSearchRows() {
  const messages = readDataFile(REPO_ROOT + "apps/desktop/src/i18n/locales/zh-CN.ts").messages;
  const rows = [];
  for (const rel of SEARCH_ROW_FILES) {
    const src = readFileSync(REPO_ROOT + rel, "utf8");
    const file = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const value = node => {
      if (!node) return "";
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
      if (ts.isArrayLiteralExpression(node)) return node.elements.map(value);
      if (ts.isObjectLiteralExpression(node)) return properties(node);
      if (ts.isCallExpression(node) && ["i18n", "t"].includes(node.expression.getText(file)) && ts.isStringLiteral(node.arguments[0])) {
        const key = node.arguments[0].text;
        if (!Object.hasOwn(messages, key)) throw new Error(`${rel}: unknown translation key ${key}`);
        return messages[key];
      }
      throw new Error(`${rel}: unsupported search label expression ${node.getText(file)}`);
    };
    const properties = object => Object.fromEntries(object.properties.filter(p => p.name).map(p => {
      const key = p.name.getText(file).replace(/^['"]|['"]$/g, "");
      if (["go", "visible"].includes(key)) return [key, true];
      if (ts.isGetAccessor(p)) {
        if (p.body?.statements.length !== 1 || !ts.isReturnStatement(p.body.statements[0])) throw new Error(`${rel}: search getter must directly return a message`);
        return [key, value(p.body.statements[0].expression)];
      }
      return [key, value(p.initializer)];
    }));
    function visit(node) {
      if (ts.isCallExpression(node) && ["defineSearchRows", "defineSearchRow"].includes(node.expression.getText(file))) {
        const first = node.arguments[0];
        for (const entry of ts.isArrayLiteralExpression(first) ? first.elements : [first]) {
          if (!ts.isObjectLiteralExpression(entry)) throw new Error(`${rel}: search registration must be an object`);
          const p = properties(entry);
          rows.push({ file: rel.split("/").pop(), id: p.id ?? "", tab: p.tab ?? "", section: p.section ?? "",
            title: p.title ?? "", desc: p.desc ?? "", aliases: p.aliases ?? [], breadcrumb: p.breadcrumb ?? [],
            displayRoot: p.displayRoot ?? "", root: p.root ?? "", note: p.fallbackNote ?? "", landOn: p.landOn ?? null });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return rows;
}
