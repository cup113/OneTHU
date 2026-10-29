/**
 * 版本比较的行为护栏（`apps/desktop/src/lib/update.ts` 的 `isNewer`）。
 *
 * 背景：分叉包的版本形如 `0.11.3-N`（Windows MSI 只接受纯数字预发布段），而原来的比较只取
 * 前三段数字，于是 `0.11.3-2` 与 `0.11.3-1` 相等——下一次分叉发版时更新检查会把新版本判成
 * 「不更新」，静默失效且没有任何报错。这条护栏钉住三点：
 *   [1] 数字预发布段参与比较（分叉两次发版之间能升上去）；
 *   [2] 基线升级仍然有效（0.11.2-N → 0.11.3-M）；
 *   [3] 非数字预发布段（`-beta`）保持旧行为，不改变上游语义。
 *
 * 跑法：node --import ./tools/ts-resolve-register.mjs tools/update-version-order-test.mjs
 * （update.ts 以 `.js` 后缀引用同目录模块，需要那条解析回退）
 */
import assert from "node:assert/strict";

// update.ts 顶层读构建期注入的 __APP_VERSION__；裸标识符会回落到 globalThis
globalThis.__APP_VERSION__ = "0.11.3-1";
const { isNewer } = await import("../apps/desktop/src/lib/update.ts");

/* [1] 数字预发布段参与比较：这是分叉第二次发版的升级路径 */
assert.equal(isNewer("0.11.3-2", "0.11.3-1"), true, "0.11.3-2 必须比 0.11.3-1 新（否则分叉发版后无人收到更新）");
assert.equal(isNewer("0.11.3-1", "0.11.3-2"), false, "旧的分叉版本不能盖过新的");

/* [2] 基线升级 */
assert.equal(isNewer("0.11.3-1", "0.11.2-1"), true, "上游小版本前进后必须算更新");
assert.equal(isNewer("0.11.4-1", "0.11.3-9"), true, "小版本优先于预发布段的序号");

/* 同号同段不重复提示 */
assert.equal(isNewer("0.11.3-1", "0.11.3-1"), false, "同号不算更新");
assert.equal(isNewer("0.11.3", "0.11.3"), false, "同号不算更新（正式版）");

/* 正式版与它自己的分叉构建：0.11.3-1 高于 0.11.3，这是刻意接受的取舍 */
assert.equal(isNewer("0.11.3-1", "0.11.3"), true, "分叉构建号高于同基线的正式版");

/* [3] 非数字预发布保持旧行为：`-beta` 进不了元组，因此不等于「更新」 */
assert.equal(isNewer("0.9.1-beta", "0.9.1"), false, "非数字预发布维持旧语义");
assert.equal(isNewer("0.9.1", "0.9.1-beta"), false, "非数字预发布维持旧语义");

/* 常规路径不回归 */
assert.equal(isNewer("v0.10.1", "0.9.9"), true, "v 前缀仍要能解析");
assert.equal(isNewer("0.10.0", "0.10.0"), false, "同版本不算更新");

console.log("版本比较：数字预发布段参与比较 ✓ / 基线升级 ✓ / 非数字预发布维持旧语义 ✓");
