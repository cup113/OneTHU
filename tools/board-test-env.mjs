import { fileURLToPath } from "node:url";
/**
 * 白板/OH 接线类守栏的**共享测试环境**（2026-10-15，oh-wire）：
 *   · 仓库自带的 DOM/存储替身（tools/dom-stub.mjs）+ hash/事件总线/观察者替身；
 *   · 一个**极小的模块钩子**（node 内置能力，数据 URL 注册，零第三方依赖）：让 node 直跑
 *     应用的真 .ts 模块 —— .tsx 组件与校园客户端（@onethu/core|info-lib 的 dist）只做模块图
 *     填充，CJS 包（react/jsx-runtime、he、jsencrypt…）用 createRequire 取**真身**再显式重导出。
 *
 * 用法：测试文件第一行 `import "./board-test-env.mjs";`，其后动态 import 真模块。
 * 跑法：node --import ./tools/ts-resolve-register.mjs tools/<你的守栏>.mjs
 *
 * 纪律：桩只用来"把模块图接上"，**断言不许碰桩的行为**——被测逻辑必须来自真模块。
 */
/* ───────────────────── 测试脚手架（DOM/事件替身 + 模块钩子） ───────────────────── */
/* 仓库自带的极简 DOM/存储替身（其余 node 测试同款） */
await import("./dom-stub.mjs");

/* explorer 写 hash 用 location；dom-stub 只给 document/localStorage，这里补齐 */
globalThis.location = { hash: "#/today" };
globalThis.history = { replaceState() {}, pushState() {} };
/* 事件总线：onePage.notifyBoardsChanged / explorerPrefs 的 storage 监听都靠它 */
const bus = new Map();
globalThis.Event = class Event { constructor(type) { this.type = type; } };
globalThis.CustomEvent = globalThis.Event;
globalThis.addEventListener = (t, f) => { if (!bus.has(t)) bus.set(t, new Set()); bus.get(t).add(f); };
globalThis.removeEventListener = (t, f) => { bus.get(t)?.delete(f); };
globalThis.dispatchEvent = (e) => { for (const f of bus.get(e?.type) ?? []) f(e); return true; };
/* userext / theme 在模块初始化时会起观察者 */
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };

