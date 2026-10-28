/** Actual HttpClient with synthetic responses only; no school/network/account access.
 * Run: node --import ./tools/ts-resolve-register.mjs tools/http-wengine-bootstrap-test.mjs */
import assert from "node:assert/strict";
import { AuthRequiredError, HttpClient, MemoryCookieJar, onAuthRequired } from "../packages/core/src/http.ts";
import { webvpnWrap } from "../packages/core/src/crypto/webvpn.ts";

globalThis.fetch = async () => { throw Error("Real network is forbidden in this fixture"); };
const LEARN = "https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/?tab=fixture";
const INFO = "https://info.tsinghua.edu.cn/f/info/fixture?tab=second";
const ROOT = "https://webvpn.tsinghua.edu.cn/";
const guide = (code = "fixture-app-code", scheme = "https") => `<html><script>
var __vpn_hostname_data="webvpn.tsinghua.edu.cn";
var __vpn_app_hostname_data="${code}";
var __vpn_app_protocol_data="${scheme}";</script></html>`;
const response = (text, status = 200) => new Response(text, { status, headers: { "content-type": "text/html" } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`✓ ${name}`); }
function cookies(jar, url) { return new Map(jar.getCookies(new URL(url)).map(c => [c.name, c.value])); }
function makeClient(fetch) { const c = new HttpClient({ fetch }); c.webVPNEncoder = webvpnWrap; return c; }

for (const input of [LEARN, webvpnWrap(LEARN)]) {
  await test(`${input === LEARN ? "logical" : "already wrapped"} URL bootstraps the real application path and scoped proxy`, async () => {
    const calls = [], seeds = [], nativeJar = new MemoryCookieJar(); let pages = 0, logins = 0;
    const c = makeClient(async (url, init) => {
      const u = new URL(url); calls.push({ u, init });
      if (u.pathname === "/wengine-vpn/cookie") {
        return response(u.searchParams.get("host") === "learn.tsinghua.edu.cn" ? "JSESSIONID=fixture-learn; XSRF-TOKEN=fixture-xsrf" : "");
      }
      if (pages++ === 0) return response(guide());
      assert.equal(cookies(nativeJar, url).get("JSESSIONID"), "fixture-learn", "native seed must finish before replay");
      return response("course-ready");
    });
    c.onAuthRequired(async () => { logins++; });
    c.nativeSeedHook = async (url, pair, path) => {
      await Promise.resolve(); seeds.push({ url, pair, path });
      nativeJar.setRaw(new URL(url), `${pair}; Path=${path}`);
    };
    assert.equal(await c.text(input), "course-ready");
    const bootstrap = calls.filter(x => x.u.pathname === "/wengine-vpn/cookie");
    assert.deepEqual(bootstrap.map(x => x.u.searchParams.get("host")), ["fixture-app-code", "learn.tsinghua.edu.cn"]);
    for (const { u, init } of bootstrap) {
      assert.equal(u.searchParams.get("path"), "/f/wlxt/index/course/student/?tab=fixture");
      assert.equal(u.searchParams.get("scheme"), "https");
      assert.equal(init.headers.get("Referer"), webvpnWrap(LEARN));
    }
    assert.equal(pages, 2); assert.equal(logins, 0); assert.equal(seeds.length, 4);
    assert.equal(cookies(c.jar, LEARN).get("JSESSIONID"), "fixture-learn");
    assert.equal(cookies(c.jar, webvpnWrap(LEARN)).get("JSESSIONID"), "fixture-learn");
    for (const jar of [c.jar, nativeJar]) {
      assert.equal(cookies(jar, ROOT).has("JSESSIONID"), false);
      assert.equal(cookies(jar, INFO).has("JSESSIONID"), false);
      assert.equal(cookies(jar, webvpnWrap(INFO)).has("JSESSIONID"), false);
    }
  });
}

