/** Build version and comparison shared by automatic reminders and the updater. */
export { dismissTag, isDismissed } from "./updateReminder.js";

/** 版本代号（随主版本更新） */
export const APP_CODENAME = "Revolution";
declare const __APP_VERSION__: string;

/** 关于页与构建元数据共用 package.json 注入的版本。 */
export const APP_VERSION_LABEL = __APP_VERSION__;

/** "v0.9.1"/"0.9.1-beta" → [0,9,1,**0**]；第四段同时承载上游热修段与分叉序号。
 *
 * 上游的稳定热修形如 `0.11.4-fix-1`（排在本版之后、下一个补丁之前）；
 * 分叉包的版本形如 `0.11.3-N`（Windows MSI 只接受纯数字预发布段）。
 * 两者都是第四段：只比前三段的话 `0.11.3-2` 与 `0.11.3-1` 相等，更新检查会把新版本
 * 判成「不更新」而静默失效。非数字预发布（`-beta`）仍是 0，与旧行为一致。 */
function toTuple(v: string): number[] {
  const base = v
    .replace(/^[vV]/, "")
    .split(/[.\-+]/)
    .slice(0, 3)
    .map((x) => parseInt(x, 10) || 0);
  const tail = /^v?\d+\.\d+\.\d+-(?:fix-)?(\d+)$/i.exec(v)?.[1];
  return [...base, tail ? Number(tail) : 0];
}

export function isNewer(latest: string, current: string): boolean {
  const a = toTuple(latest);
  const b = toTuple(current);
  for (let i = 0; i < 4; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** 当前应用版本（构建期由 package.json 注入） */
export function currentVersion(): string {
  return __APP_VERSION__;
}
