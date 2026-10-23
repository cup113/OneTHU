# 开发者中心

中文 · [English](en/developers.md)

0.11 主力开发分支为 `dev3`。先阅读 [架构](architecture.md)、[插件指南](plugin-development.md)、[生成 API 清单](api-surface.md) 与 [OH / 清小搭](oh-and-xiaoda.md)。[贡献者与主要贡献者](contributors.md) 来自可重复的 Git 历史统计。

## 本地运行

需要 Node.js 20+、pnpm；原生运行另需 Rust stable 和对应平台的 Tauri 2 系统依赖。Android 另需 JDK、Android SDK 与 NDK，具体路径由构建脚本读取。

```bash
git clone --recurse-submodules https://github.com/smartThise/OneTHU.git
cd OneTHU
git switch dev3
git submodule update --init --recursive
pnpm install
pnpm dev
```

`pnpm dev` 只启动 Vite 前端。使用模拟数据浏览界面，不代表已经验证原生网络、文件、凭据或技能 IPC。

桌面端用 `pnpm dev:app`：一条命令起原生壳，前端由 Tauri 的 `beforeDevCommand` 自己拉起，因此不要再单独跑 `pnpm dev`（vite 钉在 5180 且 strictPort，占用会让启动中止）。macOS 走 `.app` wrapper（TCC 只认 bundle），Windows/Linux 走 `tauri dev`；Windows 上还会把 WebView2 数据目录指到仓库内可写的 `node_modules/.cache/onethu-webview2`，避免默认 profile 出现「进程在、窗口不来」。

```bash
# 桌面端开发（macOS 走 wrapper，Windows/Linux 走 tauri dev）
pnpm dev:app
# 前端开发构建 / 桌面原生开发包
pnpm --filter @onethu/desktop build:dev
pnpm --filter @onethu/desktop tauri:build:dev
# Android 开发包：脚本需要 Bash（Windows 可使用合适的 Bash 环境）
pnpm --filter @onethu/desktop android:dev
```

平台依赖请按 [Tauri 官方先决条件](https://v2.tauri.app/start/prerequisites/) 安装。详细变体、签名和路径说明见 [开发构建](dev-build.md)；Android 见 [release 陷阱](android-release-traps.md)。不要把签名、Token 或密码提交到仓库。

## 工程与扩展入口

| 位置 | 职责 |
|---|---|
| `apps/desktop` | React 应用、Tauri 宿主、桌面与 Android 入口 |
| `packages/core` | 校园服务客户端与统一业务模型 |
| `packages/gui` | OneGUI 组件、石墨令牌、主题和动效 |
| `apps/desktop/src/plugins/types.ts` | 插件 API 类型真源 |
| `apps/desktop/src/plugins/facade.ts` | 宿主 API 与权限门面 |
| `plugins/OneTHU-Harness` | 独立 Rust Agent 子模块 |
| `tools` | 构建、提取、测试、模拟数据采集 |

普通插件、OH 工具、外部 MCP 与清小搭技能不是同一种运行方式。QuickJS 只运行纯同步 JavaScript，限制为 2 秒、32 MiB、256 KiB 栈、64 KiB 代码/输入输出，无网络、文件、进程、模块或异步运行。重型技能导出到文件夹或 ZIP，由外部电脑 Agent 自行配置。桌面 Rust sidecar 不会自动适配 Android。

## 验证与贡献

```bash
pnpm typecheck
pnpm i18n:check
pnpm test:onboarding
node tools/docs-api-surface.mjs
python3 tools/contributors-report.py
pnpm lint:docs
```

按变更运行相关守卫，不要求无关代码机械增加测试。国际化提取后运行 `pnpm i18n:handoff`，翻译只修改交接批次指定文件。界面改动需要真实浏览器验收横竖屏、滚动、点击、键盘与减少动态效果；构建通过不等于真机已验收。

公共截图使用 [模拟采集流程](screenshots.md)。账号密码、校园返回的个人资料、Token 和二维码不能出现在截图、日志或夹具中。

开发者可在 [官网开发者页](https://onethu.github.io/developers.html) 找到构建、插件、Harness、API、OneGUI 与贡献者入口。许可包含非商业与禁止攻击清华信息服务的附加限制，以 [LICENSE](../LICENSE) 原文为准。
