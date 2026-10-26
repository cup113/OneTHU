package app.onethu.calendar

import org.junit.Assert.*
import org.junit.Test

/** 差异同步的核心契约：内容不变就一次 provider 都不碰；变了才写；重复副本自愈。
 *
 *  这些断言守着 2026-10-26 鸿蒙真机事故的教训——provider 的删除原语在那台设备上不可靠，
 *  所以「稳态零写入」不是性能优化，是可用性前提。
 */
class CalendarMirrorTest {

  private fun key(
    title: String = "高数",
    start: Long = 1_000L,
    end: Long = 2_000L,
    allDay: Boolean = false,
    location: String = "",
    notes: String = "",
    alarm: Int? = null,
  ) = EventKey(title, start, end, allDay, location, notes, alarm)

  @Test fun unchangedContentWritesNothing() {
    val desired = listOf(key(), key(title = "线代", start = 3_000L, end = 4_000L))
    val existing = listOf(11L to key(), 12L to key(title = "线代", start = 3_000L, end = 4_000L))
    val plan = planSync(desired, existing) { it }
    assertEquals(emptyList<EventKey>(), plan.toInsert)
    assertEquals(emptyList<Long>(), plan.toDelete)
    assertEquals(2, plan.unchanged)
  }

  @Test fun changedTitleDeletesOldRowAndInsertsNewEvent() {
    val desired = listOf(key(title = "高数（改）"))
    val existing = listOf(7L to key(title = "高数"))
    val plan = planSync(desired, existing) { it }
    assertEquals(listOf(key(title = "高数（改）")), plan.toInsert)
    assertEquals(listOf(7L), plan.toDelete)
    assertEquals(0, plan.unchanged)
  }

  @Test fun removedEventIsDeleted() {
    val plan = planSync(listOf(key()), listOf(1L to key(), 2L to key(title = "已删课程"))) { it }
    assertEquals(emptyList<EventKey>(), plan.toInsert)
    assertEquals(listOf(2L), plan.toDelete)
    assertEquals(1, plan.unchanged)
  }

  @Test fun emptyCalendarInsertsEverything() {
    val desired = (1..226).map { key(title = "课$it", start = it * 10L, end = it * 10L + 5) }
    val plan = planSync(desired, emptyList()) { it }
    assertEquals(226, plan.toInsert.size)
    assertEquals(emptyList<Long>(), plan.toDelete)
    assertEquals(0, plan.unchanged)
  }

  @Test fun emptyDesiredDeletesEverything() {
    val plan = planSync(emptyList<EventKey>(), listOf(1L to key(), 2L to key())) { it }
    assertEquals(emptyList<EventKey>(), plan.toInsert)
    assertEquals(listOf(1L, 2L), plan.toDelete)
  }

  @Test fun duplicateCopiesConvergeToSingleEvent() {
    // 旧 bug 留下的三份副本：期望 1 份 → 多出来的两行必须被删，且只插 0 条
    val plan = planSync(listOf(key()), listOf(1L to key(), 2L to key(), 3L to key())) { it }
    assertEquals(emptyList<EventKey>(), plan.toInsert)
    assertEquals(2, plan.toDelete.size)
    assertEquals(1, plan.unchanged)
  }

  @Test fun identicalDesiredEventsAreMatchedAsMultiset() {
    // 期望里两条内容相同就必须落两条：只有一份现有行时，另一份要插
    val plan = planSync(listOf(key(), key()), listOf(9L to key())) { it }
    assertEquals(listOf(key()), plan.toInsert)
    assertEquals(emptyList<Long>(), plan.toDelete)
    assertEquals(1, plan.unchanged)
  }

  @Test fun whitespaceAndNullNormalizeToSameSignature() {
    val desired = listOf(key(location = "六教 6A016", notes = "带作业本"))
    val existing = listOf(5L to key(location = "  六教 6A016 ", notes = " 带作业本\n"))
    val plan = planSync(desired, existing) { it }
    assertEquals(emptyList<EventKey>(), plan.toInsert)
    assertEquals(emptyList<Long>(), plan.toDelete)
    assertEquals(1, plan.unchanged)
  }

  @Test fun reminderMinuteChangeIsADifference() {
    val plan = planSync(listOf(key(alarm = 15)), listOf(3L to key(alarm = 30))) { it }
    assertEquals(listOf(key(alarm = 15)), plan.toInsert)
    assertEquals(listOf(3L), plan.toDelete)
  }

  @Test fun absentReminderDiffersFromZeroReminder() {
    // null（无提醒）与 0（开始时提醒）必须是两种内容：前者不写 HAS_ALARM/Reminders
    val plan = planSync(listOf(key(alarm = null)), listOf(4L to key(alarm = 0))) { it }
    assertEquals(1, plan.toInsert.size)
    assertEquals(listOf(4L), plan.toDelete)
  }

  @Test fun allDayAndTimedEventsDoNotMix() {
    val plan = planSync(listOf(key(allDay = true)), listOf(6L to key(allDay = false))) { it }
    assertEquals(1, plan.toInsert.size)
    assertEquals(listOf(6L), plan.toDelete)
  }

  @Test fun sigStaysStableAcrossCalls() {
    // 签名参与匹配，必须是纯函数（不能掺时间/随机量），否则退化成每次全删全插
    assertEquals(key().signature(), key().signature())
    assertNotEquals(key().signature(), key(title = "别的").signature())
  }

  @Test fun allDayPreservesCampusDateAtUtcMidnight() {
    val formatter = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").apply { timeZone = java.util.TimeZone.getTimeZone("Asia/Shanghai") }
    val utc = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
    assertEquals("2026-10-20 00:00:00", utc.format(java.util.Date(campusAllDayUtc(formatter.parse("2026-10-20 00:00:00")!!.time))))
    assertEquals("2026-10-21 00:00:00", utc.format(java.util.Date(campusAllDayUtc(formatter.parse("2026-10-21 23:59:59")!!.time))))
  }
}
