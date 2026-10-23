//! 桌面全局悬浮球窗口（需求 5 桌面侧；macOS 优先，Windows/Linux 兼容）
//! —— ball-overlay-desktop 写域，模块注册与命令挂载由 Lead 在 src/lib.rs 做（清单见交付报告）。
//!
//! 分工：本文件只做「窗口生命周期 + 几何 + 手势事件回传」；视觉层 100% 由前端
//! `components/GlobalOrb.tsx`（Lead 独占）渲染——窗口装载 `index.html?window=overlay`，
//! `App.tsx` 在该 query 下只渲染 GlobalOrb。前端适配器是同写域的 `src/lib/overlayDesktop.ts`。
//!
//! 命令面（与 `lib/overlay.ts` 契约同名）：
//!   overlay_supported / overlay_show / overlay_hide / overlay_set_mode / overlay_move
//!   + overlay_drag_start（原生拖窗）/ overlay_nudge（JS 逐帧拖动兜底，逻辑 px 增量）
//!   + overlay_focus（**唯一**允许抢焦点的入口：用户点面板输入框）
//!   + overlay_back_to_main（**唯一**把主窗口带前台的入口：用户点「回到 OneTHU」）
//! 事件：`onethu-overlay://event`，负载三种：
//!   { "type": "drag",  "x", "y" }                球窗被移动（物理像素，50ms 节流）
//!   { "type": "geometry", "mode", "x", "y", "w", "h" }  形态落位后一次；x/y = 球心相对本窗
//!                                                  左上角的逻辑坐标（前端拿它当动画 origin）
//!   { "type": "closed" }                         「本次关闭」（窗口已隐藏）
//!
//! ## 红线：绝不抢焦点、绝不拉起主窗口（逐条对照 tao 0.35.3 源码得出的做法）
//! 1. 建窗即 `focused(false)` + `set_focusable(false)`：tao 的 macOS `set_visible(true)`
//!    走的是 `makeKeyAndOrderFront`（**不** activate app），而 `canBecomeKeyWindow` 由
//!    focusable ivar 决定 → 置 false 后窗口只能「置前」、永远不会成为 key window，
//!    用户的键盘焦点留在原来那个 app 里 ⇒ `show()` 不抢焦点。
//! 2. `accept_first_mouse(true)`：点击悬浮窗不再触发「点击激活窗口」的默认行为，
//!    单击就能直接进 DOM（「单击出面板、长按说话」全靠这个）。
//! 3. 全文件**不出现** `set_focus()`（tao 的实现 = makeKeyAndOrderFront +
//!    `activateIgnoringOtherApps:YES`，会真的把 OneTHU 激活到前台），也不出现
//!    `unminimize()`，更不按 label 去碰 "main" 窗口。
//! 4. 唯一例外：`overlay_focus(on)`，仅由前端在**用户点面板输入框**时调用（失焦即退回
//!    focusable(false)）。打了这个补丁，才可能出现「输入时 OneTHU 被激活」——见报告风险项。
//!
//! ## 形态（窗口 = 形态本身；数字与安卓 onethu-overlay 对齐：球 58+留白 / 条全宽 176 / 面板高 44%+边距 14）
//! 所有「逻辑 px」常量都按所在屏 scale_factor 换算成物理像素后落位（Retina 不缩水）。

#![cfg_attr(not(desktop), allow(dead_code))]
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

