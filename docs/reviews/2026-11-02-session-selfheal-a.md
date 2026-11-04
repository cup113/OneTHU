# 会话自愈核心 A：封闭世界探针 + 有效性证明

> 现场：2026-11-02 08:11–08:57，info 会话死亡后热上下文 46 分钟自愈全哑；
> `wengine-vpn/cookie` 返回 `200 + 空 body`，落在「未知异常 → 不许提交凭据」的死区。
> 日志：`%APPDATA%\app.onethu.desktop.fork\logs\onethu-debug.log`。
>
> **实现偏离（2026-11-02 复核后）**：评审指出 §2.3 的 `forceLogin` 在控制流上不可达
> （唯一入口挂在冷却分支，而它自己拒绝冷却），已撤销该独立原语，第 2.3 节的两端职责
> 折进 `libEnsureSession`：闸门一处、证明一处、记账一处。运行系统的描述以
> `docs/adr/2026-11-02-session-selfheal-closed-world.md` 为准；本文件保留为评审时的设计记录。

## 0. 不变量（实现时不许破）

```
I1  传输失败 ≠ 会话死亡         DNS/超时/断网在到达分类器之前就 throw，永不触发重登
I2  业务页/业务 JSON 的未知形状 ≠ 会话死亡   白名单语义原样保留，不反转
I3  基础设施探针的响应空间可穷举  活=有 XSRF；登录页/空体/网关壳=死；其余非空=未知（不重登）
I4  任何时刻至多一条登录链        lib 单飞 outstandingLoginPromise + loginGate 20s 硬冷却
I5  用户 2FA 挂起时热路径停手     libLoginPending() 为真则拒绝强原语
I6  登录成功 ≠ 服务可用          重登后必须复查证明；连续无效 → 退避 → 开路
I7  开路即终态                    停在「请重新登录」，不静默空转
I8  补域串行                     登录 settle 之后单序列补齐，不新增并发漫游
```

## 1. 数据流

```
触发源                        闸门                        原语                     证明/收尾
──────                        ────                        ────                     ─────────
keepalive 10min ┐             lib 单飞 ┐                  forceLogin()             probeWithin(5s)
softRecover     ├─ ensureSession() ──┼─→ verifyAndReLogin ──┼─→ libLogin(记住的密码) ──┼─→ ALIVE? ─→ repairDomains()
learn reloginHook│            loginGate 20s ┘               │                          │            └─→ 重试原请求
#withRenew      ┘                                         └─ 无效计数/退避/熔断 ←──────┘
```

## 2. 伪代码

### 2.1 探针分类（唯一反转白名单的地方）

改 `packages/info-lib/src/lib/core.ts` `getCsrfToken()`：

```
PROC getCsrfToken():
    raw = await uFetch(GET_COOKIE_URL)            # 200，body 为 cookie 串
    token = /XSRF-TOKEN=(.+?);/.exec(raw + ";")
    IF token: RETURN token                        # ── 唯一活证（47 字符实录）

    IF isConfirmedLoginPage(raw):                 # ── 既有：登录页
        THROW AUTH_SESSION_EXPIRED

    IF raw.trim() == "":                          # ── 新增：封闭世界
        THROW AUTH_SESSION_EXPIRED                #    空 200 只可能是会话死/网关未铸票
                                                  #    （08:11–08:51 五连实录）

    IF /__vpn_hostname_data/ on raw AND len < 4000:   # ── 新增：网关引导壳=票死
        THROW AUTH_SESSION_EXPIRED

    THROW UnrecognizedProbeError(raw)             # ── 其他非空未知：不碰凭据（I2）
```

> 为什么只有这里能反转：这是基础设施端点，没有业务页形态；每个分支的代价不对称——
> 误判「死」多一条被闸门限速的登录链，误判「未知」则是今早那种无限期卡死。

### 2.2 探针分支升级（不再「return false 收工」）

改 `apps/desktop/src/lib/infoLib.ts` `libEnsureSession()`：

```
PROC ensureSession() -> bool:
    hasCreds = await libHydrateCredentials()        # 磁盘「记住密码」→ helper（不变）
    IF hasCreds AND loginCooldownLeftMs() <= 0:
        relogged = await verifyAndReLogin(helper)   # 不变：探活+按需重登
        IF relogged: markPendingProof()             # 进入证明状态（I6）
        RETURN true

    # 无凭据 / 冷却中：只读探针
    probe = await nativeFetch(GET_COOKIE_URL)
    IF probe.status != 200:
        IF probe.status == 401: RETURN false
        THROW                                  # 传输/网关错误：不重登（I1）

    SWITCH classify(probe.body):
        ALIVE   -> RETURN true
        EXPIRED -> IF hasCreds: RETURN forceLogin("probe-expired")   # ★ 新增
                   ELSE:        RETURN false                        # 有凭据但只能等闸门
        UNKNOWN -> THROW（原样：未知形状保留原始失败）

    # 无凭据一律 RETURN false —— 不发明凭据、不弹登录页
```

