#!/usr/bin/env node
import { fileURLToPath } from "node:url";
/**
 * OH → 门面接线护栏（2026-10-15，oh-wire / task-2）：白板导航桥 + 首页程序坞 + 收藏落点。
 *
 * 三块都在**门面这一层**（插件与 OH 唯一的执行入口，plugins/facade.ts）：
 *   ⑦ 首页程序坞 `ext.homeDock.set`：一级页 ∪ 插件功能页同权停靠/取消停靠，认不出的 id 报错；
 *   ⑧ 收藏落点 `ext.onePageAddAtom`：落首页（不给 boardId）或落某块 OnePage，重复/板不存在给原因。
 *   ⑨ 锚点卫生（静态）：跨页 focus 的目标串不许自带 `row-`/`sec-` 前缀 —— 解析器
 *      （Layout.tsx:595 的 focusSettingsTarget）会自己补一次，自带前缀 = 双前缀 = 永远命不中。
 *
 * 白板导航桥盯的是两个缺口：
 *   ① `ext.tabOpen("board"/"boards")` 能不能过白名单（一级页名单副本漏页就会被拦成
 *      「不认识的页面」）；
 *   ② `nav.go("board", {boardId})` 会不会真的**切到那块板**——白板页渲染的是「当前板」
 *      （BoardDoc.activeBoardId，BoardPage.tsx:169），只把 params 塞进标签而不切板 =
 *      OH 说「打开旅行计划」实际停在上一块板，而且静默（用户看不出来）。
 *      正确链路 = 与 `#/board/<板 id>` 深链（explorer.openBoardFromHash）和 ext.onePageOpen
 *      同一对调用：openOnePage(id) + openTab("board")。
 *
 * 跑法：node --import ./tools/ts-resolve-register.mjs tools/board-nav-bridge-test.mjs
 *   （本文件自带极小的模块钩子，见「测试脚手架」段；只用 node 内置能力，不引第三方包，
 *    也不需要构建产物。）退出码：0 通过 / 1 违规。
 *
 * **测的是真模块**：state/board.ts、state/onePage.ts、state/explorer.ts、plugins/facade.ts
 * （buildApi）都在模块图里。桩只打在"与导航无关、node 直跑又进不来"的三类边上
 * （@onethu/core|info-lib 校园客户端、.tsx 组件、CJS 包具名导出）；断言不碰任何桩的行为
 * ——桩的意义只是把模块图接上。
 */
/* 测试脚手架（DOM/事件替身 + 模块钩子）已抽到 tools/board-test-env.mjs 共享——
   本文件与 board-deeplink / board-legacy-merge / board-overlap-invariant 三条守栏同一套。 */
import "./board-test-env.mjs";

/* ───────────────────── 被测的真模块 ───────────────────── */
const { loadBoard } = await import("../apps/desktop/src/state/board.ts");
const onePage = await import("../apps/desktop/src/state/onePage.ts");
const explorer = await import("../apps/desktop/src/state/explorer.ts");
const { setNavBridge } = await import("../apps/desktop/src/plugins/bridges.ts");
const { buildApi } = await import("../apps/desktop/src/plugins/facade.ts");

const fails = [];
const ok = (cond, msg) => { if (cond) console.log("  ✓ " + msg); else fails.push(msg); };
const boardTabs = () => explorer.explorerSnapshot().tabs.filter((t) => t.page === "board");

/* 门面的导航桥由 App.tsx 每帧回填（App.tsx:31）；这里填 explorerNavigate = 同一件事 */
setNavBridge((page, params) => explorer.explorerNavigate(page, params));
/* 权限取 OH 自己那条清单（plugins/OneTHU-Harness/manifest.json 的 nav/ui） */
const api = buildApi("onethu.harness", new Set(["nav", "ui"]));

/* ① 两块板：先让「期末复习」当当前板 —— "不切板"的旧行为会当场露馅 */
const a = onePage.createOnePage("期末复习");
const b = onePage.createOnePage("旅行计划");
ok(!!a && !!b && a !== b, `建了两块白板：${a} / ${b}`);
onePage.openOnePage(a);

/* ② 带参：nav.go("board", {boardId}) 必须切板 + 标签标题取板名 */
const before = boardTabs().length;
api.nav.go("board", { boardId: b });
const active = boardTabs().find((t) => t.id === explorer.explorerSnapshot().activeId) ?? boardTabs()[boardTabs().length - 1];
ok(boardTabs().length === before + 1, "带参 nav.go(\"board\", {boardId}) 开出白板标签");
ok(active?.title === "旅行计划", `标签标题 = 板名（${active?.title}）`);
ok(loadBoard().activeBoardId === b, "当前板已切到目标板（白板页渲染的就是它）");

/* ③ 无参：沿用当前板，并且**复用**已开白板标签（不多开） */
const n0 = boardTabs().length;
api.nav.go("board");
ok(boardTabs().length === n0, `无参 nav.go("board") 复用已开白板标签（${n0} → ${boardTabs().length}）`);
ok(loadBoard().activeBoardId === b, "无参时不切板（沿用当前板）");

/* ④ 「所有白板」列表页 */
api.nav.go("boards");
ok(explorer.explorerSnapshot().tabs.some((t) => t.page === "boards"), "nav.go(\"boards\") 开出「所有白板」列表页");

/* ⑤ 未知板 id：必须当场报错（不静默打开上一块板） */
let threw = "";
try { api.nav.go("board", { boardId: "board.不存在" }); } catch (e) { threw = String(e?.message ?? e); }
ok(threw.includes("没有这块白板"), `未知板 id 明确报错（${threw.slice(0, 24)}…）`);
ok(loadBoard().activeBoardId === b, "报错后当前板没被改坏");