#[cfg(desktop)]
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(desktop)]
use tauri::{
    Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

// ── 对外常量（lib.rs 注册用） ────────────────────────────────────────────────
/// 悬浮窗 label：capabilities/overlay.json 的 windows 必须与之完全一致
pub const OVERLAY_LABEL: &str = "oh-orb";
/// 事件名（前端 `listen("onethu-overlay://event")`）
pub const OVERLAY_EVENT: &str = "onethu-overlay://event";
/// 窗口装载的前端路由：App.tsx 见到 `window=overlay` 只渲染 GlobalOrb
pub const OVERLAY_URL: &str = "index.html?window=overlay";

// ── 几何常量（逻辑 px） ─────────────────────────────────────────────────────
/// 球视觉直径。**必须与 GlobalOrb.tsx 的 BALL_BOX/BALL_VISUAL 常量一致**（组件里球占满
/// 窗口减两侧留白，窗口尺寸就是球尺寸的唯一来源）。
const BALL_VISUAL: f64 = 58.0;
/// 球窗外留白：轻投影画在球元素之外，窗口正好等于球时投影会被窗口边界裁成一条硬线
/// （2026-10-11 用户实录「半个球 / 阴影不对」）。8px 与安卓 BALL_WIN_DP = BALL_DP + 16 同口径。
const BALL_PAD: f64 = 8.0;
/// 球窗体边长 = 球 + 两侧各 8 = 74
const BALL_BOX: f64 = BALL_VISUAL + BALL_PAD * 2.0;
/// 默认落点：所在屏 work area 右下角再让出 right 12 / bottom 128（与 GlobalOrb 设计稿同口径）
const EDGE_RIGHT: f64 = 12.0;
const EDGE_BOTTOM: f64 = 128.0;
/// 语音条：全宽 × 176 —— GlobalOrb 的条内容总高 = 转写雾(73) + 10 + 药丸(54) + 18 = 155，
/// 余量留给第二行转写。窗口竖向位置让**药丸中心对齐球心**（安卓 D①：球原地横向展开，不落底）。
const BAR_H: f64 = 176.0;
/// 药丸高度 / 药丸底边距窗底（与 GlobalOrb bar 态 DOM 的 54 / 18 对齐）
const BAR_PILL_H: f64 = 54.0;
const BAR_PILL_GAP: f64 = 18.0;
/// 悬浮小窗（对齐安卓 A①：PANEL_RATIO 0.44 + PANEL_MARGIN_DP 14；圆角 24 由前端画）
const PANEL_MARGIN: f64 = 14.0;
const PANEL_RATIO: f64 = 0.44;
/// 面板窗外围留白：给「柔和外阴影」留出可绘制空间（窗口正好等于视觉块时阴影会被窗口边界切出硬线）
const PANEL_SHADOW_PAD: f64 = 14.0;
/// 顶部把手改高度时的夹取范围（屏高比例；与前端 clamp 同值，Rust 这边是权威）
const PANEL_MIN_RATIO: f64 = 0.30;
const PANEL_MAX_RATIO: f64 = 0.80;
/// WindowEvent::Moved 的 drag 事件节流 / 落盘节流
const DRAG_EMIT_MS: u128 = 50;
const PERSIST_MS: u128 = 400;

/// 初始化脚本：**只剩透明底色**（球/条/面板的几何 100% 由 GlobalOrb 自己负责，
/// 2026-10-11 起不再注入任何定位覆盖）。
/// 为什么还留着它：`packages/ui/src/base.css` 给 `body` 画了不透明底色
/// （`--md-sys-color-surface-container-low`），且 `html{overflow-y:scroll; scrollbar-gutter:stable}`
/// 会在窗内预留滚动条槽——不清掉就不是真透明悬浮窗。只对 overlay 窗口注入，主窗口不受影响。
/// （若要彻底去掉注入：把这三行等价 CSS 挪进 global.css 的 overlay 作用域即可。）
const OVERLAY_INIT_JS: &str = r#"(function () {
  var css = [
    'html,body,#root{background:transparent !important;background-color:transparent !important;}',
    'html,body{margin:0 !important;padding:0 !important;overflow:hidden !important;scrollbar-gutter:auto !important;}'
  ].join('\n');
  function inject() {
    if (document.querySelector('style[data-onethu-overlay]')) return;
    var el = document.createElement('style');
    el.setAttribute('data-onethu-overlay', '1');
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();"#;

// ── 形态 ────────────────────────────────────────────────────────────────────
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Hidden,
    Ball,
    Bar,
    Panel,
}

impl Mode {
    fn parse(raw: &str) -> Result<Mode, String> {
        match raw {
            "hidden" => Ok(Mode::Hidden),
            "ball" => Ok(Mode::Ball),
            "bar" => Ok(Mode::Bar),
            "panel" => Ok(Mode::Panel),
            other => Err(format!("未知悬浮球形态：{other}（只认 hidden/ball/bar/panel）")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Mode::Hidden => "hidden",
            Mode::Ball => "ball",
            Mode::Bar => "bar",
            Mode::Panel => "panel",
        }
    }
}

/// 一块屏（work area + 缩放），全部取自 tauri 的 Monitor（物理像素，与窗口物理坐标同一坐标系）
#[derive(Clone, Copy, Debug)]
struct Mon {
    wx: i32,
    wy: i32,
    ww: u32,
    wh: u32,
    scale: f64,
}

/// 一次落位：位置用物理像素（多屏拼合空间），尺寸用逻辑像素（= CSS px，Retina 不缩水）
#[derive(Clone, Copy, Debug)]
struct Geo {
    x: i32,
    y: i32,
    lw: f64,
    lh: f64,
}

struct State {
    mode: Mode,
    /// 球的落点（物理像素，窗口左上角）——松手位置就是这么记住的
    ball: Option<(i32, i32)>,
    /// Rust 侧可见性（IPC 失败时 `is_visible()` 不可靠，故自己记账）
    visible: bool,
    /// 面板视觉高度（逻辑 px，顶部把手拖出来的；None = 用 0.44 默认）
    panel_h: Option<f64>,
    /// 隐藏过 → 下次 show 前把 overlay 页刷回球态
    /// （页面自己停在 React 的 hidden 分支上，不会随窗口 show 自动回来）
    reload_pending: bool,
    last_persist: Option<Instant>,
    last_drag_emit: Option<Instant>,
}

static STATE: Mutex<State> = Mutex::new(State {
    mode: Mode::Hidden,
    ball: None,
    panel_h: None,
    visible: false,
    reload_pending: false,
    last_persist: None,
    last_drag_emit: None,
});

fn st() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(desktop)]
fn log(line: &str) {
    crate::debug_log_line(&format!("[OVERLAY] {line}"));
}

// ── 位置落盘（appData/state/overlay-pos.json；与 lib.rs 的 state_* 同目录同风格） ──
// 选 Rust 文件而不是 localStorage：① 首次建窗就要定位置，等前端加载完再挪会看到跳一下；
// ② 本仓注释已记录「WKWebView 的 localStorage 会被系统驱逐」，落盘才跨重启可靠。
#[cfg(desktop)]
#[derive(Serialize, Deserialize)]
struct SavedPos {
    x: i32,
    y: i32,
    #[serde(default)]
    scale: f64,
    /// 面板视觉高度（逻辑 px）：顶部把手拖出来的，下次打开沿用
    #[serde(default)]
    panel_h: Option<f64>,
}

#[cfg(desktop)]
fn pos_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("state");
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    Some(dir.join("overlay-pos.json"))
}

