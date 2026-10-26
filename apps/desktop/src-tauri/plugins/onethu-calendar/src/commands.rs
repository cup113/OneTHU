//! 插件命令（JS 入口；平台内部分发）
use tauri::{AppHandle, Runtime};
#[cfg(any(target_os = "android", target_os = "macos"))]
use tauri::Manager;

use crate::{SyncPayload, SyncResult};

/// 当前平台是否支持原生系统日历读写
#[tauri::command]
pub fn supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "android"))
}

/// 请求系统日历权限（Android 运行时权限弹窗 / macOS TCC 弹窗）
#[tauri::command]
pub async fn request_permission<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<crate::OnethuCalendar<R>>().0.clone();
        // 权限弹窗由用户决定何时关，等待期不定 → 必须走异步桥（同步变体会挂住一个
        // tokio worker 直到用户点完弹窗，tauri 上游对长阻塞 mobile 命令的一贯警告）
        let v: serde_json::Value = handle
            .run_mobile_plugin_async("requestPermission", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())?;
        Ok(v.get("granted").and_then(|g| g.as_bool()).unwrap_or(false))
    }
    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        crate::macos::request_permission()
    }
    #[cfg(not(any(target_os = "android", target_os = "macos")))]
    {
        let _ = &app;
        Ok(false)
    }
}

/// 幂等同步：窗口内清旧 → 全量重写，返回 { added, removed }
#[tauri::command]
pub async fn sync<R: Runtime>(app: AppHandle<R>, payload: SyncPayload) -> Result<SyncResult, String> {
    crate::ownership::validate_payload(&payload)?;
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<crate::OnethuCalendar<R>>().0.clone();
        // 同步本体跑在 Kotlin 单线程执行器上（见 OnethuCalendarPlugin.sync），原生侧几秒起步；
        // 必须用异步桥等待，同步变体会把一个 tokio worker 整段挂死在 rx.recv() 上
        let v: serde_json::Value = handle
            .run_mobile_plugin_async("sync", payload)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::from_value(v).map_err(|e| format!("系统日历返回异常：{e}"))
    }
    #[cfg(target_os = "macos")]
    {
        let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("system-calendar-binding.json");
        crate::macos::sync(payload, &path)
    }
    #[cfg(not(any(target_os = "android", target_os = "macos")))]
    {
        let _ = (&app, payload);
        Err("此平台不支持写入系统日历（可改用 .ics 导出）".into())
    }
}

/// 上次同步的面包屑（进程级死亡后的现场；诊断摘要里带出来）。
///
/// 为什么需要它：鸿蒙兼容层上 adb 拿不到通道，原生侧日志（Kotlin Logger）只进 logcat，
/// 进程被信号带走后现场就没了。Kotlin 侧把每一步 provider 调用落盘 + fsync，这里读回来
/// 交给前端，用户点「复制诊断摘要」即可贴出——最后一行就是死亡边界。
#[tauri::command]
pub async fn sync_trace<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<crate::OnethuCalendar<R>>().0.clone();
        let v: serde_json::Value = handle
            .run_mobile_plugin_async("syncTrace", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())?;
        Ok(v.get("text").and_then(|t| t.as_str()).unwrap_or_default().to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Ok(String::new())
    }
}

/// 移除 OneTHU 专属日历（连同其中全部事件）
#[tauri::command]
pub async fn remove_calendar<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<crate::OnethuCalendar<R>>().0.clone();
        // 删除几千条事件同样在后台执行器上跑数秒 → 异步桥
        let _v: serde_json::Value = handle
            .run_mobile_plugin_async("removeCalendar", serde_json::json!({ "calendarTitle": crate::CALENDAR_TITLE }))
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("system-calendar-binding.json");
        crate::macos::remove_calendar(&path)
    }
    #[cfg(not(any(target_os = "android", target_os = "macos")))]
    {
        let _ = &app;
        Err("此平台不支持系统日历操作".into())
    }
}
