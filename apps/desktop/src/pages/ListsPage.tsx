import { t as i18n, msg as i18nMsg, useLocale as useUiLocale } from "../i18n/index.js";
/**
 * 清单页：个人待办。数据写在暂存箱文档里（kind === "list" 的箱），与暂存表面按用途分开。
 *
 * 交互（docs/plans/2026-10-30-lists-page.md）：
 * - 点行勾选；整行拖动排序（触屏长按 400ms，鼠标 6px）；已完成滑入折叠区，5 秒内可撤销。
 * - 清单箱只收 task；暂存箱看不到清单，清单页也看不到暂存箱。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Btn, Checkbox, IconBtn, Input, Menu, Text, type MenuItem } from "@onethu/gui";
import { IconMore, IconPlus } from "../components/Icons.js";
import { showToast } from "../state/toast.js";
import { openFormModal } from "../lib/formModal.js";
import { confirmOk } from "../lib/confirm.js";
import { GESTURE, claimGesture, releaseGesture } from "../lib/gestureArena.js";
import {
  addTask, clearDoneTasks, createList, deleteVault, listVaults, removeFromVault, renameVault,
  reorderTasks, setTaskDone, subscribeVault, updateVaultItem, vaultSnapshot, type VaultItem,
} from "../state/vault.js";

const SELECTED_KEY = "onethu.lists.selected.v1";

function readSelected(): string {
  try { return localStorage.getItem(SELECTED_KEY) ?? ""; } catch { return ""; }
}

export function ListsPage(): ReactNode {
  const uiLocale = useUiLocale();
  const doc = useSyncExternalStore(subscribeVault, vaultSnapshot, vaultSnapshot);
  const lists = useMemo(() => listVaults(), [uiLocale, doc]);
  const [selectedId, setSelectedId] = useState(readSelected);
  const list = lists.find((entry) => entry.id === selectedId) ?? lists[0] ?? null;

  useEffect(() => {
    try { localStorage.setItem(SELECTED_KEY, list?.id ?? ""); } catch { /* 纯偏好 */ }
  }, [list?.id]);

  const [draft, setDraft] = useState("");
  const [switcher, setSwitcher] = useState<HTMLElement | null>(null);
  const [boxMenu, setBoxMenu] = useState<HTMLElement | null>(null);
  const [itemMenu, setItemMenu] = useState<{ anchor: HTMLElement; item: VaultItem } | null>(null);
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
  const undoTimer = useRef(0);

  const open = list ? list.items.filter((it) => it.type === "task" && !it.done) : [];
  const done = list ? list.items.filter((it) => it.type === "task" && it.done) : [];

  /* ── 勾选：滑入已完成，5 秒内可撤销 ── */
  const toggle = (item: VaultItem, next: boolean): void => {
    if (!list) return;
    setTaskDone(list.id, item.id, next);
    if (!next) return;
    setUndo({ id: item.id, title: item.title });
    window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), 5000);
  };
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);
  const revert = (): void => {
    if (!list || !undo) return;
    setTaskDone(list.id, undo.id, false);
    setUndo(null);
    window.clearTimeout(undoTimer.current);
  };

  const submit = (): void => {
    if (!list) return;
    const result = addTask(list.id, draft);
    if (result.ok) { setDraft(""); return; }
    if (result.reason === "duplicate") showToast(i18nMsg("pages.lists.duplicate", { name: String(list.name) }));
  };

  const create = async (): Promise<void> => {
    const form = await openFormModal(i18nMsg("pages.lists.new"), [
      { key: "name", label: i18nMsg("pages.lists.nameLabel"), required: true, default: i18n("pages.lists.defaultName") },
    ]);
    if (!form?.name?.trim()) return;
    const box = createList(form.name);
    setSelectedId(box.id);
    setSwitcher(null);
  };

  const renameList = async (): Promise<void> => {
    if (!list) return;
    const form = await openFormModal(i18nMsg("pages.lists.renameTitle"), [
      { key: "name", label: i18nMsg("pages.lists.nameLabel"), required: true, default: list.name },
    ]);
    if (form?.name?.trim()) renameVault(list.id, form.name);
    setBoxMenu(null);
  };

  const removeList = (): void => {
    if (!list) return;
    const name = list.name, id = list.id;
    setBoxMenu(null);
    void confirmOk(i18nMsg("pages.lists.removeConfirm", { name: String(name) })).then((ok) => {
      if (!ok) return;
      deleteVault(id);
      showToast(i18nMsg("pages.lists.removed", { name: String(name) }));
    });
  };

  const renameItem = async (item: VaultItem): Promise<void> => {
    const form = await openFormModal(i18nMsg("pages.lists.itemRename"), [
      { key: "title", label: i18nMsg("pages.lists.itemTitle"), required: true, default: item.title },
    ]);
    setItemMenu(null);
    const next = form?.title?.trim();
    if (next && next !== item.title) updateVaultItem(item.id, { title: next });
  };

  const removeItem = (item: VaultItem): void => {
    if (!list) return;
    setItemMenu(null);
    removeFromVault(list.id, item.id);
    showToast(i18n("pages.lists.itemRemoved"));
  };

  /* ── 拖动排序：触屏长按武装、鼠标 6px 武装；只重排未完成项 ── */
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragTick, setDragTick] = useState(0);
  const drag = useRef<{ id: string; y0: number; dy: number; to: { id: string; after: boolean } | null } | null>(null);
  const dragEl = useRef<HTMLElement | null>(null);
  const press = useRef<{ id: string; y: number; timer: number } | null>(null);
  const justDragged = useRef(0);

  const clearPress = (): void => {
    const p = press.current;
    if (p) window.clearTimeout(p.timer);
    press.current = null;
  };

  const arm = (id: string, y: number): void => {
    clearPress();
    drag.current = { id, y0: y, dy: 0, to: null };
    dragEl.current = document.querySelector<HTMLElement>(`.lists-row[data-task-id="${id}"]`);
    claimGesture("lists-reorder");
    setDragging(id);
    setDragTick((n) => n + 1);
  };

  const hitTest = (y: number, skipId: string): { id: string; after: boolean } | null => {
    const rows = document.querySelectorAll<HTMLElement>(".lists-open .lists-row[data-task-id]");
    for (const row of rows) {
      const id = row.dataset.taskId;
      if (!id || id === skipId) continue;
      const rect = row.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) return { id, after: y > rect.top + rect.height / 2 };
    }
    return null;
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent): void => {
      const state = drag.current;
      if (!state) return;
      event.preventDefault();
      state.dy = event.clientY - state.y0;
      if (dragEl.current) dragEl.current.style.transform = `translateY(${state.dy}px)`;
      state.to = hitTest(event.clientY, state.id);
      setDragTick((n) => n + 1);
    };
    const finish = (): void => {
      const state = drag.current;
      if (state?.to && list) reorderTasks(list.id, state.id, state.to.id, state.to.after);
      if (dragEl.current) dragEl.current.style.transform = "";
      dragEl.current = null;
      drag.current = null;
      setDragging(null);
      releaseGesture("lists-reorder");
      justDragged.current = Date.now();
    };
    const block = (event: TouchEvent): void => { if (drag.current) event.preventDefault(); };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("touchmove", block, { passive: false });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("touchmove", block);
    };
  }, [dragging, list?.id]);

  const onRowDown = (event: ReactPointerEvent<HTMLLIElement>, item: VaultItem): void => {
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.button !== 0) return;
    const mouse = event.pointerType === "mouse";
    press.current = { id: item.id, y: event.clientY, timer: 0 };
    if (!mouse) press.current.timer = window.setTimeout(() => arm(item.id, event.clientY), GESTURE.longPressMs);
  };

  const onRowMove = (event: ReactPointerEvent<HTMLLIElement>): void => {
    const p = press.current;
    if (!p) return;
    const dy = event.clientY - p.y;
    const limit = event.pointerType === "mouse" ? GESTURE.mouseSlop : GESTURE.longPressSlop;
    if (Math.abs(dy) <= limit) return;
    if (event.pointerType === "mouse") arm(p.id, p.y);
    else clearPress();
  };

  const onRowUp = (): void => { clearPress(); };
  const onClickCapture = (event: React.MouseEvent): void => {
    if (Date.now() - justDragged.current > 200) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const itemActions: MenuItem[] = itemMenu ? [
    { id: "rename", label: i18n("pages.lists.itemRename"), onSelect: () => void renameItem(itemMenu.item) },
    { id: "remove", label: i18n("pages.lists.itemRemove"), danger: true, onSelect: () => removeItem(itemMenu.item) },
  ] : [];
  const boxActions: MenuItem[] = [
    { id: "rename", label: i18n("pages.lists.rename"), onSelect: () => void renameList() },
    { id: "clear", label: i18n("pages.lists.clearDone"), danger: true, disabled: !done.length, onSelect: () => { if (list) clearDoneTasks(list.id); setBoxMenu(null); } },
    { id: "remove", label: i18n("pages.lists.remove"), danger: true, onSelect: removeList },
  ];

  const row = (item: VaultItem): ReactNode => {
    const draggingThis = dragging === item.id;
    const state = drag.current;
    const target = state && state.to?.id === item.id ? (state.to.after ? " is-after" : " is-before") : "";
    return (
      <li
        key={item.id}
        className={"lists-row" + (item.done ? " is-done" : "") + (draggingThis ? " is-dragging" : "") + target}
        data-task-id={item.id}
        onPointerDown={(event) => onRowDown(event, item)}
        onPointerMove={onRowMove}
        onPointerUp={onRowUp}
        onPointerCancel={onRowUp}
      >
        <Checkbox
          className="lists-check"
          checked={!!item.done}
          onChange={(next) => toggle(item, next)}
          label={<span className="lists-row-text">{item.title}</span>}
        />
        {item.done ? null : (
          <IconBtn
            className="lists-row-more"
            label={i18n("pages.lists.itemMenu", { title: item.title })}
            icon={<IconMore />}
            onClick={(event) => { event.stopPropagation(); setItemMenu({ anchor: event.currentTarget, item }); }}
          />
        )}
      </li>
    );
  };

  return (
    <div className="lists-page" data-lists={String(lists.length)}>
      {list ? (
        <>
          <header className="lists-head">
            <Btn variant="ghost" className="lists-title" aria-haspopup="menu" aria-expanded={!!switcher} onClick={(event) => setSwitcher(event.currentTarget)}>
              <span>{list.name}</span>
              <span className="lists-caret" aria-hidden="true">▾</span>
            </Btn>
            <Text slot="micro" tone="faint" className="lists-count">
              {open.length ? i18n("pages.lists.count", { count: String(open.length) }) : ""}
            </Text>
            <div className="lists-head-actions">
              <IconBtn label={i18n("pages.lists.new")} icon={<IconPlus />} onClick={() => void create()} />
              <IconBtn label={i18n("pages.lists.menu")} aria-haspopup="menu" aria-expanded={!!boxMenu} icon={<IconMore />} onClick={(event) => setBoxMenu(event.currentTarget)} />
            </div>
          </header>

          <div className="lists-add">
            <Input
              value={draft}
              onChange={setDraft}
              onEnter={submit}
              icon={<span aria-hidden="true">＋</span>}
              placeholder={i18n("pages.lists.addPlaceholder")}
              aria-label={i18n("pages.lists.addPlaceholder")}
              autoComplete="off"
            />
          </div>

          <div className="lists-open" onClickCapture={onClickCapture}>
            {open.length ? <ul className="lists-rows">{open.map(row)}</ul> : null}
          </div>

          {!list.items.length ? (
            <div className="lists-empty">
              <b>{i18n("pages.lists.empty")}</b>
              <Text slot="micro" tone="faint">{i18n("pages.lists.emptyHint")}</Text>
            </div>
          ) : null}

          {done.length ? (
            <details className="lists-done">
              <summary>
                <span className="lists-chev" aria-hidden="true">▸</span>
                {i18n("pages.lists.done")} {done.length}
              </summary>
              <ul className="lists-rows">{done.map(row)}</ul>
            </details>
          ) : null}

          {undo ? (
            <div className="lists-undo" role="status">
              <span>{i18n("pages.lists.completedToast", { title: undo.title })}</span>
              <Btn size="sm" variant="ghost" onClick={revert}>{i18n("pages.lists.undo")}</Btn>
            </div>
          ) : null}
        </>
      ) : (
        <div className="lists-blank">
          <b>{i18n("pages.lists.noLists")}</b>
          <Text slot="micro" tone="faint">{i18n("pages.lists.noListsHint")}</Text>
          <Btn variant="outline" icon={<IconPlus />} onClick={() => void create()}>{i18n("pages.lists.new")}</Btn>
        </div>
      )}

      <Menu
        open={!!switcher}
        onClose={() => setSwitcher(null)}
        anchor={switcher ?? undefined}
        title={i18n("pages.lists.switch")}
        label={i18n("pages.lists.switch")}
        items={[
          ...lists.map((entry) => ({
            id: entry.id,
            label: entry.name,
            onSelect: () => { setSelectedId(entry.id); setSwitcher(null); },
          })),
          { id: "new", label: i18n("pages.lists.new"), onSelect: () => void create() },
        ]}
      />
      <Menu open={!!boxMenu} onClose={() => setBoxMenu(null)} anchor={boxMenu ?? undefined} title={list?.name} label={i18n("pages.lists.menu")} items={boxActions} />
      <Menu open={!!itemMenu} onClose={() => setItemMenu(null)} anchor={itemMenu?.anchor} title={itemMenu?.item.title} label={i18n("pages.lists.itemMenu", { title: itemMenu?.item.title ?? "" })} items={itemActions} />
      {/* dragTick 只用于让拖动中的落点样式重新渲染 */}
      <span hidden data-drag-tick={dragTick} />
    </div>
  );
}
