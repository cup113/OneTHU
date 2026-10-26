//! macOS 系统日历：EventKit（EKEventStore）。
//!
//! - 权限：优先 requestFullAccessToEventsWithCompletion:（macOS 14+），
//!   老系统回退 requestAccessToEntityType:completion:（废弃但可用）。
//! - 专属日历：仅操作应用私有文件中绑定的日历标识；不认领同名日历。
//!   可用账户源优先 iCloud，其次本地；账户自身可能同步到其他设备。
//! - 幂等：fetch 窗口内该日历全部事件 → removeEvent(commit=false) → 逐条
//!   saveEvent(commit=false) → 一次 commit()（大批量只落一次盘）。

use std::sync::{mpsc, Mutex};
use std::path::Path;
use std::collections::HashSet;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSDate, NSString};
use objc2_event_kit::{
    EKAlarm, EKCalendar, EKEntityType, EKEvent, EKEventStore, EKSpan, EKSourceType,
};

use crate::{SyncPayload, SyncResult};
use crate::ownership::CalendarBinding;

static MUTATION_LOCK: Mutex<()> = Mutex::new(());

/// 等待权限回调的时长（首次弹 TCC 框，给足时间）
const PERMISSION_TIMEOUT: Duration = Duration::from_secs(180);

fn nsdate(ms: i64) -> Retained<NSDate> {
    NSDate::initWithTimeIntervalSince1970(NSDate::alloc(), (ms as f64) / 1000.0)
}

fn nsstr(s: &str) -> Retained<NSString> {
    NSString::from_str(s)
}

/// 请求系统日历权限；首次弹 TCC 授权框
pub fn request_permission() -> Result<bool, String> {
    let store = unsafe { EKEventStore::new() };

    let (tx, rx) = mpsc::channel::<bool>();
    let block = block2::RcBlock::new(
        move |granted: Bool, _err: *mut objc2_foundation::NSError| {
            let _ = tx.send(granted.as_bool());
        },
    );
    // 完成块可能在任意队列被调；等待结果（命令跑在线程池，阻塞无碍）
    unsafe {
        let ptr = &*block as *const _ as *mut _;
        // macOS 14+ 走新 API，旧系统回退废弃 API（功能等价）
        let has_new: bool = objc2::msg_send![
            &store,
            respondsToSelector: objc2::sel!(requestFullAccessToEventsWithCompletion:)
        ];
        if has_new {
            store.requestFullAccessToEventsWithCompletion(ptr);
        } else {
            #[allow(deprecated)]
            store.requestAccessToEntityType_completion(EKEntityType::Event, ptr);
        }
    }
    rx.recv_timeout(PERMISSION_TIMEOUT)
        .map_err(|_| "等待系统日历授权超时".into())
}

/// 找到（或创建）专属日历。
///
/// 建日历的 source 候选链（learnX 实测结论：macOS 上本地源可能拒绝建日历
/// —— EKError 17 "That account does not allow calendars to be added or removed"，
/// 部分账户（如 Coremail CalDAV）也不允许）：
///   1) iCloud（CalDAV，随用户 Apple 设备同步）；
///   2) 本地 On My Mac；
///   3) 默认日历的源。
/// 逐个尝试，谁接受用谁；全部失败才报错。
fn find_or_create_calendar(store: &EKEventStore, title: &str, binding: &mut CalendarBinding, path: &Path) -> Result<(Retained<EKCalendar>, Option<String>), String> {
    let title_ns = nsstr(title);

    // Only the saved opaque identifier grants ownership. A same-name calendar in
    // another account (or from a legacy installation) is never adopted or cleared.
    if let Some(id) = &binding.id {
        if let Some(cal) = unsafe { store.calendarWithIdentifier(&nsstr(id)) } {
            if !unsafe { cal.allowsContentModifications() } { return Err("已绑定日历不可写，请检查账户权限".into()); }
            return Ok((cal, None));
        }
    }
    let had_legacy = unsafe { store.calendarsForEntityType(EKEntityType::Event) }.iter()
        .any(|cal| unsafe { cal.title() }.to_string() == title);
    let warning = had_legacy.then(|| "已创建并绑定新的专属日历；旧版或其他账户的同名日历未修改，请在系统日历中核对后自行清理".to_string());

    // 候选源排序：iCloud 优先，其次本地，再次默认日历的源
    let mut sources: Vec<Retained<objc2_event_kit::EKSource>> =
        unsafe { store.sources() }.into_iter().collect();
    sources.sort_by_key(|s| match unsafe { s.sourceType() } {
        EKSourceType::CalDAV if unsafe { s.title() }.to_string() == "iCloud" => 0,
        EKSourceType::Local => 1,
        EKSourceType::CalDAV => 3,
        _ => 4,
    });
    if let Some(def) = unsafe { store.defaultCalendarForNewEvents() }.and_then(|c| unsafe { c.source() }) {
        sources.push(def);
    }

    let mut last_err = String::new();
    for source in &sources {
        let cal = unsafe { EKCalendar::calendarForEntityType_eventStore(EKEntityType::Event, store) };
        unsafe {
            cal.setSource(Some(source));
            cal.setTitle(&title_ns);
        }
        match unsafe { store.saveCalendar_commit_error(&cal, true) } {
            Ok(()) => {
                log::info!(
                    "[onethu-calendar] 已在源「{}」创建系统日历「{title}」",
                    unsafe { source.title() }.to_string()
                );
                binding.id = Some(unsafe { cal.calendarIdentifier() }.to_string());
                binding.window_start_ms = None;
                binding.window_end_ms = None;
                binding.save(path)?;
                return Ok((cal, warning));
            }
            Err(e) => {
                last_err = format!("{e:?}");
                log::warn!("[onethu-calendar] 源「{}」拒绝建日历：{e:?}", unsafe { source.title() }.to_string());
            }
        }
    }
    Err(format!(
        "创建日历失败（已尝试 {} 个账户源，均拒绝）：{last_err}。请检查系统日历账户是否允许创建日历后重试。",
        sources.len()
    ))
}

