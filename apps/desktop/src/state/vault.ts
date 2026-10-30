import { t as i18n } from "../i18n/index.js";
/**
 * OneTHU 暂存箱（Phase 1）：万物皆可收纳的本地清单层。
 *
 * 设计边界（docs/plans/2026-10-18-organization-vault-share.md）：
 * - **只存引用/摘要，不复制大内容**：原子存 `{kind,key}`，文件存云盘引用 + hash，文字片段才存正文。
 * - 云盘是文件与分享的最终存储；本模块不直接发请求（上传/分享在 vaultSync/vaultShare 适配层）。
 * - 暂存箱是「临时工作区」：内容随箱存在；被分享口令收录后才由云盘清单承担长期存储。
 * - 多个箱子；同一时刻有一个 active。全部本地持久化在 `onethu.vaults.v1`。
 */
import type { AtomRef } from "./favorites.js";

export type VaultItemType = "atom" | "text" | "file" | "board-item" | "payload" | "task";

/** 箱子的用途：stash = 收纳（旧语义，缺省）；list = 清单页。两面互不可见。 */
export type VaultBoxKind = "stash" | "list";

/** 拖入暂存箱的识别结果（任何可拖元素最终都归一成这个） */
export interface VaultCatch {
  type: VaultItemType;
  title: string;
  sub?: string;
  atom?: AtomRef;
  text?: string;
  file?: VaultFileRef;
  board?: { boardId: string; itemId: string };
  /** 类型专属数据（主题变量、设置项、邮件/新闻快照等；只放必要字段） */
  payload?: unknown;
  /** 来源提示（首页/搜索/邮件…），用于清单副行 */
  source?: string;
  /** 远端文件来源：拖入后自动下载并缓存到暂存箱（云盘/附件）。 */
  remote?: {
    kind: "seafile" | "learn" | "news";
    repoId?: string;
    path?: string;
    url?: string;
    /** 云端已知大小（可选，缓存完以实际字节为准） */
    size?: number;
  };
}

export interface VaultFileRef {
  name: string;
  size?: number;
  mime?: string;
  /** 内容 SHA-256（去重键）；未算完为 undefined */
  hash?: string;
  /** 云盘内路径（Seafile repo path）；null = 还没上传/只在本机 */
  cloudPath?: string | null;
  /** 云盘分享链接（可选提示） */
  shareUrl?: string;
  shareKeyRepoId?: string;
  cloudRepoId?: string;
  /** 本地暂存路径（仅本机；分享清单会剔除） */
  stagedPath?: string;
}

export interface VaultItem extends VaultCatch {
  id: string;
  addedAt: number;
  /** 清单条目是否已完成（只在 kind === "list" 的箱里写） */
  done?: boolean;
  doneAt?: number;
}

export interface VaultBox {
  id: string;
  name: string;
  items: VaultItem[];
  createdAt: number;
  updatedAt: number;
  /** 最近一次生成的口令（仅提示，可重新生成） */
  lastShareCode?: string;
  /** 缺省 = stash：旧文档不需要迁移 */
  kind?: VaultBoxKind;
}

export interface VaultDoc {
  v: 1;
  boxes: VaultBox[];
  activeId: string;
}

const KEY = "onethu.vaults.v1";

export const VAULT_TYPE_LABEL: Record<VaultItemType, string> = {
  get atom() { return i18n("state.vault.1fd167c6ae13"); },
  get text() { return i18n("state.vault.14b69bd6eeb0"); },
  get file() { return i18n("state.vault.39932f24fe11"); },
  get "board-item"() { return i18n("state.vault.206359b4b54d"); },
  get payload() { return i18n("state.vault.5440f7424f28"); },
  get task() { return i18n("pages.lists.type.task"); },
};

function newId(prefix: string): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function emptyBox(name = i18n("state.vault.defaultName")): VaultBox {
  const now = Date.now();
  return { id: newId("vb."), name, items: [], createdAt: now, updatedAt: now };
}

