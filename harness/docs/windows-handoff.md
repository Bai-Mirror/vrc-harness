# Windows RC 接手说明（RC-W）

本页写给在 Windows 上继续开发 Harness 的人：Windows 端做到了哪里，平台相关的代码在两个平台上各自怎么实现，哪些已经在实机上验证过，还有哪些没做。凡是「能/不能」「成功/失败」的结论，都注明是在哪个环境测到的；换了环境要先复测。

## 1. 现状

### 09-30 增量：Unity 受管短执行路径

真实原图工程中，一张存在且摘要正确的 PNG 在 265 字符绝对路径下被 Unity 2022.3.22f1 的 `File.OpenRead` 拒绝；系统长路径配置不足以解决该读取及构建缓存问题。Runtime 现在为每次 Unity 启动创建本机用户目录中的短 junction，仅替换 `-projectPath` 和 `AVH_PROJECT_DIR` 的执行拼写。工程原位置、授权、写边界与产物核验仍指向同一个物理工程，用户无需搬工程。

入口使用独立 Medium 完整性目录和来源标记；启动前核对目录/链接身份及物理目标，遇到替换拒绝使用。编辑器忙碌检查按真实物理目标识别两种路径。确认编辑器退出后只移除自有 junction 与标记，不递归删除工程；未知残留不被下一次启动复用。完整 SDK 的真实受管启动、Low 边界及真实长路径商业贴图的导入读回已通过；脸型来源/预览和性能副本的身份消费者仍在兼容复验，这不是原图全流程产出通过。

### Windows（09-29，`harness/rc-windows`）

四个平台后端、后台服务、TUI/GUI 入口和桌面安装包都有了 Windows 实现，与 Linux 实现并存，按平台选择；Linux 行为不变。

- 原生辅助程序 `native/windows`（Rust，产出 `avh-win.exe` 与 `avh-win-launch.exe`）承担 Node 够不到的 Win32 部分：
  - 命名 Job Object，监管 Run、检查与 Unity；
  - 受限令牌加 Low 完整性，作为写边界；
  - 完整性标签；
  - 进程命令行；
  - 登录自启动项。

  `npm run build` 在 Windows 上会构建它并放进 `dist/native/`；从源码运行前先执行 `npm run native:build`。
- Claude Code 作为执行方启用（D4，见第 3 节）：每个 Run 有自己的 Claude 配置目录，用你为 Harness 保存的长期令牌或 Anthropic API Key 登录，不读写你自己的 `~/.claude` 与 `~/.claude.json`。
- 桌面版是按用户安装的 NSIS 安装包（`npm run tauri:build`）：
  - 不需要管理员，装在 `%LOCALAPPDATA%\Harness`，自带 Node 与辅助程序；
  - 升级时先清掉旧版 GUI 文件，卸载后不留安装目录；
  - 用户数据在 `AVH_HOME`（默认 `%LOCALAPPDATA%\avh`），卸载不动它。
- 首次配置接管整台电脑的环境准备：一次管理员授权（一次 UAC）完成所有机器级的安装和设置，之后不需要授权的部分自动做完，只留下必须本人做的事（第 2 节）。
- 验证（第 5 节）：
  - Windows 11 上单测 0 失败，本机 CI 全部通过；
  - 桌面安装包装好后能走完首次配置，BOOTH 登录窗口能读出会话；
  - Linux 回归在 WSL2 Debian 13 上跑，结果与未改动的基线一致。

### Linux RC 与首个开发版（背景）

- Linux TUI RC 在 `harness/rc-linux` 分支上开发（基于 `harness/dev`，已合入 WP10c/11/12）。
- 已完成（Linux 宿主机，Node 24.19，Unity 2022.3.22f1）：
  - L1 可安装包：`npm run build` 出 `dist/`，`bin/avh.js` 有源码时跑源码、否则跑 `dist/`；`node scripts/check.mjs` 做类型检查、单测、打包、干净 HOME 安装后的 `--version` / `doctor`。
  - L2 受管检查：检查命令异步、精简环境变量、bwrap 只读挂载工程、锁内验证。
  - L3 正式 Workflow：流程定义 ＋ 能力清单 ＋ 输入 Manifest 冻结；rule 求值（缺数据即 no_data）；观测 → Verdict；方案版本；工具文件按哈希冻结。见 [workflow-runtime.md](workflow-runtime.md)。
  - L4 服务与本地接口 v1：`avh service run|start|stop|status`，Unix 套接字 NDJSON 接口。见 [local-api.md](local-api.md)。
  - L5 TUI（Ink 7）：`avh tui`，经本地接口读写，不直接碰状态库。
  - L6 业务能力：13 个阶段的动作与观测在开发工程上逐段跑通，现在随内置能力包分发（第 4 节）。
  - L7：Kaguya ＋ Re-Poppin'Cat ＋ Medical Melty Nightmare 经服务与 TUI、由正式 Workflow 跑到 UPLOAD_READY（13 个阶段、三道 Gate 经 TUI 批准，交付包 17 项检查与性能 10 项全过）。
- 09-28 开发者预览收口与 09-29 首个开发版 0.1.0-dev.1 的内容见根目录 `CHANGELOG.md` 与各提交说明。这两版在 Linux 上都**没有**用内置包跑过真实 Unity 端到端。
- 推送时的验证（`77a8fc4`，Linux 宿主机 Ubuntu 26.04、Node 24.19）：本机 CI 12/12；`AVH_SYSTEMD_IT=1` 全量 513 项，508 过、0 败、5 跳（需要真实 codex/claude）。

