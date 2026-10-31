# 日程 · 全天事件横幅行（方案 A）落地（2026-10-29）

> 设计规格与并排对照见 [全天事件 UI Demo](../demo-schedule-allday-banner.html)。
> 本文只记录这次实现本身；Demo 仍保留为评审依据。

## 背景

0.11.4-4 的全天事件只是时间轴上方一行芯片：外层 `.schedule-chip-row` 没有任何 CSS 规则，
`slice(0, 8)` 静默丢弃第 9 件起的事件，芯片不带日期、不落星期列；一周只有全天事件时还会
误报「本周暂无排课与日程」。此前的 `721b4a41` 只提交了可交互 Demo，产品代码没有改过。

## 改动

| 文件 | 内容 |
| --- | --- |
| `apps/desktop/src/lib/alldayLayout.ts`（新增） | `weekDaySpan` 把全天事件投影到周内 0–6；`layoutAllDay` 做「合并 → 分道 → 折叠」 |
| `tools/schedule-allday-test.mjs`（新增） | 纯布局契约，含「可见 + 折叠 = 全部」的覆盖不变量 |
| `apps/desktop/src/pages/Schedule.tsx` | 投影全天事件、横幅行、吸顶包壳、`+N` 菜单、空态条件、`availH` 依赖 |
| `packages/gui/src/recipes/schedule.css` | `.schedule-head` 吸顶；`.schedule-allday*` 横幅/沟槽/列线/`+N`；手机收紧 |
| `packages/gui/src/components/chip.tsx` | 转发 `titleAttr` / `aria-label`（`OneBase` 已声明，此前被丢弃） |

## 规则

- **合并**：同 `uid` 且同标题的相邻/重叠日并成一条；每日重复收敛成一条整周条，
  `RECURRENCE-ID` 改过标题的实例保留自己的条。
- **分道**：跨度长的先占低道；同长按开始日，再按输入顺序。
- **折叠**：可见道数桌面 3、手机 2；超出部分按它覆盖的每一天记入该列 `+N`，点击列清单
  直接打开事件编辑器。任何事件都不会被静默丢弃。
- **日期**：全天事件按 `[start, end)` 处理，末日 = `end − 1`；跨周裁到边界，完全在窗口外的
  不上屏；用校园墙钟日序号投影，设备时区不影响归属。
- **外观**：全天事件只有一种外观（来源不进视觉），沟槽标与 `+N` 菜单标题复用现有
  `pages.schedule.0b97c851e4a7`（全天），本次不新增 i18n key。
- **铺满**：横幅行与星期表头同处一个吸顶容器，行高一起从 `availH` 里扣掉，画布仍正好
  铺满时间轴，不产生纵向滚动。

## 验证

1. `node --import ./tools/ts-resolve-register.mjs tools/schedule-allday-test.mjs`：42 个断言通过。
2. 反证：把 `layoutAllDay` 的超 cap 分支改成直接丢弃（旧芯片行的静默截断）→ 测试红
   （「第 3 条起折叠进 +N」失败）；还原后文件 SHA-256 与注入前一致
   （`32B7BDA7858EE3FAD62F18ECB217D32D6E09735F8F73763B8C2E2063ABD50B0A`）。
3. `pnpm --filter @onethu/desktop typecheck`、`node tools/i18n-test.mjs`、`node tools/token-guard.mjs`、
   `node tools/css-parse-test.mjs`、`node tools/onegui-guard.mjs`、`node tools/style-scan.mjs`、
   `node --import ./tools/ts-resolve-register.mjs tools/hook-order-test.mjs` 全部通过。
   `ui-copy-lint` 报的 12 处都在未触碰的文件里（`libraryErrorText.ts`、`VisitTab.tsx`、
   `Plugins.tsx`、`Settings.tsx`、`ImSettingsSection.tsx`），属存量。
4. 浏览器核对（`pnpm --filter @onethu/desktop dev`，预览页 `?explorer-preview=page&page=schedule`，
   注入「3 天跨天 + 每日重复 + 同一天 5 条」）：
   - 列对齐：星期单元格 x=40 / 179 / 319…，横幅左缘 = 列 +4；跨 2 列的宽 271.7 = 2 列 − 8。
   - 每日重复 7 次出现 → 1 条整周条；桌面周四的 4 条可见 2 条、折叠 2 条为 `+2`，菜单标题
     「周四 10/29 · 全天」，条目正是被折叠的「本科生论坛」「拿体检报告」，点击打开对应事件编辑器。
   - `scrollHeight === clientHeight`（无纵向滚动）；画布底边 634 = 时间轴底 635 − 1。
   - 只有全天事件的周不再出现空态；切到无事件周时横幅整行消失、空态恢复。
   - 手机 390×844：2 行 + `+3`；横幅高 36px（触控高度）、步进 40px；标题 3 字 + 省略号。
   - 暗色（`data-og-scheme=dark`）：底色与墨色都取自令牌，可读。
   - 极简/实用壳（`.explorer-shell.is-simple`）下横幅行同样出现，`scrollHeight === clientHeight`，
     画布底边仍贴住时间轴。
   - 列表视图无变化。
5. 未做：本机没有 Playwright，`tools/*-browser-test.mjs` 未运行；像素验收用 DSH 浏览器人工完成，
   截图留在 `.playwright-mcp/`（已 gitignore）。

## 边界

- 系统日历、桌面小组件、提醒规则未改（提醒仍跳过全天事件，已有测试锁定）。
- 不新增数据字段，不改 `cal.*` 契约；跨周事件只显示本周可见段。
- 手机单列约 51px，长标题靠 `+N` 清单与编辑器补全；不做入场动画。
