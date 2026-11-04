/** Executes the production session guard with simulated transport.
 *
 *  2026-11-02 会话自愈专项。现场实录（08:11–08:57）：info 会话死亡后热上下文
 *  46 分钟自愈全哑——cookie 探针回 `200 + 空体`，被判成未知异常，于是所有恢复
 *  路径都不许提交凭据，只有重启能救。本文件锁住修复后的契约：
 *
 *    [1] 健康会话不重登，并让陈旧的无效计数衰减
 *    [2] 重登之后必须被**门户**探针证明有效才算恢复
 *    [3] 确认死才记无效；结论不明只进退避，永远不开熔断
 *    [4] 验证失败保留原始错误，绝不顺带重放凭据
 *    [5] 只读路径：活/死/未知各有确定语义，传输错误原样抛出
 *    [6] 冷却与退避都拦在重登之前——不存在绕过闸门的第二条重登旁路
 *    [7] 熔断期间仍探针：会话其实活着就自愈复位
 *    [8] 并入进行中的登录（用户 2FA）时不下结论
 *    [9] 并发入口只跑一条恢复链、只记一次账（否则一个抖动就能开熔断）
 *   [10] 2FA 完成属于一次完整登录：必须复位熔断（执行断言，不是源码匹配）
 *   [11] 封闭世界判定：空体与网关壳=死，陌生非空=未知
 *   [12] 证明窗口以**最后一次**观测为准：夹着 5xx 的混合窗口不算死
 *   [13] 证明窗口按墙钟封顶：探针卡死不能把 5 秒拖成 90 秒
 *   [14] 门户探针把「未登录」映射成死，其余异常原样抛出
 *   [15] 空 cookie 体先预热一次应用入口，再判死（冷启动不误发凭据）
 *   [16] 证明窗口的采样上限：死会话最多三次探针（判活即返回）
 *
 * Run: node tools/session-probe-policy-test.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const transpile = (text) =>
  ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

/** 从一份 TS 源码里摘出指定顶层声明（函数或 const）并编译成可执行代码。 */
function declarations(source, names) {
  const ast = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
  const picked = [];
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && names.includes(statement.name.text)) {
      picked.push(statement.getText(ast));
    } else if (ts.isVariableStatement(statement)) {
      const hit = statement.declarationList.declarations.some(
        (d) => ts.isIdentifier(d.name) && names.includes(d.name.text),
      );
      if (hit) picked.push(statement.getText(ast));
    }
  }
  assert.equal(picked.length, names.length, `源码里缺少 ${names.join(",")}`);
  return transpile(picked.join("\n").replace(/^export\s+/gm, ""));
}

const infoLib = read("../apps/desktop/src/lib/infoLib.ts");
const core = read("../packages/info-lib/src/lib/core.ts");
const clients = read("../apps/desktop/src/lib/clients.ts");

/* ── 真实的封闭世界判定（不是替身） ───────────────────────────────── */
const classifyDeps = {};
new Function(
  "exports",
  "cheerio",
  declarations(core, ["classifyGatewayProbe", "isConfirmedLoginPage"]) +
    "\nexports.classifyGatewayProbe = classifyGatewayProbe;",
)(
  classifyDeps,
  // cheerio 只用于认登录页；本文件断言的分支都不靠它（空体/网关壳/陌生页）。
  { load: () => Object.assign(() => ({ length: 0, toArray: () => [] }), {}) },
);
const classifyGatewayProbe = classifyDeps.classifyGatewayProbe;

/* ── 真实的重登治理策略 ───────────────────────────────────────────── */
const policyModule = {};
new Function("exports", "require", transpile(read("../apps/desktop/src/lib/reloginPolicy.ts")))(
  policyModule,
  () => ({}),
);
const { ReloginPolicy } = policyModule;

const deadlineSource = declarations(infoLib, ["withDeadline"]) + "\nexports.f = withDeadline;";
const ensureSource = declarations(infoLib, ["runEnsureSession"]) + "\nexports.f = runEnsureSession;";
const flightSource = declarations(infoLib, ["libEnsureSession"]) + "\nexports.f = libEnsureSession;";
const proveSource = declarations(infoLib, ["proveReloginEffective"]) + "\nexports.f = proveReloginEffective;";
const portalSource = declarations(infoLib, ["probePortal"]) + "\nexports.f = probePortal;";
const forceSource = declarations(infoLib, ["libForceRelogin"]) + "\nexports.f = libForceRelogin;";