### 2.3 强原语 + 有效性证明 + 熔断

新增于 `apps/desktop/src/lib/infoLib.ts`（复用既有原语，不新造登录链）：

```
STATE:
    ineffectiveStreak = 0
    nextAllowedLoginAt = 0
    circuitOpen = false
    PROOF_WINDOW_MS   = 5_000
    BACKOFF_STEP_MS   = 30_000     # 30s → 60s → … → 10min
    BACKOFF_CAP_MS    = 600_000
    BREAKER_OPEN_AT   = 3

PROC forceLogin(reason) -> bool:
    IF libLoginPending():      LOG "skip: 2FA 进行中"; RETURN false      # I5
    IF circuitOpen:            RETURN false                              # I7
    IF now < nextAllowedLoginAt: RETURN false                            # 退避
    cred = await loadRemembered()
    IF !cred OR cred.username != session.username: RETURN false          # 无凭据不重放

    ok = await libLogin(cred.username, cred.password, session.fingerprint)
    IF !ok: RETURN false          # LoginError/2FA/验证码：终态，不重试（既有语义）

    # ── 证明：登录链成功 ≠ 服务可用
    IF await probeWithin(PROOF_WINDOW_MS) == ALIVE:
        ineffectiveStreak = 0
        await repairDomains()                                                # I8
        RETURN true

    ineffectiveStreak += 1
    IF ineffectiveStreak >= 2:
        nextAllowedLoginAt = now + min(BACKOFF_STEP_MS << (ineffectiveStreak-2), BACKOFF_CAP_MS)
    IF ineffectiveStreak >= BREAKER_OPEN_AT:
        circuitOpen = true
        raise AuthRequiredError("自动恢复多次未生效，请重新登录")  # 诚实终态
    RETURN false
```

`repairDomains()`（登录成功后串行，绝不并发开新链）：

```
PROC repairDomains():
    info.resetStaticSessionCaches()          # libToken 10min 静态缓存
    await libRoamLearn().catch(() => false)  # learn 会话（roam id 表单）
    info.invalidateZhjwRoam()                # #zhjwRoamed=false：允许下次重漫游教务
```

### 2.4 接线（不新增入口）

```
softRecover(scope)      → ensureSession()          # 现有，去掉 20s 双节流叠加的静默失败
learn.reloginHook       → ensureSession() → libRoamLearn()
InfoClient renewer      → ensureSession()
keepalive 10min         → ensureSession()
#withRenew 失败重试      → 现有 2.5s 缓冲保留
```

## 3. 失效模式

| # | 失效 | 现状 | 本方案 |
|---|---|---|---|
| F1 | 会话过期 + 凭据仅在磁盘 | 46 分钟卡死，只有重启能救 | 探针 EXPIRED + 有凭据 → 强原语重登 |
| F2 | 登录成功、服务仍死（维护） | 22s 一次无限重放（softRecover 节流 + 1 次重试） | 证明失败 → 30s→10min 退避 → 开路 |
| F3 | 用户正在 2FA | 已被 trySilentRelogin 挡住，但热路径无此守卫 | forceLogin 首行 libLoginPending() |
| F4 | 离线/DNS 失败 | 不重登 | 不变（I1） |
| F5 | 业务页换形状 | 不重登 | 不变（I2） |
| F6 | 并发 5 个面板同时报错 | lib 单飞 + 各 client 单飞 | 不变，全部汇到 ensureSession() |
| F7 | 学校风控升级要验证码 | LoginError 终态 | 不变，且熔断先一步止损 |

## 4. 护栏测试（`tools/` 假传输层，同 learn-session-recover-test.mjs 模式）

```
T1  cookie 端点返回 200 空体      → 必须 AUTH_SESSION_EXPIRED，且触发一次 libLogin
T2  cookie 端点 DNS 抛错          → 绝不触发 libLogin
T3  cookie 端点 200 + 陌生 HTML   → 不触发 libLogin（未知形状）
T4  5 个入口并发同时撞死          → 只产生 1 条登录链
T5  登录成功但探针仍空            → 第 1 次不退避；第 2 次退避 30s；第 3 次开路
T6  2FA 挂起中触发                → forceLogin 直接 false，无密码 POST
T7  登录成功且探针 ALIVE          → 计数清零 + 调用 repairDomains 一次
```

## 5. 待定参数（实现时按实录校准）

- `PROOF_WINDOW_MS`：5s 是初值；实测登录链 settle 后 info 域生效 ≤ 1s（08:57 boot 实录）
- 退避曲线是否复用 `libSoftRelogin` 的 30s→10min 指数（建议复用，别造两套）
- 熔断是否跨重启保持（建议**不保持**：重启 = 用户新意图，boot 路径本来就会重登一次）
