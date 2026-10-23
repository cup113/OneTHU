//! 后台常驻档位的**移动端替身**（Android/iOS 没有系统托盘，也不存在「二选一」）。
//!
//! 存在的唯一理由：`desktop_keepalive_read` / `desktop_keepalive_write` 在
//! `lib.rs` 的 `invoke_handler!` 里是无条件注册的，安卓侧必须存在同名命令，否则
//! 整个命令表编不过（与 `overlay_win` 的 `not_supported` 兜底同一套路）。
//!
//! 语义上诚实：移动端的保活载体只有悬浮球一种，所以 `read` 恒定报 `overlay`；
//! `write` 直接拒绝——设置页在非桌面平台根本不渲染这个分节，调用它属于程序缺陷。
#![cfg(not(desktop))]

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub mode: &'static str,
    pub locale: String,
    pub tray_ready: bool,
}

#[tauri::command]
pub fn desktop_keepalive_read() -> Snapshot {
    Snapshot {
        mode: "overlay",
        locale: "zh-CN".to_string(),
        tray_ready: false,
    }
}

#[tauri::command]
pub fn desktop_keepalive_write(mode: String, locale: String) -> Result<Snapshot, String> {
    let _ = (mode, locale);
    Err("后台常驻方式只在桌面端可配置（移动端只有悬浮球一种载体）".into())
}
