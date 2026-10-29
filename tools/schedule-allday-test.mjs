/**
 * 全天横幅行（方案 A）的纯布局契约。
 *
 * 只测 lib/alldayLayout.ts：日期投影用注入的 dayOf，不碰时区/DOM；
 * 页面接线与像素几何由浏览器验收覆盖（见 docs/reviews/）。
 */
import assert from "node:assert/strict";

const { ALLDAY_DAYS, layoutAllDay, weekDaySpan } = await import("../apps/desktop/src/lib/alldayLayout.ts");

const DAY = 86_400_000;
const dayOf = (ms) => Math.floor(ms / DAY);
const at = (day) => day * DAY;
const occ = (uid, d0, d1, summary = uid) => ({ uid, summary, src: "local", d0, d1 });
let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const ok = (value, label) => { assert.ok(value, label); checks++; };

/* ── weekDaySpan：end 排他、跨周裁切、窗口外不上屏 ── */
eq(weekDaySpan(at(100), at(101), dayOf, 100), { d0: 0, d1: 0 }, "单天全天事件落在周一");
eq(weekDaySpan(at(100), at(103), dayOf, 100), { d0: 0, d1: 2 }, "三天事件含端点");
eq(weekDaySpan(at(98), at(101), dayOf, 100), { d0: 0, d1: 0 }, "跨到本周前的条裁到周一");
eq(weekDaySpan(at(104), at(108), dayOf, 100), { d0: 4, d1: 6 }, "跨到下周的条裁到周日");
eq(weekDaySpan(at(99), at(100), dayOf, 100), null, "周一 00:00 结束（end 排他）不算本周");
eq(weekDaySpan(at(107), at(108), dayOf, 100), null, "整条在周日后不上屏");
eq(weekDaySpan(at(100), at(100), dayOf, 100), null, "零时长不上屏");
eq(weekDaySpan(Number.NaN, at(101), dayOf, 100), null, "非法时间不上屏");

/* ── 合并：每日重复收敛成一条，改过标题的实例各留一条 ── */
const daily = layoutAllDay(Array.from({ length: 7 }, (_, d) => occ("daily", d, d, "背单词打卡")), 3);
eq(daily.spans.length, 1, "每日重复的 7 次出现合并成 1 条");
eq([daily.spans[0].d0, daily.spans[0].d1, daily.spans[0].lane], [0, 6, 0], "合并后铺满整周");

const renamed = layoutAllDay([occ("series", 0, 0, "系列"), occ("series", 1, 1, "改过的标题")], 3);
eq(renamed.spans.map((s) => s.summary), ["系列", "改过的标题"], "同 uid 不同标题不合并");

const gaps = layoutAllDay([occ("weekly", 0, 0), occ("weekly", 2, 2)], 3);
eq(gaps.spans.length, 2, "同 uid 不相邻的两天不合并");

const overlap = layoutAllDay([occ("trip", 0, 2), occ("trip", 1, 3)], 3);
eq([overlap.spans[0].d0, overlap.spans[0].d1], [0, 3], "同 uid 重叠条并成一条");

/* ── 分道与折叠 ── */
const sameDay = layoutAllDay(Array.from({ length: 5 }, (_, i) => occ(`e${i}`, 2, 2)), 3);
eq(sameDay.spans.map((s) => s.lane), [0, 1, 2, 3, 4], "同列按输入顺序分道");
eq(sameDay.visibleRows, 3, "可见道数被 cap 截住");
eq(sameDay.hidden[2].length, 2, "第 3 条起折叠进 +N");
ok(sameDay.hidden[0].length === 0 && sameDay.hidden[1].length === 0, "别的列不受影响");
ok(sameDay.hasOverflow, "有折叠即报溢出");

const stacked = layoutAllDay([occ("a", 1, 3), occ("b", 1, 3), occ("c", 1, 3), occ("d", 1, 3)], 2);
eq([stacked.hidden[1].length, stacked.hidden[2].length, stacked.hidden[3].length], [2, 2, 2], "跨天条被折叠时覆盖的每一天都记一次");
eq(stacked.hidden[0].length + stacked.hidden[4].length, 0, "未覆盖的列不记折叠");

const priority = layoutAllDay([occ("long", 0, 2), occ("x1", 1, 1), occ("x2", 1, 1), occ("x3", 1, 1)], 2);
eq(priority.spans.find((s) => s.uid === "long").lane, 0, "跨度长的先占低道");
eq(priority.spans.filter((s) => s.uid !== "long").map((s) => s.lane), [1, 2, 3], "单天条顺次占道");
eq(priority.hidden[1].map((s) => s.uid), ["x2", "x3"], "第二天折叠后两条");

const tie = layoutAllDay([occ("first", 0, 0), occ("second", 0, 0)], 3);
eq(tie.spans.map((s) => [s.uid, s.lane]), [["first", 0], ["second", 1]], "同长同日按输入顺序定道");

/* ── 边界 ── */
const empty = layoutAllDay([], 3);
eq([empty.spans.length, empty.visibleRows, empty.hasOverflow], [0, 0, false], "空输入无横幅、无行");
eq(empty.hidden.length, ALLDAY_DAYS, "空输入也给出 7 列折叠数组");
const clamped = layoutAllDay([occ("zero", 2, 2)], 0);
eq([clamped.visibleRows, clamped.spans[0].lane], [1, 0], "cap 至少为 1");
const clampedRange = layoutAllDay([occ("over", 6, 9), occ("bad", 2, 1), occ("nan", Number.NaN, 1)], 3);
eq(clampedRange.spans.map((s) => [s.uid, s.d0, s.d1]), [["over", 6, 6]], "越界裁切，非法范围丢弃");

/* ── 永久不变量：没有事件被静默丢弃 ── */
const mixed = layoutAllDay([
  occ("long", 0, 5),
  occ("m1", 1, 1), occ("m2", 1, 1), occ("m3", 1, 1),
  occ("w1", 3, 3), occ("w2", 3, 4),
  occ("daily", 0, 0, "打卡"), occ("daily", 1, 1, "打卡"), occ("daily", 2, 2, "打卡"),
], 2);
for (let d = 0; d < ALLDAY_DAYS; d++) {
  const covering = mixed.spans.filter((s) => s.d0 <= d && d <= s.d1);
  const hidden = mixed.hidden[d];
  eq(hidden.map((s) => s.uid).sort(), covering.filter((s) => s.lane >= 2).map((s) => s.uid).sort(), `第 ${d} 天的折叠清单 = 该列超道次的条`);
  eq(covering.filter((s) => s.lane < 2).length + hidden.length, covering.length, `第 ${d} 天可见 + 折叠覆盖全部条`);
}

console.log(`全天横幅行布局：${checks} 个断言通过（合并 / 分道 / 折叠 / 覆盖不变量）`);