/* ⑦ 首页程序坞：只读快照 / 停靠 / 取消停靠 / 未注册 id 报错 */
const { spheresSnapshot } = await import("../apps/desktop/src/state/homeSpheres.ts");
const dock0 = spheresSnapshot().docked.slice();
const snap = api.ext.homeDock.set();
ok(Array.isArray(snap.docked) && snap.docked.length === dock0.length, `homeDock.set() 只读快照：坞上 ${snap.docked?.length} 颗球`);
ok(snap.dockable?.length >= 5, `可停靠清单含一级页（共 ${snap.dockable?.length} 项）`);
ok(typeof api.ext.homeDock === "function", "ext.homeDock 本身可调用（门面 rpc 是平铺两段式 api[ns][method]，嵌套命名空间只能这么到达）");
ok(snap.entries?.some((e) => e.page === "life" && e.label === "生活"), "只读快照带名字（OH 才能把「打卡页」对到 page id）");
const DOCK_TARGET = "life"; /* 一级页（NAV 里；且不在默认前 8 颗里，停靠/取消停靠都能看见变化） */
if (dock0.includes(DOCK_TARGET)) api.ext.homeDock.set(DOCK_TARGET, false);
const docked = api.ext.homeDock.set(DOCK_TARGET, true);
ok(docked.docked.includes(DOCK_TARGET) && spheresSnapshot().docked.includes(DOCK_TARGET), "停靠一级页「生活」：状态层与返回值一致");
ok(!api.ext.homeDock.set(DOCK_TARGET, false).docked.includes(DOCK_TARGET), "取消停靠生效");
/* 本轮新能力：**插件功能页**也能进坞（pageKey = plugin:<插件>:<页>，注册在 plugins/tabs.ts） */
const { registerPluginTab, unregisterPluginTabs } = await import("../apps/desktop/src/plugins/tabs.ts");
registerPluginTab({ pageKey: "plugin:oh.wire.test:dock", pluginId: "oh.wire.test", title: "打卡" });
const pluginSnap = api.ext.homeDock.set();
ok(pluginSnap.dockable.includes("plugin:oh.wire.test:dock"), "插件功能页进了「可停靠」清单（一级页 ∪ 插件页）");
ok(api.ext.homeDock.set("plugin:oh.wire.test:dock", true).docked.includes("plugin:oh.wire.test:dock"), "插件功能页真正停靠进坞");
api.ext.homeDock.set("plugin:oh.wire.test:dock", false); /* 先取消停靠再注销插件 */
unregisterPluginTabs("oh.wire.test");
ok(spheresSnapshot().docked.join(",") === dock0.join(","), "坞回到初始状态（无残留）");
let dockErr = "";
try { api.ext.homeDock.set("plugin:不存在:main", true); } catch (e) { dockErr = String(e?.message ?? e); }
ok(dockErr.includes("不认识这个页面"), "未注册的插件页 id 报错（不静默停靠一颗看不见的球）");

/* ⑧ 收藏落点：落指定板 / 重复给 duplicate / 不给 boardId 落首页（系统板）/ 板不存在给 no-board */
const landingBoard = onePage.createOnePage("收藏落点板");
const toBoard = api.ext.onePageAddAtom({ boardId: landingBoard }, "course:oh-wire-1");
ok(toBoard.ok === true && toBoard.boardId === landingBoard, "落指定 OnePage 成功");
ok(api.ext.onePageAddAtom({ boardId: landingBoard }, "course:oh-wire-1").reason === "duplicate", "同板同原子 → reason=duplicate（自带查重）");
const toHome = api.ext.onePageAddAtom({ to: "home" }, "course:oh-wire-2");
const homeBoard = onePage.allOnePages().find((b) => b.id === toHome.boardId);
ok(toHome.ok === true && homeBoard?.kind === "system", "不给 boardId = 落首页（系统板）");
ok(onePage.onePagesWithAtom("course|oh-wire-2").length === 1, "首页上确实躺着那颗原子（可查回；: 已归一成 |）");
ok(api.ext.onePageAddAtom({ boardId: "board.不存在" }, "course:oh-wire-3").reason === "no-board", "目标板不存在 → reason=no-board");

/* ⑥ 一级页名单副本：ext.tabOpen 对白板两页放行（漏了会被拦成「不认识的页面」） */
ok(!!api.ext.tabOpen("board")?.id, "ext.tabOpen(\"board\") 放行");
ok(!!api.ext.tabOpen("boards")?.id, "ext.tabOpen(\"boards\") 放行");

/* ⑨ 锚点卫生（静态扫源码）：目标串自带 row-/sec- 前缀 → focusSettingsTarget 再补一次
   → 永远命不中（用户侧=搜到了、点了没反应）。这一条是"腐坏会复发"的教训换来的：
   2026-10-15 一次清扫就抓到 7 处（OH 家族 14 个 goOhRow 调用全在内）。 */
{
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = dir + "/" + e;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e)) files.push(p);
    }
  };
  walk(fileURLToPath(new URL("../apps/desktop/src", import.meta.url)));
  const bad = [];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      for (const m of line.matchAll(/(?:target|fallbackTarget|root)\s*:\s*"(row-|sec-)[^"]*"/g)) {
        bad.push(`${f.split("/src/")[1]}: ${m[0]}`);
      }
    }
  }
  ok(bad.length === 0, `跨页锚点不带 row-/sec- 前缀（违例 ${bad.length} 处）${bad.length ? "：" + bad.join(" / ") : ""}`);
}

console.log(fails.length ? `\n✗ 白板导航桥 ${fails.length} 项失败` : "\n✅ 白板导航桥全绿");
for (const f of fails) console.error("   ✗ " + f);
process.exit(fails.length ? 1 : 0);
