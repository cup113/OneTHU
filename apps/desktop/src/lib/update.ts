/** Build version and comparison shared by automatic reminders and the updater. */
export { dismissTag, isDismissed } from "./updateReminder.js";

/** 版本代号（随主版本更新） */
export const APP_CODENAME = "Revolution";
declare const __APP_VERSION__: string;

/** 关于页与构建元数据共用 package.json 注入的版本。 */
export const APP_VERSION_LABEL = __APP_VERSION__;

/** "v0.9.1"/"0.9.1-beta" → [0,9,1]；数字预发布段（"0.11.3-2" → [0,11,3,2]）参与比较。
 *
 * 为什么要把第四段带进来：分叉包的版本形如 `0.11.3-N`（Windows MSI 只接受纯数字预发布段），
 * 只比前三段的话 `0.11.3-2` 与 `0.11.3-1` 相等，更新检查会把新版本判成「不更新」而静默失效。
 * 非数字预发布（`-beta`）仍是 NaN，不进元组，与旧行为一致。 */
function toTuple(v: string): number[] {
  const parts = v.replace(/^[vV]/, "").split(/[.\-+]/);
  const tuple = parts
    .slice(0, 3)
    .map((x) => parseInt(x, 10) || 0);
  const prerelease = parseInt(parts[3] ?? "", 10);
  if (Number.isFinite(prerelease)) tuple.push(prerelease);
  return tuple;
}

export function isNewer(latest: string, current: string): boolean {
  const a = toTuple(latest);
  const b = toTuple(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** 当前应用版本（构建期由 package.json 注入） */
export function currentVersion(): string {
  return __APP_VERSION__;
}