function load(): VaultDoc {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) throw new Error("empty");
    const p = JSON.parse(raw) as Partial<VaultDoc>;
    if (p.v !== 1 || !Array.isArray(p.boxes) || p.boxes.length === 0) throw new Error("bad");
    const boxes = p.boxes.filter((b): b is VaultBox => !!b && typeof b.id === "string" && Array.isArray(b.items));
    if (boxes.length === 0) throw new Error("bad");
    /* 老文档里的箱子都没有 kind → 全部算 stash；清单页上线后若一个 stash 都不剩，补一个空的。 */
    if (!boxes.some((b) => b.kind !== "list")) boxes.unshift(emptyBox());
    const stash = boxes.find((b) => b.kind !== "list")!;
    const activeId = boxes.some((b) => b.id === p.activeId && b.kind !== "list") ? String(p.activeId) : stash.id;
    return { v: 1, boxes, activeId };
  } catch {
    const box = emptyBox();
    return { v: 1, boxes: [box], activeId: box.id };
  }
}

let doc: VaultDoc = load();
const listeners = new Set<() => void>();

function commit(): void {
  doc = { ...doc, boxes: doc.boxes.map((b) => ({ ...b })) };
  try {
    localStorage.setItem(KEY, JSON.stringify(doc));
  } catch {
    /* 配额满：保持内存态可用 */
  }
  listeners.forEach((f) => f());
}

