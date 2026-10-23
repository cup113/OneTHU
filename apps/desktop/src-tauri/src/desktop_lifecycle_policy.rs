//! Close/reopen policy, shared by the native adapter and offline behavior tests.
//!
//! 「关窗之后应用还活着吗」只由两件事决定：用户选的**后台常驻档位**（`KeepAlive`，
//! 桌面端设置 → 外观与布局 → 后台常驻，二选一），以及**该档位的载体此刻是否在场**。
//! 判据故意不用「球可见吗」这一条：托盘档压根没有球，而球档在托盘起来时也不该被托盘接管。
//!
//! 载体在场的定义：
//!   - `Overlay`：悬浮球窗口可见；
//!   - `Tray`：托盘图标真的建成了（系统拒绝、无 libappindicator、图标被回收 → 不在场）。
//!
//! 载体不在场就退出，是**红线**：主窗口已隐藏、载体又不存在时继续活着，用户将没有任何入口
//! 把进程叫回来（只剩任务管理器）。
//!
//! 本文件必须保持零依赖：`tools/desktop-lifecycle-policy-test.mjs` 用 `rustc --test` 单独
//! 编译执行它（CI「Check desktop window ownership」步骤）。
use std::sync::atomic::{AtomicBool, Ordering};

/// 后台常驻档位（桌面端设置里的二选一）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeepAlive {
    /// 悬浮球保活：球是载体（默认档，与引入托盘之前的行为一致）。
    Overlay,
    /// 托盘保活：系统托盘图标是载体，不创建悬浮球。
    Tray,
}

impl KeepAlive {
    /// 解析持久化的档位值。未知/空值一律按默认档处理——宁可回到今天的既有行为，
    /// 也不要因为一个坏字符串让用户失去后台常驻。
    pub fn parse(raw: &str) -> KeepAlive {
        match raw {
            "tray" => KeepAlive::Tray,
            _ => KeepAlive::Overlay,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            KeepAlive::Overlay => "overlay",
            KeepAlive::Tray => "tray",
        }
    }

    /// 该档位的保活载体此刻是否在场。
    fn carrier_present(self, windows: &impl Windows) -> bool {
        match self {
            KeepAlive::Overlay => windows.overlay_visible(),
            KeepAlive::Tray => windows.tray_present(),
        }
    }
}

pub trait Windows {
    fn overlay_visible(&self) -> bool;
    /// 托盘图标是否真的存在（建失败/被系统回收都是 false）。
    fn tray_present(&self) -> bool;
    fn hide_main(&self) -> Result<(), String>;
    fn show_main(&self) -> Result<(), String>;
    fn focus_main(&self) -> Result<(), String>;
    fn exit(&self);
}

#[derive(Default)]
pub struct Lifecycle {
    main_closed: AtomicBool,
}

impl Lifecycle {
    /// 用户点了主窗口的关闭按钮。
    ///
    /// 载体在场 → 只隐藏主窗口（保留同一份 WebView/会话，供用户唤回）；载体不在场 → 整个
    /// 应用退出（含可能存在的隐藏悬浮窗）。隐藏期间载体可能刚好消失（球被关掉、托盘被回收），
    /// 所以隐藏后再对账一次：两个都不可见时退出，不留无入口进程。
    pub fn close_main(&self, windows: &impl Windows, mode: KeepAlive) -> Result<(), String> {
        if !mode.carrier_present(windows) {
            windows.exit();
            return Ok(());
        }
        windows.hide_main()?;
        self.main_closed.store(true, Ordering::SeqCst);
        self.reconcile(windows, mode);
        Ok(())
    }

    pub fn activate_main(&self, windows: &impl Windows) -> Result<(), String> {
        windows.show_main()?;
        self.main_closed.store(false, Ordering::SeqCst);
        // Windows may deny foreground activation after successfully showing
        // main. The visible window still owns the app; focus is best effort.
        let _ = windows.focus_main();
        Ok(())
    }

    /// 悬浮球被隐藏（「本次关闭悬浮球」）。托盘档下这件事与保活无关：托盘还在就继续活着。
    pub fn overlay_hidden(&self, windows: &impl Windows, mode: KeepAlive) {
        if mode.carrier_present(windows) {
            return;
        }
        if !windows.overlay_visible() && self.main_closed.swap(false, Ordering::SeqCst) {
            windows.exit();
        }
    }