## 2. 在 Windows 上起步

用桌面版的人不需要先准备任何东西：首次配置的第一步会检查电脑，把缺的东西一次装好（下面「一键配置」）。

从源码开发还要：Node ≥ 24、Git、Rust（rustup，`x86_64-pc-windows-msvc`）与 Visual Studio 的 C++ 生成工具。其余（Python、7-Zip、Unity 2022.3.22f1 等）可以由 `avh deps install` 装。

Codex CLI 可选，要先 `codex login`；pi 可选（npm 包 `@earendil-works/pi-coding-agent`，旧名 `@mariozechner/pi-coding-agent` 已弃用），密钥在首次配置或设置页里填，它的 bash 工具要 Git Bash。

```powershell
cd vrc-harness\harness
npm ci
npm run native:build                 # Windows 辅助程序
npm test
npm run check                        # 本机 CI，含打包后在干净用户目录里安装
node bin/avh.js deps                 # 依赖状态与这台电脑的配置计划
node bin/avh.js deps install --dry-run   # 演练：不提权、不做任何改动，只报告会做什么
node bin/avh.js gui                  # 或 tui；首次运行进配置向导
npm run tauri:build                  # 桌面安装包：src-tauri\target\release\bundle\nsis\
```

`AVH_HOME` 默认是 `%LOCALAPPDATA%\avh`（D9：路径要短，不能在云同步目录里）。后台服务用 `avh service start|stop|status`；`avh service install` 把它设为登录后启动（`HKCU\...\Run`）。

正式服务启动和 `doctor` 会在实际 HOME、Run 根和工作区检查安全标签，检查失败时不启动调度。失败不是「目录不可写」，而是这个进程不能给该目录写完整性标签：卷不支持完整性标签（exFAT、FAT32、部分网络盘）、安全软件拦截、目录 ACL 只有继承的「修改」权限（缺少写所有者权限），或令牌缺少 `SeRelabelPrivilege`，都会这样。GUI/CLI 直接显示失败路径、系统错误与中文处理办法（确认「完全控制」、改用本地 NTFS 卷、检查安全软件）。Harness 不自动改写原目录 ACL，不降低隔离要求；现有工程中另有受限 ACL 时，实际 Run 仍会在启动命令前拒绝并显示同样的提示。默认本地 HOME 是推荐位置，不是禁止其他盘符。

受管 Unity 短路径按 Windows 文件句柄解析两端的物理目录；应用虚拟化导致的路径写法差异不算工程目标变化。Runtime 保存的原路径仍是观测与授权身份，所有权标记、随机绑定及下级链接拒绝继续生效。

### 一键配置（`src/windows-setup.ts`、`src/windows-setup-script.ts`）

计划按这台电脑的实际情况算出，已经满足的项目不出现：

| 项目 | 怎么判断已满足 | 怎么做 |
|---|---|---|
| 允许运行 PowerShell 脚本 | 对当前用户生效的执行策略（组策略 → 当前用户 → 本机）已是 RemoteSigned/Unrestricted/Bypass | 本机范围设为 RemoteSigned；PowerShell 7 另有自己的设置，同样处理。组策略锁定时列为「不能自动完成」；当前用户范围单独设成了限制值时，不提权改当前用户范围 |
| 系统级 UTF-8（默认勾选，可取消） | `HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage` 的 ACP/OEMCP/MACCP 都是 65001 | 写这三个值；需要重启，界面写明少数老程序可能乱码。注册表已改而系统还没重启时，提示重启并给「立即重启」按钮 |
| Python 默认 UTF-8（默认勾选） | 用户环境变量里有 PYTHONUTF8 | `setx PYTHONUTF8 1`，不提权 |
| 长路径 | `LongPathsEnabled=1` | 写注册表；Git 在场（或本次安装）时再设 `git config --system core.longpaths true` |
| winget 包 | 依赖检测没找到对应程序 | `Git.Git`、`Python.Python.3.13`、`7zip.7zip`、`Microsoft.DotNet.SDK.8`、`OpenJS.NodeJS.LTS`（只在要装 AI 工具而没有 npm 时）、`Microsoft.PowerShell`、`Unity.UnityHub`；一律 `--scope machine --source winget` |
| Unity 2022.3.22f1 | Hub 的安装目录（默认目录与 Hub 里设的第二目录）里有这个版本 | `"Unity Hub.exe" -- --headless install --version 2022.3.22f1 --changeset 887be4894c44`；Android/Quest 支持另勾（默认不勾），用 `install-modules --module android --childModules`。下载约 2.8 GB（Android 另约 1.8 GB），进度按 Hub 下载目录里安装包的大小显示 |
| Defender 排除（默认不勾） | 读不到（排除列表要管理员才能看），勾选时脚本里再判断 | 排除工作区与 `%LOCALAPPDATA%\Unity\cache`；界面写明代价：放进这些目录的恶意文件不会被实时发现。Defender 没在运行时不提供 |
| Blender（脸型设计，可选，默认不勾） | PATH 或 Program Files 的 Blender Foundation 目录内，`--version` 能报 Blender 版本；无需配置工作流路径 | 勾选后在同一次 UAC 中用 `winget install --id BlenderFoundation.Blender -e --silent --scope machine --source winget` 安装；脸型设计与表情补偿需要，保留原外形无需安装。09-30 已只读检测到本机 5.2.0 LTS，并通过发现、选项和安装计划专项；未执行真实安装与页面点击验收 |
| VPM CLI | `vpm --version` 能运行 | `dotnet tool install --global vrchat.vpm.cli`，不提权 |
| Codex CLI、Claude Code、pi（各自默认勾选） | 命令能报版本 | `npm install --global @openai/codex` / `@anthropic-ai/claude-code` / `@earendil-works/pi-coding-agent`，装到用户自己的 npm 目录，不提权 |

