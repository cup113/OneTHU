/**
 * 网络学堂「把文件拖进提交卡」护栏（2026-11-24）。
 *
 * 用户现场：Windows 上往作业提交卡拖文件毫无反应，只能点「选择文件」。
 * 两层原因，缺一层都还是拖不进去：
 *
 *   ① 窗口层：Tauri 窗口默认 `dragDropEnabled: true`，文件在 WebView2 外层就被原生
 *      拖放截走，网页的 drop 事件拿不到 dataTransfer.files。tauri-utils 源码注释原文：
 *      "Disabling it is required to use HTML5 drag and drop on the frontend on Windows."
 *   ② 页面层：提交卡当时只有一个裸 <input type="file">，没有任何接收区。
 *
 * 因此 [1] 守窗口配置，[2] 守落点并入既有提交流，[3] 守接收区的注册方式——
 * 非 capture 且不 stopPropagation 时，文件会被暂存箱的整屏接收层或富文本编辑器吃掉。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");
const conf = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json"));
const page = read("apps/desktop/src/pages/learn/AssignmentDetailPage.tsx");
const hook = read("apps/desktop/src/lib/fileDropZone.ts");
const css = read("apps/desktop/src/styles/global.css");

/* ---------- [1] 窗口：原生拖放必须关 ---------- */
const nativeDropOff = (cfg) => {
  const windows = cfg?.app?.windows;
  return Array.isArray(windows) && windows.length > 0 && windows.every((w) => w.dragDropEnabled === false);
};
assert.ok(nativeDropOff(conf), "窗口必须 dragDropEnabled=false，否则 Windows 上 drop 到不了网页");
assert.ok(!nativeDropOff({ app: { windows: [{}] } }), "缺省即开启：没写这个键的窗口必须判失败");
assert.ok(!nativeDropOff({ app: { windows: [{ dragDropEnabled: true }] } }), "写着 true 必须判失败");

/* ---------- [2] 提交卡：接收区必须挂上，且并入既有提交流 ---------- */
const wired = (src) =>
  /useFileDrop\(\(file\)\s*=>\s*\{\s*setSubFile\(file\);?\s*\}\)/.test(src) &&
  /ref=\{fileDrop\.ref\}/.test(src) &&
  /"hw-file-drop"/.test(src);
assert.ok(wired(page), "提交卡必须挂 useFileDrop，并把文件交给 setSubFile（与「选择文件」同一条路）");
assert.ok(!wired(page.replace("useFileDrop(", "notFileDrop(")), "去掉接收区后必须判失败");
assert.ok(!wired(page.replace("setSubFile(file)", "upload(file)")), "落点绕开 setSubFile 必须判失败");

/* ---------- [3] 接收区：capture 注册 + 收口 ---------- */
const captureWired = (src) => {
  const events = ["dragenter", "dragover", "dragleave", "drop"];
  const registered = events.every((name) => src.includes(`addEventListener("${name}", `));
  const captureCount = (src.match(/,\s*true\);/g) ?? []).length;
  return registered && captureCount >= events.length && /event\.preventDefault\(\)/.test(src) && /event\.stopPropagation\(\)/.test(src);
};
assert.ok(captureWired(hook), "接收区必须四个事件都 capture 注册，并 preventDefault + stopPropagation");
assert.ok(!captureWired(hook.replace(/,\s*true\);/g, ");")), "改成冒泡注册必须判失败");
assert.ok(!captureWired(hook.replaceAll("event.stopPropagation();", "")), "不 stopPropagation 必须判失败");

/* ---------- [4] 热态：只在悬停时给出提示，平时不占版面 ---------- */
assert.ok(/\.hw-file-drop\.is-hot\s*\{/.test(css), "必须有文件悬停时的热态样式");
assert.ok(/\.hw-file-drop-hint\s*\{[^}]*pointer-events:\s*none/.test(css), "提示层不得挡住落点");

console.log("learn-file-drop-test: 全部断言通过（窗口关原生拖放 + 提交卡接收区 + capture 收口）");
