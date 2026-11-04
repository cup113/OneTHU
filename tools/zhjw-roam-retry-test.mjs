#!/usr/bin/env node
/**
 * 教务域局部自愈的回归钉子（2026-11-03 线上实录）。
 *
 * 现场：某一刻门户/学堂全 200，只有教务 `jxmh_out.do` 302 → `timeout.jsp`，
 * 「今日课程」静默失败（卡片有旧数据，不显示错误条）。根因不是整条会话死，
 * 而是教务域会话单独死：#zhjwRoamed 是一次性旗标，只有「全局重登成功」才清零，
 * 而续约者在 30s 冷却里直接返回 false —— #withRenew 把「没去试」当成「试了没用」，
 * 于是不重漫游、不重试、直接放弃。
 *
 * 钉住六件事：
 *   ① 教务撞死会话 → 就地重漫游一次并重试（不依赖门户判活，也不依赖重登）
 *   ② 会话健康时不额外漫游（每次取数只漫游一次）
 *   ③ 只对「未登录」证据重试——服务端 5xx 之类不得触发重漫游
 *   ④ 重漫游自己也救不回来时，有界失败，不循环
 *   ⑤ 考试的 timeout.jsp 与课表同形，同样要重漫游后重试
 *   ⑥ 并发取数共享一条漫游链（#ensureZhjw 单飞）
 *
 * 运行：node --import ./tools/ts-resolve-register.mjs tools/zhjw-roam-retry-test.mjs
 */
import assert from "node:assert/strict";
import { InfoClient } from "../packages/core/src/info/client.ts";

const LANDING = "https://webvpn.example/https/x/f/info/portal/index";
const PORTAL_OK = "<html><body>信息门户</body></html>";
/** 教务超时页：getSchedule 的分类正则认 jsp.timeout，与线上 len=1187 的页面同判据 */
const ZHJW_TIMEOUT = "<html><script>location.replace('/timeout.jsp')</script>jsp.timeout</html>";
const ZHJW_OK = `m(${JSON.stringify([
  { nq: "2026-11-03", nr: "数学分析", dd: "三教1101", fl: "本科", kssj: "08:00", jssj: "09:35", JC: "1-2", XQ: "2" },
])})`;
const EXAM_OK = `m(${JSON.stringify([
  { nq: "2026-11-10", nr: "数学分析", dd: "三教1101", fl: "考试", kssj: "08:00", jssj: "10:00" },
])})`;

/**
 * 替身取数：只覆盖 getSchedule 真正会走的四个端点（取 cookie / 门户漫游 / 漫游落地 / 课表 JSONP）。
 * scheduleReply / landingReply 都按第 n 次调用决策，便于构造「第一次就死、漫游之后才活」。
 */
function harness({ scheduleReply, landingReply = () => PORTAL_OK }) {
  const calls = { schedule: 0, roam: 0, landing: 0 };
  const jar = {
    getCookies: () => [{ name: "XSRF-TOKEN", value: "tok", path: "/" }],
    setRaw: () => undefined,
  };
  const http = {
    jar,
    nativeSeedHook: undefined,
    lastTarget: "",
    lastDebug: "",
    lastFinalUrl: "",
    wengineInterstitial: (t) => String(t).includes("__vpn_hostname_data"),
    request: async () => ({ ok: true, headers: { get: () => null }, text: async () => "" }),
    text: async (url) => {
      const u = String(url);
      if (u.includes("onlineAppRedirect")) {
        calls.roam += 1;
        return JSON.stringify({ result: "success", object: { roamingurl: LANDING } });
      }
      if (u === LANDING) {
        calls.landing += 1;
        return landingReply(calls.landing);
      }
      if (u.includes("jxmh_out.do")) {
        calls.schedule += 1;
        return scheduleReply(calls.schedule);
      }
      return "<html></html>";
    },
  };
  return { client: new InfoClient(http), calls };
}