/** withDeadline：真实实现，用来给下面所有窗口测试一个可信的封顶。 */
const realWithDeadline = (() => {
  const exports = {};
  new Function("exports", deadlineSource)(exports);
  return exports.f;
})();

let passed = 0;
async function test(name, run) {
  await run();
  console.log(`PASS ${++passed} ${name}`);
}

/** 纯策略：两级计数（确认死 / 结论不明）。 */
function policyFixture(options) {
  return new ReloginPolicy(options);
}

/** runEnsureSession 的依赖替身：重登、证明、补域、记账全部可观察。 */
function ensureFixture({
  credentials = true,
  cooldown = 0,
  verified = false,
  verificationError = null,
  portal = "alive",
  portalThrows = null,
  proof = "alive",
  pendingLogin = false,
  policy = null,
} = {}) {
  const rp = policy ?? new ReloginPolicy();
  const counts = { verifies: 0, portals: 0, proves: 0, repairs: 0, ineffective: 0, indeterminate: 0 };
  const exports = {};
  const deps = {
    libHydrateCredentials: async () => credentials,
    loginCooldownLeftMs: () => cooldown,
    libLoginPending: () => pendingLogin,
    verifyAndReLogin: async () => {
      counts.verifies++;
      if (verificationError) throw verificationError;
      return verified;
    },
    helper: { userId: "fixture-account", fingerprint: "fixture-device" },
    reloginPolicy: rp,
    log: async () => {},
    probePortal: async () => {
      counts.portals++;
      if (portalThrows) throw portalThrows;
      return portal;
    },
    proveReloginEffective: async () => {
      counts.proves++;
      return proof;
    },
    noteIneffectiveRelogin: () => {
      counts.ineffective++;
      rp.noteIneffective();
    },
    noteIndeterminateRelogin: () => {
      counts.indeterminate++;
      rp.noteIndeterminate();
    },
    repairDomainsAfterRelogin: async () => {
      counts.repairs++;
    },
    withDeadline: realWithDeadline,
    PROBE_TIMEOUT_MS: 3_000,
  };
  new Function("exports", ...Object.keys(deps), ensureSource)(exports, ...Object.values(deps));
  return { run: exports.f, counts, policy: rp };
}

/** 并发单飞：同一个 ensureFlight 与同一个 runEnsureSession。 */
function flightFixture() {
  let runs = 0;
  const exports = {};
  const deps = {
    ensureFlight: { current: null },
    runEnsureSession: async () => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    },
  };
  new Function("exports", ...Object.keys(deps), flightSource)(exports, ...Object.values(deps));
  return { ensure: exports.f, runs: () => runs };
}

/** 证明窗口：伪时钟 + 可控观测序列。返回判定与探针次数（采样上限要能被证伪）。 */
function proveWindow(observations, { windowMs = 4_000, gaps = [1_500, 2_000], onProbe } = {}) {
  let index = 0;
  let clock = 0;
  let probes = 0;
  const FakeDate = class extends Date {
    static now() {
      return clock;
    }
  };
  const exports = {};
  const deps = {
    probePortal: async () => {
      probes += 1;
      onProbe?.(probes);
      const value = observations[Math.min(index++, observations.length - 1)];
      if (value === "throw") throw new TypeError("fixture offline");
      return value;
    },
    withDeadline: realWithDeadline,
    PROOF_WINDOW_MS: windowMs,
    PROOF_GAPS_MS: gaps,
    PROOF_MAX_GAP_MS: gaps[gaps.length - 1],
    setTimeout: (fn, ms) => {
      clock += typeof ms === "number" ? ms : 0;
      fn();
      return 0;
    },
    Date: FakeDate,
  };
  new Function("exports", ...Object.keys(deps), proveSource)(exports, ...Object.values(deps));
  return {
    run: () => exports.f(),
    probes: () => probes,
  };
}

/** 只要判定，不要计数（旧调用点保持不变）。 */
function proveFixture(observations) {
  return proveWindow(observations).run();
}

/** 门户探针包装：把「未登录」映射成死。 */
function portalFixture(error) {
  const exports = {};
  const deps = {
    helper: { userId: "fixture-account" },
    probePortalSession: async () => {
      throw error;
    },
  };
  new Function("exports", ...Object.keys(deps), portalSource)(exports, ...Object.values(deps));
  return exports.f();
}