    /// 隐藏主窗口之后的对账：主窗曾按「关闭」处理过，而载体已经不在场 → 退出。
    fn reconcile(&self, windows: &impl Windows, mode: KeepAlive) {
        if mode.carrier_present(windows) {
            return;
        }
        if self.main_closed.swap(false, Ordering::SeqCst) {
            windows.exit();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[derive(Default)]
    struct FakeWindows {
        main_visible: Cell<bool>,
        overlay_visible: Cell<bool>,
        tray_present: Cell<bool>,
        activations: Cell<usize>,
        exits: Cell<usize>,
        hide_fails: Cell<bool>,
        activate_fails: Cell<bool>,
        focus_fails: Cell<bool>,
        overlay_closes_during_hide: Cell<bool>,
        tray_lost_during_hide: Cell<bool>,
    }

    impl Windows for FakeWindows {
        fn overlay_visible(&self) -> bool {
            self.overlay_visible.get()
        }
        fn tray_present(&self) -> bool {
            self.tray_present.get()
        }
        fn hide_main(&self) -> Result<(), String> {
            if self.hide_fails.get() {
                return Err("hide failed".into());
            }
            self.main_visible.set(false);
            if self.overlay_closes_during_hide.get() {
                self.overlay_visible.set(false);
            }
            if self.tray_lost_during_hide.get() {
                self.tray_present.set(false);
            }
            Ok(())
        }
        fn show_main(&self) -> Result<(), String> {
            if self.activate_fails.get() {
                return Err("activate failed".into());
            }
            self.main_visible.set(true);
            self.activations.set(self.activations.get() + 1);
            Ok(())
        }
        fn focus_main(&self) -> Result<(), String> {
            if self.focus_fails.get() {
                Err("focus denied".into())
            } else {
                Ok(())
            }
        }
        fn exit(&self) {
            self.exits.set(self.exits.get() + 1);
        }
    }

    fn open_windows() -> FakeWindows {
        let windows = FakeWindows::default();
        windows.main_visible.set(true);
        windows.overlay_visible.set(true);
        windows
    }

    /// 托盘档：球不存在，托盘图标在场。
    fn tray_windows() -> FakeWindows {
        let windows = FakeWindows::default();
        windows.main_visible.set(true);
        windows.tray_present.set(true);
        windows
    }

    #[test]
    fn close_then_repeated_launch_reuses_the_main_window_and_keeps_oh() {
        let lifecycle = Lifecycle::default();
        let windows = open_windows();
        lifecycle.close_main(&windows, KeepAlive::Overlay).unwrap();
        assert!(!windows.main_visible.get());
        assert!(windows.overlay_visible.get());
        assert_eq!(windows.exits.get(), 0);
        for _ in 0..5 {
            lifecycle.activate_main(&windows).unwrap();
        }
        assert!(windows.main_visible.get());
        assert_eq!(windows.activations.get(), 5);
        windows.overlay_visible.set(false);
        lifecycle.overlay_hidden(&windows, KeepAlive::Overlay);
        assert_eq!(windows.exits.get(), 0, "reopened main still owns the app");
    }

    #[test]
    fn closing_oh_after_main_exits_once_without_a_stranded_hidden_process() {
        let lifecycle = Lifecycle::default();
        let windows = open_windows();
        lifecycle.close_main(&windows, KeepAlive::Overlay).unwrap();
        windows.overlay_visible.set(false);
        lifecycle.overlay_hidden(&windows, KeepAlive::Overlay);
        lifecycle.overlay_hidden(&windows, KeepAlive::Overlay);
        assert_eq!(windows.exits.get(), 1);
    }

    #[test]
    fn closing_main_with_no_visible_oh_exits_including_a_hidden_overlay() {
        let lifecycle = Lifecycle::default();
        let windows = open_windows();
        windows.overlay_visible.set(false);
        lifecycle.close_main(&windows, KeepAlive::Overlay).unwrap();
        assert_eq!(windows.exits.get(), 1);
    }

    #[test]
    fn hiding_oh_with_main_open_or_minimized_keeps_the_app() {
        let lifecycle = Lifecycle::default();
        let windows = open_windows();
        windows.main_visible.set(false); // minimizing is not an explicit close
        windows.overlay_visible.set(false);
        lifecycle.overlay_hidden(&windows, KeepAlive::Overlay);
        assert_eq!(windows.exits.get(), 0);
    }

    #[test]
    fn failed_hide_retains_main_and_never_marks_it_closed() {
        let lifecycle = Lifecycle::default();
        let windows = open_windows();
        windows.hide_fails.set(true);
        assert!(lifecycle.close_main(&windows, KeepAlive::Overlay).is_err());
        assert!(windows.main_visible.get());
        windows.overlay_visible.set(false);
        lifecycle.overlay_hidden(&windows, KeepAlive::Overlay);
        assert_eq!(windows.exits.get(), 0);
    }

    #[test]
    fn failed_reopen_does_not_leave_a_hidden_process_when_oh_closes() {
        let lifecycle = Lifecycle::default();
        let windows = open_windows();
        lifecycle.close_main(&windows, KeepAlive::Overlay).unwrap();
        windows.activate_fails.set(true);
        assert!(lifecycle.activate_main(&windows).is_err());
        windows.overlay_visible.set(false);
        lifecycle.overlay_hidden(&windows, KeepAlive::Overlay);
        assert_eq!(windows.exits.get(), 1);
    }

    #[test]
    fn denied_focus_after_successful_show_keeps_the_reopened_app() {
        let lifecycle = Lifecycle::default();
        let windows = open_windows();
        lifecycle.close_main(&windows, KeepAlive::Overlay).unwrap();
        windows.focus_fails.set(true);
        lifecycle.activate_main(&windows).unwrap();
        assert!(windows.main_visible.get());
        windows.overlay_visible.set(false);
        lifecycle.overlay_hidden(&windows, KeepAlive::Overlay);
        assert_eq!(windows.exits.get(), 0);
    }

    #[test]
    fn oh_closing_during_main_hide_does_not_strand_an_invisible_process() {
        let lifecycle = Lifecycle::default();
        let windows = open_windows();
        windows.overlay_closes_during_hide.set(true);
        lifecycle.close_main(&windows, KeepAlive::Overlay).unwrap();
        assert!(!windows.main_visible.get());
        assert!(!windows.overlay_visible.get());
        assert_eq!(windows.exits.get(), 1);
    }

    // ── 托盘档（2026-10-23 后台常驻二选一） ──────────────────────────────

    #[test]
    fn tray_mode_close_keeps_running_without_any_orb() {
        let lifecycle = Lifecycle::default();
        let windows = tray_windows();
        lifecycle.close_main(&windows, KeepAlive::Tray).unwrap();
        assert!(!windows.main_visible.get(), "主窗口应被隐藏而不是销毁");
        assert_eq!(windows.exits.get(), 0, "托盘图标还在，进程必须继续活着");

        lifecycle.activate_main(&windows).unwrap();
        assert!(windows.main_visible.get());
        assert_eq!(windows.activations.get(), 1, "托盘双击/菜单必须能唤回同一份主窗口");
    }

    #[test]
    fn tray_mode_without_a_tray_icon_exits_instead_of_stranding() {
        let lifecycle = Lifecycle::default();
        let windows = tray_windows();
        windows.tray_present.set(false); // 图标没建成（系统拒绝 / 无 libappindicator）
        lifecycle.close_main(&windows, KeepAlive::Tray).unwrap();
        assert_eq!(windows.exits.get(), 1, "没有载体时必须能退出，否则用户没有任何入口");
    }

    #[test]
    fn tray_lost_during_main_hide_does_not_strand_an_invisible_process() {
        let lifecycle = Lifecycle::default();
        let windows = tray_windows();
        windows.tray_lost_during_hide.set(true);
        lifecycle.close_main(&windows, KeepAlive::Tray).unwrap();
        assert!(!windows.main_visible.get());
        assert_eq!(windows.exits.get(), 1);
    }

    #[test]
    fn tray_mode_ignores_orb_hiding_while_the_tray_stays() {
        let lifecycle = Lifecycle::default();
        let windows = tray_windows();
        lifecycle.close_main(&windows, KeepAlive::Tray).unwrap();
        lifecycle.overlay_hidden(&windows, KeepAlive::Tray);
        assert_eq!(windows.exits.get(), 0, "托盘档下球的可见性与保活无关");
    }

    #[test]
    fn tray_mode_exits_once_after_the_tray_disappears() {
        let lifecycle = Lifecycle::default();
        let windows = tray_windows();
        lifecycle.close_main(&windows, KeepAlive::Tray).unwrap();
        windows.tray_present.set(false); // 系统回收了托盘图标
        lifecycle.overlay_hidden(&windows, KeepAlive::Tray);
        lifecycle.overlay_hidden(&windows, KeepAlive::Tray);
        assert_eq!(windows.exits.get(), 1, "载体消失后必须退出，且只退出一次");
    }

    #[test]
    fn overlay_mode_keeps_todays_behaviour_even_if_a_stale_tray_exists() {
        let lifecycle = Lifecycle::default();
        let windows = open_windows();
        // 档位是悬浮球，但结构上还残留着一个托盘图标（切换中途的瞬态）：判据只看档位载体。
        windows.tray_present.set(true);
        windows.overlay_visible.set(false);
        lifecycle.close_main(&windows, KeepAlive::Overlay).unwrap();
        assert_eq!(windows.exits.get(), 1, "悬浮球档关球即退出，不能被残留托盘救活");
    }

    #[test]
    fn keepalive_parse_is_fail_safe_and_round_trips() {
        assert_eq!(KeepAlive::parse("tray"), KeepAlive::Tray);
        assert_eq!(KeepAlive::parse("overlay"), KeepAlive::Overlay);
        for bad in ["", "TRAY", " tray", "tray ", "tray-keepalive", "{}"] {
            assert_eq!(KeepAlive::parse(bad), KeepAlive::Overlay, "坏值必须回到默认档：{bad}");
        }
        for mode in [KeepAlive::Overlay, KeepAlive::Tray] {
            assert_eq!(KeepAlive::parse(mode.as_str()), mode);
        }
    }
}
