# Harness Runtime 与客户端

首次使用桌面版请看[开始使用 Harness](docs/start-here.md)，包含界面入口、AI 连接、素材授权、制作与中断恢复。`0.1.0-dev.1` 尚为待发布候选，实际发布状态以软件更新页为准。

面向用户的产品说明见[根目录 README](../README.md)，中文设计、当前升级规划与发布口径从[文档导航](../docs/zh/README.md)进入。本页说明当前包的开发与运行方式。

This package loads frozen `process/0.1` YAML definitions and derives stage and milestone states from immutable evidence snapshots. A stage completion records fingerprints for its `invalidated_by` artifacts; evidence, decisions, and acceptance events remain separate records. See [the public format](docs/process-format-v0.1.md).

Run `npm test` for synthetic unit tests and `npx tsc --noEmit` for type checking.

## Interfaces

- `avh gui` opens the local GUI in an app window. On first launch it checks the host and guides the user through workspace, knowledge, tools, delivery, and AI-provider setup. AI providers are Codex CLI, Claude Code, and DeepSeek or Zhipu GLM (mainland or international) reached through pi, the pi coding agent CLI, with the person's own API key entered once in the wizard and stored outside the configuration ([docs/cli.md](docs/cli.md#pi-执行方deepseek智谱-glm)). On Windows, Claude Code signs in with a long-lived token (`claude setup-token`, which the GUI opens in a console window) or an Anthropic API key saved for Harness, never with the person's own login (see [docs/windows-handoff.md](docs/windows-handoff.md), D4). `avh gui install` adds a per-user launcher (a `.desktop` entry on Linux, a Start menu shortcut on Windows); `avh gui uninstall` removes only that launcher.
- `avh tui` opens the keyboard-first terminal interface. The default pages are Home, Projects, Assets, Background, Core, and Settings; project screens show a human-oriented overview first and keep raw stages and evidence behind `t`.
- Both interfaces use the same user-owned Runtime API and state database. The GUI host binds only to `127.0.0.1`, requires a random session token, and never exposes the Runtime's endpoint (a Unix socket on Linux, a named pipe on Windows) to web content.

Native Tauri packaging, Linux prerequisites, and release checks are documented in [docs/linux-gui.md（已改写为中文，见决定 D-23）](docs/linux-gui.md（已改写为中文，见决定 D-23）). The Windows backends (a Rust helper in `native/windows` for Job Objects, the Low integrity sandbox, integrity labels and login autostart), the NSIS installer and what has been verified on Windows are in [docs/windows-handoff.md](docs/windows-handoff.md).

## Host environment

`avh deps` lists what Harness needs on this computer and how the missing parts would be installed; `avh deps install` installs them (`--dry-run` only reports). The GUI's first-run step and the settings page show the same list, grouped, with one install button.

- Linux: missing distribution packages come from one `pkexec` + `apt-get` command (one password prompt), then the user-level VPM CLI install.
- Windows: a plan computed from what is on the computer runs every machine-level item in one elevated PowerShell (one UAC prompt): script execution policy, system-wide UTF-8 (on by default, can be unchecked; needs a restart), long paths, the winget packages (Git, Python, 7-Zip, .NET 8 SDK, Node.js LTS for npm, PowerShell 7, Unity Hub), Unity 2022.3.22f1 through Unity Hub's command line (Android/Quest support optional), and optionally Defender exclusions. Progress is reported per item; afterwards PATH is refreshed and the user-level steps run without elevation: `PYTHONUTF8=1`, the VPM CLI, and Codex, Claude Code and pi through npm.
- What stays with the person, each with a button: signing in to Unity Hub to activate a license, logging in to Codex (Claude Code's token is taken in the AI step), restarting after the UTF-8 change, and installing App Installer when winget is missing.

The Windows elevated script has been run only as a dry run on the development machine (Windows 11 Pro 10.0.26200, not elevated); a real run on a clean account is still to be verified. Details and limits: [docs/windows-handoff.md](docs/windows-handoff.md) §2 and §8.

## Build, package and local check

A source checkout runs the TypeScript directly (`node bin/avh.js …`). The packed package ships only compiled JavaScript: `npm run build` compiles `src/` into `dist/`, copies the migrations and the `.mjs` child-process entry points (rewriting their relative `.ts` imports), records the commit in `dist/build-info.json`, and copies the repository's license files. On Windows it also builds the helper (`npm run native:build`, which needs Rust) and copies `avh-win.exe` and `avh-win-launch.exe` into `dist/native/`. `npm pack` runs the build first. The package stays `private` so it cannot be published to the npm registry by accident.

`npm run check` stands in for CI, because Harness branches are not pushed before release. It runs the type check and unit tests, builds, packs, installs the tarball under a clean `HOME`, and then runs the installed `avh --version`, `avh doctor` and a state-database round trip (plus the GUI launcher: the `.desktop` entry on Linux, the Start menu shortcut on Windows, which also shows that the packaged helper is found). Options: `--integration` also runs the host integration tests (systemd, bwrap, real CLIs); `--skip-tests`; `--keep` keeps the temporary directory; `--log <file>` keeps the log. `avh --version` prints the package version, the build commit, the highest state schema the Runtime can open, and the Node version.

## Task proof records

`requestHumanRedo(db, taskId, reason)` records a human-authored `requested_redo` event for a waiting Task. The scheduler then moves that Task to `READY`. Gate decisions, warning acceptances, and accepted out-of-bounds changes record ordered human evidence events when written. Approval requires an applicable event after the Task entered `WAITING_HUMAN`, bound to a current artifact hash.

`Scheduler.cancelTask(taskId, reason)` asks the verifier to stop a Task in `VERIFYING` and moves it to `CANCELLED` only after `Verifier.cancel(spec)` returns `confirmed`. A verifier without `cancel` cannot confirm that stop. Stage completions now identify the Run that produced them; legacy completions remain readable but cannot prove a later Task passed.
