# 登录入口被网关短路、构建产物陈旧与未提权写盘

日期：2026-10-23。基线：main `9029e7c1`，本轮提交 `cff2ff0e` … `b26028f6`（5 个）。

## 问题与原因

0.11.2 桌面端登录约一半概率失败，报「统一认证没有返回可用的登录表单」，诊断摘要为
`AUTH-FAIL reason=unexpected-page stage=credential-entry`，且十分钟内反复重试通常不会转成功。
排查中发现这是**三件互不相干的事**叠在一起，任何一件都会让另外两件的证据失真。

### 一、网关仍登录时，凭证入口被短路（登录失败的直接原因）

`login()` 用 `GET https://webvpn.tsinghua.edu.cn/login?oauth_login=true` 作为凭证入口。
该请求只有在 WebVPN 网关**已登出**时才会 302 到 `oauth.tsinghua.edu.cn/thu-oauth/auth`，
再 302 到 `id.tsinghua.edu.cn/.../login/form/<id>/0`（17524 字符，带 SM2 公钥）。
网关会话仍有效时，同一请求被 302 到网关自己的页面（网络学堂应用页 2760 字符，或门户首页
4891 字符，正文含「个人信息 / 注销」），OAuth 根本不开始，解析器只能报 `unexpected-page`。

而每次尝试前的清仓只清 `id.tsinghua.edu.cn` 与 `oauth.tsinghua.edu.cn`（刻意保留
webvpn/learn/info 的会话票），所以重试多少次 landing 都不变——这解释了「十分钟内重试不变成功」。
现场日志里同一天有干净的 A/B：

| 时间 | 入口 | 终到 | 后续 |
| --- | --- | --- | --- |
| 15:08:16 失败 | `/login?oauth_login=true` | `webvpn…/https/<learn-hex>/f/wlxt/…`，2760 字符 | 无 OAuth、无凭据 POST → `unexpected-page` |
| 16:25:16 成功 | 同一条命令 | `oauth…/thu-oauth/auth` → `id…/login/form/<id>/0`，17524 字符 | `POST …/login/check` 200 → session-established |

补一条 2026-10-23 现场：首次恢复只清了 `webvpn.tsinghua.edu.cn` 后缀，重取后落到门户首页
（正文「个人信息 / 注销」）——**wengine 票挂在 `.tsinghua.edu.cn` 上，按 webvpn 后缀匹配不到**。
所以可靠恢复必须先 `GET https://webvpn.tsinghua.edu.cn/logout`（与门户「注销」同一端点）
让服务端失效，再连父域一起清。

### 二、`@onethu/info-lib` 以 dist 被消费，修了 src 不生效

桌面端通过包导出读 `@onethu/info-lib` → `dist/index.js`，不是源码；而离线回归测试用 tsx 直接
读 src。于是「测试全绿 + 应用里一行新逻辑都没跑」可以同时成立：
修复提交后重新构建、重启、复测，仍然报原错误，原因是 `packages/info-lib/dist` 停在改动前
（src 12:44 / dist 10:35）。`@onethu/core` 走源码（vite `optimizeDeps.exclude`），两者口径不同。

### 三、未提权的未签名 dev exe 在 `%APPDATA%` 下写不进去

同一台机器上，非提权启动的 dev 构建里：运行日志一行不写、导览的权限选择存不住、
`state` 文件不落盘，而窗口、网络、登录都正常；用管理员终端启动后全部恢复。
该路径上的两处设计让故障**完全静默**：`debug_log_line` 在路径不可用/写入失败时静默 return，
`privacy_consent_write` 的错误只以一条通用文案抛给界面。
正式安装包未复现。

## 修改

- 登录入口改走 `platformFetchWith` 取**终到 URL**；`isGatewayLanding` 认三种形态：
  `/https/<hex>/…`、`/http-<port>/<hex>/…`、门户首页 `/`。裸 `/login`（200 且无跳转）不算——
  那是网关自己也没登录。
- 命中网关登录态时：先 `GET /logout`，再按 `webvpn.tsinghua.edu.cn` + `tsinghua.edu.cn`
  两个后缀清原生 cookie 仓与 JS jar，然后只重取入口一次。宿主没接钩子或清不动则完全回退原判定，
  后端语义不变。