#[cfg(desktop)]
fn load_pos(app: &AppHandle) -> Option<(i32, i32)> {
    let raw = std::fs::read_to_string(pos_path(app)?).ok()?;
    let v: SavedPos = serde_json::from_str(&raw).ok()?;
    Some((v.x, v.y))
}

/// 读回面板高度（首次用到时懒加载进 State）
#[cfg(desktop)]
fn load_panel_h(app: &AppHandle) -> Option<f64> {
    let raw = std::fs::read_to_string(pos_path(app)?).ok()?;
    let v: SavedPos = serde_json::from_str(&raw).ok()?;
    v.panel_h.filter(|h| *h > 80.0)
}

/// 只更新面板高度（球位/缩放沿用内存里的现值）
#[cfg(desktop)]
fn save_panel_h(app: &AppHandle, h: f64) {
    let (x, y) = {
        let s = st();
        s.ball.unwrap_or((0, 0))
    };
    if let Some(p) = pos_path(app) {
        let body = serde_json::to_string(&SavedPos {
            x,
            y,
            scale: 1.0,
            panel_h: Some(h),
        })
        .unwrap_or_default();
        let _ = std::fs::write(p, body);
    }
}

#[cfg(desktop)]
fn save_pos(app: &AppHandle, x: i32, y: i32, scale: f64, force: bool) {
    {
        let mut s = st();
        if !force {
            let now = Instant::now();
            if let Some(t) = s.last_persist {
                if now.duration_since(t).as_millis() < PERSIST_MS {
                    return;
                }
            }
            s.last_persist = Some(now);
        } else {
            s.last_persist = Some(Instant::now());
        }
    }
    if let Some(p) = pos_path(app) {
        let panel_h = { st().panel_h };
        let body = serde_json::to_string(&SavedPos { x, y, scale, panel_h }).unwrap_or_default();
        if let Err(e) = std::fs::write(&p, body) {
            log(&format!("位置落盘失败：{e}"));
        }
    }
}

/// 面板高度口径的**唯一来源**（task-18：两处 30% 合并成一处，单位固定为逻辑 px）。
/// 返回 (最小, 最大, 默认)。
#[cfg(desktop)]
fn panel_limits(work_h_log: f64) -> (f64, f64, f64) {
    let min = (work_h_log * PANEL_MIN_RATIO).max(120.0);
    let max = (work_h_log * PANEL_MAX_RATIO).max(min + 1.0);
    (min, max, work_h_log * PANEL_RATIO)
}

// ── 显示器与几何 ────────────────────────────────────────────────────────────
#[cfg(desktop)]
fn mon_of(m: &tauri::Monitor) -> Mon {
    let scale = if m.scale_factor() > 0.0 { m.scale_factor() } else { 1.0 };
    let full = m.size();
    let wa = m.work_area();
    // 防御：个别驱动/work_area 缺失时 tauri 会给 0 或与屏尺寸差一个量级（坐标空间不一致），
    // 这种情况直接退回整屏矩形——宁可贴着 Dock/任务栏，也不要落到屏幕外。
    let sane = wa.size.width > 0
        && wa.size.height > 0
        && (wa.size.width as f64) < (full.width as f64) * 1.05
        && (wa.size.width as f64) > (full.width as f64) * 0.6
        && (wa.size.height as f64) > (full.height as f64) * 0.4;
    if sane {
        Mon {
            wx: wa.position.x,
            wy: wa.position.y,
            ww: wa.size.width,
            wh: wa.size.height,
            scale,
        }
    } else {
        Mon {
            wx: m.position().x,
            wy: m.position().y,
            ww: full.width,
            wh: full.height,
            scale,
        }
    }
}

#[cfg(desktop)]
fn point_in(m: Mon, x: i32, y: i32) -> bool {
    x >= m.wx && x < m.wx + m.ww as i32 && y >= m.wy && y < m.wy + m.wh as i32
}

/// 选屏：① 球当前所在屏 → ② 鼠标所在屏（多显示器取鼠标那块）→ ③ 主屏 → ④ 兜底
#[cfg(desktop)]
fn pick_monitor(win: &WebviewWindow, hint: Option<(i32, i32)>) -> Mon {
    let all: Vec<Mon> = win
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(mon_of)
        .collect();
    if let Some((x, y)) = hint {
        if let Some(m) = all.iter().copied().find(|m| point_in(*m, x, y)) {
            return m;
        }
    }
    if let Ok(c) = win.cursor_position() {
        let (cx, cy) = (c.x as i32, c.y as i32);
        if let Some(m) = all.iter().copied().find(|m| point_in(*m, cx, cy)) {
            return m;
        }
    }
    if let Ok(Some(p)) = win.primary_monitor() {
        return mon_of(&p);
    }
    all.first().copied().unwrap_or(Mon {
        wx: 0,
        wy: 0,
        ww: 1280,
        wh: 800,
        scale: 1.0,
    })
}