/* [1] 健康会话：不重登，并让陈旧计数衰减 */
await test("a healthy session does not relogin and decays stale strikes", async () => {
  const policy = policyFixture();
  policy.noteIneffective(); // 一次历史抖动留下的账（未进退避窗口）
  const f = ensureFixture({ verified: false, policy });
  assert.equal(await f.run(), true);
  assert.deepEqual(f.counts, { verifies: 1, portals: 0, proves: 0, repairs: 0, ineffective: 0, indeterminate: 0 });
  assert.equal(policy.ineffective, 0);
});

/* [2] 重登必须被门户探针证明（不是网关票） */
await test("a relogin is only accepted once the portal probe proves it", async () => {
  const proven = ensureFixture({ verified: true, proof: "alive" });
  assert.equal(await proven.run(), true);
  assert.equal(proven.counts.proves, 1);
  assert.equal(proven.counts.repairs, 1);

  const dead = ensureFixture({ verified: true, proof: "dead" });
  assert.equal(await dead.run(), false);
  assert.equal(dead.counts.ineffective, 1);
  assert.equal(dead.counts.repairs, 0);
});

/* [3] 只有确认死才记无效；不明只进退避 */
await test("indeterminate proofs back off but never open the breaker", async () => {
  const policy = policyFixture({ baseMs: 0, capMs: 0 });
  const f = ensureFixture({ verified: true, proof: "unknown", policy });
  for (let i = 0; i < 6; i++) await f.run();
  assert.equal(policy.ineffective, 0, "不明不记无效");
  assert.equal(policy.indeterminate, 6, "不明要进退避计数");
  assert.equal(policy.open, false, "反复不明永远不能开熔断");

  const dead = ensureFixture({ verified: true, proof: "dead", policy: policyFixture({ baseMs: 0, capMs: 0 }) });
  for (let i = 0; i < 3; i++) await dead.run();
  assert.equal(dead.policy.open, true, "确认死三次才开路");
});

/* [4] 验证失败保留原始错误 */
await test("verification failures retain their cause and cannot enter another login path", async () => {
  for (const error of [
    new TypeError("offline"),
    Object.assign(Error("503"), { status: 503 }),
    Object.assign(Error("wrong account"), { code: "AUTH_SESSION_CONFLICT" }),
    Error("2FA required"),
  ]) {
    const f = ensureFixture({ verificationError: error });
    await assert.rejects(f.run(), (e) => e === error);
    assert.equal(f.counts.proves, 0);
    assert.equal(f.counts.repairs, 0);
  }
});

/* [5] 只读路径 */
await test("the read-only path keeps alive/dead apart and rethrows transport failures", async () => {
  assert.equal(await ensureFixture({ credentials: false, portal: "alive" }).run(), true);
  assert.equal(await ensureFixture({ credentials: false, portal: "dead" }).run(), false);
  assert.equal(await ensureFixture({ credentials: false, portal: "unknown" }).run(), false);
  const offline = new TypeError("fixture timeout");
  await assert.rejects(ensureFixture({ credentials: false, portalThrows: offline }).run(), (e) => e === offline);
});

/* [6] 冷却与退避都拦在重登之前 */
await test("cooldown and backoff gate every relogin before it starts", async () => {
  const cooling = ensureFixture({ cooldown: 5_000, portal: "dead" });
  assert.equal(await cooling.run(), false);
  assert.equal(cooling.counts.verifies, 0, "冷却期内不得发起重登");
  assert.equal(cooling.counts.portals, 1, "冷却期只做只读探针");

  const policy = policyFixture();
  policy.noteIneffective();
  policy.noteIneffective(); // 进入退避窗口
  const throttled = ensureFixture({ policy, portal: "dead" });
  assert.equal(await throttled.run(), false);
  assert.equal(throttled.counts.verifies, 0, "退避窗口内不得发起重登");

  const recovered = ensureFixture({ policy, portal: "alive" });
  assert.equal(await recovered.run(), true);
  assert.equal(policy.nextAt, 0, "只读探针判活同样要解除退避");
  assert.equal(policy.ineffective, 0);
});

/* [7] 熔断期间仍探针：误判要能自己解开 */
await test("an open breaker still probes and heals itself when the session is alive", async () => {
  const policy = policyFixture();
  for (let i = 0; i < 3; i++) policy.noteIneffective();
  assert.equal(policy.open, true);

  const alive = ensureFixture({ policy, portal: "alive" });
  assert.equal(await alive.run(), true);
  assert.equal(policy.open, false, "探针判活必须复位熔断");
  assert.equal(alive.counts.verifies, 0);

  for (let i = 0; i < 3; i++) policy.noteIneffective();
  const dead = ensureFixture({ policy, portal: "dead" });
  assert.equal(await dead.run(), false);
  assert.equal(dead.counts.verifies, 0, "熔断打开期间绝不重放凭据");
});

