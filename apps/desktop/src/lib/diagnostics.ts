/** 一键诊断摘要（2026-09-23，#42 取证口径）。
 *
 * 为什么单独做这个：运行日志里有学号、姓名、课程数据，用户不愿意交（这是对的），
 * 但「会话已失效」这类问题没有现场就只能猜。这里只取判断故障所需的那几件事——
 * 版本、运行环境、登录状态、回页种类、页面长度——学号、姓名、票据一律遮蔽或根本
 * 不取。用户点一下复制，粘到反馈里即可。
 */

import { APP_CODENAME } from "./update.js";
import { isAndroidNavigator } from "./androidHost.js";
import { isTauri, lastAuthEntryText, loadRemembered, learn, session } from "./clients.js";
import { lastErrorText } from "./transport.js";
import { redactNetworkLog } from "./networkLog.js";

declare const __APP_VERSION__: string;

/** 学号/课程号等长数字、票据值、邮箱一律遮蔽——摘要要能公开贴出来。 */
export function redactDiagnostics(text: string): string {
  return redactNetworkLog(String(text ?? ""))
    .replace(/(_csrf|JSESSIONID|XSRF-TOKEN|ticket|wengine_vpn_ticket)=[^&\s;"']+/gi, "$1=***")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "***@***")
    .replace(/\b\d{7,}\b/g, (m) => `${m.slice(0, 3)}${"*".repeat(m.length - 3)}`);
}

function hostLabel(): string {
  if (!isTauri) return "浏览器预览";
  return isAndroidNavigator(navigator) ? "Android" : "桌面";
}

function oneLine(s: string, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : "-";
}

/** 应用数据目录能否真正落盘：写一个一次性 key 再读回。
 *  现场（2026-10-23）：日志、同意协议、状态文件同时静默丢失，需要摘要里有一行自证结论。 */
async function persistenceProbe(): Promise<string> {
  if (!isTauri) return "-";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const token = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await invoke("state_write", { name: "__diag_probe", content: JSON.stringify({ token }) });
    const back = await invoke<string | null>("state_read", { name: "__diag_probe" });
    const ok = typeof back === "string" && back.includes(token);
    await Promise.resolve(invoke("state_delete", { name: "__diag_probe" })).catch(() => undefined);
    return ok ? "ok" : "读回不一致";
  } catch (e) {
    return `失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 上次系统日历同步的现场（原生侧落盘的面包屑）。
 *
 *  为什么放在摘要里：鸿蒙兼容层上 adb 拿不到通道，进程级死亡后 logcat 也带不走；
 *  原生侧把每一步 provider 调用落盘 + fsync，这里是唯一能把它读出来、并让用户一键贴出的路。
 *  末行就是死亡边界——例如只有 `clear.start` 没有 `clear.done`，即死在删除调用里。 */
async function calendarSyncTrace(): Promise<string> {
  if (!isTauri) return "-";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = await invoke<string>("plugin:onethu-calendar|sync_trace");
    const lines = String(text ?? "").trim().split("\n").filter(Boolean);
    if (!lines.length) return "无记录";
    return lines.slice(-16).join(" ⏎ ");
  } catch (e) {
    return `读取失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 摘要正文（纯文本，可直接粘贴到反馈里）。 */
export async function buildDiagnostics(): Promise<string> {
  const remembered = await loadRemembered().catch(() => null);
  const rows: Array<[string, string]> = [
    ["版本", `OneTHU ${__APP_VERSION__} “${APP_CODENAME}”`],
    ["环境", `${hostLabel()} · ${navigator.userAgent.slice(0, 90)}`],
    ["时间", new Date().toISOString()],
    ["本机写盘", await persistenceProbe()],
    ["日历同步", await calendarSyncTrace()],
    ["登录状态", `${session.state} · 已保存密码 ${remembered ? "是" : "否"}`],
    ["学习会话", learn.lastCsrfDebug || "本次运行没有取过"],
    ["登录入口", oneLine(lastAuthEntryText(), 160) || "-"],
    ["课程页", oneLine(learn.lastDebug, 200)],
    ["学习响应", oneLine(learn.lastResponseDebug, 140)],
    ["分组页", oneLine(learn.lastGroupsDebug, 140)],
    ["讨论区", oneLine(learn.lastBbsThreadDebug, 140)],
    ["详情页", oneLine(learn.lastPageDetailDebug, 140)],
    ["最近报错", oneLine(lastErrorText(), 200)],
  ];
  return redactDiagnostics(rows.map(([k, v]) => `${k}：${v}`).join("\n"));
}