#[cfg(desktop)]
fn clamp_i(v: i32, lo: i32, hi: i32) -> i32 {
    if hi < lo {
        lo
    } else {
        v.max(lo).min(hi)
    }
}

/// 球心（物理像素）：给了落点就用落点，否则用该屏默认落点
#[cfg(desktop)]
fn ball_center(mon: Mon, ball: Option<(i32, i32)>) -> (i32, i32) {
    let (x, y) = ball.unwrap_or_else(|| default_ball(mon));
    let half = (BALL_BOX * mon.scale / 2.0).round() as i32;
    (x + half, y + half)
}

#[cfg(desktop)]
fn default_ball(mon: Mon) -> (i32, i32) {
    let d = (BALL_BOX * mon.scale).round() as i32;
    let right = (EDGE_RIGHT * mon.scale).round() as i32;
    let bottom = (EDGE_BOTTOM * mon.scale).round() as i32;
    (
        mon.wx + mon.ww as i32 - d - right,
        mon.wy + mon.wh as i32 - d - bottom,
    )
}

#[cfg(desktop)]
fn geo_for(mode: Mode, mon: Mon, ball: Option<(i32, i32)>) -> Geo {
    let s = mon.scale;
    match mode {
        Mode::Hidden | Mode::Ball => {
            let d = (BALL_BOX * s).round().max(1.0) as i32;
            let (x, y) = ball.unwrap_or_else(|| default_ball(mon));
            Geo {
                x: clamp_i(x, mon.wx, mon.wx + mon.ww as i32 - d),
                y: clamp_i(y, mon.wy, mon.wy + mon.wh as i32 - d),
                lw: BALL_BOX,
                lh: BALL_BOX,
            }
        }
        Mode::Bar => {
            // 全宽 × 176；竖向让**药丸中心落在球心**上（球原地横向展开，不跳到底部）
            let h = (BAR_H * s).round().max(1.0) as i32;
            let pill_half = ((BAR_PILL_GAP + BAR_PILL_H / 2.0) * s).round() as i32;
            let (_, cy) = ball_center(mon, ball);
            let y = clamp_i(cy - (h - pill_half), mon.wy, mon.wy + mon.wh as i32 - h);
            Geo {
                x: mon.wx,
                y,
                lw: (mon.ww as f64) / s,
                lh: BAR_H,
            }
        }
        Mode::Panel => {
            // 安卓 A①：左右/底部各留 14，高 = 屏高 × 0.44（顶部把手可改 30%~80%），圆角 24 前端画。
            // task-18 统一口径：**夹取/存储一律逻辑 px，只在最后一次性换算物理落位**；
            // 两处 30% 下限合并到 panel_limits()，杜绝「存进去又被另一处夹回最小」。
            let work_h_log = mon.wh as f64 / s;
            let work_w_log = mon.ww as f64 / s;
            let (min_l, max_l, def_l) = panel_limits(work_h_log);
            let v_log = { st().panel_h }.unwrap_or(def_l).clamp(min_l, max_l);
            let lw = (work_w_log - PANEL_MARGIN * 2.0 + PANEL_SHADOW_PAD * 2.0).max(160.0);
            let lh = v_log + PANEL_SHADOW_PAD * 2.0;
            Geo {
                x: mon.wx + ((PANEL_MARGIN - PANEL_SHADOW_PAD) * s).round() as i32,
                y: mon.wy + mon.wh as i32
                    - ((PANEL_MARGIN + v_log + PANEL_SHADOW_PAD) * s).round() as i32,
                lw,
                lh,
            }
        }
    }
}

/// 形态落位后回传几何：`x/y` = **球心相对本窗左上角的逻辑坐标**，`w/h` = 本窗逻辑尺寸。
/// 前端拿它当 `transform-origin`（球在哪，就从哪「滴落铺开」；球被拖到任何角落都对得上）。
/// 注：这是与 `drag`（窗口物理坐标）不同的语义，用独立 type 以免污染球位记忆。
#[cfg(desktop)]
fn emit_geometry(win: &WebviewWindow, mode: Mode, geo: Geo, ball: Option<(i32, i32)>) {
    let s = win.scale_factor().unwrap_or(1.0);
    let half = (BALL_BOX * s / 2.0).round() as i32;
    let (cx, cy) = match ball {
        Some((x, y)) => (x + half, y + half),
        None => (geo.x + half, geo.y + half),
    };
    let _ = win.emit(
        OVERLAY_EVENT,
        serde_json::json!({
            "type": "geometry",
            "mode": mode.as_str(),
            "x": ((cx - geo.x) as f64 / s).round(),
            "y": ((cy - geo.y) as f64 / s).round(),
            "w": geo.lw.round(),
            "h": geo.lh.round(),
        }),
    );
}