/* [8] 并入进行中的登录（2FA）时不下结论 */
await test("joining a pending login makes no claim either way", async () => {
  const f = ensureFixture({ verified: true, pendingLogin: true, proof: "dead" });
  assert.equal(await f.run(), false);
  assert.equal(f.counts.proves, 0);
  assert.equal(f.counts.ineffective, 0);
});

/* [9] 并发入口只跑一条链、只记一次账（评审 #1） */
await test("concurrent callers share one recovery chain and one strike", async () => {
  const flight = flightFixture();
  const results = await Promise.all([flight.ensure(), flight.ensure(), flight.ensure(), flight.ensure(), flight.ensure()]);
  assert.deepEqual(results, [true, true, true, true, true]);
  assert.equal(flight.runs(), 1, "五个并发入口只允许跑一条恢复链");
});

/* [10] 2FA 完成必须复位熔断（执行断言） */
await test("completing 2FA resets the breaker", async () => {
  const ast = ts.createSourceFile("clients.ts", clients, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "verify2FA");
  assert.ok(fn, "clients.ts 里必须有 verify2FA");
  const code = ts.transpileModule(fn.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let resets = 0;
  let softResets = 0;
  const exports = {};
  const libModule = {
    libVerify2FA: async () => {},
    helper: {},
    getSelfFinger3: () => "",
    setLibFinger3: () => {},
    resetReloginPolicy: () => resets++,
  };
  const deps = {
    session: { state: "idle", finger3: "", injectCredentials() {} },
    logLine: async () => {},
    pendingSecret: null,
    persist: async () => {},
    retryTuojAfterTrust: () => {},
    resumeLearnAfterLogin: async () => {},
    adoptSuccessfulDesktopLogin: async () => {},
    dumpDebug: async () => {},
    require: () => libModule,
    resetSoftReloginBackoff: () => softResets++,
  };
  new Function("exports", ...Object.keys(deps), code + "\nexports.f = verify2FA;")(exports, ...Object.values(deps));
  await exports.f("totp", "000000", true);
  assert.equal(resets, 1, "2FA 完成必须复位熔断（删掉调用必须让这条断言失败）");
  assert.equal(softResets, 1, "2FA 完成也要复位续约冷却，否则刚登录完还被挡十分钟");
});

/* [11] 封闭世界判定 */
await test("the gateway probe verdict is closed-world", async () => {
  assert.equal(classifyGatewayProbe("XSRF-TOKEN=abc;"), "alive");
  assert.equal(classifyGatewayProbe(""), "expired", "空体是 2026-11-02 实录的死相");
  assert.equal(
    classifyGatewayProbe('<script>var __vpn_hostname_data="x";var __vpn_app_hostname_data="y";</script>'),
    "expired",
  );
  assert.equal(classifyGatewayProbe("<main>维护中</main>"), "unknown");
});

/* [12] 混合窗口以最后一次观测为准（评审 #4） */
await test("a mixed proof window is judged by its last observation", async () => {
  assert.equal(await proveFixture(["dead"]), "dead");
  assert.equal(await proveFixture(["alive"]), "alive");
  assert.equal(await proveFixture(["dead", "throw"]), "unknown",
    "死一次之后只回 5xx/断网：结论不明，不记死");
  assert.equal(await proveFixture(["throw"]), "unknown", "断网不是会话死");
});

/* [13] 证明窗口按墙钟封顶（评审 #3） */
await test("the proof window is bounded by the wall clock, not by the transport", async () => {
  const started = Date.now();
  const verdict = await realWithDeadline(new Promise(() => {}), 30, "unknown");
  const elapsed = Date.now() - started;
  assert.equal(verdict, "unknown");
  assert.ok(elapsed < 2_000, `卡死的探针必须在毫秒级被截断，实际 ${elapsed}ms`);

  // 真实接线：证明函数本身也必须被截断（去掉 withDeadline 会让这条超时）
  const exports = {};
  const deps = {
    probePortal: () => new Promise(() => {}),
    withDeadline: realWithDeadline,
    PROOF_WINDOW_MS: 60,
    PROOF_GAPS_MS: [10, 10],
    PROOF_MAX_GAP_MS: 10,
  };
  new Function("exports", ...Object.keys(deps), proveSource)(exports, ...Object.values(deps));
  const raced = await Promise.race([
    exports.f(),
    new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 1_500)),
  ]);
  assert.notEqual(raced, "TIMEOUT", "证明函数没有用墙钟截断卡死的探针");
});

