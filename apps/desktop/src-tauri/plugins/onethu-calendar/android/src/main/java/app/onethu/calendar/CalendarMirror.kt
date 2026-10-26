package app.onethu.calendar

/* 系统日历的幂等同步：差异驱动，而不是「清空重写」。
 *
 * 历史（重要，别再改回去）：本文件原先只有 replaceCalendarMirror —— 先清空整份日历再全量插入。
 * 它解决了「旧实现先插后删、进程死在两步之间就多出一整份副本」的问题，但代价是每次同步
 * 都要 452 次 provider 写（226 删 + 226 插），并且把「删除」这个原语放进了稳态路径。
 *
 * 2026-10-26 鸿蒙真机实测：provider 的批量删除（`calendar_id=? AND _id IN (…×200 个 ?)`）
 * 一旦真正执行就带走整个进程（事务回滚，旧事件一条未删）；而空表插入 226 条、删日历行级联
 * 删事件都正常。结论是「删除」在这台设备的兼容层上不可靠——稳态必须零写入。
 *
 * 于是改成按内容签名做多重集差：内容没变的事件一次 provider 都不碰（稳态 0 写），只有真的
 * 新增/改动/消失的事件才写，删除永远是单条 `_id=?`。
 *
 * 为什么用内容签名而不是 uid 绑定：Android 的 Events 表对**非 sync-adapter 应用**不开放
 * 可写 UID 列（UID_2445 / SYNC_DATA* 只有 sync adapter 能写），没有稳定 uid 可对。内容签名
 * 保住了「声明期望集合 → 幂等收敛」这个性质：期望集合不变，结果就不变。
 */

/** 事件的「内容身份」：决定要不要写 provider 的唯一依据。
 *
 *  startMs/endMs 必须是**落库后的值**（全天事件已换算成 UTC 零点），否则与回读值对不上；
 *  文本一律过 [normText]，提醒分钟数取 null 表示「无提醒」。
 */
internal data class EventKey(
  val title: String,
  val startMs: Long,
  val endMs: Long,
  val allDay: Boolean,
  val location: String,
  val notes: String,
  val alarmMinutes: Int?,
) {
  fun signature(): String =
    "$title\u0001$startMs\u0001$endMs\u0001$allDay\u0001$location\u0001$notes\u0001${alarmMinutes ?: ""}"
}

/** 文本归一化：provider 回读可能把 null 变空串、或保留首尾空白。
 *
 *  不归一的后果不是「多写一次」，而是**每次同步都全删全插**（签名永远对不上）——
 *  正好是本设计要避免的最坏情况，所以两边都必须过这一层。
 */
internal fun normText(value: String?): String = (value ?: "").trim()

/** 一次同步要做的写操作。 */
internal data class SyncPlan<T>(
  /** 期望集合里有、provider 里没有：插入 */
  val toInsert: List<T>,
  /** provider 里有、期望集合里没有：删除（含旧 bug 留下的重复副本） */
  val toDelete: List<Long>,
  /** 两边签名一致、本次完全不碰的条数 */
  val unchanged: Int,
)

/** 按内容签名做多重集差：配不上的现有行删、配不上的期望事件插。
 *
 *  多重集（而不是集合）语义：期望里有两条内容相同的事件就必须落两条，现有有三份就删掉多的两份
 *  —— 重复副本因此也是自愈的，不需要额外的去重逻辑。
 */
internal fun <T> planSync(
  desired: List<T>,
  existing: List<Pair<Long, EventKey>>,
  keyOf: (T) -> EventKey,
): SyncPlan<T> {
  // 签名 → 期望集合里还没被配掉的索引（同名多份就是多个索引）
  val bySig = HashMap<String, MutableList<Int>>()
  desired.forEachIndexed { index, item ->
    bySig.getOrPut(keyOf(item).signature()) { ArrayList() }.add(index)
  }
  val matched = BooleanArray(desired.size)
  val toDelete = ArrayList<Long>()
  for ((id, key) in existing) {
    val queue = bySig[key.signature()]
    val index = if (queue.isNullOrEmpty()) null else queue.removeAt(queue.size - 1)
    if (index == null) toDelete.add(id) else matched[index] = true
  }
  val toInsert = desired.filterIndexed { index, _ -> !matched[index] }
  return SyncPlan(toInsert = toInsert, toDelete = toDelete, unchanged = desired.size - toInsert.size)
}

/** CalendarProvider all-day dates must be UTC midnight for the campus calendar date. */
internal fun campusAllDayUtc(ms: Long): Long {
  val campus = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("Asia/Shanghai")).apply { timeInMillis = ms }
  return java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).apply {
    clear()
    set(campus.get(java.util.Calendar.YEAR), campus.get(java.util.Calendar.MONTH), campus.get(java.util.Calendar.DAY_OF_MONTH))
  }.timeInMillis
}