export function subscribeVault(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function vaultSnapshot(): VaultDoc {
  return doc;
}

/**
 * 当前暂存箱：永远是 stash 箱。清单箱即使被别的代码写进 activeId，也不会接住拖入内容。
 */
export function activeVault(): VaultBox {
  return doc.boxes.find((b) => b.id === doc.activeId && b.kind !== "list")
    ?? doc.boxes.find((b) => b.kind !== "list")
    ?? doc.boxes[0]!;
}

/** 暂存表面能看到的箱子（旧箱无 kind，一律算 stash）。 */
export function stashVaults(): VaultBox[] {
  return doc.boxes.filter((b) => b.kind !== "list");
}

/** 清单页的箱子。 */
export function listVaults(): VaultBox[] {
  return doc.boxes.filter((b) => b.kind === "list");
}

export function setActiveVault(id: string): void {
  const box = doc.boxes.find((b) => b.id === id);
  if (!box || box.kind === "list" || doc.activeId === id) return;
  doc = { ...doc, activeId: id };
  commit();
}

export function createVault(name = i18n("lib.contentexchange.4dc6d8e7a87a")): VaultBox {
  const box = emptyBox(name.trim() || i18n("lib.contentexchange.4dc6d8e7a87a"));
  doc = { ...doc, boxes: [...doc.boxes, box], activeId: box.id };
  commit();
  return box;
}

/** 新建清单：只入列，不抢 activeId（那是暂存浮球的当前箱）。 */
export function createList(name = i18n("pages.lists.defaultName")): VaultBox {
  const now = Date.now();
  const box: VaultBox = { id: newId("vb."), name: name.trim() || i18n("pages.lists.defaultName"), items: [], createdAt: now, updatedAt: now, kind: "list" };
  doc = { ...doc, boxes: [...doc.boxes, box] };
  commit();
  return box;
}

export function renameVault(id: string, name: string): void {
  const next = name.trim();
  if (!next) return;
  doc = { ...doc, boxes: doc.boxes.map((b) => (b.id === id ? { ...b, name: next, updatedAt: Date.now(), lastShareCode: undefined } : b)) };
  commit();
}

/** 删除箱子；每个表面至少保留一个（删掉最后一个 stash / 最后一份清单时各补一个空的）。 */
export function deleteVault(id: string): void {
  const target = doc.boxes.find((b) => b.id === id);
  if (!target) return;
  let boxes = doc.boxes.filter((b) => b.id !== id);
  if (target.kind === "list") {
    if (!boxes.some((b) => b.kind === "list")) {
      boxes = [...boxes, { id: newId("vb."), name: i18n("pages.lists.defaultName"), items: [], createdAt: Date.now(), updatedAt: Date.now(), kind: "list" }];
    }
  } else if (!boxes.some((b) => b.kind !== "list")) {
    const box = emptyBox();
    doc = { v: 1, boxes: [box, ...boxes], activeId: box.id };
    commit();
    return;
  }
  const active = boxes.some((b) => b.id === doc.activeId && b.kind !== "list")
    ? doc.activeId
    : boxes.find((b) => b.kind !== "list")!.id;
  doc = { ...doc, boxes, activeId: active };
  commit();
}

export function itemFromCatch(c: VaultCatch): VaultItem {
  return { ...c, id: newId("vi."), addedAt: Date.now() };
}

/** 同一 atom / 同一文件（hash）在同一箱内不重复；清单只在未完成条目之间判重。 */
export function isDuplicate(box: VaultBox, c: VaultCatch): boolean {
  if (c.type === "task") {
    const title = taskTitle(c.title);
    return box.items.some((it) => it.type === "task" && !it.done && taskTitle(it.title) === title);
  }
  if (c.atom) return box.items.some((it) => it.atom && it.atom.kind === c.atom!.kind && it.atom.key === c.atom!.key);
  if (c.file?.hash) return box.items.some((it) => it.file?.hash && it.file.hash === c.file!.hash);
  if (c.text) return box.items.some((it) => it.type === "text" && it.text === c.text);
  return false;
}

export type VaultAddReason = "duplicate" | "no-box" | "list-box" | "stash-box";

export function addToVault(c: VaultCatch, boxId?: string): { ok: boolean; reason?: VaultAddReason; item?: VaultItem } {
  const box = boxId ? doc.boxes.find((b) => b.id === boxId) : activeVault();
  if (!box) return { ok: false, reason: "no-box" };
  /* 两个表面按用途分开：清单箱只收 task，stash 箱不收 task。 */
  if (box.kind === "list" && c.type !== "task") return { ok: false, reason: "list-box" };
  if (box.kind !== "list" && c.type === "task") return { ok: false, reason: "stash-box" };
  if (isDuplicate(box, c)) return { ok: false, reason: "duplicate" };
  const item = itemFromCatch(c);
  const items = c.type === "task" ? [...box.items, item] : [item, ...box.items];
  doc = {
    ...doc,
    boxes: doc.boxes.map((b) => (b.id === box.id ? { ...b, items, updatedAt: Date.now(), lastShareCode: undefined } : b)),
  };
  commit();
  return { ok: true, item };
}

function taskTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** 新建一条清单待办：追加到末尾，未完成之间按标题判重。 */
export function addTask(boxId: string, title: string): { ok: boolean; reason?: "empty" | "duplicate" | "no-box"; item?: VaultItem } {
  const text = title.trim().replace(/\s+/g, " ");
  if (!text) return { ok: false, reason: "empty" };
  const result = addToVault({ type: "task", title: text }, boxId);
  if (result.ok) return { ok: true, item: result.item };
  return { ok: false, reason: result.reason === "duplicate" ? "duplicate" : "no-box" };
}

export function setTaskDone(boxId: string, itemId: string, done: boolean): void {
  doc = {
    ...doc,
    boxes: doc.boxes.map((b) => (b.id !== boxId ? b : {
      ...b,
      updatedAt: Date.now(),
      items: b.items.map((it) => (it.id === itemId && it.type === "task" ? { ...it, done, doneAt: done ? Date.now() : undefined } : it)),
    })),
  };
  commit();
}

/** 清除已完成：返回删掉的条数。 */
export function clearDoneTasks(boxId: string): number {
  const box = doc.boxes.find((b) => b.id === boxId);
  if (!box) return 0;
  const kept = box.items.filter((it) => !it.done);
  const removed = box.items.length - kept.length;
  if (!removed) return 0;
  doc = { ...doc, boxes: doc.boxes.map((b) => (b.id === boxId ? { ...b, items: kept, updatedAt: Date.now() } : b)) };
  commit();
  return removed;
}

/**
 * 拖动排序：只重排未完成项；已完成项在数组里的位置保持不动，
 * 所以取消勾选能回到原位。返回是否真的移动过。
 */
export function reorderTasks(boxId: string, fromId: string, toId: string, after: boolean): boolean {
  const box = doc.boxes.find((b) => b.id === boxId);
  if (!box) return false;
  const slots: number[] = [];
  box.items.forEach((it, index) => { if (it.type === "task" && !it.done) slots.push(index); });
  const open = slots.map((i) => box.items[i]!);
  const from = open.findIndex((it) => it.id === fromId);
  if (from < 0) return false;
  const moved = open.splice(from, 1)[0]!;
  const to = open.findIndex((it) => it.id === toId);
  if (to < 0) return false;
  open.splice(after ? to + 1 : to, 0, moved);
  const items = [...box.items];
  slots.forEach((slot, k) => { items[slot] = open[k]!; });
  if (items.every((it, i) => it === box.items[i])) return false;
  doc = { ...doc, boxes: doc.boxes.map((b) => (b.id === boxId ? { ...b, items, updatedAt: Date.now() } : b)) };
  commit();
  return true;
}

/** 更新箱内某条目（用于远端文件缓存完成后补 hash/stagedPath/cloudPath）。 */
export function updateVaultItem(itemId: string, patch: Partial<VaultItem>): void {
  let hit = false;
  doc = {
    ...doc,
    boxes: doc.boxes.map((b) => {
      if (!b.items.some((x) => x.id === itemId)) return b;
      hit = true;
      return { ...b, items: b.items.map((x) => (x.id === itemId ? { ...x, ...patch } : x)), updatedAt: Date.now() };
    }),
  };
  if (hit) commit();
}

export function removeFromVault(boxId: string, itemId: string): void {
  doc = {
    ...doc,
    boxes: doc.boxes.map((b) => (b.id === boxId ? { ...b, items: b.items.filter((x) => x.id !== itemId), updatedAt: Date.now(), lastShareCode: undefined } : b)),
  };
  commit();
}

export function clearVault(boxId: string): void {
  doc = {
    ...doc,
    boxes: doc.boxes.map((b) => (b.id === boxId ? { ...b, items: [], updatedAt: Date.now(), lastShareCode: undefined } : b)),
  };
  commit();
}

/** 整箱替换（口令导入为当前暂存箱；未收录内容即时消失，符合临时工作区语义）。 */
export function replaceVaultItems(boxId: string, catches: VaultCatch[]): void {
  const items = catches.map(itemFromCatch);
  doc = {
    ...doc,
    boxes: doc.boxes.map((b) => (b.id === boxId ? { ...b, items, updatedAt: Date.now(), lastShareCode: undefined } : b)),
  };
  commit();
}

export function markVaultShared(boxId: string, code: string): void {
  doc = {
    ...doc,
    boxes: doc.boxes.map((b) => (b.id === boxId ? { ...b, lastShareCode: code } : b)),
  };
  commit();
}

/** 文件去重索引：同一 hash 在全部箱子里出现一次（文件本体在云盘只存一份）。 */
export function fileHashIndex(): Map<string, VaultFileRef[]> {
  const out = new Map<string, VaultFileRef[]>();
  for (const b of doc.boxes) {
    for (const it of b.items) {
      const f = it.file;
      if (!f?.hash) continue;
      const arr = out.get(f.hash) ?? [];
      arr.push(f);
      out.set(f.hash, arr);
    }
  }
  return out;
}