/* [14] 门户探针的映射 */
await test("the portal probe maps a missing login to dead and rethrows the rest", async () => {
  assert.equal(await portalFixture(Object.assign(new Error("sign in"), { code: "AUTH_SESSION_EXPIRED" })), "dead");
  const other = new TypeError("offline");
  await assert.rejects(portalFixture(other), (e) => e === other);
});

/* [15] 空 cookie 体先预热一次应用入口（评审 U1） */
await test("an empty cookie body warms the app entry once before judging death", async () => {
  const run = (responses) => {
    const calls = [];
    const exports = {};
    const deps = {
      uFetch: async (url) => {
        calls.push(url);
        if (url === "COOKIE") return responses.shift() ?? "";
        if (url === "ENTRY") return "<html>entry</html>";
        throw new Error(`unexpected ${url}`);
      },
      GET_COOKIE_URL: "COOKIE",
      INFO_ENTRY_URL: "ENTRY",
      classifyGatewayProbe,
      IdAuthError: class extends Error {},
    };
    new Function("exports", ...Object.keys(deps), declarations(core, ["getCsrfToken"]) + "\nexports.f = getCsrfToken;")(
      exports, ...Object.values(deps),
    );
    return { run: exports.f, calls };
  };

  const warmed = run(["", "XSRF-TOKEN=after-warm;"]);
  assert.equal(await warmed.run(), "after-warm", "预热后拿到票就不算死");
  assert.deepEqual(warmed.calls, ["COOKIE", "ENTRY", "COOKIE"], "空体必须换来一次入口预热");

  const expired = run(["", ""]);
  await assert.rejects(expired.run(), (e) => e.code === "AUTH_SESSION_EXPIRED");
  assert.deepEqual(expired.calls, ["COOKIE", "ENTRY", "COOKIE"], "预热后仍空才算会话死");
});

/* [16] 证明窗口的采样上限（评审 #3）：会话已死时单次探针要三个请求，采样不能刷成风暴 */
await test("the proof window samples at most three times", async () => {
  const dead = proveWindow(["dead"]);
  assert.equal(await dead.run(), "dead");
  assert.ok(dead.probes() <= 3, `死会话的证明窗口最多三次探针，实际 ${dead.probes()} 次`);
  const unknown = proveWindow(["throw"]);
  assert.equal(await unknown.run(), "unknown");
  assert.ok(unknown.probes() <= 3, `结论不明的窗口同样受上限约束，实际 ${unknown.probes()} 次`);
  // 判活即返回：好会话不许被拖满整个窗口
  const alive = proveWindow(["alive"]);
  assert.equal(await alive.run(), "alive");
  assert.equal(alive.probes(), 1, "判活立即返回，不额外采样");
});

/* [17] 强制重登（选课死结）也必须过闸门（评审 #4）：熔断期间不得重放账密 */
await test("force relogin honours the breaker instead of replaying credentials", async () => {
  const runForce = (policy) => {
    const calls = { hydrate: 0, login: 0 };
    const exports = {};
    const deps = {
      reloginPolicy: policy,
      log: async () => undefined,
      libHydrateCredentials: async () => {
        calls.hydrate += 1;
        return true;
      },
      helper: { userId: "fixture-account", password: "fixture-secret", fingerprint: "fixture-fp" },
      inflight: null,
      libLogin: async () => {
        calls.login += 1;
        return { state: "ready" };
      },
    };
    new Function("exports", ...Object.keys(deps), forceSource)(exports, ...Object.values(deps));
    return { run: exports.f, calls };
  };

  const healthy = runForce(new ReloginPolicy());
  assert.equal(await healthy.run(), true, "闸门放行时照旧重建");
  assert.equal(healthy.calls.login, 1, "放行时必须真的登录一次");

  const tripped = new ReloginPolicy();
  tripped.noteIneffective();
  tripped.noteIneffective();
  tripped.noteIneffective();
  assert.equal(tripped.open, true, "三次确认无效应该开路");
  const blocked = runForce(tripped);
  assert.equal(await blocked.run(), false, "熔断打开时强制重登不得放行");
  assert.equal(blocked.calls.login, 0, "熔断打开时一次登录都不许发（否则就是旁路）");
});

console.log(`${passed} production session-guard scenarios passed.`);
