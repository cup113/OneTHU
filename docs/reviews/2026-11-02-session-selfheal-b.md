# 会话自愈核心 B：只修分类（最小面）

> 同一现场（2026-11-02 08:11–08:57）。B 只做 A 的第 2.1、2.2 两段：
> 把探针的封闭世界判定修对，热路径**不新增强原语**，
> 依赖既有的 `verifyAndReLogin → login(helper 里的凭据)` 自然把会话救回来。

## 1. 与 A 的差别

A 修「**判定 + 谁来重登 + 重登有没有用**」；B 只修「**判定**」，把「重登是否有效」留给下一次探针。

## 2. 伪代码

### 2.1 探针分类（与 A 逐字相同）

```
PROC getCsrfToken():
    raw = await uFetch(GET_COOKIE_URL)
    token = /XSRF-TOKEN=(.+?);/.exec(raw + ";")
    IF token: RETURN token                        # 唯一活证
    IF isConfirmedLoginPage(raw): THROW AUTH_SESSION_EXPIRED
    IF raw.trim() == "":          THROW AUTH_SESSION_EXPIRED   # ★ 新增
    IF 网关引导壳(__vpn_hostname_data, len<4000): THROW AUTH_SESSION_EXPIRED  # ★ 新增
    THROW UnrecognizedProbeError(raw)             # 未知非空：不碰凭据
```

### 2.2 探针分支升级（与 A 相同）

```
PROC ensureSession() -> bool:
    hasCreds = await libHydrateCredentials()
    IF hasCreds AND loginCooldownLeftMs() <= 0:
        RETURN true after verifyAndReLogin(helper)      # 分类修好后这里天然会重登
    probe = await nativeFetch(GET_COOKIE_URL)
    SWITCH classify(probe.body):
        ALIVE   -> RETURN true
        EXPIRED -> IF hasCreds: RETURN forceSimpleLogin()   # ★ 新增
                   ELSE: RETURN false
        UNKNOWN -> THROW
```

`forceSimpleLogin()` = `libLogin(记住的密码)`，**没有**证明、没有退避、没有熔断：

```
PROC forceSimpleLogin() -> bool:
    cred = await loadRemembered()
    IF !cred: RETURN false
    r = await libLogin(cred.username, cred.password, session.fingerprint)
    RETURN r.state == "ready"
```

## 3. B 能修 / 修不了

| 场景 | A | B |
|---|---|---|
| 会话过期、凭据在磁盘（今早 08:11 主现场） | 修好 | **修好**（分类改成 EXPIRED 后，verifyAndReLogin 会重登） |
| 凭据不在内存、hydrate 失败 | 修好（forceLogin 重读磁盘） | 半步：ensureSession 的 EXPIRED 分支会调 forceSimpleLogin，也重读磁盘 |
| 登录成功但服务仍死（学校维护） | 30s→10min 退避 + 开路 | **不治**：20s 一次的 softRecover 节流下持续重放，无上限 |
| 用户 2FA 挂起时热路径重登 | forceLogin 首行拒绝 | **不治**：verifyAndReLogin 的 outstandingLoginPromise 会 join 而非新建，风险较低但未显式守卫 |
| 「单域成功宣告全局活」错误条常亮 | 补域 + 证明 | 不治（错误条仍需手动重试） |
| 代码/回归面 | ~4 文件 + 3 个新状态 | **1 个函数 + 1 个分支** |

## 4. 护栏测试

```
T1  空体 → AUTH_SESSION_EXPIRED 且触发一次 libLogin
T2  DNS 失败 → 不重登
T3  陌生非空 HTML → 不重登
T4  并发入口 → 单飞（既有断言，回归用）
```

## 5. 事实风险

B 的判定修正会让**每一次真实死亡**都真的去登录（这是目的），但维护期「登录成功、服务仍空」没有刹车——
按今早节奏，rolled 重放频率 = `softRecover` 20s 节流 + keepalive 10min，且用户手点重试不受 20s 节流约束
（`libEnsureSession` 在冷却外每次都会被调用）。这是 B 明确不解决的部分。