#[cfg(desktop)]
fn apply_geo(win: &WebviewWindow, g: Geo) -> Result<(), String> {
    // 尺寸用逻辑像素、位置用物理像素：tauri 的 Size/Position 两套类型别混。
    // task-18：把**实际调用值与返回值**都留证（「拖了等于没拖」必须能一眼看出是没调还是缩回去了）。
    log(&format!(
        "apply_geo: set_size(逻辑 {:.0}x{:.0}) set_position(物理 {},{})",
        g.lw, g.lh, g.x, g.y
    ));
    let rs = win.set_size(LogicalSize::new(g.lw, g.lh));
    let rp = win.set_position(PhysicalPosition::new(g.x, g.y));
    log(&format!(
        "apply_geo 返回: set_size={} set_position={}",
        if rs.is_ok() { "ok" } else { "err" },
        if rp.is_ok() { "ok" } else { "err" }
    ));
    rs.map_err(|e| format!("设置悬浮窗尺寸失败：{e}"))?;
    rp.map_err(|e| format!("设置悬浮窗位置失败：{e}"))?;
    Ok(())
}

// ── macOS：让「点击悬浮窗」不激活整个 app（红线级，2026-10-11 用户实测根因） ──
// 机理：tao 的 set_focusable(false) 只是把 TaoWindow 的 focusable ivar 置假，而它只被
// canBecomeKeyWindow / canBecomeMainWindow 读取 —— **拦不住 AppKit 在鼠标落下时激活 app**。
// app 一旦被激活，AppKit 需要挑一个能当 key 的窗口：悬浮窗不能，于是选中**主窗口**并置前
// ⇒ 用户看到的就是「无论怎么点悬浮窗都会回到 onethu 窗口」。
// 唯一有效的做法是 NSPanel 的 nonactivatingPanel 内部那招：`-[NSWindow _setPreventsActivation:]`。
// 私有 API，但先用 respondsToSelector 探针，符号不在（未来系统）就跳过并落日志，不会崩。
#[cfg(target_os = "macos")]
fn macos_prevent_activation(win: &WebviewWindow) {
    // overlay_show is async IPC. Raw AppKit mutations must not run on its Tokio
    // worker: macOS 26 traps in NSWMWindowCoordinator instead of returning an error.
    let target = win.clone();
    if let Err(error) = win.run_on_main_thread(move || macos_prevent_activation_on_main(&target)) {
        log(&format!("无法在主线程设置悬浮窗激活策略：{error}"));
    }
}

#[cfg(target_os = "macos")]
fn macos_prevent_activation_on_main(win: &WebviewWindow) {
    use objc2::runtime::{AnyObject, Bool};
    // 两处坑（都是 Android 交叉编译查不到的 macOS-only 分支，2026-10-11 用户跑 tauri:dev 炸的就是这里）：
    // ① ns_window() 定义在 `WebviewWindow` 上（不是 `Webview`，不要写 `as_ref().ns_window()`）；
    // ② 它返回 `Result<*mut c_void, tauri::Error>`，要先拆 Result 再判空。
    let ptr = match win.ns_window() {
        Ok(p) if !p.is_null() => p,
        _ => {
            log("拿不到 NSWindow，跳过 _setPreventsActivation（点击仍可能激活本体）");
            return;
        }
    };
    unsafe {
        let ns: &AnyObject = &*(ptr.cast::<AnyObject>());
        let responds: Bool = objc2::msg_send![
            ns,
            respondsToSelector: objc2::sel!(_setPreventsActivation:)
        ];
        if responds.as_bool() {
            let _: () = objc2::msg_send![ns, _setPreventsActivation: Bool::YES];
            log("已置 _setPreventsActivation=YES：点击悬浮窗不再激活 OneTHU，主窗口不会被带前");
        } else {
            log("此系统无 _setPreventsActivation: —— 点击悬浮窗仍会激活本体（需换 NSPanel 方案）");
        }
    }
}

#[cfg(all(desktop, not(target_os = "macos")))]
fn macos_prevent_activation(_win: &WebviewWindow) {}

/// 观测主窗口何时被激活（红线条取证：点悬浮窗后若出现这行，说明激活源还在）——只装一次
#[cfg(desktop)]
fn watch_main_activation(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static WATCHED: AtomicBool = AtomicBool::new(false);
    if WATCHED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    main.on_window_event(|ev| {
        if let tauri::WindowEvent::Focused(true) = ev {
            log("【取证件】主窗口成为 key —— 有东西 activate 了 OneTHU（点悬浮窗的任何非输入框操作都不该出现这行）");
        }
    });
}

