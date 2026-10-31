#!/usr/bin/env node
/**
 * 学习会话 403 的自愈回归（2026-10-30 日志实录形状的钉子）。
 *
 * 实录：学习域会话过期后，`getCurrentAndNextSemester` 恒回 HTTP 403（6 天 363 次，
 * 全部集中在该端点），而同一条网关票上的 info/card 仍是 200（死的只是学习域自己
 * 那份会话）。客户端把 403 当普通错误上抛，界面只能显示「重试」，而重试拿的还是
 * 同一份死会话与旧 `_csrf`，于是永远 403；只有硬刷新（整页重载 → 新客户端 →
 * `_csrf` 为空）才重新建链。
 *
 * 这里钉住五件事：
 *   ① 403 → 静默重建一次 → 用新 `_csrf` 重放，成功；
 *   ② 重建失败 → 抛会话错误，且旧凭据已作废（下一次「重试」会重新建链）；
 *   ③ 并发里**晚到**的旧请求 403 不能作废别人刚重建好的新凭据（复审 finding 1）；
 *   ④ 取凭据页（启动探活）上的 403 仍按服务失败上抛——启动链走静默重登兜底；
 *   ⑤ 非会话的状态码（500）不得被误判成掉线（不重登、不丢凭据）。
 * 运行：node --import ./tools/ts-resolve-register.mjs tools/learn-session-recovery-test.mjs
 */
import assert from "node:assert/strict";
import { HttpClient } from "../packages/core/src/http.ts";
import { LearnClient } from "../packages/core/src/learn/client.ts";
import { LEARN_COURSE_LIST_PAGE, LEARN_CURRENT_SEMESTER } from "../packages/core/src/learn/urls.ts";

let checks = 0;
const test = async (name, fn) => { await fn(); checks++; console.log(`✓ ${name}`); };

const COURSE_PAGE = new URL(LEARN_COURSE_LIST_PAGE()).pathname;
const SEMESTER = new URL(LEARN_CURRENT_SEMESTER()).pathname;
const CSRF_PAGE = '<html><body><form><input type="hidden" name="_csrf" value="fresh-token"></form></body></html>';
const semesterJson = () => new Response(JSON.stringify({ result: { id: "2026-2027-1" } }), { status: 200, headers: { "content-type": "application/json" } });

/** 替身学习域：alive=false 时学习会话已死（读接口回 403、取凭据页也回 403）。 */
function fixture({ alive = false, httpStatus = 0, hookWorks = true } = {}) {
  const state = { alive, httpStatus, hookWorks, relogins: 0, csrfSeen: [], coursePageCalls: 0 };
  const fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === COURSE_PAGE) {
      state.coursePageCalls++;
      return state.alive
        ? new Response(CSRF_PAGE, { status: 200, headers: { "content-type": "text/html" } })
        : new Response("forbidden", { status: 403 });
    }
    if (u.pathname === SEMESTER) {
      state.csrfSeen.push(u.searchParams.get("_csrf"));
      if (state.httpStatus) return new Response("boom", { status: state.httpStatus });
      return state.alive ? semesterJson() : new Response("forbidden", { status: 403 });
    }
    return new Response("not found", { status: 404 });
  };
  const client = new LearnClient(new HttpClient({ fetch }));
  client.reloginHook = async () => {
    state.relogins++;
    if (!state.hookWorks) return false;
    state.alive = true;
    return true;
  };
  return { state, client };
}

await test("读到 HTTP 403 时重建一次会话，并用新凭据重放", async () => {
  const { state, client } = fixture();
  client.applyCsrf("stale-token");
  const semester = await client.getCurrentSemester();
  assert.equal(semester.id, "2026-2027-1");
  assert.equal(state.relogins, 1, "静默重建恰好一次，不能每个课程各登一次");
  assert.deepEqual(state.csrfSeen, ["stale-token", "fresh-token"], "先用旧凭据撞 403，再用重建后的新凭据重放一次");
  assert.equal(client.csrfToken, "fresh-token", "重建后的凭据要留在客户端上，别让下一次入口再撞旧值");
});

