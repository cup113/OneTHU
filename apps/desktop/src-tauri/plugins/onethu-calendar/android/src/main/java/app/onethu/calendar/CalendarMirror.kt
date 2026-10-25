package app.onethu.calendar

/** Clear the whole mirror before writing the replacement.
 *
 * The calendar is app-owned (local account `OneTHU`), so it is regenerated from app data every
 * sync; losing it on a failed insert is self-healing, while leaving the previous copy behind is
 * not. The old implementation inserted first and deleted afterwards, so a process death between
 * the two steps left a complete extra copy — on 鸿蒙/HarmonyOS that produced dozens of duplicate
 * sets per user (2026-10-25). Deleting first makes an interrupted run converge instead of grow.
 */
internal fun <T> replaceCalendarMirror(
  events: List<T>,
  clearAll: () -> Int,
  insertBatch: (List<T>) -> List<Long>,
): Int {
  val removed = clearAll()
  // Each event has at most one reminder operation; 150 events <= 300 operations.
  for (batch in events.chunked(150)) {
    val ids = insertBatch(batch)
    check(ids.size == batch.size) { "系统日历未完整返回新增事件标识" }
  }
  return removed
}

/** CalendarProvider all-day dates must be UTC midnight for the campus calendar date. */
internal fun campusAllDayUtc(ms: Long): Long {
  val campus = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("Asia/Shanghai")).apply { timeInMillis = ms }
  return java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).apply {
    clear()
    set(campus.get(java.util.Calendar.YEAR), campus.get(java.util.Calendar.MONTH), campus.get(java.util.Calendar.DAY_OF_MONTH))
  }.timeInMillis
}