// ── 建窗（懒创建、复用；label 固定 oh-orb，与 capabilities 对齐） ─────────────
// Windows WebView2 deadlocks if a synchronous IPC command creates a WebView.
// Keep every lazy-creation caller async, and serialize concurrent first opens.
#[cfg(desktop)]
static WINDOW_CREATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(desktop)]
async fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let _creating = WINDOW_CREATION.lock().await;
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        return Ok(w);
    }
    log("create start (async IPC)");
    let win = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App(OVERLAY_URL.into()))
        .title("OH")
        .inner_size(BALL_BOX, BALL_BOX)
        .position(0.0, 0.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .decorations(false)
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        // macOS：非 key 窗口也把第一次点击直接交给 webview（不激活 app）——不抢焦点的关键
        .accept_first_mouse(true)
        .focused(false)
        .visible(false)
        .initialization_script(OVERLAY_INIT_JS)
        .build()
        .map_err(|e| format!("创建悬浮窗失败：{e}"))?;
    // canBecomeKeyWindow/canBecomeMainWindow → false：窗口只置前、不当 key（tao 的 focusable ivar）
    if let Err(e) = win.set_focusable(false) {
        log(&format!("set_focusable 失败（不影响显示）：{e}"));
    }
    // ★红线级：点击本窗不得激活 app（否则主窗口会被 AppKit 挑成 key 并置前）
    macos_prevent_activation(&win);
    watch_main_activation(app);
    let ev_win = win.clone();
    let ev_app = app.clone();
    win.on_window_event(move |ev| match ev {
        tauri::WindowEvent::Moved(pos) => {
            let emit = {
                let mut s = st();
                if s.mode != Mode::Ball {
                    // 形态切换时的程序落位也会走这里，别把它当成「用户拖过球」
                    return;
                }
                s.ball = Some((pos.x, pos.y));
                let now = Instant::now();
                let due = match s.last_drag_emit {
                    Some(t) => now.duration_since(t).as_millis() >= DRAG_EMIT_MS,
                    None => true,
                };
                if due {
                    s.last_drag_emit = Some(now);
                }
                due
            };
            if emit {
                let _ = ev_win.emit(
                    OVERLAY_EVENT,
                    serde_json::json!({ "type": "drag", "x": pos.x, "y": pos.y }),
                );
            }
            let scale = ev_win.scale_factor().unwrap_or(1.0);
            save_pos(&ev_app, pos.x, pos.y, scale, false);
        }
        tauri::WindowEvent::Focused(true) => {
            log("悬浮窗成为 key（只有用户点面板输入框时才该出现；其他时候出现=焦点被抢）");
        }
        tauri::WindowEvent::Destroyed => {
            let mut s = st();
            s.mode = Mode::Hidden;
            s.visible = false;
            s.ball = None;
            log("悬浮窗已销毁（下次 overlay_show 会重建）");
        }
        _ => {}
    });
    log(&format!(
        "悬浮窗已创建：label={OVERLAY_LABEL} url={OVERLAY_URL} 初始 {BALL_BOX}x{BALL_BOX} 逻辑 px（球 {BALL_VISUAL} + 留白 {BALL_PAD}×2）"
    ));
    Ok(win)
}

// ── 命令 ────────────────────────────────────────────────────────────────────

/// 「后台常驻」是否允许桌面悬浮球出场。
///
/// 2026-10-23（后台常驻二选一）：托盘档下悬浮球整个不参与——设置页不会显示球开关，前端启动
/// 也不会调 `overlay_show`；这里再拦一道，旧前端、插件、残留调用都带不回球来。判据是档位，
/// 不是「托盘图标在不在」：托盘建失败时仍是托盘档，此时冒出球会让人以为档位没生效。
#[cfg(desktop)]
fn orb_allowed() -> bool {
    crate::desktop_keepalive::mode() != crate::desktop_lifecycle::KeepAlive::Tray
}

/// 该平台是否支持系统级悬浮球（桌面 = true；Android/iOS = false，安卓走 onethu-overlay 插件）
#[tauri::command]
pub fn overlay_supported() -> bool {
    cfg!(desktop)
}

/// 显示球（用户在本体 OH 对话界面点「打开悬浮球」时调；不激活主窗口、不抢焦点）
#[tauri::command]
pub async fn overlay_show(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if !orb_allowed() {
            log("托盘保活档：不创建悬浮球（overlay_show 已忽略）");
            return Ok(());
        }
        let win = ensure_window(&app).await?;
        let reload = {
            let mut s = st();
            let r = s.reload_pending;
            s.reload_pending = false;
            r
        };
        if reload {
            // 页面停在 React 的 hidden 分支（需求 5「本次关闭悬浮球」）→ 先刷回球态再显形；
            // 窗口是透明的，刷页面期间看不见任何残影。
            let _ = win.eval("location.reload()");
        }
        let ball = { st().ball }.or_else(|| load_pos(&app));
        let need_panel_h = { st().panel_h.is_none() };
        if need_panel_h {
            let h = load_panel_h(&app);
            st().panel_h = h;
        }
        let mon = pick_monitor(&win, ball);
        let geo = geo_for(Mode::Ball, mon, ball);
        {
            let mut s = st();
            s.mode = Mode::Ball;
            s.visible = true;
        }
        apply_geo(&win, geo)?;
        let _ = win.set_always_on_top(true);
        macos_prevent_activation(&win); // 幂等：重建/系统升级后都保证这条不丢
        if !win.is_visible().unwrap_or(false) {
            win.show().map_err(|e| format!("显示悬浮窗失败：{e}"))?;
        }
        emit_geometry(&win, Mode::Ball, geo, ball);
        log(&format!(
            "show ball @({},{}) {}x{} 逻辑 scale={} reload={}",
            geo.x, geo.y, geo.lw, geo.lh, mon.scale, reload
        ));
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("桌面悬浮球仅桌面端支持（安卓走 onethu-overlay 插件）".into())
    }
}