await test("direct logical request retains its actual Referer and has no proxy-wide seed", async () => {
  const calls = [], seeds = []; let pages = 0;
  const c = makeClient(async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/wengine-vpn/cookie") { calls.push({ u, init }); return response("JSESSIONID=fixture-direct"); }
    assert.equal(url, LEARN); return response(pages++ === 0 ? guide("learn.tsinghua.edu.cn", "javascript") : "ready");
  });
  c.nativeSeedHook = (url, pair, path) => { seeds.push({ url, pair, path }); };
  assert.equal(await c.text(LEARN, { direct: true }), "ready");
  assert.equal(calls.length, 1, "identical app-code and real host are deduplicated");
  assert.equal(calls[0].init.headers.get("Referer"), LEARN);
  assert.equal(calls[0].u.searchParams.get("scheme"), "https", "untrusted scheme cannot become a protocol");
  assert.deepEqual(seeds, [{ url: "https://learn.tsinghua.edu.cn/", pair: "JSESSIONID=fixture-direct", path: "/" }]);
});

await test("overlapping delayed bodies retain each request's Referer and cookie namespace", async () => {
  const delayed = deferred(), started = deferred(), calls = [], pageCounts = new Map();
  const c = makeClient(async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/wengine-vpn/cookie") {
      calls.push({ u, referer: init.headers.get("Referer") });
      return response(`JSESSIONID=${u.searchParams.get("host") === "learn.tsinghua.edu.cn" ? "learn-only" : "info-only"}`);
    }
    const count = pageCounts.get(url) ?? 0; pageCounts.set(url, count + 1);
    if (count) return response("ready");
    if (url === webvpnWrap(LEARN)) {
      const stream = new ReadableStream({ start(controller) {
        started.resolve();
        void delayed.promise.then(() => { controller.enqueue(new TextEncoder().encode(guide("learn.tsinghua.edu.cn"))); controller.close(); });
      } });
      return new Response(stream);
    }
    return response(guide("info.tsinghua.edu.cn"));
  });
  const first = c.text(webvpnWrap(LEARN)); await started.promise;
  assert.equal(await c.text(webvpnWrap(INFO)), "ready");
  delayed.resolve(); assert.equal(await first, "ready");
  assert.equal(calls.length, 2);
  for (const { u, referer } of calls) {
    const logical = u.searchParams.get("host") === "learn.tsinghua.edu.cn" ? LEARN : INFO;
    assert.equal(referer, webvpnWrap(logical));
    assert.equal(u.searchParams.get("path"), new URL(logical).pathname + new URL(logical).search);
  }
  assert.equal(cookies(c.jar, webvpnWrap(LEARN)).get("JSESSIONID"), "learn-only");
  assert.equal(cookies(c.jar, webvpnWrap(INFO)).get("JSESSIONID"), "info-only");
  assert.equal(cookies(c.jar, ROOT).has("JSESSIONID"), false);
});

await test("native seed completion is awaited before the single application replay", async () => {
  const seedGate = deferred(), seedStarted = deferred(); let pages = 0;
  const c = makeClient(async url => {
    if (new URL(url).pathname === "/wengine-vpn/cookie") return response("JSESSIONID=fixture");
    return response(pages++ === 0 ? guide("learn.tsinghua.edu.cn") : "ready");
  });
  c.nativeSeedHook = async () => { seedStarted.resolve(); await seedGate.promise; };
  const pending = c.text(LEARN); await seedStarted.promise; await flush();
  assert.equal(pages, 1); seedGate.resolve(); assert.equal(await pending, "ready"); assert.equal(pages, 2);
});

await test("bootstrap rejects error-status cookies, control bytes, attributes and gateway tickets", async () => {
  const seeds = []; let pages = 0;
  const c = makeClient(async url => {
    const u = new URL(url);
    if (u.pathname === "/wengine-vpn/cookie") {
      if (u.searchParams.get("host") === "fixture-app-code") return response("JSESSIONID=error-status", 403);
      return response("JSESSIONID=safe; Domain=unrelated.invalid; Path=/; Max-Age=999; Secure=true; SameSite=None;\nSet-Cookie: victim=bad; bad=val\rue; wengine_vpn_ticket=anonymous; heartbeat=bad; show_test=bad; refresh=bad");
    }
    return response(pages++ === 0 ? guide() : "ready");
  });
  c.jar.setRaw(new URL(ROOT), "wengine_vpn_ticket=active-gateway; Path=/");
  c.nativeSeedHook = (url, pair, path) => { seeds.push({ url, pair, path }); };
  assert.equal(await c.text(LEARN), "ready");
  assert.equal(seeds.length, 2); assert.ok(seeds.every(x => x.pair === "JSESSIONID=safe"));
  assert.deepEqual([...cookies(c.jar, LEARN)], [["JSESSIONID", "safe"]]);
  assert.equal(cookies(c.jar, ROOT).get("wengine_vpn_ticket"), "active-gateway");
  assert.equal(cookies(c.jar, "https://unrelated.invalid/").size, 0);
});

