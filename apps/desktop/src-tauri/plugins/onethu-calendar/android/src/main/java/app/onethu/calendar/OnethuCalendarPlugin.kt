// OneTHU 系统日历插件（Android）
//
// 模型（学习 learnX，src/helpers/calendar.ts / expo-calendar 补丁）：
// - 专属本地账户日历「OneTHU 日程」（ACCOUNT_TYPE_LOCAL），不碰用户已有日历；
// - 幂等同步：清窗口旧事件 → 全量重写（applyBatch 分批）；
// - 课程/考试可带提前提醒（Reminders 表）；
// - 华为/鸿蒙兼容：日历投影不含 IS_PRIMARY（会 IllegalArgumentException），
//   cursor 读取一律用 getColumnIndex 容错（不用 getColumnIndexOrThrow）。

package app.onethu.calendar

import android.Manifest
import android.content.ContentProviderOperation
import android.content.ContentValues
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import android.provider.CalendarContract.Reminders
import androidx.core.content.ContextCompat
import app.tauri.Logger
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val TAG = "OnethuCalendar"

/** 本地账户名（日历挂靠，不与任何系统账号关联、不参与云同步） */
private const val ACCOUNT_NAME = "OneTHU"

private val TZ = java.util.TimeZone.getTimeZone("Asia/Shanghai").id

/** 单批插入条数（每条最多再带一个提醒操作 → 每批 ≤ 300 个 provider 操作）。 */
private const val INSERT_BATCH = 150

/** 事件参数（与 TS 层 camelCase 对齐） */
@InvokeArg
class EventArg {
  lateinit var title: String
  var startMs: Long = 0
  var endMs: Long = 0
  var allDay: Boolean = false
  var location: String? = null
  var notes: String? = null
  var alarmMinutes: Int? = null
}

@InvokeArg
class SyncArgs {
  lateinit var calendarTitle: String
  var windowStartMs: Long = 0
  var windowEndMs: Long = 0
  lateinit var events: Array<EventArg>
}

@InvokeArg
class CalendarTitleArgs {
  lateinit var calendarTitle: String
}

/**
 * 同步取证面包屑：每次 provider 调用前后各落一行盘（带 fsync）。
 *
 * 为什么不复用 Logger：Kotlin 的 Logger 只进 logcat，而鸿蒙兼容层上 adb 拿不到通道，
 * 进程级死亡（native 崩溃/被强杀）连 logcat 都带不走。落盘 + 下次启动读取（诊断摘要）
 * 是唯一能把现场交出来的路径；fsync 是必须的——进程被信号带走时，内核缓冲里的内容会一起丢。
 *
 * 2026-10-26 真机实测就是靠这类证据定位的：写入 226 条两次全成功，只有「删已有事件」崩，
 * 且事务回滚后一条未删 → 死区在清空阶段。
 */
private object SyncTrace {
  private const val FILE = "calendar-sync-trace.log"
  private const val MAX_BYTES = 64 * 1024
  private var t0 = 0L

  fun begin(ctx: android.content.Context) {
    t0 = System.currentTimeMillis()
    mark(ctx, "=== 同步开始")
  }

  fun mark(ctx: android.content.Context, line: String) {
    try {
      val file = java.io.File(ctx.filesDir, FILE)
      if (file.length() > MAX_BYTES) file.delete()
      val rel = if (t0 == 0L) 0L else System.currentTimeMillis() - t0
      java.io.FileOutputStream(file, true).use { out ->
        out.write("+${rel}ms $line\n".toByteArray(Charsets.UTF_8))
        out.flush()
        out.fd.sync()
      }
    } catch (_: Throwable) {
      // 取证失败绝不能影响同步主流程
    }
  }

  fun read(ctx: android.content.Context): String = try {
    java.io.File(ctx.filesDir, FILE).readText(Charsets.UTF_8)
  } catch (_: Throwable) {
    ""
  }
}

@TauriPlugin(
  permissions = [
    Permission(
      strings = [Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR],
      alias = "calendar"
    )
  ]
)
class OnethuCalendarPlugin(private val activity: android.app.Activity) : Plugin(activity) {

  // ---------- 工具 ----------

  private val resolver get() = activity.contentResolver
  private val binding get() = activity.getSharedPreferences("onethu-calendar-binding", android.content.Context.MODE_PRIVATE)
  /** 日历写入的单线程执行器：命令必须立刻返回，provider 事务不能占着 IPC 线程（见 sync 注释）。 */
  private val io = java.util.concurrent.Executors.newSingleThreadExecutor()