/// 本次关闭：隐藏窗口 + 发 `closed`（与 lib/overlay.ts 的「本次关闭」标记语义一致）。
/// 幂等——已隐藏时直接返回，避免 closed → hide → closed 自激。
#[tauri::command]
pub fn overlay_hide(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
            return Ok(());
        };
        let was_visible = {
            let mut s = st();
            let v = s.visible || win.is_visible().unwrap_or(false);
            s.visible = false;
            s.mode = Mode::Hidden;
            s.reload_pending = true;
            v
        };
        if !was_visible {
            return Ok(());
        }
        let ball = { st().ball };
        if let Some((x, y)) = ball {
            let scale = win.scale_factor().unwrap_or(1.0);
            save_pos(&app, x, y, scale, true);
        }
        win.hide().map_err(|e| format!("隐藏悬浮窗失败：{e}"))?;
        let _ = win.emit(OVERLAY_EVENT, serde_json::json!({ "type": "closed" }));
        log("hide（本次关闭）");
        crate::desktop_lifecycle::overlay_hidden(&app);
        // 隐藏态下把页面刷回球态：下次 overlay_show 立刻可用（否则页面卡在 hidden 分支，
        // 窗口虽显示但什么都不渲染）。若期间又被 show 回来就放弃这次刷新。
        let w2 = win.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(180)).await;
            let still_hidden = { !st().visible };
            if still_hidden {
                let _ = w2.eval("location.reload()");
            }
        });
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("桌面悬浮球仅桌面端支持".into())
    }
}

/// 切形态：ball（球）/ bar（语音条）/ panel（半屏对话面）/ hidden（= 本次关闭）
#[tauri::command]
pub async fn overlay_set_mode(app: AppHandle, mode: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        // 兼容写法 `panel:<逻辑高度>`：把手改高度走这条时，**即使专用命令没注册也能工作**
        // （2026-10-11 用户实测就是 `Command overlay_set_panel_height not found`——旧包没注册）。
        let (mode, inline_h) = match mode.split_once(':') {
            Some(("panel", h)) => ("panel".to_string(), h.trim().parse::<f64>().ok()),
            _ => (mode, None),
        };
        let m = Mode::parse(&mode)?;
        if m == Mode::Hidden {
            return overlay_hide(app);
        }
        if !orb_allowed() {
            log(&format!("托盘保活档：忽略切形态 {mode}（不创建悬浮球）"));
            return Ok(());
        }
        let win = ensure_window(&app).await?;
        let ball = { st().ball }.or_else(|| load_pos(&app));
        if let Some(h) = inline_h {
            let mon2 = pick_monitor(&win, ball);
            let (min_l, max_l, _) = panel_limits(mon2.wh as f64 / mon2.scale);
            let want = h.clamp(min_l, max_l);
            st().panel_h = Some(want);
            save_panel_h(&app, want);
            log(&format!("set_mode(panel:{h:.0}) 兼容路径 → panel_h={want:.0}"));
        } else {
            let need_panel_h = { st().panel_h.is_none() };
            if need_panel_h {
                let h = load_panel_h(&app);
                st().panel_h = h;
            }
        }
        let mon = pick_monitor(&win, ball);
        let geo = geo_for(m, mon, ball);
        {
            let mut s = st();
            s.mode = m;
            s.visible = true;
            s.reload_pending = false;
        }
        apply_geo(&win, geo)?;
        let _ = win.set_always_on_top(true);
        if let Some((x, y)) = ball {
            let scale = win.scale_factor().unwrap_or(1.0);
            save_pos(&app, x, y, scale, true);
        }
        if !win.is_visible().unwrap_or(false) {
            win.show().map_err(|e| format!("显示悬浮窗失败：{e}"))?;
        }
        emit_geometry(&win, m, geo, ball);
        log(&format!(
            "set_mode {} @({},{}) {}x{} 逻辑",
            m.as_str(),
            geo.x,
            geo.y,
            geo.lw,
            geo.lh
        ));
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (&app, &mode);
        Err("桌面悬浮球仅桌面端支持".into())
    }
}

