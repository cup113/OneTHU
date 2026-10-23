//! Desktop main-window ownership and explicit reactivation. OH stays usable
//! while main is closed; another launch reuses that same process and session.
use tauri::{AppHandle, Manager, Runtime, Window, WindowEvent};

#[path = "desktop_lifecycle_policy.rs"]
mod policy;
pub use policy::{KeepAlive, Lifecycle};

struct Windows<'a, R: Runtime>(&'a AppHandle<R>);

impl<R: Runtime> policy::Windows for Windows<'_, R> {
    fn overlay_visible(&self) -> bool {
        self.0
            .get_webview_window(crate::overlay_win::OVERLAY_LABEL)
            .is_some_and(|window| window.is_visible().unwrap_or(true))
    }

    /// 托盘档的载体：只认托盘图标真的在不在，不认档位（建失败/被系统回收都是 false）。
    fn tray_present(&self) -> bool {
        crate::tray::present(self.0)
    }

    fn hide_main(&self) -> Result<(), String> {
        self.0
            .get_webview_window("main")
            .ok_or("找不到主窗口（main）")?
            .hide()
            .map_err(|e| format!("隐藏主窗口失败：{e}"))
    }

    fn show_main(&self) -> Result<(), String> {
        let window = self
            .0
            .get_webview_window("main")
            .ok_or("找不到主窗口（main）")?;
        let _ = window.unminimize();
        window.show().map_err(|e| format!("唤回主窗口失败：{e}"))
    }

    fn focus_main(&self) -> Result<(), String> {
        let window = self
            .0
            .get_webview_window("main")
            .ok_or("找不到主窗口（main）")?;
        window.set_focus().map_err(|e| {
            let message = format!("聚焦主窗口失败：{e}");
            crate::debug_log_line(&format!("[LIFECYCLE] {message}"));
            message
        })
    }

    fn exit(&self) {
        self.0.exit(0);
    }
}

pub fn window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        // Preserve main even if hide fails. Destroying it while OH survives
        // would make the user's "Back to OneTHU" action permanently unusable.
        api.prevent_close();
        let app = window.app_handle();
        let mode = crate::desktop_keepalive::mode();
        if let Err(error) = app.state::<Lifecycle>().close_main(&Windows(app), mode) {
            crate::debug_log_line(&format!("[LIFECYCLE] {error}"));
        }
    }
}

pub fn activate_main<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.state::<Lifecycle>().activate_main(&Windows(app))
}

/// The plugin callback may arrive off the UI thread (macOS socket listener).
/// Only explicit launches, Dock clicks and "Back to OneTHU" use this path.
pub fn request_activate_main<R: Runtime>(app: &AppHandle<R>) {
    let target = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(error) = activate_main(&target) {
            crate::debug_log_line(&format!("[LIFECYCLE] reopen: {error}"));
        }
    });
}

pub fn overlay_hidden<R: Runtime>(app: &AppHandle<R>) {
    let mode = crate::desktop_keepalive::mode();
    app.state::<Lifecycle>().overlay_hidden(&Windows(app), mode);
}
