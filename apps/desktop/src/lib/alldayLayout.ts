/**
 * 全天事件在周视图里的横幅行布局（方案 A）。
 *
 * 规格来源：docs/demo-schedule-allday-banner.html（列对齐 banner、跨天横铺、
 * 每日重复合并、逐列 +N 折叠）。纯函数：不碰 DOM、时区与页面状态，日期投影
 * 由调用方注入 dayOf（校园墙钟日序号），因此可以直接在 node 里测。
 */

/** 周视图恒为 7 列（与 Schedule.tsx 的 WEEK_COLUMNS 同一语义） */
export const ALLDAY_DAYS = 7;
/** 可见道次上限：桌面 3 行、手机 2 行；超出的按列折叠成 +N */
export const ALLDAY_ROWS_DESKTOP = 3;
export const ALLDAY_ROWS_PHONE = 2;

export type AllDaySource = "cloud" | "local";

export interface AllDayOccurrence {
  uid: string;
  summary: string;
  src: AllDaySource;
  /** 含端点的周内天下标（0 = 周一） */
  d0: number;
  d1: number;
}

export interface AllDaySpan extends AllDayOccurrence {
  /** 0 起的道次；>= cap 即被折叠进该列的 +N */
  lane: number;
}

export interface AllDayLayout {
  /** 按「跨度长 → 短、开始日 → 后、输入顺序」排好的条（含被折叠的） */
  spans: AllDaySpan[];
  /** hidden[day] = 该列被折叠的条（按分道顺序） */
  hidden: AllDaySpan[][];
  visibleRows: number;
  hasOverflow: boolean;
}

/**
 * 把一次全天事件投影到周内天下标。
 *
 * - `dayOf(ms)` 返回与 `weekStartDay` 同一坐标系的整数日序号（调用方注入时区口径）
 * - 全天事件是 `[start, end)` 语义：末日 = end − 1
 * - 完全在周窗口之前/之后、或时长 ≤ 0 → null（不上屏）
 * - 跨周界的条裁到 0..days−1，仍保持连续
 */
export function weekDaySpan(
  startMs: number,
  endMs: number,
  dayOf: (ms: number) => number,
  weekStartDay: number,
  days = ALLDAY_DAYS,
): { d0: number; d1: number } | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const first = Math.floor(dayOf(startMs)) - weekStartDay;
  const last = Math.floor(dayOf(endMs - 1)) - weekStartDay;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  if (last < 0 || first >= days || last < first) return null;
  return { d0: Math.max(0, first), d1: Math.min(days - 1, last) };
}

const hiddenColumns = (): AllDaySpan[][] => Array.from({ length: ALLDAY_DAYS }, () => []);

/**
 * 合并 → 分道 → 折叠。
 *
 * 合并只发生在「同 uid 且同标题」的相邻/重叠日之间：每日重复收敛成一条，
 * 被 RECURRENCE-ID 改过标题的实例保留自己的条，不会被并进系列。
 */
export function layoutAllDay(occurrences: readonly AllDayOccurrence[], cap: number): AllDayLayout {
  const limit = Math.max(1, Math.floor(cap) || 1);
  if (occurrences.length === 0) return { spans: [], hidden: hiddenColumns(), visibleRows: 0, hasOverflow: false };

  // 1. 合并：按 uid + 标题分组，组内按开始日排序，相邻/重叠日并入同一条
  const groups = new Map<string, AllDayOccurrence[]>();
  const keys: string[] = [];
  for (const raw of occurrences) {
    if (!Number.isFinite(raw.d0) || !Number.isFinite(raw.d1)) continue;
    const d0 = Math.max(0, Math.min(ALLDAY_DAYS - 1, Math.trunc(raw.d0)));
    const d1 = Math.max(0, Math.min(ALLDAY_DAYS - 1, Math.trunc(raw.d1)));
    if (d1 < d0) continue;
    const key = `${raw.uid}\u0000${raw.summary}`;
    const list = groups.get(key);
    const occ = { ...raw, d0, d1 };
    if (list) list.push(occ);
    else {
      groups.set(key, [occ]);
      keys.push(key);
    }
  }
  const merged: AllDayOccurrence[] = [];
  for (const key of keys) {
    const list = groups.get(key)!;
    list.sort((a, b) => a.d0 - b.d0 || a.d1 - b.d1);
    let cur: AllDayOccurrence | null = null;
    for (const occ of list) {
      if (cur && occ.d0 <= cur.d1 + 1) {
        cur.d1 = Math.max(cur.d1, occ.d1);
        continue;
      }
      cur = { ...occ };
      merged.push(cur);
    }
  }

  // 2. 分道：跨度长的先占低道（同长按开始日，再按输入顺序，不让标题决定谁被折叠）
  const ranked = merged
    .map((span, index) => ({ span, index }))
    .sort((a, b) => (b.span.d1 - b.span.d0) - (a.span.d1 - a.span.d0) || a.span.d0 - b.span.d0 || a.index - b.index);
  const lanes: boolean[][] = Array.from({ length: ALLDAY_DAYS }, () => []);
  const spans: AllDaySpan[] = [];
  for (const { span } of ranked) {
    let lane = 0;
    for (;;) {
      let free = true;
      for (let d = span.d0; d <= span.d1; d++) {
        if (lanes[d]![lane]) {
          free = false;
          break;
        }
      }
      if (free) break;
      lane++;
    }
    for (let d = span.d0; d <= span.d1; d++) lanes[d]![lane] = true;
    spans.push({ ...span, lane });
  }

  // 3. 折叠：超出 cap 的条按它覆盖的每一天记进 hidden；可见行数取实际用到的道数
  const hidden = hiddenColumns();
  let maxLane = -1;
  for (const span of spans) {
    maxLane = Math.max(maxLane, span.lane);
    if (span.lane < limit) continue;
    for (let d = span.d0; d <= span.d1; d++) hidden[d]!.push(span);
  }
  return { spans, hidden, visibleRows: Math.min(limit, maxLane + 1), hasOverflow: hidden.some((list) => list.length > 0) };
}
