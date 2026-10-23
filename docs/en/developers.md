# Developer center

[中文](../developers.md) · English

The active development branch for 0.11 is `dev3`. Read the [architecture](architecture.md), [plugin guide](plugin-development.md), [generated API surface](api-surface.md) and [OH / Xiaoda guide](oh-and-xiaoda.md). The [contributor directory](contributors.md) is reproducibly derived from Git history.

## Run locally

Use Node.js 20+ and pnpm. Native development also requires Rust stable and the platform-specific Tauri 2 prerequisites. Android additionally requires a JDK, Android SDK and NDK.

```bash
git clone --recurse-submodules https://github.com/smartThise/OneTHU.git
cd OneTHU
git switch dev3
git submodule update --init --recursive
pnpm install
pnpm dev
```

`pnpm dev` starts the Vite frontend only. A fixture-based browser preview does not validate native networking, files, credentials or skill IPC.

The desktop app starts with `pnpm dev:app`: one command boots the native shell, and Tauri's `beforeDevCommand` starts the frontend itself — so do not run `pnpm dev` alongside it (vite is pinned to strict port 5180, and an occupied port aborts startup). macOS goes through the `.app` wrapper (TCC grants permissions only to a bundle); Windows and Linux run `tauri dev`, and on Windows the WebView2 data directory is pointed at the writable `node_modules/.cache/onethu-webview2` inside the repo, so a bad default profile cannot leave a live process with no window.

On Windows, if the desktop shell starts and sign-in works but **nothing persists** (no run-log lines, permission choices in the guide never saved, state files missing), rerun once from an elevated terminal to compare: as measured on 2026-10-23, the unsigned, non-elevated dev executable could not write under `%APPDATA%\app.onethu.desktop` at all (run log, consent and state files all lost), and elevation fixed it immediately. The diagnostic summary's "本机写盘 / local write" row reports exactly that (`state_write` → `state_read` read-back). Installed release builds are not affected.

```bash
# Desktop app development (macOS uses the wrapper, Windows/Linux run tauri dev)
pnpm dev:app
# Frontend development build / native desktop development package
pnpm --filter @onethu/desktop build:dev
pnpm --filter @onethu/desktop tauri:build:dev
# Android development APK; the script requires Bash
pnpm --filter @onethu/desktop android:dev
```

Install the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). The [detailed build reference](../dev-build.md) describes development variants, signing and paths. See [Android release investigation](../android-release-traps.md) for platform pitfalls; these detailed historical references are maintained in Chinese. Never commit signing keys, tokens or passwords.

## Source and extension entry points

| Location | Responsibility |
|---|---|
| `apps/desktop` | React application, Tauri host, desktop and Android entry points |
| `packages/core` | Campus service clients and shared business models |
| `packages/gui` | OneGUI components, Graphite tokens, themes and motion |
| `apps/desktop/src/plugins/types.ts` | Plugin API type source |
| `apps/desktop/src/plugins/facade.ts` | Host API and permission facade |
| `plugins/OneTHU-Harness` | Rust agent submodule |
| `tools` | Build, extraction, tests and fixture capture |

Application plugins, OH tools, external MCP servers and Xiaoda skills have different execution models. QuickJS supports pure synchronous JavaScript only, with a 2-second limit, 32 MiB memory, 256 KiB stack, and 64 KiB code and I/O bounds. It has no network, files, processes, modules or async execution. Export heavier skills to a folder or ZIP and configure an external desktop agent. Desktop Rust sidecars do not automatically work on Android.

## Validate and contribute

```bash
pnpm typecheck
pnpm i18n:check
pnpm test:onboarding
node tools/docs-api-surface.mjs
python3 tools/contributors-report.py
pnpm lint:docs
```

Run checks relevant to the change. Run `pnpm i18n:handoff` after extracting new messages; translators should modify only the assigned handoff files. Check UI changes in a browser at portrait and landscape sizes, including scrolling, clicks, keyboard access and reduced motion. A successful build is not physical-device acceptance.

Use the [fixture capture workflow](screenshots.md) for public images. Keep passwords, private campus responses, tokens and QR codes out of screenshots, logs and fixtures. The [public developer page](https://onethu.github.io/en/developers.html) links the build, plugin, Harness, API, OneGUI and contributor resources. Read the [license](../../LICENSE), including its non-commercial and no-attack restrictions.
