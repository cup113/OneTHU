//! 后台常驻「托盘保活」档：Windows 通知区域 / macOS 菜单栏的托盘图标（桌面端）。
//!
//! 这个模块只做一件事——把一个托盘图标和它的菜单建出来、拆掉、按语言重建；**谁是保活载体
//! 由 `desktop_keepalive` 的档位决定**，关闭窗口的后果由 `desktop_lifecycle_policy` 决定。
//!
//! 命令面（前端 `lib/desktopKeepAlive.ts` 对应）：
//!   `ensure(app, locale)`  建托盘（已存在且语言没变 → 幂等返回；语言变了 → 重建）
//!   `remove(app)`          拆托盘（切回悬浮球保活、退出前）
//!   `present(app)`         托盘图标此刻是否真的在场（关窗策略的判据之一）
//!
//! 红线：
//! 1. **失败不得假装存在**。`ensure` 把错误如实返回，`present` 只认 `tray_by_id`——系统拒绝
//!    托盘、无 libappindicator、图标被回收时都是「不在场」，此时关主窗口必须能退出，
//!    绝不留下用户没有任何入口的后台进程。
//! 2. **不抢焦点、不拉起别的东西**。托盘的任何点击只经 `desktop_lifecycle::request_activate_main`
//!    唤回主窗口（与单实例重开、Dock 点击同一条路径）。
//! 3. 托盘菜单文案在这里各存一份（原生菜单读不到前端词表）；语言由前端在启动与切换时推过来
//!    （`desktop_keepalive_write` 的 locale 参数），不做系统语言猜测。
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Runtime};

/// 托盘图标 id：`capabilities/` 不需要它（托盘由 Rust 建，不走前端 API）。
pub const TRAY_ID: &str = "keepalive";
/// 托盘菜单项 id（`on_menu_event` 按它分派）
const MENU_SHOW: &str = "keepalive-show";
const MENU_SETTINGS: &str = "keepalive-settings";
const MENU_QUIT: &str = "keepalive-quit";
/// 原生 → 前端的事件名（与 `lib/desktopKeepAlive.ts` 的 ACTION_EVENT 必须逐字一致）
pub const ACTION_EVENT: &str = "onethu-desktop://event";

/// 已建托盘所用的语言（None = 没有托盘）。用来让语言切换只重建必要的部分。
static BUILT_LOCALE: Mutex<Option<String>> = Mutex::new(None);

struct Labels {
    show: &'static str,
    settings: &'static str,
    quit: &'static str,
    tooltip: &'static str,
}

/// 菜单文案（两语）：前端只推 locale 代码，具体字串在原生侧留着。
fn labels(locale: &str) -> Labels {
    if locale.starts_with("en") {
        Labels {
            show: "Show OneTHU",
            settings: "Background settings",
            quit: "Quit",
            tooltip: "OneTHU is running in the background",
        }
    } else {
        Labels {
            show: "显示 OneTHU",
            settings: "后台常驻设置",
            quit: "退出",
            tooltip: "OneTHU 在后台运行",
        }
    }
}

fn log(line: &str) {
    crate::debug_log_line(&format!("[TRAY] {line}"));
}

/// 托盘图标此刻是否真的存在（关窗策略的判据：判「图标建成了」而不是「档位是托盘」）。
pub fn present<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

/// 拆掉托盘图标（不存在也算成功）。退出前必须先调，否则 Windows 会留下一个残影图标。
pub fn remove<R: Runtime>(app: &AppHandle<R>) {
    if app.remove_tray_by_id(TRAY_ID).is_some() {
        log("托盘图标已移除");
    }
    if let Ok(mut built) = BUILT_LOCALE.lock() {
        *built = None;
    }
}

/// macOS 用单色模板图（`icon_as_template`），Windows/Linux 用应用自身的彩色小图。
///
/// 返回 `Image<'static>`（`new_owned` 收走像素），所以解码出来的缓冲区可以就地释放。
fn tray_image<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::image::Image<'static>, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        // 模板图只取 alpha 通道，深浅色菜单栏各自反白；44×44 由系统缩到 22pt。
        let (rgba, width, height) = decode_template_png(include_bytes!("../icons/tray-template.png"))?;
        Ok(tauri::image::Image::new_owned(rgba, width, height))
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.default_window_icon()
            .map(|icon| {
                tauri::image::Image::new_owned(icon.rgba().to_vec(), icon.width(), icon.height())
            })
            .ok_or_else(|| "缺少应用图标，无法创建托盘图标".to_string())
    }
}