执行顺序：
1. 机器级的项目写成一个 PowerShell 脚本，只弹一次 UAC。
2. 提权进程不按文件名运行脚本：命令行上的引导代码读一次文件、核对 SHA-256，只运行核对过的字节，所以写入和提权之间文件被换掉也不会运行。
3. 脚本逐项运行，可以重复运行（每项先检查，满足就跳过）；一项失败不影响无关的项目，只跳过依赖它的项目（如 Git 装失败，就跳过 Git 的长路径设置）。同一时间只运行一个配置：另一个正在进行时，后来的什么都不做，报告「另一个 Harness 配置正在进行」。
4. 每项的状态（pending/running/done/skipped/failed、原因、消息、Unity 的下载字节数）和「需要重启」写进状态文件，Runtime 边运行边读，GUI 每秒刷新一次。
5. 结束后 Runtime 从注册表读 Machine 与 User 的 PATH，只补上自己还没有的条目，新装的工具不用重启 Harness 就能找到。
6. 再运行不需要授权的项目（Python 的 UTF-8、VPM CLI、AI 命令行工具，以及需要时当前用户的执行策略），然后重新检查。

UAC 被拒绝时什么都不做（包括不需要授权的部分），可以随时重来。脚本里来自这台电脑的文字（路径、包 id、版本）都先校验；路径用单引号，并把 PowerShell 认作单引号的四种字符都加倍。

只能由本人做的事，各有一个按钮打开对应的地方：
- 在 Unity Hub 里登录并激活免费的 Personal 许可证（找不到许可证时）；
- 登录 Codex（打开一个终端窗口运行 codex login）。Claude Code 在 Windows 上用为 Harness 保存的令牌，在选择 AI 执行方的一步取得；
- UTF-8 改过后重启电脑；
- 没有 winget 时：先试「启用 winget」（Microsoft 文档给的 `Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe`），不行就打开 Microsoft Store 的「应用安装程序」页面。Windows 10 1809 之前的版本不能用 winget，只提示更新 Windows。winget 不可用时，设置类项目照常做，软件包列为「不能自动完成」。

命令行：`avh deps` 列出依赖与计划；`avh deps install` 执行。
- `--dry-run`：不提权、不改动，脚本照常检查并报告会执行的命令；
- `--no-utf8`、`--no-python-utf8`、`--no-unity`、`--android`、`--defender`、`--without codex,claude,pi`：调整可选项。

Linux 仍是 pkexec + apt 一次授权，装的东西不变；`--dry-run` 只打印计划。

## 3. 平台后端对照