- 新增 `LoginPreparationReason = "gateway-session-pinned"`，与「登录页变体」区分。
- 新增 `InfoHelper.onAuthEntry` / `onAuthPageSnapshot` 两个钩子：前者只回脱敏落点与判定，
  后者在**无法识别的认证页**分支回页面原文，由宿主落盘。回调异常不影响登录判定。
- 桌面端：`nativeCookieClearDomains(suffixes)`；日志记 `AUTH-PHASE gateway-clear`、
  `AUTH-ENTRY gateway= cleared= retried= status= chars= final=<origin+path>`、
  `AUTH-SNAPSHOT <path>`；诊断摘要新增「登录入口」与「本机写盘」两行（后者用
  `state_write` → `state_read` 回读校验）；中英文案 `login.error.gatewaySession`。
- 新增 `tools/ensure-info-lib.mjs`，挂到 `apps/desktop` 的 `predev` / `prebuild`：
  按 mtime 判 src 与 dist 新旧，落后才跑一次 tsc（新鲜时约 10ms 返回）。
- 新增 `dev:app`（根与包各一条）：macOS 委托既有 `.app` wrapper，Windows/Linux 起
  `tauri dev`；Windows 另把 WebView2 数据目录指到仓库内 `node_modules/.cache/onethu-webview2`，
  并在 5180 已占用时提前报错。

## 验证

| 范围 | 结果 |
| --- | --- |
| 登录离线回归 `pnpm run test:login` | 37 项通过（新增：清一次重取成功、无钩子回退、清不动回退、清完仍落地报新 reason、id 域不触发、门户首页恢复、裸 `/login` 壳不误判） |
| 登录准入与设备身份 | 28 项通过 |
| 网络日志隐私 | 23 项通过 |
| info-lib `tsc -p . --noEmit` | 通过 |
| 桌面生产构建 | `vite build` 通过 |
| i18n | 中英各 7589／7589，errors 0；`lint:docs` 0 处违规 |
| 注入验证 | 把 `isGatewayLanding` 改成恒 false 时用例 31/34 失败；恢复后文件 SHA-256 与注入前一致 |

`dev:app` 实测：vite `:5180` → cargo → `onethu.exe`，约 20s 出现可见的 `Tauri Window`，
WebView2 数据目录落在仓库内。`desktop` 的 `tsc` 仍有 `packages/gui` 的 React 类型报错
（缺 `@types/react`，既有环境问题，`apps/desktop/src` 无报错）。

## 未验证 / 不能声称

- **`%APPDATA%` 写入被拒的阻断者没有定位**。已证明的是「非提权写不进、提权可写」，
  用户判断为 Windows Defender，本轮未取证。
- **修复生效与 HMR 的关系未确认**。已证明 dist 曾陈旧；至于最终是 HMR 把新模块推进运行中的
  页面，还是用户重载了页面，没有证据。
- **恢复链在真实校园网关上没有独立验收**。37 项是离线夹具；用户随后登录成功，但与
  「logout + 父域清票」的因果关系未确认（也可能是网关会话恰好到期）。
- **门户首页对匿名访客是否也返回**未验证。若匿名态同样返回门户首页，`path === "/"` 判据会在
  该状态下多做一次清理与重取，代价是额外一次请求，不会误报成功。
- 早前把「十分钟内重试不变成功」归因于 `libSoftRelogin` 的指数冷却属于猜测：手动登录走的是
  20 秒冷却，两者不是同一条路径。

## 复跑与排查手册

1. 先确认产物：`packages/info-lib/dist` 是否比 src 新（`predev` 会自动处理），
   或直接搜 `gateway-session-pinned` 是否在 dist 里。
2. 复现后看 `%APPDATA%\app.onethu.desktop\logs\onethu-debug.log`：
   `AUTH-PHASE gateway-clear` 出现但随后仍 302 回 webvpn 页面 ⇒ 网关未真正登出；
   `AUTH-ENTRY … final=id.tsinghua.edu.cn/…` 且 `chars` 不是 17524 ⇒ 登录页变体，改解析。
3. 日志为空时不要当「没有动作」：先看诊断摘要的「本机写盘」，`失败：…` 说明整个应用数据目录
   不可写（先用提权终端对比），`ok` 才说明日志链路本身有问题。
4. 未识别页面已自动留证在 `%TEMP%\onethu-tmp\<pid>-<stamp>-<n>\auth-entry-<time>-<reason>.html`，
   文件头有 `reason / stage / final / chars`。文件含学校页面原文（可能有隐藏令牌），
   只在本机用于排障，看完删除，不进任何上报口径。