await test("重建也失败时抛会话错误，并作废旧凭据（下一次重试能重新建链）", async () => {
  const { state, client } = fixture({ hookWorks: false });
  client.applyCsrf("stale-token");
  await assert.rejects(() => client.getCurrentSemester(), (e) => e?.name === "AuthRequiredError");
  assert.equal(state.relogins, 1);
  assert.equal(client.csrfToken, null, "死凭据必须作废：留着它，用户点几次「重试」就撞几次同一个 403");

  // 会话恢复后，用户再点一次「重试」就该好——不需要整页重载
  state.hookWorks = true;
  const semester = await client.getCurrentSemester();
  assert.equal(semester.id, "2026-2027-1");
  assert.equal(state.relogins, 2);
  assert.deepEqual(state.csrfSeen, ["stale-token", "fresh-token"]);
});

await test("并发里晚到的旧请求 403 不作废别人重建好的新凭据", async () => {
  // A、B 同时拿同一份旧凭据发请求；A 的 403 先回并触发重建，A 重放成功之后，
  // B 那条**在重建之前就发出**的请求才回 403。此时 B 手里的凭据已不是当前那份。
  let releaseB;
  const bGate = new Promise((resolve) => { releaseB = resolve; });
  const state = { alive: false, relogins: 0, csrfSeen: [] };
  const fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === COURSE_PAGE) {
      return state.alive
        ? new Response(CSRF_PAGE, { status: 200, headers: { "content-type": "text/html" } })
        : new Response("forbidden", { status: 403 });
    }
    if (u.pathname === SEMESTER) {
      const token = u.searchParams.get("_csrf");
      state.csrfSeen.push(token);
      if (token === "fresh-token") {
        setTimeout(releaseB, 25); // A 的重放成功后再放行 B 的晚到 403
        return semesterJson();
      }
      if (state.csrfSeen.filter((t) => t === "stale-token").length === 1) {
        return new Response("forbidden", { status: 403 });
      }
      await bGate;
      return new Response("forbidden", { status: 403 });
    }
    return new Response("not found", { status: 404 });
  };
  const client = new LearnClient(new HttpClient({ fetch }));
  client.reloginHook = async () => { state.relogins++; await new Promise((r) => setTimeout(r, 10)); state.alive = true; return true; };
  client.applyCsrf("stale-token");

  const [a, b] = await Promise.allSettled([client.getCurrentSemester(), client.getCurrentSemester()]);
  assert.equal(a.status, "fulfilled", "A 应先自愈成功");
  assert.equal(b.status, "fulfilled", "B 的晚到 403 必须用新凭据重试成功，而不是变成假会话失效");
  assert.equal(client.csrfToken, "fresh-token", "刚重建好的新凭据不能被旧请求的 403 清掉");
  assert.equal(state.relogins, 1, "整轮只重建一次，不能因为晚到 403 再登一次");
});

await test("取凭据页上的 403 仍是服务失败：丢给启动链静默重登，不在这里空转", async () => {
  const { state, client } = fixture();
  await assert.rejects(() => client.resume(), /HTTP 403/);
  assert.equal(state.relogins, 0);
  assert.equal(state.coursePageCalls, 1, "只打一次取凭据页；启动探活按失败收口");
  assert.equal(client.csrfToken, null);
});

await test("服务器 5xx 不被误判成掉线：不重登、不丢凭据", async () => {
  const { state, client } = fixture({ httpStatus: 500 });
  client.applyCsrf("stale-token");
  await assert.rejects(() => client.getCurrentSemester(), /HTTP 500/);
  assert.equal(state.relogins, 0);
  assert.equal(client.csrfToken, "stale-token");
});

console.log(`learn-session-recovery-test: ${checks} groups passed`);
