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
    val calId = findOrCreateCalendar(args.calendarTitle)

    // 专属日历归本应用所有（本地账户），每次同步都是全量重建：只按 CALENDAR_ID 清空，
    // 不按时间窗挑 id。旧实现按窗口取旧 id、逐条删，历史遗留的重复副本落在窗口外就永远
    // 删不掉；按日历清空则一次收敛。
    fun clearAll(): Int {
      val ids = ArrayList<Long>()
      (resolver.query(Events.CONTENT_URI, arrayOf(Events._ID),
        "${Events.CALENDAR_ID}=?", arrayOf(calId.toString()), null
      ) ?: throw IllegalStateException("无法读取已有系统日历事件")).use { cursor -> while (cursor.moveToNext()) ids.add(cursor.getLong(0)) }
      var removed = 0
      for (chunk in ids.chunked(200)) {
        removed += resolver.delete(Events.CONTENT_URI,
          "${Events.CALENDAR_ID}=? AND ${Events._ID} IN (${chunk.joinToString(",") { "?" }})",
          (listOf(calId.toString()) + chunk.map { it.toString() }).toTypedArray())
      }
      // 计数不符不再当成失败：部分 ROM（鸿蒙兼容层实测）的 delete 返回值不可靠，旧实现据此
      // 抛「旧事件清理未完成」，前端重试又整份重写一遍——这正是重复事件的放大器。
      return removed
    }

    fun insertBatch(batch: List<EventArg>): List<Long> {
      val ops = ArrayList<ContentProviderOperation>()
      val eventIndexes = ArrayList<Int>()
      for (ev in batch) {
        val eventValues = ContentValues().apply {
          put(Events.CALENDAR_ID, calId)
          put(Events.TITLE, ev.title)
          put(Events.DTSTART, if (ev.allDay) campusAllDayUtc(ev.startMs) else ev.startMs)
          put(Events.DTEND, if (ev.allDay) campusAllDayUtc(ev.endMs) else ev.endMs)
          put(Events.EVENT_TIMEZONE, if (ev.allDay) "UTC" else TZ)
          put(Events.EVENT_END_TIMEZONE, if (ev.allDay) "UTC" else TZ)
          put(Events.AVAILABILITY, Events.AVAILABILITY_BUSY)
          put(Events.STATUS, Events.STATUS_CONFIRMED)
          if (ev.allDay) put(Events.ALL_DAY, 1)
          if (!ev.location.isNullOrBlank()) put(Events.EVENT_LOCATION, ev.location)
          if (!ev.notes.isNullOrBlank()) put(Events.DESCRIPTION, ev.notes)
          val alarm = ev.alarmMinutes
          if (alarm != null && alarm >= 0) put(Events.HAS_ALARM, 1)
        }
        ops.add(ContentProviderOperation.newInsert(Events.CONTENT_URI).withValues(eventValues).build())
        val eventOpIndex = ops.size - 1
        eventIndexes.add(eventOpIndex)
        val alarm = ev.alarmMinutes
        if (alarm != null && alarm >= 0) {
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

    val removed = replaceCalendarMirror(args.events.toList(), ::clearAll, ::insertBatch)
    val added = args.events.size
    Logger.info(TAG, "系统日历同步完成：+$added / -$removed")
    return JSObject().put("added", added).put("removed", removed)
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
        val id = findOwnedCalendar(args.calendarTitle)
        if (id != null) {
          resolver.delete(localAccountUri(Calendars.CONTENT_URI),
            "${Calendars._ID}=? AND ${Calendars.ACCOUNT_NAME}=? AND ${Calendars.ACCOUNT_TYPE}=?",
            arrayOf(id.toString(), ACCOUNT_NAME, CalendarContract.ACCOUNT_TYPE_LOCAL))
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

  private fun grantedJson(granted: Boolean): JSObject {
    val obj = JSObject()
    obj.put("granted", granted)
    return obj
  }
}