/// 解一张 RGBA8 PNG 成 (rgba, w, h)。只认这条路径：模板图是我们自己出的资产，
/// 出现别的色型就是资产被换错了，宁可报错也不要显示成一块黑。
#[cfg(target_os = "macos")]
fn decode_template_png(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("托盘模板图读取失败：{e}"))?;
    let mut buffer = vec![0u8; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|e| format!("托盘模板图解码失败：{e}"))?;
    if info.color_type != png::ColorType::Rgba {
        return Err(format!(
            "托盘模板图必须是带透明通道的 PNG（当前色型 {:?}）",
            info.color_type
        ));
    }
    buffer.truncate(info.buffer_size());
    Ok((buffer, info.width, info.height))
}

/// 建托盘（幂等）。语言变了会重建菜单——用户切界面语言后不该还看到旧语言的菜单。
///
/// 只能在主线程上调用：命令层用同步命令（Tauri 的同步命令在主线程执行），
/// `setup` 也在主线程。失败一律返回错误，由调用方决定「不落盘 / 不隐藏窗口」。
pub fn ensure<R: Runtime>(app: &AppHandle<R>, locale: &str) -> Result<(), String> {
    if present(app) {
        let same = BUILT_LOCALE
            .lock()
            .map(|built| built.as_deref() == Some(locale))
            .unwrap_or(false);
        if same {
            return Ok(());
        }
        remove(app);
    }

    let text = labels(locale);
    let show = MenuItem::with_id(app, MENU_SHOW, text.show, true, None::<&str>)
        .map_err(|e| format!("托盘菜单创建失败：{e}"))?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, text.settings, true, None::<&str>)
        .map_err(|e| format!("托盘菜单创建失败：{e}"))?;
    let quit = MenuItem::with_id(app, MENU_QUIT, text.quit, true, None::<&str>)
        .map_err(|e| format!("托盘菜单创建失败：{e}"))?;
    let separator =
        PredefinedMenuItem::separator(app).map_err(|e| format!("托盘菜单创建失败：{e}"))?;
    let menu = Menu::with_items(app, &[&show, &settings, &separator, &quit])
        .map_err(|e| format!("托盘菜单创建失败：{e}"))?;

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(text.tooltip)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|icon, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // 左键 = 显示主窗口（两端一致；菜单走右键）
                crate::desktop_lifecycle::request_activate_main(icon.app_handle());
            }
        });
    // macOS 菜单栏按模板图处理（只取 alpha、随深浅色反白）；Windows 用彩色小图。
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);
    // 托盘由 AppHandle 自己持有（`build_inner` 会把它登记进资源表与 tray 管理器），
    // 这里的返回值只是本轮句柄，丢掉不影响图标常驻（`tray_by_id` 取得回来）。
    builder
        .icon(tray_image(app)?)
        .build(app)
        .map_err(|e| format!("创建托盘图标失败：{e}"))?;

    if let Ok(mut built) = BUILT_LOCALE.lock() {
        *built = Some(locale.to_string());
    }
    log(&format!("托盘图标已创建（locale={locale}）"));
    Ok(())
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        MENU_SHOW => crate::desktop_lifecycle::request_activate_main(app),
        MENU_SETTINGS => {
            // 先唤回主窗口再派事件：主窗口可能正藏着，藏着的窗口收得到事件但不该「凭空弹设置」。
            crate::desktop_lifecycle::request_activate_main(app);
            if let Err(error) = app.emit_to(
                "main",
                ACTION_EVENT,
                serde_json::json!({ "type": "open-keepalive-settings" }),
            ) {
                log(&format!("派发后台常驻设置事件失败：{error}"));
            }
        }
        MENU_QUIT => {
            // 先摘图标再退出：Windows 上带着托盘图标退出会留下残影。
            remove(app);
            log("托盘菜单退出");
            app.exit(0);
        }
        // 全局菜单监听会收到应用里所有菜单的事件：只认自己的 id 前缀，别刷别人的日志。
        other if other.starts_with("keepalive-") => log(&format!("未知托盘菜单项：{other}")),
        _ => {}
    }
}