/// 幂等同步：窗口清旧 + 全量重写 + 单次 commit
pub fn sync(payload: SyncPayload, path: &Path) -> Result<SyncResult, String> {
    let _guard = MUTATION_LOCK.lock().map_err(|_| "系统日历锁异常".to_string())?;
    let mut binding = CalendarBinding::read(path)?;
    let store = unsafe { EKEventStore::new() };

    if !request_permission()? {
        return Err("没有系统日历权限（请在 系统设置→隐私与安全性→日历 里允许 OneTHU）".into());
    }

    let (cal, warning) = find_or_create_calendar(&store, &payload.calendar_title, &mut binding, path)?;
    let (start_ms, end_ms) = binding.include_window(payload.window_start_ms, payload.window_end_ms);
    binding.save(path)?;
    let calendars = NSArray::from_slice(&[&*cal]);
    // EventKit silently caps one predicate to four years. Split long saved ranges
    // and deduplicate crossing events; query only our bound calendar, never all accounts.
    let mut cursor = start_ms;
    let chunk = 3 * 365 * 86_400_000_i64;
    let mut seen = HashSet::new();
    let mut removed: u32 = 0;
    while cursor < end_ms {
        let limit = cursor.saturating_add(chunk).min(end_ms);
        let predicate = unsafe { store.predicateForEventsWithStartDate_endDate_calendars(
            &nsdate(cursor), &nsdate(limit), Some(&calendars)) };
        for ev in unsafe { store.eventsMatchingPredicate(&predicate) }.iter() {
            let id = unsafe { ev.calendarItemIdentifier() }.to_string();
            if !seen.insert(id) { continue; }
            unsafe { store.removeEvent_span_commit_error(&ev, EKSpan::ThisEvent, false) }
                .map_err(|e| format!("清理旧事件失败：{e:?}"))?;
            removed += 1;
        }
        cursor = limit;
    }

    // 全量写入（不逐条 commit，最后一次落盘）
    let mut added: u32 = 0;
    for ev in &payload.events {
        let event = unsafe { EKEvent::eventWithEventStore(&store) };
        unsafe {
            event.setTitle(Some(&nsstr(&ev.title)));
            event.setStartDate(Some(&nsdate(ev.start_ms)));
            event.setEndDate(Some(&nsdate(ev.end_ms)));
            event.setAllDay(ev.all_day);
            event.setCalendar(Some(&cal));
            if let Some(loc) = &ev.location {
                event.setLocation(Some(&nsstr(loc)));
            }
            if let Some(note) = &ev.notes {
                event.setNotes(Some(&nsstr(note)));
            }
            if let Some(min) = ev.alarm_minutes {
                let alarm = EKAlarm::alarmWithRelativeOffset(-(min as f64) * 60.0);
                event.addAlarm(&alarm);
            }
            store
                .saveEvent_span_commit_error(&event, EKSpan::ThisEvent, false)
                .map_err(|e| format!("写入事件失败：{e:?}"))?;
        }
        added += 1;
    }

    unsafe { store.commit() }.map_err(|e| format!("提交系统日历变更失败：{e:?}"))?;

    // macOS 仍是「窗口内清旧 → 全量重写」（EventKit 没有 Android 兼容层那种删除原语问题），
    // 所以这里没有"未变"计数，恒为 0。
    Ok(SyncResult { added, removed, unchanged: 0, warning })
}

/// 移除专属日历（连同事件）
pub fn remove_calendar(path: &Path) -> Result<(), String> {
    let _guard = MUTATION_LOCK.lock().map_err(|_| "系统日历锁异常".to_string())?;
    let binding = CalendarBinding::read(path)?;
    let Some(id) = binding.id else {
        return Err("没有本机绑定的专属日历；旧版同名日历请在系统日历中核对后自行移除".into());
    };
    let store = unsafe { EKEventStore::new() };
    if !request_permission()? { return Err("没有系统日历权限".into()); }
    if let Some(cal) = unsafe { store.calendarWithIdentifier(&nsstr(&id)) } {
        unsafe { store.removeCalendar_commit_error(&cal, true) }
            .map_err(|e| format!("移除日历失败：{e:?}"))?;
    }
    CalendarBinding::default().save(path)?;
    Ok(())
}