| 位置 | Linux | Windows |
|---|---|---|
| `src/host-platform.ts` | `/proc` 找进程 | 大小写不敏感的路径比较、OneDrive 检测（已有）；辅助程序列进程；npm 的 `.cmd` 包装改为直接起它调用的程序；冻结命令里的 `python3` 换成本机 Python；7-Zip 目录补进 PATH |
| `src/exec/run-supervisor.ts`、`windows-supervisor.ts` | systemd 瞬时单元，取消时整组停 | `avh-win unit` 持有命名 Job（`Local\avh-run-<id>`，关闭即终止），任务名存在当且仅当 Run 在跑；停止时先让 Job 不再接收新进程再终止，避免竞态 |
| `src/exec/write-boundary.ts`、`windows-boundary.ts`、`unit-wrapper.mjs` | bwrap：只读根、可写目录绑定、遮住控制接口与配置 | `lowil`：受限令牌加 Low 完整性。Run 的可写目录打 Low 标签，其中的 `.git` 打回 Medium（只读）。`AVH_HOME` 的 `run/config/state` 与桌面版的 WebView 数据打「Medium ＋ 禁止读」，Low 进程读不到（D13）。标签先记账再打；账本在 `AVH_HOME/state/labels`，Run 碰不到；收尾或取消时按账撤销，服务启动时清理中断任务遗留的标签 |
| `src/exec/check-runner.ts` | bwrap 只读根、tmpfs、断网 | 同样的 Low 令牌，放在检查自己的命名 Job 里，只有检查自己的临时目录可写；首版不断网（用户决定） |
| `src/exec/unity-launcher.ts`、`unity-steps.ts`、`windows-unity.ts`、`unity-batch-lock.ts`、`unity-license.ts` | bwrap 里起 Unity，flock 全机批处理锁 | `Unity.exe` 在 Low 下直接起（默认 D3D11）。`USERPROFILE/APPDATA/LOCALAPPDATA/TEMP` 指向 Run 目录，并复制 Hub 的许可证（V11）。批处理锁用独占打开的锁文件，**缺省在 `%LOCALAPPDATA%\avh-unity\unity-batch.lock`，即 `AVH_HOME` 之外、按账户一份**：它保护的 `LicenseClient-<账户>` 管道与 `Unity-LicenseClient-<账户>` 互斥量是全机按账户共享的，锁留在 HOME 里时另一个安装、另一棵工作树和开发测试各拿一把锁，谁都不串行（`docs/zh/工作区/证据/缺陷/19_跨车道Unity争用导致退出码199.md`）。它是**一组计数槽**（`AVH_UNITY_SLOTS`，Windows 缺省 2、Linux 缺省 1，`1` 时仍是原来那个单一文件）：能并行是因为已起来的客户端可以被共用——实测 Low 完整性的客户端同时服务第二个 Low 编辑器与一个普通完整性编辑器，而普通完整性的客户端对 Low 编辑器回 `Connection Refused; code: 0x8000000a`；Harness 的编辑器一律跑在 Low，所以本账户第一个需要客户端的是 Harness 时槽都能用。工程是否已被编辑器打开看 `Temp\UnityLockfile` 能否独占打开，**并且**看进程表：只在**没有任何 `Unity.exe` 命名本工程**（或只剩「操作系统已让它退出、内核还没回收」的残留）时才认为空闲；这是唯一能放进 `UnityProjectOccupancy` 的判据——`free` 才允许启动，`editor` 是活编辑器（等它有意义），`exiting` 是内核未回收的残留（进程表看得见它、`process.kill(pid,0)` 已说它不存在；它仍占着锁，**只有重启能清**，于是诊断直接写「请重启电脑后重试」并带 PID，**从不**去删仍被持有的锁文件），`locked` 是锁被占而无人认领。四种状态的诊断经 `evidence.guidance` 进 `unity_step_failed` 与 Run 结果。取消一个 Unity 任务时，Unity 单元的命名 Job 停稳之后还要**等该任务每个步骤打开的工程上确实没有活编辑器**（有界，缺省 15 秒）：还在跑就返回 `not_confirmed`（不把没停干净的树记成已取消），只剩残留才确认取消并写 `unity_editor_stuck_exiting`。另一账户的编辑器或用户自己开着的编辑器不受这把锁管，因此 `unity-license.ts` 认「授权客户端特征行 ＋ 退出码 199」，等持锁的授权客户端退出（至多 120 秒）后重跑（至多 2 次）；它还在时重跑没有意义——我们的 Low 完整性编辑器连不上它的客户端，自己的客户端也抢不到互斥量。仍不通过则把占用者和「关闭那个 Unity 或等它结束」写进 Run 结果与 `unity_step_failed`。打不了标签时以普通权限在 Job 里运行，并记下「未隔离」（D2） |
| `test/fixtures/unity-slot.ts`（开发夹具起真实编辑器） | Linux 直接起；Windows 走 `WindowsUnityLauncher.launchSync` | Windows 上夹具与产品步骤走**同一条启动路径**：同一机器级计数槽、同一个 Low 完整性 helper、同样的隔离 profile（`HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP` 指向夹具自己的 Run 目录，Hub 许可证按 `defaultWindowsHomeSeeds` 复制进去），以及工程与 Run 目录的 Low 标签；`planArgs()` 允许夹具自带 argv，并把调用方环境里的真实 profile 覆盖掉。原因是 Medium 编辑器会让本账户的授权客户端变成 Medium 的，而 Medium 客户端拒绝 Harness 的 Low 编辑器（`Connection Refused; code: 0x8000000a`），所以旧夹具能与在跑的 Run 互相打断；夹具起编辑器前一律先取槽（`waitUnityBatchSlot`，有界等待并报出在等什么） |
| `src/service/manager.ts` | systemd 用户单元 ＋ linger | 经 `avh-win-launch` 以无窗口控制台在后台启动；登录后启动写 `HKCU\...\Run`；停止时关闭调度进程的 stdin，让它在安全点退出 |
| `src/api/*` | Unix 套接字 | 命名管道（端点名按 `AVH_HOME` 派生）；Low 进程连接会被拒（实测 EPERM） |
| Provider | codex-cli、claude-cli、legacy DSH、agy | codex-cli 用它自带的 Windows 沙箱（`sandbox: self`）；claude-cli 在 Low 完整性沙箱里运行，配置目录在 Run 目录里，凭据按名字注入（D4，见下）；DSH、agy 只在 Linux（D5），`doctor` 写明原因 |
| pi-cli（`src/providers/pi.ts`） | bwrap（`outer`），bash 工具用 `/bin/bash` | 同一个 Low 完整性沙箱（`outer`，必须有）；npm 的 `pi.cmd` 包装解析为 `node` 加 pi 脚本；bash 工具用 Git Bash，取 Harness 所用 git 旁边那份写进 Run 内的 `settings.json`。Run 的环境照常按白名单，密钥由 `secretEnv` 在启动时补上 |
| 环境依赖 `src/environment.ts`、`windows-setup.ts`、`windows-setup-script.ts` | pkexec ＋ apt 一次授权 | 一键配置（第 2 节）：一个提权的 PowerShell 做完所有机器级项目，只弹一次 UAC，状态文件报告进度；之后刷新 PATH、做用户级安装。探测程序都在临时目录里运行（VPM CLI 的崩溃上报会往工作目录写 `Sentry\`）；启动 Windows PowerShell 时去掉 PowerShell 7 的 PSModulePath，否则从 PowerShell 7 窗口启动的 Harness 调不动 `Get-ExecutionPolicy`、`Start-Process` |
| GUI 入口 `src/gui/*` | `.desktop` 启动器 | 开始菜单快捷方式 `Harness (avh gui).lnk`（安装包自己的叫 `Harness.lnk`，互不覆盖）；浏览器用 Edge/Chrome 的应用窗口 |
| 桌面外壳 `src-tauri/` | DEB、AppImage；WebKitGTK 读 BOOTH Cookie | NSIS 按用户安装；自带 `node.exe`，以无窗口控制台启动；WebView2 读 BOOTH Cookie。两个 BOOTH 命令只授予主窗口在本次 Runtime 端口上的页面（两个平台相同） |

### Claude Code 在 Windows 上（D4）

Linux 上 Claude 用你自己的登录：bwrap 遮住 `~/.claude`，只留登录文件可写。完整性标签表达不了这种遮罩；复制登录文件也不行：OAuth 的刷新令牌会轮换，副本会让你自己的登录失效。所以 Windows 上（`src/providers/claude.ts`）：

- Run 在 Low 完整性沙箱（`lowil`）里运行，`CLAUDE_CONFIG_DIR` 指向 Run 目录里的 `claude-config`。它和 Run 目录一样在 Low 下可写。Claude Code 2.1.268 在设了这个变量时，把全局配置写到 `$CLAUDE_CONFIG_DIR/.claude.json`（读程序与实测一致）。
- 设置文件也生成在这个目录里（`settings.json`），写明与 Linux 相同的策略：只允许配置的工具，关掉钩子（`disableAllHooks`）和自动记忆（`autoMemoryEnabled: false`）。命令行参数与 Linux 相同：`--safe-mode`、`--setting-sources ''`、`--no-session-persistence`。
- 登录用你为 Harness 保存的凭据（`src/providers/secrets.ts`），经 `CommandSpec.secretEnv` 按名字注入，`command.json` 与 Run 记录里只有名字：
  - 长期令牌：`claude setup-token` 生成，作为 `CLAUDE_CODE_OAUTH_TOKEN`（凭据名 `claude-oauth-token`）；
  - 或 Anthropic API Key：作为 `ANTHROPIC_API_KEY`（`claude-api-key`）。

  两样都保存时只给令牌。都没有时，Run 在记录任何东西之前就被拒绝。
- Bash 工具经 Git Bash：`CLAUDE_CODE_GIT_BASH_PATH` 指向 Harness 所用 git 旁边的 `bash.exe`。PATH 上的 `bash.exe` 通常是 WSL 的。
  - `HOME` 在 Run 目录里，临时目录也在（执行单元对所有沙箱 Run 都这样设），`/tmp` 随之落在 Run 里。
  - Git Bash 的登录 shell 在 Low 下能运行，只往这两处写：`/etc/profile.d` 里唯一会写文件的脚本，只在 `HOME` 里有 `.bashrc` 而没有 `.bash_profile` 时补一个；bash 的历史文件只有交互 shell 才写。
  - `HOME` 由 Harness 事先建好：它不存在时，`/etc/profile` 会当作首次启动，在输出里打印提示。
- 提示词经 stdin 传入：Windows 的命令行最长 32,767 个字符，阶段提示词可能更长。
- Run 不继承任何 `ANTHROPIC_*`、`CLAUDE*` 变量：Run 环境本来按白名单，现在另外排除这两类（`windowsRunEnvironment`）。Harness 自己从 Claude Code 会话里启动时，那个会话的端点和令牌也到不了 Run。
- 探测：版本来自 `claude --version`（npm 的 `.cmd` 包装改为直接起 `claude.exe`，同样不带上述变量）；登录状态看是否保存了令牌或 API Key，不读 `~/.claude`。两样都在才算就绪。
- GUI：首次配置的 AI 步骤和设置里，选 Claude Code 后出现凭据面板。按钮在单独的命令行窗口里运行 `claude setup-token`，你在浏览器里登录后把令牌粘贴进掩码输入框保存（`secret.set`），之后只显示「已保存」，可以更换或清除；也可以改填 API Key。首次配置时还没有 Runtime，由 GUI 宿主把凭据存到同一个位置。

另有两处 Linux 实跑时修掉、Windows 上要留意的坑：Unity 的 IPC 套接字路径长度（Linux 的 `sun_path` 限制）；VRCFury 的 Harmony 补丁偶发在编辑器启动期崩溃，Runtime 对这类崩溃重试至多两次。

## 4. 内置能力包在 Windows 上

- 能力清单里写的 `python3` 在冻结命令时换成本机 Python（`sys.executable`），Windows 上的 Run 与检查都设 `PYTHONUTF8=1`。
- 能力包哈希：Windows 的 `stat` 不给 POSIX 权限。在 Windows 上，目录按 0755、文件按 0644 计算哈希，签名发行里可执行的文件记在包旁的 `<包>.modes.json`，按 0755 计算。这样同一个包在两个平台上哈希相同。Linux 与服务端的算法不变（服务端复用同一个文件）；`test/pack-hash.test.ts` 用固定哈希值检查。
- 仓库根目录的 `.gitattributes` 固定 LF：Windows 上 `core.autocrlf=true` 会把检出的文本改成 CRLF，改变内置包的哈希。
- C# 部分与平台无关；出图用编辑器默认图形 API，Windows 上是 D3D11。

## 5. 实机验证

Windows：用户的开发机，Windows 11 Pro 10.0.26200，Node 24.18.0，Unity 2022.3.22f1，codex-cli 0.158.0，09-27 至 09-29。

- 写边界可行，全程不需要管理员（V7、V7b、V8′、V22）：
  - 非管理员能自己生成受限 Low 令牌，写普通目录与 `%APPDATA%` 被拒，git commit 正常；
  - 能给自建目录打标签；「Medium ＋ 禁止读」的目录，Low 进程读不到；
  - 标签不跟随目录联接，Low 进程也建不了联接；
  - 撤销标签用空 ACL，每个文件约 150 µs。
- Job：终止能带走脱离的孙进程（V9b）。停止时先让 Job 不再接收新进程，在启动后 5、20、50、300 ms 各停一次，都拿到退出码 143。
- 命名管道：Low 进程连接被拒（EPERM）。
- Unity：`Unity.exe` 能在 Low 下以隔离的用户目录运行，复制过 Hub 许可证后批处理可用（V10、V11）。
- 单测：`npm test` 共 556 项，0 失败，30 项跳过（Linux 专属或需要真实 Provider）。本机 CI（`node scripts/check.mjs`）全部通过，包括：
  - 包里有两个辅助程序；
  - 干净用户目录下安装后的 `--version`、开始菜单快捷方式、`doctor`（「OS 级隔离可用（临时目录探测，Low 完整性）」）、状态库往返。

  `doctor` 这一步就是在检验打包后的程序能找到自带的辅助程序。
- 桌面安装包（NSIS）：
  - 按用户安装、升级安装、卸载都通过，卸载后不留安装目录；
  - 装好后能走完首次配置，GUI 起的后台服务正常；
  - 打开 BOOTH 登录窗口后，能从 WebView2 读出会话并存进配置；
  - WebView 数据目录打「禁止读」标签后重启，Cookie 仍在，BOOTH 页面照常加载；WebView2 的网络服务进程不在沙箱里，不受标签影响；
  - BOOTH 页面自己调用这两个命令会被拒。
- Claude Code（09-29，npm 版 2.1.268，Git for Windows 2.55；没有令牌，环境里去掉了所有 `ANTHROPIC_*`、`CLAUDE*`）：
  - 经辅助程序在 Low 下、用临时的 `CLAUDE_CONFIG_DIR` 运行：`--version` 正常；`auth status` 报未登录，配置目录是 Run 里的那个；`-p` 以 `Not logged in`（`authentication_failed`）干净失败，退出码 1，没有发出 API 请求（`duration_api_ms` 为 0）。
  - 不给提示词参数时，`-p` 从 stdin 读提示词。`--version` 不在配置目录里写任何东西。
  - 给一个假的 `CLAUDE_CODE_OAUTH_TOKEN`：Claude 用它登录，被 API 以 401（`Invalid bearer token`）拒绝，归为登录错误；Run 目录里只有 `claude-config/.claude.json` 及其备份，令牌值不在任何文件里。
  - 运行前后对比 `%USERPROFILE%\.claude`、`%USERPROFILE%\.claude.json`、`AppData\LocalLow`、`%LOCALAPPDATA%\Temp\Low`、`HKCU\Software\AppDataLow`、凭据管理器的目标列表和用户目录第一层：除了本机另一个 Claude Code 会话自己的会话记录，没有变化。Claude 写下的 `.claude.json`、`backups/`、`sessions/` 都在 Run 的配置目录里，它的临时目录在 Run 的 `tmp/` 里。
  - Git Bash 在 Low 下以登录 shell 运行：here-doc、`mktemp`、写 `HOME` 与工作目录都正常，写用户目录被拒；没有 MSYS 共享内存之类的报错。
  - 单测里，假的 claude 经 `UnitExecutor` 在 Low 下跑完整 Run：保存的令牌到达；令牌不在 Run 目录的任何文件里；环境里只有 Harness 设的 Claude 变量；写 `~/.claude`、`~/.claude.json` 被拒（EPERM）。
  - 打开 `claude setup-token` 窗口的命令行，用无害程序代替 Claude 验证过：路径含空格、括号和 `@` 时参数完整，窗口里没有 `ANTHROPIC_*`、`CLAUDE*`。
- 一键配置（09-29，同一台开发机，不提权）：
  - 提权脚本只在演练模式下跑过：真实脚本以普通权限运行，每项的检查照常执行，改动只报告不执行；
  - 测试里用替身程序模拟失败、winget 的退出码与耗时，验证了执行顺序、已满足即跳过、失败只跳过依赖它的项目、状态文件格式与运行中可读，以及引导代码拒绝运行被改过的脚本；
  - Unity 两步用替身 Unity Hub 在临时目录里真正运行过：Hub 收到的参数、下载进度、装好后的检查。真实的 Unity Hub 下载与安装没有跑过；
  - 生成的脚本经 PowerShell 自带的解析器检查：各种勾选组合都没有语法错误，只调用脚本自己的函数和已知命令；含各种引号、`$()`、分号的路径只成为一个字符串；
  - 这台开发机的演练计划是：Git 长路径（需要授权），Python UTF-8 与 pi（不需要授权），其余都已满足；
  - 未验证：真实的提权运行（UAC、winget 安装、注册表、执行策略、Defender）、Unity 的真实下载，以及在干净账户上从零开始走完。
- 用户实机试用（09-29，桌面安装版）：在依赖面板点「安装缺失项：vpm」，`dotnet tool install --global vrchat.vpm.cli` 装好了 `%USERPROFILE%\.dotnet\tools\vpm.exe`（0.1.28），不提权的用户级安装在真机上可用。
- pi（09-29，pi 0.73.1 与 0.87.1 各装在临时前缀里，未连任何真实模型服务）：
  - 在受限 Low 令牌下能启动；没有密钥时以 1 退出，报「No API key found」，归为 `auth`；
  - 对着本机 127.0.0.1 上的替身服务走完一次任务：`write` 工具写进工程，Git Bash 在 Low 下能跑，写工程外被拒（EPERM / Permission denied）；
  - 密钥进了命令的环境，`command.json`、`provider-request.json`、日志与会话记录里都没有它；
  - 两个版本的 JSON 事件、错误写法（「401 …」与「401: {…}」）都按同一套规则解析；这些做成了 `AVH_PI_CLI` 开启的测试。
- 未测：
  - 带令牌的 Claude 真实派工，以及 Bash 工具在 Low 下执行模型给的命令（需要你的令牌）；
  - pi 对真实 DeepSeek、智谱 GLM 的调用（需要用户自己的密钥）；
  - codex 自带 Windows 沙箱下的真实派工（V5，需要 `codex login`）；本机已有 codex 建的沙箱账户；
  - 经正式 Workflow 的真实 Unity 步骤与 H-003w；
  - Windows Terminal 与 conhost 下的 TUI（中文宽字符、输入法、粘贴、80×24）；
  - 长路径与非 ASCII 路径（V4、V14）；EditorPrefs 位置（V12）；打开中的工程再起批处理（V13）。

Linux 回归：WSL2 Debian 13，Node 24.21，bubblewrap 0.12.0，systemd 257，09-29。

- `AVH_SYSTEMD_IT=1` 全量 535 项，515 过、1 败、19 跳。
- 失败的是 `Unity bwrap keeps project writes while protecting Git metadata`：在未改动的基线 `4a40402` 上同样失败，原因是 bubblewrap 0.12 拒绝挂载到符号链接（`/bin/sh`）上，与 Windows 改动无关，已另立任务。
- 本机 CI 12/12。
- 这台 WSL 需要 `dbus-user-session`（`systemd-run --user` 要用户总线）和 `7zip`（归档测试）；缺它们时，同样的 10 项在基线上也失败。

## 6. 决定

- D1 宿主路线：原生 Windows 为主；WSL 只用来跑 Linux 回归。
- D2 写边界：受限令牌 ＋ Low 完整性（阻止级）。某个目录打不了标签时（如不支持 ACL 的卷），Unity 以普通权限在 Job 里运行，并记下「未隔离」，事后照常做越界扫描。降级原因写进 Run 目录的 `unity-isolation.txt` 与步骤证据的 `isolationNote`（哪个可写目录、哪个调用、什么系统错误）；撤销标签的二次失败同样记在那里，不覆盖降级原因、也不让编辑器已经跑完的步骤变成失败（账本留给服务启动时清理）。
- D3 原生辅助程序用 Rust，随 GUI 一起构建。尚未签名，发行前要签名，并观察杀软误报。
- D4 Claude 在 Windows 上启用，不复制也不读取你自己的登录：每个 Run 有自己的配置目录（`CLAUDE_CONFIG_DIR`），用为 Harness 保存的长期令牌或 Anthropic API Key 登录（第 3 节）。Linux 不变：bwrap 遮罩，沿用你自己的登录。
- D5 legacy DSH、agy 只留在 Linux。
- D6 Python 由用户安装（依赖面板经 winget 装 `Python.Python.3.13`），不附带嵌入式 Python。
- D9 `AVH_HOME` 默认 `%LOCALAPPDATA%\avh`。
- 检查沙箱首版不断网：Low 完整性不限制网络。
- D13 读隔离：`AVH_HOME` 的 `run/config/state` 与桌面 WebView 数据加「Medium ＋ 禁止读」标签，服务启动时和第一个 Low 进程启动前各做一次。
- **D7、D8 是保留的空号**：从未分配过内容，不是被撤销的决定。引用时必须先在此处登记，不得凭空编号。
- **D10–D12 已收口为已知限制（2026-10-02，决定 D-36），不再是待定项**，并须写进安装说明：
  - **D10 共享盘**：云同步目录之外的网络共享盘不受支持。Harness 只推荐本地位置；检测到云同步或共享盘路径时**明确拒绝并说明原因**（与 `rejectCloudSyncedPath` 一致）。
  - **D11 EBUSY 重试**：不做专门的退避重试。被占用文件按普通失败上报，保留现场并可重试，不静默重放已执行的动作。
  - **D12 工程 git 换行符策略**：不对用户工程做特殊处理。Harness 不擅自改写用户工程的换行符；其自身的提交按仓库既有 `.gitattributes` 规则处理。

## 7. RC-W 验收进度

1. 路线与安全设计（D1–D3）：已定，写边界、读隔离、Job 与管道已实测。
2. 四个平台后端的 Windows 实现，服务改为每用户后台进程、经命名管道提供同一套接口：完成。
3. TUI 在 Windows Terminal 与 conhost 下的核对：未做。
4. GUI：桌面外壳与安装包完成，经同一套接口接入。
5. H-003w：
   - 同一样例在 Windows 上到 UPLOAD_READY：未做；
   - 干净账户上安装、升级、卸载：本机按用户安装已通过；在另一个干净账户上尚未验证。
6. Unity MCP 首版选型验收（产品设计 18）：未开始，前提不变。
7. GUI 接入 MCP 前的受限入口：未开始。

## 8. 已知限制

### Windows

- Low 标签是全机的：Run 进行中，它的可写目录对本机所有 Low 进程可写。
  - 两个同时进行的 Run 之间，写入不受系统阻止；
  - Run 收尾时的越界扫描仍会查出写到工程外、但在同一仓库里的改动；
  - 要彻底隔开，需要给每个 Run 单独的受限 SID 并改 ACL。
- 检查与声明「无网络」的 Run 在 Windows 上都不断网。
- 需要「遮罩目录」的沙箱策略无法用标签表达；只要求检测级的会降为越界扫描。Linux 上用它的 Claude，在 Windows 上改用自己的配置目录，不需要它。
- Claude Code：
  - 令牌在 Claude 进程的环境里。模型经 Bash 工具运行的命令能不能看到它，取决于 Claude Code，未验证。它的 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 会把权限模式强制为默认，Harness 没有开。
  - 长期令牌有效一年（`claude setup-token` 自己的说明）。在 Harness 里清除只删掉保存的这一份，令牌本身到期前仍然有效。
  - Low 完整性只防写、不防读：Run 读得到你的文件，包括你自己 Claude Code 的登录文件（Linux 上同样读得到）。Claude 自己不会去读。
  - Run 里的 git 读 Git for Windows 的系统配置，读不到你的 `~/.gitconfig`，因为 `HOME` 在 Run 目录里。
  - Run 里的程序写不了你用户目录里的缓存（npm、pip 等），和其他 Low 完整性 Run 一样。
  - Workflow 创建时冻结执行方的探测结果：保存令牌之前建的 Workflow 不会派给 Claude，要新建。
- codex 用它自带的 Windows 沙箱，Harness 不再套一层。codex 首次使用沙箱时会自建本机账户，可能请求一次管理员授权。
- pi 的 shell 工具继承 API 密钥变量（两个平台相同）：模型能读到并用它联网。Run 收尾会把打印出来的密钥从日志与会话记录里换掉，但写进别处的拦不住；Low 标签也不限网络。
- 辅助程序与安装包未签名，开了「智能应用控制」或 SmartScreen 的机器可能拦截。
- 一键配置：
  - 提权部分只在演练中验证过（第 5 节），真实运行要在干净账户上验证；
  - UAC 里输入的是另一个管理员账户时，提权部分以那个账户运行：winget 包按 `--scope machine` 仍装给全机，但 Unity Hub 的下载目录和第二安装目录属于那个账户；不需要授权的部分仍装给当前用户；
  - Unity Hub 的命令行从 Hub 3.18 起标为弃用（仍可用；Unity 给的替代是实验性的 Unity CLI）。Hub 开着时不安装，要先退出；Hub 的退出码没有文档，以编辑器是否在磁盘上为准；
  - 刷新 PATH 只作用于发起配置的 Harness 进程（GUI 宿主或命令行），已经打开的终端要重开才看得到新装的命令。首次配置时后台服务在配置之后才启动，不受影响；在设置页补装时后台服务已在运行，要重启它（`avh service stop` 再 `start`）执行单元才看得到新装的工具；
  - 系统级 UTF-8 可能让少数不支持 Unicode 的老程序显示乱码，要重启才生效；
  - 没有 winget 时只提供「注册应用安装程序」和「打开 Microsoft Store」两个办法，不自动下载安装 App Installer。
- 桌面外壳被强制结束时，它起的 GUI 服务进程会留下（Linux 同样如此）。窗口正常关闭则一并结束；后台服务本来就设计为独立运行。
- BOOTH 对未登录的访客也发同名会话 Cookie，没登录就点「我已完成登录」也会显示保存成功（两个平台相同，已另立任务）。

### 从 Linux RC 带过来的

- 回归阶段已在 Play 模式里做几何贴合检测：`regression_pre` 调用 `AVH.Harness.HarnessFitStage.Run`，证据见[自动几何检测接通证据](../../docs/zh/工作区/证据/自动几何检测接通证据.md)。Play 口径的 T1/T4 与转台渲图仍未接，覆盖记录里逐项写明。
- 悬空引用按惰性槽、已登记来源可补、字节未改且所有已拥有来源都没有的厂商缺件、以及其余阻断分类；厂商缺件材质槽在装配时只有多出来的尾部空槽可自动移除，落在网格子网格槽位的必须交人决定，装配产物再由观察器独立复核为零断链。
- 业务链只在一个样例上跑过。该样例的鞋底穿模已被几何检测判为硬阻断（设计 24）；第二种结构的真实工程还没有回归。
- 调度空闲时每秒重扫产物成员，样例工程上约占 13–16% 单核（Linux 实测）；Windows 上文件状态调用更慢，先量一次再定是否要先做空闲降频。
- 产物指纹在一次 UPLOAD_READY 后变化过一次、触发整链重跑，触发文件已无法还原；现在每个新版本的事件会写明成员增删改。
- `sandbox: self` 的执行方只限写、不限读。Windows 上 codex 的沙箱账户能读什么由 ACL 决定，`AVH_HOME` 另有「禁止读」标签。
- 09-28 复评留下的（Linux 宿主机）：沙箱只防写、不防读，`~/.ssh` 等仍可读；需要网络的 Run 与宿主共享网络；仓库 config 里的 filter/textconv 驱动没有中和；BOOTH 物化请求不节流；AppImage 拉起的后台服务在窗口关闭后会失效（读码推断）。汇总见私有工作区的复评存档。
- 09-29 知识一致性证伪留下的：
  - outfit 没有设计输入通道；
  - setup-project 每次按基准重置；
  - menu 的 design.json 表达力有限；
  - regression 不测 p95；
  - package 的 client_checks 只接受固定 id。

  知识里已写成「遇到时停下交人」。
- 最终证伪（09-29）：
  - 知识包下载先整体读进内存；
  - GUI 悬停提示与部分报错仍透出机器理由；
  - 新建流程尚未运行时，闸门状态的措辞不准；
  - `--no-scheduler` 时的措辞不准。

  详见私有工作区。
