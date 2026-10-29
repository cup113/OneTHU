//! 桌面端「后台常驻」档位的真源（悬浮球保活 / 托盘保活，二选一）。
//!
//! 为什么档位存在原生文件（`$APPDATA/desktop-keepalive-v1.json`）而不是 localStorage：
//! 1. 托盘图标必须**在 webview 起来之前**就建好（`setup` 阶段），那时前端一行 JS 都还没跑；
//! 2. 本仓已有「WKWebView 的 localStorage 会被系统驱逐」的记录（见 `lib.rs` 的 `state_*`
//!    与 `overlay_win.rs` 的位置落盘注释），关窗行为这种决定性的偏好不能靠它。
//!
//! 形状照 `privacy_consent.rs`：`init` 启动读一次并发布到内存，读/写各一条命令，
//! 落盘走 `native_security::private_atomic_write`，文件缺失或损坏一律回到默认档
//! （`overlay` = 引入托盘之前的行为）。
//!
//! 红线：
//! 1. **托盘建不出来就不许落盘成托盘档**：否则用户下次启动会「选了托盘却没图标」。
//! 2. 档位是关窗策略的唯一权威（`desktop_lifecycle_policy` 只读 `mode()`），
//!    `overlay_show` 在托盘档会被 `overlay_win` 直接拒掉，避免球与托盘两个载体并存。
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use tauri::Manager;

use crate::desktop_lifecycle::KeepAlive;

/// 文件名（改它等于让所有用户回到默认档，别改）
const FILE_NAME: &str = "desktop-keepalive-v1.json";
const DEFAULT_LOCALE: &str = "zh-CN";

/// 落盘形状。`#[serde(default)]`：缺字段的旧文件/手改文件都能读。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    /// "overlay" | "tray"（其他值按 overlay 解释）
    pub mode: String,
    /// 当前界面语言（决定托盘菜单文案；由前端推上来）
    pub locale: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            mode: KeepAlive::Overlay.as_str().to_string(),
            locale: DEFAULT_LOCALE.to_string(),
        }
    }
}

impl Prefs {
    fn normalized(self) -> Self {
        let locale = self.locale.trim();
        Self {
            mode: KeepAlive::parse(self.mode.trim()).as_str().to_string(),
            locale: if locale.is_empty() { DEFAULT_LOCALE.to_string() } else { locale.to_string() },
        }
    }
}

/// 档位（0 = overlay，1 = tray）。策略层每读一次只碰一个原子量，不做文件 I/O。
static MODE: AtomicU8 = AtomicU8::new(0);
/// 当前语言（托盘菜单重建用）
static LOCALE: Mutex<Option<String>> = Mutex::new(None);
/// 写命令串行化：并发切换时最终态必须是最后一次成功落盘的那个值
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn log(line: &str) {
    crate::debug_log_line(&format!("[KEEPALIVE] {line}"));
}

fn path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join(FILE_NAME))
}

fn publish(prefs: &Prefs) {
    let value = match KeepAlive::parse(&prefs.mode) {
        KeepAlive::Tray => 1,
        KeepAlive::Overlay => 0,
    };
    MODE.store(value, Ordering::SeqCst);
    if let Ok(mut slot) = LOCALE.lock() {
        *slot = Some(prefs.locale.clone());
    }
}

fn read_file(app: &tauri::AppHandle) -> Prefs {
    let Ok(file) = path(app) else {
        return Prefs::default();
    };
    let Ok(raw) = std::fs::read(&file) else {
        return Prefs::default();
    };
    match serde_json::from_slice::<Prefs>(&raw) {
        Ok(prefs) => prefs.normalized(),
        Err(e) => {
            log(&format!("档位文件损坏，按默认档处理：{e}"));
            Prefs::default()
        }
    }
}

/// 启动时调用（`setup` 里、其余窗口初始化之前）：读档 → 发布 → 托盘档就把图标建出来。
///
/// 托盘建失败**不改档位**：文件里仍是 tray，但 `tray::present()` 是 false，
/// 于是关主窗口会如实退出（`desktop_lifecycle_policy` 判载体在场，不判档位）。
pub fn init(app: &tauri::AppHandle) {
    let prefs = read_file(app);
    publish(&prefs);
    log(&format!("启动档位 mode={} locale={}", prefs.mode, prefs.locale));
    if KeepAlive::parse(&prefs.mode) == KeepAlive::Tray {
        if let Err(error) = crate::tray::ensure(app, &prefs.locale) {
            log(&format!("托盘图标未能创建（关窗将按退出处理）：{error}"));
        }
    }
}

/// 当前档位（关窗策略的唯一输入）
pub fn mode() -> KeepAlive {
    match MODE.load(Ordering::SeqCst) {
        1 => KeepAlive::Tray,
        _ => KeepAlive::Overlay,
    }
}

/// 当前托盘菜单语言（未推过则回默认）
pub fn locale() -> String {
    LOCALE
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .unwrap_or_else(|| DEFAULT_LOCALE.to_string())
}

/// 前端拿到的快照。`trayReady` 是**实测**结果（托盘图标真的在不在），不是档位回声。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub mode: &'static str,
    pub locale: String,
    pub tray_ready: bool,
}

fn snapshot(app: &tauri::AppHandle) -> Snapshot {
    Snapshot {
        mode: mode().as_str(),
        locale: locale(),
        tray_ready: crate::tray::present(app),
    }
}

#[tauri::command]
pub fn desktop_keepalive_read(app: tauri::AppHandle) -> Snapshot {
    snapshot(&app)
}

/// 切换档位 / 推送界面语言。同步命令（Tauri 的同步命令在主线程执行）——托盘创建与菜单
/// 必须落在主线程上。
///
/// 顺序是有讲究的：**先建托盘，成功才落盘**；再发布到内存（策略立刻读到新档位）；
/// 最后才隐藏悬浮球（隐藏会触发 `overlay_hidden`，那时档位必须已经是托盘，否则会误退出）。
#[tauri::command]
pub fn desktop_keepalive_write(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    mode: String,
    locale: String,
) -> Result<Snapshot, String> {
    if window.label() != "main" {
        return Err("后台常驻只能在主窗口里修改".into());
    }
    let _serial = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let next = Prefs { mode, locale }.normalized();
    let target = KeepAlive::parse(&next.mode);

    if target == KeepAlive::Tray {
        crate::tray::ensure(&app, &next.locale)?;
    } else {
        crate::tray::remove(&app);
    }

    let file = path(&app)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建应用数据目录：{e}"))?;
    }
    let body = serde_json::to_vec(&next).map_err(|e| format!("档位序列化失败：{e}"))?;
    crate::native_security::private_atomic_write(&file, &body)?;

    publish(&next);
    log(&format!("档位已更新 mode={} locale={}", next.mode, next.locale));

    if target == KeepAlive::Tray {
        // 托盘档不保留悬浮球：两个载体并存会让人以为「二选一」没生效。
        if let Err(error) = crate::overlay_win::overlay_hide(app.clone()) {
            log(&format!("隐藏悬浮球失败（不影响托盘保活）：{error}"));
        }
    }

    Ok(snapshot(&app))
}
