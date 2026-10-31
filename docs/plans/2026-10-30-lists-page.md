# 清单页：核心设计与实现

2026-10-30 · 分支 `feat/stash-todo` · 状态：已实现，待真实浏览器/真机验收

## 目标

个人待办清单：随手记下、勾掉、在三种模式里都能看到。数据写进现有 `onethu.vaults.v1`，不新建存储层。

## 非目标（v1）

- 跨设备同步；分享口令 / 接收清单
- 截止日期、提醒、重复规则
- 作业聚合（仍归 `TasksPage` 的「待办」）

## 数据

```ts
type VaultBoxKind = "stash" | "list";
interface VaultBox { /* 现有字段 */ kind?: VaultBoxKind }   // 缺省 stash
type VaultItemType = "atom" | "text" | "file" | "board-item" | "payload" | "task";
interface VaultItem { /* 现有字段 */ done?: boolean; doneAt?: number }
```

### 不变量

1. `doc.activeId` 永远指向 stash 箱；清单页用自己的选中态（`onethu.lists.selected.v1`），不写 `activeId`。
2. 暂存表面（浮球、抽屉、`/vault`）只列 `kind !== "list"`；清单页只列 `kind === "list"`。
3. 落到清单箱的非 `task` 条目一律拒绝（`reason: "list-box"`）；`task` 落不进 stash（`"stash-box"`）。
4. 每个表面至少保留一个箱：删掉最后一份清单就重建一份空清单；删掉最后一个 stash 就重建空 stash。
5. 任务判重只在**同箱未完成任务**之间；勾掉之后可以再建同名。
6. 新任务追加到数组末尾；**数组顺序就是清单顺序**，不另设 `order` 字段。
7. 已完成项占住它在数组里的位置：取消勾选会回到原位，拖动排序只重排未完成项。
8. 完成项留在箱内，视图折叠成「已完成 N」；底部提示 5 秒内可撤销。

## 伪代码

```
addTask(boxId, rawTitle):
  title = rawTitle.trim().replace(/\s+/g, " ")
  if title 为空                          → { ok:false, reason:"empty" }
  if 箱内存在 !done 且 title 相同的任务  → { ok:false, reason:"duplicate" }
  item = { id, type:"task", title, addedAt: now, done:false }
  box.items = [...box.items, item]
  persist(); return { ok:true, item }

setTaskDone(boxId, itemId, done):
  item.done = done; item.doneAt = done ? now : undefined
  persist()

reorderTasks(boxId, fromId, toId, after):
  slots = 未完成项在 items 里的下标
  open  = slots 对应的条目
  把 from 从 open 取出，插到 to 前/后
  按 slots 写回 items      // 已完成项的位置不动

deleteVault(boxId):
  删掉该箱
  若删的是清单且已无清单 → 补一份空清单
  若删的是 stash 且已无 stash → 补一个空 stash，并设为 activeId
```

视图排序：

```
open = 任务里 !done 的，按数组顺序
done = 任务里 done 的，按数组顺序
标题 = 未完成 {open.length} 项
```

## 交互

| 输入 | 动作 |
|---|---|
| 点行任意处 | 勾选 / 取消勾选（勾选后滑入「已完成」，底部 5 秒可撤销） |
| 触屏长按 400ms 后移动 | 抓起整行排序；移动超过 8px 则视为滚动 |
| 鼠标按住移动 6px | 直接拖动排序 |
| 行尾 ⋯ | 重命名 / 删除条目（桌面悬停出现，触屏常显） |
| 标题 ▾ | 切换清单 / 新建清单 |
| 右上 ⋯ | 重命名清单 / 清除已完成 / 删除清单 |

拖动中以 2px 插入线提示落点，松手落库；指针取消、窗口失焦不写。

## 入口（六处注册）

| 位置 | 注册点 |
|---|---|
| 首页功能目录、程序坞、更多功能 | `Layout.NAV`（排在末尾，不挤占默认前八颗球） |
| 程序坞白名单 | `homeSpheres` 的 known 自动取自 NAV |
| 搜索、命令面板、OH `open_page` | `PAGE_ATOMS` + `NAV_REGISTRY` |
| 页头星标与「最近使用」 | `PAGE_ATOMS` |
| OneGO / OneShot / 实用模式四格 | `quickAccess` 从 `NAV_REGISTRY` 自动生成 |
| 标签页图标 | `TabStrip` 映射 + `renderPage` |

手机上同一套注册，极简/实用模式默认放行。

## 文件

- `state/vault.ts`：`kind`、`task`、`done`，`addTask` / `setTaskDone` / `clearDoneTasks` / `reorderTasks` / `createList` / `deleteVault` / `activeVault`
- `pages/ListsPage.tsx`
- `packages/gui/src/recipes/lists.css`（页面配方，只走 OneGUI 令牌；不占用应用旧样式表行数）
- `renderPage.tsx`、`TabStrip.tsx`、`state/app.tsx`、`state/navigation.ts`、`state/atoms.tsx`、`components/Layout.tsx`
- `tools/lists-model-test.mjs`

## 失败模式

| 场景 | 处理 |
|---|---|
| localStorage 配额满 | 现有 `commit()` 吞异常，内存态继续可用 |
| 选中的清单被删 | 回退到第一份清单，选中态写回 |
| 旧文档没有 `kind` | 一律视为 stash；若一个 stash 都不剩，读档时补一个 |
| OH / 插件 `vault.addText` 指向清单 | 拒绝并回 `list-box` |
| 口令导入 | 仍只新建 stash 箱，不影响清单 |
| 拖动中列表滚动 | 武装后拦截 `touchmove`；未武装的移动按滚动处理 |

## 验收

1. 添加、勾选、取消勾选后刷新仍在。
2. 同名未完成任务被拒；完成后可再建同名。
3. 清单不出现在暂存箱；文件拖不进清单箱。
4. 删到最后一份清单仍有空清单可用。
5. 极简 / 实用模式能看到清单页，数据与完整模式一致。

## 已验证 / 未验证

- 已过：`tsc --noEmit`、`i18n-test`（7732 键 × 2）、OneGUI 护栏（R1–R9）、风格扫描、令牌守卫、`nav-shell-test`、`pc-layout-test`、`lists-model-test`（12 项）、`nav-page-whitelists-test`。
- 真实浏览器验收（2026-10-31）：通过——入口可达、添加与判重、撤销、拖动排序与刷新保持、暂存箱与清单双向隔离、取消勾选回原位。
- 验收首轮失败：`openTab` 的 `KNOWN_PAGES` 没有 `lists`，点入口直接回首页。已补登三张白名单，并加 `nav-page-whitelists-test` 钉住「导航注册表 ⊆ 三张白名单」。
- 未验：Android / iOS 真机；未跑完整 `pnpm guard`（其 `ui-copy-lint` 在基线提交上已有 12 处历史违规）。