/// 顶部把手拖动改面板高度（参数 = **视觉块**的逻辑 px）。
/// Rust 侧权威夹取到屏高 30%~80%，立刻改窗 + 落盘（下次打开沿用），并回传新 geometry。
#[tauri::command]
pub async fn overlay_set_panel_height(app: AppHandle, h: f64) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let win = ensure_window(&app).await?;
        let ball = { st().ball }.or_else(|| load_pos(&app));
        let mon = pick_monitor(&win, ball);
        let work_h_log = mon.wh as f64 / mon.scale;
        let (min_l, max_l, _) = panel_limits(work_h_log);
        let want = h.clamp(min_l, max_l);
        st().panel_h = Some(want);
        log(&format!(
            "panel_set_height: 入参 h={h:.1} → want={want:.1}（min={min_l:.1} max={max_l:.1} work_h_log={work_h_log:.1} scale={:.1}）",
            mon.scale
        ));
        let geo = geo_for(Mode::Panel, mon, ball);
        let (lw, lh) = (geo.lw, geo.lh);
        apply_geo(&win, geo)?;
        save_panel_h(&app, want);
        emit_geometry(&win, Mode::Panel, geo, ball);
        log(&format!("panel_set_height 生效: 窗口逻辑 {lw:.0}x{lh:.0}（视觉块 {want:.0} + 阴影留白 {:.0}）", PANEL_SHADOW_PAD * 2.0));
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (&app, h);
        Err("桌面悬浮球仅桌面端支持".into())
    }
}

/// 把悬浮窗移到屏幕绝对位置（物理像素，与 OverlayEvent.x/y 同一坐标系）——JS 拖动兜底通道
#[tauri::command]
pub async fn overlay_move(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let win = ensure_window(&app).await?;
        let pos = PhysicalPosition::new(x.round() as i32, y.round() as i32);
        win.set_position(pos)
            .map_err(|e| format!("移动悬浮窗失败：{e}"))?;
        note_ball(&app, &win, pos);
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (&app, x, y);
        Err("桌面悬浮球仅桌面端支持".into())
    }
}

/// 相对移动（逻辑 px 增量）——JS 拖动兜底用，避免把 CSS 屏幕坐标硬换算成物理像素
#[tauri::command]
pub async fn overlay_nudge(app: AppHandle, dx: f64, dy: f64) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let win = ensure_window(&app).await?;
        let cur = win
            .outer_position()
            .map_err(|e| format!("读取悬浮窗位置失败：{e}"))?;
        let scale = win.scale_factor().unwrap_or(1.0);
        let pos = PhysicalPosition::new(
            cur.x + (dx * scale).round() as i32,
            cur.y + (dy * scale).round() as i32,
        );
        win.set_position(pos)
            .map_err(|e| format!("移动悬浮窗失败：{e}"))?;
        note_ball(&app, &win, pos);
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (&app, dx, dy);
        Err("桌面悬浮球仅桌面端支持".into())
    }
}

/// 记球位 + 落盘（ball 态才记；形态切换的程序移动不算）
#[cfg(desktop)]
fn note_ball(app: &AppHandle, win: &WebviewWindow, pos: PhysicalPosition<i32>) {
    let recording = {
        let mut s = st();
        if s.mode != Mode::Ball {
            false
        } else {
            s.ball = Some((pos.x, pos.y));
            true
        }
    };
    if !recording {
        return;
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    save_pos(app, pos.x, pos.y, scale, false);
}

/// 原生窗口拖动（macOS = performWindowDragWithEvent，必须在主线程、且紧跟用户鼠标事件）。
/// **必须是同步命令**：Tauri v2 的同步命令跑主线程，异步命令跑线程池——放异步里会读到
/// 错误的 currentEvent，拖不起来。
#[tauri::command]
pub fn overlay_drag_start(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        // Dragging needs the current native mouse event, so keep this command
        // synchronous, but never create a WebView here (Windows deadlock).
        let win = app.get_webview_window(OVERLAY_LABEL)
            .ok_or("悬浮窗尚未打开")?;
        log("drag_start：交给原生开始拖窗（拖不动时前端会自动退 nudge 兜底）");
        win.start_dragging()
            .map_err(|e| format!("启动窗口拖动失败：{e}"))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("桌面悬浮球仅桌面端支持".into())
    }
}

/// 「回到 OneTHU」：把主窗口带前台的**唯一**入口，只在用户点面板顶栏那个按钮时调用。
/// 红线没有破：这里是**用户显式动作**，不是任何自动路径（自动路径一律不碰 main）。
#[tauri::command]
pub fn overlay_back_to_main(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        crate::desktop_lifecycle::activate_main(&app)?;
        log("back_to_main：用户点了「回到 OneTHU」");
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("桌面悬浮球仅桌面端支持".into())
    }
}

/// **唯一允许抢焦点的入口**：用户点面板输入框 → `on=true`；输入框失焦 → `on=false`。
/// 前端（overlayDesktop.ts）只在悬浮窗里监听 input/textarea 的 focusin/focusout 时调用，
/// 任何其他路径（show/hide/set_mode/拖动）都不碰 focus。
#[tauri::command]
pub fn overlay_focus(app: AppHandle, on: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
            return Ok(());
        };
        if on {
            let _ = win.set_focusable(true);
            win.set_focus()
                .map_err(|e| format!("聚焦悬浮窗失败：{e}"))?;
            log("focus(on)：用户点了面板输入框 —— 这是唯一会 activate 本体的路径（其余点击靠 _setPreventsActivation 拦住）");
        } else {
            let _ = win.set_focusable(false);
        }
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (&app, on);
        Err("桌面悬浮球仅桌面端支持".into())
    }
}
