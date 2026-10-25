package app.onethu.calendar

import org.junit.Assert.*
import org.junit.Test

class CalendarMirrorTest {
  @Test fun clearsWholeMirrorBeforeWritingReplacement() {
    val operations = ArrayList<String>()
    val count = replaceCalendarMirror((1..301).toList(), { operations.add("clear"); 42 }, { batch ->
      operations.add("insert:${batch.size}"); batch.map { it.toLong() + 1000 }
    })
    // Delete-first: an interrupted run must converge instead of leaving a second copy behind.
    assertEquals(listOf("clear", "insert:150", "insert:150", "insert:1"), operations)
    assertEquals(42, count)
  }

  @Test fun clearFailureAbortsBeforeWritingAnything() {
    var inserted = 0
    try {
      replaceCalendarMirror(listOf(1, 2), { error("provider refused") }, { batch -> inserted += batch.size; batch.map { it.toLong() } })
      fail("must reject")
    } catch (e: IllegalStateException) {
      assertEquals("provider refused", e.message)
    }
    assertEquals(0, inserted)
  }

  @Test fun partialInsertKeepsWhatWasWrittenSoNextRunReplacesIt() {
    var calls = 0
    try {
      replaceCalendarMirror((1..151).toList(), { 0 }, { batch ->
        calls++; if (calls == 2) error("provider failed")
        batch.map { it.toLong() + 1000 }
      })
      fail("must reject")
    } catch (e: IllegalStateException) {
      assertEquals("provider failed", e.message)
    }
    // First batch of 150 stays on the calendar; the next sync clears it and rewrites all 151.
    assertEquals(2, calls)
  }

  @Test fun incompleteIdentifierReturnIsRejected() {
    try {
      replaceCalendarMirror(listOf("a", "b"), { 0 }, { listOf(7L) })
      fail("must reject")
    } catch (e: IllegalStateException) {
      assertTrue(e.message!!.contains("未完整返回"))
    }
  }

  @Test fun emptyMirrorClearsPreviousEventsWithoutInserting() {
    assertEquals(2, replaceCalendarMirror(emptyList<Unit>(), { 2 }, { error("must not insert") }))
  }

  @Test fun allDayPreservesCampusDateAtUtcMidnight() {
    val formatter = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").apply { timeZone = java.util.TimeZone.getTimeZone("Asia/Shanghai") }
    val utc = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
    assertEquals("2026-10-20 00:00:00", utc.format(java.util.Date(campusAllDayUtc(formatter.parse("2026-10-20 00:00:00")!!.time))))
    assertEquals("2026-10-21 00:00:00", utc.format(java.util.Date(campusAllDayUtc(formatter.parse("2026-10-21 00:00:00")!!.time))))
  }
}
