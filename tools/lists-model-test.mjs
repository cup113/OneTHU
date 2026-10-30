/**
 * 清单模型：箱型分区、判重、完成回位、拖动排序、删除兜底。
 * 运行：node --import tsx tools/lists-model-test.mjs
 */
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};

const vault = await import("../apps/desktop/src/state/vault.ts");

const stash = vault.activeVault();
assert.ok(stash && stash.kind !== "list", "初始必须有一个 stash 箱");

const list = vault.createList("本周");
assert.equal(vault.activeVault().id, stash.id, "新建清单不能抢占暂存浮球的 activeId");
assert.deepEqual(vault.listVaults().map((b) => b.id), [list.id]);

const first = vault.addTask(list.id, "  买  洗衣液 ");
assert.equal(first.ok, true);
assert.equal(first.item.title, "买 洗衣液", "标题去空白、折叠连续空格");
assert.equal(vault.addTask(list.id, "买 洗衣液").reason, "duplicate", "未完成之间按标题判重");
assert.equal(vault.addTask(stash.id, "不该进箱子").reason, "no-box", "清单条目只能落在清单箱");

assert.equal(vault.addToVault({ type: "text", title: "笔记", text: "正文" }, list.id).reason, "list-box");
assert.equal(vault.addToVault({ type: "task", title: "越界" }).reason, "stash-box", "无 boxId 时落在 stash，不许收 task");

vault.setTaskDone(list.id, first.item.id, true);
assert.equal(vault.addTask(list.id, "买 洗衣液").ok, true, "勾掉之后可以再建同名");
assert.equal(vault.listVaults()[0].items.filter((it) => it.type === "task").length, 2);

/* 排序：只在未完成项之间移动；已完成项占住数组位置，取消勾选回到原位 */
const box = vault.listVaults()[0];
for (const it of [...box.items]) vault.removeFromVault(box.id, it.id);
const a = vault.addTask(box.id, "A").item;
const b = vault.addTask(box.id, "B").item;
const c = vault.addTask(box.id, "C").item;
vault.setTaskDone(box.id, b.id, true);
assert.equal(vault.reorderTasks(box.id, c.id, a.id, false), true, "C 拖到 A 前面");
const openAfter = vault.listVaults()[0].items.filter((it) => !it.done).map((it) => it.title);
assert.deepEqual(openAfter, ["C", "A"]);
vault.setTaskDone(box.id, b.id, false);
assert.deepEqual(vault.listVaults()[0].items.map((it) => it.title), ["C", "B", "A"], "B 回到它原来的数组位置");

/* 删除兜底：最后一份清单删掉后补一份空清单，stash 与 activeId 不受影响 */
const only = vault.listVaults()[0];
vault.deleteVault(stash.id);
assert.equal(vault.listVaults().length, 1);
const freshStash = vault.activeVault();
assert.notEqual(freshStash.id, stash.id, "最后一个 stash 删掉后要补一个");
assert.notEqual(freshStash.kind, "list");
assert.equal(vault.vaultSnapshot().activeId, freshStash.id);
vault.deleteVault(only.id);
assert.equal(vault.listVaults().length, 1, "至少保留一份清单");
assert.ok(vault.listVaults()[0].items.length === 0);

/* 持久化：文档能落盘并被再次读出（v=1 + kind 保留） */
const raw = JSON.parse(store.get("onethu.vaults.v1"));
assert.equal(raw.v, 1);
assert.ok(raw.boxes.some((entry) => entry.kind === "list"));

console.log("✓ 清单模型 12 项断言通过");