await test("empty bootstrap and long injected business pages do not trigger retries or login", async () => {
  for (const body of [guide("learn.tsinghua.edu.cn"), guide() + "x".repeat(5000)]) {
    let pages = 0, cookieCalls = 0, logins = 0;
    const c = makeClient(async url => {
      if (new URL(url).pathname === "/wengine-vpn/cookie") { cookieCalls++; return response(""); }
      pages++; return response(body);
    });
    c.onAuthRequired(async () => { logins++; });
    assert.equal(await c.text(LEARN), body); assert.equal(pages, 1); assert.equal(logins, 0);
    assert.equal(cookieCalls, body.length > 4000 ? 0 : 1);
  }
});

await test("a short wengine shell that renders text is an answer, not a cookie handshake", async () => {
  // 「您没有执行当前操作的权限」壳页：同样短、同样带 __vpn_* 变量，但它渲染了文案。
  // 去舞一次 /wengine-vpn/cookie 换不来页面——只会白烧一次请求，还让诊断把它记成
  // 「interstitial=true」，把排查引向错误的会话方向（2026-10-28 实录）。
  for (const [body, expected] of [
    [`${guide()}<body><p class="infoo">您没有执行当前操作的权限</p></body></html>`, 0],
    [`${guide()}<body><p>系统繁忙，请稍后再试</p></body></html>`, 0],
    [guide("learn.tsinghua.edu.cn"), 1],
  ]) {
    let pages = 0, cookieCalls = 0;
    const c = makeClient(async url => {
      if (new URL(url).pathname === "/wengine-vpn/cookie") { cookieCalls++; return response("JSESSIONID=fixture-replay"); }
      pages++; return response(body);
    });
    await c.text(LEARN);
    assert.equal(pages, expected ? 2 : 1);
    assert.equal(cookieCalls, expected);
  }
});

await test("strict text status validation preserves legacy behavior and keeps bodies out of errors", async () => {
  for (const status of [403, 429, 502]) {
    let logins = 0;
    const c = makeClient(async (_url, init) => {
      assert.equal("validateStatus" in init, false, "local option must not leak into fetch");
      return response("private-fixture-response", status);
    });
    c.onAuthRequired(async () => { logins++; });
    assert.equal(await c.text(LEARN), "private-fixture-response");
    await assert.rejects(() => c.text(LEARN, {}, { validateStatus: true }), e => e.message === `HTTP ${status}`);
    assert.equal(logins, 0);
  }
});

await test("strict status observes the final replay response and retains one automatic login", async () => {
  for (const finalStatus of [200, 503]) {
    let calls = 0, logins = 0;
    const c = makeClient(async () => calls++ === 0 ? response('<input id="sm2publicKey">') : response("final", finalStatus));
    c.onAuthRequired(async () => { logins++; });
    if (finalStatus === 200) assert.equal(await c.text(LEARN, {}, { validateStatus: true }), "final");
    else await assert.rejects(() => c.text(LEARN, {}, { validateStatus: true }), /^Error: HTTP 503$/);
    assert.equal(calls, 2); assert.equal(logins, 1);
  }
});

await test("service-owned authentication errors suppress only their own global broadcast", async () => {
  let broadcasts = 0;
  const unsubscribe = onAuthRequired(() => { broadcasts++; });
  try {
    const local = new AuthRequiredError("fixture-local-recovery", { broadcast: false });
    assert.equal(local.name, "AuthRequiredError"); assert.equal(broadcasts, 0);
    new AuthRequiredError(); assert.equal(broadcasts, 1);
    new AuthRequiredError("fixture-explicit-global", { broadcast: true }); assert.equal(broadcasts, 2);
    new AuthRequiredError("fixture-default-global", {}); assert.equal(broadcasts, 3);
  } finally { unsubscribe(); }
});

console.log(`HTTP WebVPN bootstrap: ${passed} behavior fixtures passed; no network.`);