/* 模块钩子：把上面三类边接上。为什么不用真身：.tsx 需要 JSX 转换，而仓库没有可独立
   解析的 JSX 工具链（esbuild 只作为 Vite 的传递依赖躺在 .pnpm 里），所以组件一律只做
   模块图填充；校园客户端同理（真身 dist 是无后缀相对导入 + CJS 具名导出）。 */
{
  const { register } = await import("node:module");
  const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
  const loader = `
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { localizedSource } from ${JSON.stringify(new URL("./i18n/source-view.mjs", import.meta.url).href)};
const REPO = ${JSON.stringify(REPO)};
const req = createRequire(REPO + "/package.json");
const bare = (specifier) => !/^(\\.|\\/|file:|data:|node:|#)/.test(specifier);
/* 万能桩：可调、可 new、可链式取值；字符串化给 ""、数值化给 0（模板串里不炸） */
const NOOP = [
  "const noop = new Proxy(function () {}, {",
  "  get: (_t, k) => {",
  "    if (typeof k === 'symbol' || k === 'then') return undefined;",
  "    if (k === 'valueOf') return () => 0;",
  "    if (k === 'toString') return () => '';",
  "    return noop;",
  "  },",
  "  apply: () => noop,",
  "  construct: () => noop,",
  "});",
].join("\\n");
const stubModule = (names) => NOOP + "\\nexport default noop;\\n" + names.map((n) => "export const " + n + " = noop;").join("\\n") + "\\n";
/** .tsx 一律只做模块图填充；**例外**：components/Layout.tsx 的 NAV 是纯数据数组
    （首页一级页目录，也是首页程序坞的白名单）—— 从源码里抠出来求值，桩掉会让坞的断言
    失去意义。求值走 Function + with(Proxy)：icon: IconPen 这类标识符统一取到 noop
    （symbol 键返回 undefined，否则 Symbol.unscopables 会被当成「全部不可作用域」→ ReferenceError）。 */
function tsxStub(file) {
  const names = namesOf(file);
  const out = stubModule(names.filter((n) => n !== "NAV"));
  try {
    const src = localizedSource(readFileSync(file, "utf8"), file);
    const at = src.indexOf("export const NAV");
    if (at < 0) return out;
    const eq = src.indexOf("= [", at); /* 类型注解里可能有 Page[]，认赋值点才稳 */
    if (eq < 0) return out;
    const start = eq + 2;
    let depth = 0;
    let end = -1;
    for (let i = start; i >= 0 && i < src.length; i++) {
      if (src[i] === "[") depth++;
      else if (src[i] === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end <= start) return out;
    const literal = src.slice(start, end);
    return out + "export const NAV = new Function('scope', 'with (scope) { return (' + "
      + JSON.stringify(literal) + " + '); }')(new Proxy({}, { has: () => true, get: (_t, k) => (typeof k === 'symbol' ? undefined : noop) }));\\n";
  } catch { return out; }
}
/** 桩出的具名导出清单：从真源码里扫 export，名字对齐后 import 才不会爆 */
function namesOf(file) {
  const src = readFileSync(file, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export\\s+(?:async\\s+)?(?:function|class|const|let|var)\\s+([A-Za-z_$][\\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\\s*\\{([^}]*)\\}/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\\s+as\\s+/).pop().trim();
      if (/^[A-Za-z_$][\\w$]*$/.test(n)) names.add(n);
    }
  }
  return [...names];
}
/** 校园客户端的具名导出清单（扫全仓 import 语句） */
function campusNames() {
  const files = [];
  const walk = (dir) => {
    let ents = []; try { ents = readdirSync(dir); } catch { return; }
    for (const e of ents) {
      const p = dir + "/" + e;
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p); else if (/\\.(ts|tsx)$/.test(e)) files.push(p);
    }
  };
  walk(REPO + "/apps/desktop/src");
  try { for (const p of readdirSync(REPO + "/packages")) walk(REPO + "/packages/" + p + "/src"); } catch { /* 无 packages */ }
  const names = new Set();
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/import\\s*\\{([^}]*)\\}\\s*from\\s*"@onethu\\/(?:core|info-lib)"/g)) {
      for (const part of m[1].split(",")) {
        const n = part.replace(/type\\s+/, "").trim().split(/\\s+as\\s+/)[0].trim();
        if (/^[A-Za-z_$][\\w$]*$/.test(n)) names.add(n);
      }
    }
  }
  return [...names];
}
/** CJS 包在 ESM 里具名导出探测会失败（react/jsx-runtime、he、jsencrypt…）：
    用 createRequire 取**真身**再显式重导出（不是替身） */
function cjsWrapper(specifier, parentURL) {
  const reqs = [req];
  try { if (parentURL?.startsWith("file:")) reqs.push(createRequire(fileURLToPath(parentURL))); } catch { /* 只用仓库根 */ }
  let resolved = ""; let mod = null;
  for (const r of reqs) { try { resolved = r.resolve(specifier); mod = r(specifier); break; } catch { /* 换起点 */ } }
  if (!mod) return null;
  const keys = Object.keys(mod).filter((k) => k !== "default" && /^[A-Za-z_$][\\w$]*$/.test(k));
  const src = "import def from " + JSON.stringify(pathToFileURL(resolved).href) + ";\\nexport default def;\\n"
    + keys.map((k) => "export const " + k + " = def[" + JSON.stringify(k) + "];").join("\\n") + "\\n";
  return { url: "data:text/javascript;base64," + Buffer.from(src).toString("base64"), shortCircuit: true };
}
export async function resolve(specifier, context, next) {
  if (specifier === "@onethu/core" || specifier === "@onethu/info-lib") {
    return { url: "data:text/javascript;base64," + Buffer.from(stubModule(campusNames())).toString("base64"), shortCircuit: true };
  }
  if (bare(specifier) && !specifier.startsWith("@onethu")) {
    const w = cjsWrapper(specifier, context.parentURL);
    if (w) return w;
  }
  try {
    return await next(specifier, context);
  } catch (e) {
    if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e;
    if (!/\\.[a-z]+$/i.test(specifier)) { try { return await next(specifier + ".js", context); } catch { /* 继续回退 */ } }
    if (specifier.endsWith(".js")) {
      for (const ext of [".ts", ".tsx"]) { try { return await next(specifier.slice(0, -3) + ext, context); } catch { /* 继续回退 */ } }
    }
    throw e;
  }
}
export async function load(url, context, next) {
  const clean = url.split("?")[0];
  if (clean.endsWith(".tsx")) return { format: "module", source: tsxStub(fileURLToPath(clean)), shortCircuit: true };
  if (/\\.(css|svg|png|jpg)$/.test(url)) return { format: "module", source: "export default {};", shortCircuit: true };
  return next(url, context);
}
`;
  register("data:text/javascript;base64," + Buffer.from(loader).toString("base64"));
}