  private fun saveCalendarId(id: Long) {
    check(binding.edit().putLong("calendarId", id).commit()) { "保存系统日历绑定失败" }
  }

  private fun hasCalendarPermission(): Boolean =
    ContextCompat.checkSelfPermission(activity, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED &&
      ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED

  /**
   * 本地账户的 sync-adapter URI（创建/删除日历必须走这里；learnX 同款）
   */
  private fun localAccountUri(base: Uri): Uri =
    base.buildUpon()
      .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
      .appendQueryParameter(Calendars.ACCOUNT_NAME, ACCOUNT_NAME)
      .appendQueryParameter(Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL)
      .build()

  /**
   * 日历表投影：**不含 IS_PRIMARY**（华为/鸿蒙 ROM 上该合成列会抛
   * IllegalArgumentException —— learnX 打过同款补丁）；列读取用 getColumnIndex 容错。
   */
  private val calendarProjection = arrayOf(
    Calendars._ID,
    Calendars.CALENDAR_DISPLAY_NAME,
    Calendars.CALENDAR_COLOR,
    Calendars.CALENDAR_TIME_ZONE,
    Calendars.NAME,
    Calendars.OWNER_ACCOUNT,
    Calendars.VISIBLE,
    Calendars.SYNC_EVENTS
  )

  /** Legacy Android ownership is verifiable by the app-only local account, not display name alone. */
  private fun findOwnedCalendar(title: String): Long? {
    val saved = binding.getLong("calendarId", -1)
    val where = if (saved >= 0) "${Calendars._ID}=?" else "(${Calendars.NAME}=? OR ${Calendars.CALENDAR_DISPLAY_NAME}=?)"
    val args = if (saved >= 0) arrayOf(ACCOUNT_NAME, CalendarContract.ACCOUNT_TYPE_LOCAL, saved.toString())
      else arrayOf(ACCOUNT_NAME, CalendarContract.ACCOUNT_TYPE_LOCAL, title, title)
    (resolver.query(localAccountUri(Calendars.CONTENT_URI), calendarProjection,
      "${Calendars.ACCOUNT_NAME}=? AND ${Calendars.ACCOUNT_TYPE}=? AND $where", args, null
    ) ?: throw IllegalStateException("无法读取系统日历账户" )).use { cursor ->
      val idIdx = cursor.getColumnIndex(Calendars._ID)
      if (idIdx >= 0 && cursor.moveToFirst()) {
        val id = cursor.getLong(idIdx)
        if (saved != id) saveCalendarId(id)
        return id
      }
    }
    return null
  }

  /** 找到（或创建）OneTHU 专属日历，返回其 _id */
  private fun findOrCreateCalendar(title: String): Long {
    findOwnedCalendar(title)?.let { return it }
    // 再建
    val values = ContentValues().apply {
      put(Calendars.ACCOUNT_NAME, ACCOUNT_NAME)
      put(Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL)
      put(Calendars.NAME, title)
      put(Calendars.CALENDAR_DISPLAY_NAME, title)
      put(Calendars.CALENDAR_COLOR, 0xFF1FA487.toInt())
      put(Calendars.CALENDAR_ACCESS_LEVEL, Calendars.CAL_ACCESS_OWNER)
      put(Calendars.OWNER_ACCOUNT, ACCOUNT_NAME)
      put(Calendars.VISIBLE, 1)
      put(Calendars.SYNC_EVENTS, 1)
      put(Calendars.CALENDAR_TIME_ZONE, TZ)
    }
    val uri = resolver.insert(localAccountUri(Calendars.CONTENT_URI), values)
      ?: throw IllegalStateException("创建系统日历失败")
    val id = android.content.ContentUris.parseId(uri)
    saveCalendarId(id)
    Logger.info(TAG, "已创建系统日历「$title」#$id")
    return id
  }

  // ---------- 命令 ----------

  /** 运行时权限：已授权直接回 true，否则弹系统授权框，结果回调后回查 */
  @Command
  fun requestPermission(invoke: Invoke) {
    if (hasCalendarPermission()) {
      invoke.resolve(grantedJson(true))
      return
    }
    requestPermissionForAliases(arrayOf("calendar"), invoke, "calendarPermissionCallback")
  }

  @PermissionCallback
  fun calendarPermissionCallback(invoke: Invoke) {
    invoke.resolve(grantedJson(hasCalendarPermission()))
  }

  /**
   * 幂等同步：清空专属日历 → 全量重写。
   *
   * **必须后台执行、命令立刻返回**：Tauri 的 `runCommand` 由 JNI 在 IPC 线程上同步调用，
   * 期间上游持有 plugins 互斥量；一次数千事件的 provider 事务要十秒，主线程一撞就 ANR /
   * 黑屏（上游 tauri#14694 同款死锁形态）。2026-10-25 真机实测：点「开启并同步」显示十秒
   * 「开启中」，此时一滑动即闪退；且闪退发生在「插入已提交、删除未执行」之间，于是每次尝试
   * 都留下一整份额外副本——重复事件就是这么堆起来的。
   */
  @Command
  fun sync(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(SyncArgs::class.java)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "同步参数无效")
      return
    }
    if (!hasCalendarPermission()) {
      invoke.reject("没有系统日历权限（请在系统设置里允许 OneTHU 读写日历）")
      return
    }
    io.execute {
      try {
        val result = syncBlocking(args)
        activity.runOnUiThread { invoke.resolve(result) }
      } catch (ex: Throwable) {
        // Throwable 而非 Exception：后台线程上的 Error（如 provider 事务触发的 OOM）若不被
        // 接住会直接掀翻整个进程（2026-10-26 鸿蒙真机：开自动同步后每轮启动同步进程即死，
        // 关同步后稳定）。同步失败是可恢复的——指纹未前移，下一轮重试；这里把它转成
        // 可见错误，用户至少还活着能看到。
        val message = "${ex.javaClass.simpleName}: ${ex.message}"
        Logger.error(TAG, "系统日历同步失败 $message", ex)
        activity.runOnUiThread { invoke.reject(message) }
      }
    }
  }

  @Synchronized
  private fun syncBlocking(args: SyncArgs): JSObject {
    val ctx = activity.applicationContext
    SyncTrace.begin(ctx)
    val calId = findOrCreateCalendar(args.calendarTitle)
    SyncTrace.mark(ctx, "cal.id=$calId 期望=${args.events.size}")

    // 期望集合 → 落库值 + 内容签名。全天事件先换算成 UTC 零点再签名：签名必须与 provider
    // 回读的值逐字段一致，否则每次同步都会被判成「内容全变了」→ 退化成全删全插。
    val pending = args.events.map { ev ->
      val start = if (ev.allDay) campusAllDayUtc(ev.startMs) else ev.startMs
      val end = if (ev.allDay) campusAllDayUtc(ev.endMs) else ev.endMs
      val alarm = ev.alarmMinutes?.takeIf { it >= 0 }
      Pending(
        ev = ev, startMs = start, endMs = end,
        key = EventKey(
          title = normText(ev.title), startMs = start, endMs = end, allDay = ev.allDay,
          location = normText(ev.location), notes = normText(ev.notes), alarmMinutes = alarm,
        ),
      )
    }

    // 差异驱动：稳态（内容没变）这里查出 N 条、算完 plan 是 0 删 0 插，provider 一次写都不发。
    // 这是本设计的核心——鸿蒙兼容层的**删除**不可靠（见 CalendarMirror.kt 顶部注释），
    // 只有把删除从稳态路径里彻底拿掉才稳。
    val existing = readExisting(calId)
    SyncTrace.mark(ctx, "read.done 现有=${existing.size}")
    val plan = planSync(pending, existing) { it.key }
    SyncTrace.mark(ctx, "plan 不动=${plan.unchanged} 插=${plan.toInsert.size} 删=${plan.toDelete.size}")

    var removed = 0
    for (id in plan.toDelete) {
      // 单条 _id=?：一参数一语句。删的条数天然很少（只删真的消失/改过的），
      // 旧 bug 留下的重复副本也在这一支里被逐个收掉。
      SyncTrace.mark(ctx, "del.start id=$id")
      val n = resolver.delete(Events.CONTENT_URI, "${Events._ID}=?", arrayOf(id.toString()))
      SyncTrace.mark(ctx, "del.done id=$id raw=$n")
      if (n > 0) removed++
    }

    var batchNo = 0
    for (batch in plan.toInsert.chunked(INSERT_BATCH)) {
      batchNo += 1
      SyncTrace.mark(ctx, "ins.$batchNo.start n=${batch.size}")
      val ids = insertBatch(calId, batch)
      // 少返回标识 = 这批没全落地。宁可让本轮失败、下一轮按差异重试（差异同步天然idempotent），
      // 也不能当成写成功——那会在下次同步里被当成「缺这两条」再插一遍，长成重复副本。
      check(ids.size == batch.size) { "系统日历未完整返回新增事件标识" }
      SyncTrace.mark(ctx, "ins.$batchNo.done")
    }

    val added = plan.toInsert.size
    SyncTrace.mark(ctx, "=== 同步完成 插=$added 删=$removed 不动=${plan.unchanged}")
    Logger.info(TAG, "系统日历同步完成：+$added / -$removed / =${plan.unchanged}")
    return JSObject()
      .put("added", added)
      .put("removed", removed)
      .put("unchanged", plan.unchanged)
  }

  /** 期望事件（已换算落库值）+ 内容签名 */
  private data class Pending(val ev: EventArg, val startMs: Long, val endMs: Long, val key: EventKey)

  /**
   * 读回本日历现有事件的内容签名。
   *
   * 提醒分钟数在 Reminders 表（Events 只有 HAS_ALARM）：用**一次全表查询 + 内存按 event_id 关联**
   * 拿，而不是 `EVENT_ID IN (?,…×N)` —— 长参数列表正是这台设备上出事的那类语句，不碰它。
   * 读不到提醒就当「无提醒」：宁可某条被判成有变化而重写一次，也不要整轮失败。
   */
  private fun readExisting(calId: Long): List<Pair<Long, EventKey>> {
    val alarms = readReminderMinutes()
    val cols = arrayOf(
      Events._ID, Events.TITLE, Events.DTSTART, Events.DTEND,
      Events.ALL_DAY, Events.EVENT_LOCATION, Events.DESCRIPTION,
    )
    val out = ArrayList<Pair<Long, EventKey>>()
    (resolver.query(Events.CONTENT_URI, cols, "${Events.CALENDAR_ID}=?", arrayOf(calId.toString()), null)
      ?: throw IllegalStateException("无法读取已有系统日历事件")).use { c ->
      // 列读取一律 getColumnIndex 容错（华为/鸿蒙的投影会少列，getColumnIndexOrThrow 会抛）
      val iId = c.getColumnIndex(Events._ID)
      if (iId < 0) throw IllegalStateException("系统日历未返回事件标识")
      val iTitle = c.getColumnIndex(Events.TITLE)
      val iStart = c.getColumnIndex(Events.DTSTART)
      val iEnd = c.getColumnIndex(Events.DTEND)
      val iAllDay = c.getColumnIndex(Events.ALL_DAY)
      val iLoc = c.getColumnIndex(Events.EVENT_LOCATION)
      val iNotes = c.getColumnIndex(Events.DESCRIPTION)
      while (c.moveToNext()) {
        val id = c.getLong(iId)
        out.add(
          id to EventKey(
            title = normText(if (iTitle >= 0) c.getString(iTitle) else null),
            startMs = if (iStart >= 0) c.getLong(iStart) else 0L,
            endMs = if (iEnd >= 0) c.getLong(iEnd) else 0L,
            allDay = if (iAllDay >= 0) c.getInt(iAllDay) != 0 else false,
            location = normText(if (iLoc >= 0) c.getString(iLoc) else null),
            notes = normText(if (iNotes >= 0) c.getString(iNotes) else null),
            alarmMinutes = alarms[id],
          )
        )
      }
    }
    return out
  }

  /** event_id → 提醒分钟数（我们每条只写一个提醒，多条的取第一条）。 */
  private fun readReminderMinutes(): Map<Long, Int> {
    val out = HashMap<Long, Int>()
    try {
      (resolver.query(Reminders.CONTENT_URI, arrayOf(Reminders.EVENT_ID, Reminders.MINUTES), null, null, null)
        ?: return out).use { c ->
        val iEvent = c.getColumnIndex(Reminders.EVENT_ID)
        val iMin = c.getColumnIndex(Reminders.MINUTES)
        if (iEvent < 0 || iMin < 0) return out
        while (c.moveToNext()) {
          val eventId = c.getLong(iEvent)
          if (!out.containsKey(eventId)) out[eventId] = c.getInt(iMin)
        }
      }
    } catch (_: Exception) {
      // 读不到提醒按「无提醒」处理（见 readExisting 注释）
    }
    return out
  }

  /** 批量插入（含提醒 back-reference），返回新增事件 id。 */
  private fun insertBatch(calId: Long, batch: List<Pending>): List<Long> {
    val ops = ArrayList<ContentProviderOperation>()
    val eventIndexes = ArrayList<Int>()
    for (p in batch) {
      val ev = p.ev
      val alarm = p.key.alarmMinutes
      val eventValues = ContentValues().apply {
        put(Events.CALENDAR_ID, calId)
        put(Events.TITLE, ev.title)
        put(Events.DTSTART, p.startMs)
        put(Events.DTEND, p.endMs)
        put(Events.EVENT_TIMEZONE, if (ev.allDay) "UTC" else TZ)
        put(Events.EVENT_END_TIMEZONE, if (ev.allDay) "UTC" else TZ)
        put(Events.AVAILABILITY, Events.AVAILABILITY_BUSY)
        put(Events.STATUS, Events.STATUS_CONFIRMED)
        if (ev.allDay) put(Events.ALL_DAY, 1)
        if (!ev.location.isNullOrBlank()) put(Events.EVENT_LOCATION, ev.location)
        if (!ev.notes.isNullOrBlank()) put(Events.DESCRIPTION, ev.notes)
        if (alarm != null) put(Events.HAS_ALARM, 1)
      }
      ops.add(ContentProviderOperation.newInsert(Events.CONTENT_URI).withValues(eventValues).build())
      val eventOpIndex = ops.size - 1
      eventIndexes.add(eventOpIndex)
      if (alarm != null) {
        val reminderValues = ContentValues().apply {
          put(Reminders.MINUTES, alarm)
          put(Reminders.METHOD, Reminders.METHOD_DEFAULT)
        }
        ops.add(
          ContentProviderOperation.newInsert(Reminders.CONTENT_URI)
            .withValues(reminderValues)
            .withValueBackReference(Reminders.EVENT_ID, eventOpIndex)
            .build()
        )
      }
    }
    val results = resolver.applyBatch(CalendarContract.AUTHORITY, ops)
    return eventIndexes.mapNotNull { index -> results[index].uri?.let { android.content.ContentUris.parseId(it) } }
  }

  /** 移除 OneTHU 专属日历（连同事件）——同样后台执行，删除几千条事件不能占 IPC 线程。 */
  @Command
  fun removeCalendar(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(CalendarTitleArgs::class.java)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "参数无效")
      return
    }
    if (!hasCalendarPermission()) {
      invoke.reject("没有系统日历权限")
      return
    }
    io.execute {
      try {
        val ctx = activity.applicationContext
        SyncTrace.begin(ctx)
        SyncTrace.mark(ctx, "remove.start")
        val id = findOwnedCalendar(args.calendarTitle)
        SyncTrace.mark(ctx, "remove.cal=$id")
        if (id != null) {
          val n = resolver.delete(localAccountUri(Calendars.CONTENT_URI),
            "${Calendars._ID}=? AND ${Calendars.ACCOUNT_NAME}=? AND ${Calendars.ACCOUNT_TYPE}=?",
            arrayOf(id.toString(), ACCOUNT_NAME, CalendarContract.ACCOUNT_TYPE_LOCAL))
          SyncTrace.mark(ctx, "remove.done raw=$n")
        }
        check(binding.edit().clear().commit()) { "清理系统日历绑定失败" }
        activity.runOnUiThread { invoke.resolve(JSObject()) }
      } catch (ex: Throwable) {
        // 同 sync：Error 级失败转可见错误，不掀进程
        val message = "${ex.javaClass.simpleName}: ${ex.message}"
        Logger.error(TAG, "移除系统日历失败 $message", ex)
        activity.runOnUiThread { invoke.reject(message) }
      }
    }
  }

  /**
   * 上次同步的面包屑（诊断摘要用）。
   *
   * 进程级死亡带不走 logcat，这份落盘文件是唯一能把「死在哪一步」带出来的通道：
   * 最后一行就是死亡边界（例如只有 `clear.start` 没有 `clear.done`，即死在删除调用里）。
   */
  @Command
  fun syncTrace(invoke: Invoke) {
    invoke.resolve(JSObject().put("text", SyncTrace.read(activity.applicationContext)))
  }

  private fun grantedJson(granted: Boolean): JSObject {
    val obj = JSObject()
    obj.put("granted", granted)
    return obj
  }
}