/* ── ① 教务会话中途死亡：重漫游后重试必须成功 ── */
{
  // 死/活只由「漫游落地」翻转：只有真的重漫游过，第二次课表才拿得到数据。
  let dead = false;
  const h = harness({
    landingReply: () => {
      dead = false;
      return PORTAL_OK;
    },
    scheduleReply: (n) => {
      if (n === 1) {
        dead = true;
        return ZHJW_TIMEOUT;
      }
      return dead ? ZHJW_TIMEOUT : ZHJW_OK;
    },
  });
  const rows = await h.client.getSchedule("2026-11-03", "2026-11-03");
  assert.equal(rows.length, 1, "[1] 教务撞死会话后必须重漫游并重试成功");
  assert.equal(h.calls.roam, 2, "[1] 必须真的重漫游过一次（漫游端点两次：首次建立 + 恢复）");
  assert.equal(h.calls.schedule, 2, "[1] 课表只重试一次");
}

/* ── ② 会话健康：不得凭空多漫游 ── */
{
  const h = harness({ scheduleReply: () => ZHJW_OK });
  const rows = await h.client.getSchedule("2026-11-03", "2026-11-03");
  assert.equal(rows.length, 1, "[2] 健康会话正常出数");
  assert.equal(h.calls.roam, 1, "[2] 健康会话只漫游一次");
  assert.equal(h.calls.schedule, 1, "[2] 健康会话不重试");
}

/* ── ③ 非「未登录」的失败不得触发重漫游 ── */
{
  const h = harness({ scheduleReply: () => "<html>500 Internal Server Error</html>" });
  await assert.rejects(
    () => h.client.getSchedule("2026-11-03", "2026-11-03"),
    /课表接口返回非 JSON/,
    "[3] 服务端错误按普通错误上报",
  );
  assert.equal(h.calls.roam, 1, "[3] 5xx 不是会话证据，不得重漫游");
  assert.equal(h.calls.schedule, 1, "[3] 5xx 不重试");
}

/* ── ④ 重漫游救不回来：有界失败，不循环 ── */
{
  const h = harness({
    landingReply: (n) => (n === 1 ? PORTAL_OK : "<html><title>登录超时</title>jsp.timeout</html>"),
    scheduleReply: () => ZHJW_TIMEOUT,
  });
  await assert.rejects(
    () => h.client.getSchedule("2026-11-03", "2026-11-03"),
    /漫游未建立会话/,
    "[4] 重漫游失败要如实抛出，不静默",
  );
  assert.equal(h.calls.schedule, 1, "[4] 重漫游失败后不得再打课表");
  assert.equal(h.calls.roam, 2, "[4] 只重漫游一次");
}

/* ── ⑤ 考试走的是同一个 timeout.jsp：也必须重漫游后重试 ── */
{
  // 考试把 jsp.timeout 归成服务端窗口问题（不重登），但录像里它就是会话死的同一个页面。
  // 所以局部重漫游要认它一次；重试仍失败才如实上报。
  const h = harness({ scheduleReply: (n) => (n === 1 ? ZHJW_TIMEOUT : EXAM_OK) });
  const rows = await h.client.getExams();
  assert.equal(rows.length, 1, "[5] 考试的 timeout 页也要重漫游后重试成功");
  assert.equal(h.calls.roam, 2, "[5] 考试路径同样要真的重漫游一次");
}

/* ── ⑥ 并发取数共享一条漫游链（单飞） ── */
{
  let failures = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    // 只压「恢复用的漫游」：让它等到两个失败都发生再返回，模拟真实并发时序
    // （首次建立不该等，否则会测出死锁而不是单飞）
    landingReply: async () => {
      if (failures > 0) await gate;
      return PORTAL_OK;
    },
    scheduleReply: (n) => {
      if (n <= 2) {
        failures += 1;
        if (failures === 2) release();
        return ZHJW_TIMEOUT;
      }
      return ZHJW_OK;
    },
  });
  const [a, b] = await Promise.all([
    h.client.getSchedule("2026-11-03", "2026-11-03"),
    h.client.getSchedule("2026-11-02", "2026-11-09"),
  ]);
  assert.equal(a.length, 1, "[6] 第一个入口恢复出数");
  assert.equal(b.length, 1, "[6] 第二个入口恢复出数");
  assert.equal(h.calls.roam, 2, "[6] 两个并发入口只多漫游一次（没有单飞则各跑各的恢复链）");
}

console.log("✓ zhjw-roam-retry: 6 组全部通过（教务域局部自愈）");
