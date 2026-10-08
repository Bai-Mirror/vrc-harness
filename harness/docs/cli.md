# `avh` 命令行与本机配置

需要 Node 24 或更新版本。在 `harness/` 中运行 `./bin/avh.js`，或通过 package bin 运行 `avh`。命令使用 `AVH_HOME`；Linux 缺省为 `~/.avatar-harness`，Windows 缺省为 `%LOCALAPPDATA%\avh`。

```sh
avh --version
avh workspace init
avh doctor
avh deps [install]
avh update check [--channel dev]
avh update knowledge [--channel dev] [--install <发行 id>]
avh project import /workspace/ExampleProject --profile avatar-flow --json
avh project import-all --kinds client,private,history,sample
avh project list
avh project brief ExampleProject --out /tmp/brief.md
avh project archive ExampleProject [--check] [--json]
avh project share ExampleProject --purpose self --dry-run [--layers A,B] [--include C:_harness/sensitive/conversation.json]
avh project share ExampleProject --purpose others --out /tmp/example.7z [--permitted-only] [--acknowledge <路径>] [--recipient 收件人]
avh project restore /tmp/example.7z --check
avh project restore /tmp/example.7z [--as-copy] [--name 目录名] [--allow-network] [--expect new|update|same|conflict]
avh project restore --complete ExampleProject
avh project conversation ExampleProject --search '关键词'
avh booth sync [--deep] [--json]
avh booth pool [--json]
avh booth pool pin|unpin <版本>
avh booth pool remove <版本>... [--dry-run]
avh booth plan release <计划 id>
avh provider list --probe
avh workflow create ExampleProject --profile pc-recolor-outfit --manifest manifest.yaml
avh workflow stage-tool show|select <workflow-id> --stage <stage> --pack <id> [--expect-token <token> --note '原因']
avh workflow list
avh workflow show <workflow-id>
avh workflow cancel <workflow-id> --note '原因'
avh task add ExampleProject --spec task.yaml
avh task list --project ExampleProject
avh task show <task-id>
avh task accept-changes <task-id> --note '已审阅越界改动' [--path escape.txt]
avh serve --once
avh serve --interval 1000
avh service install | start | stop | status | uninstall
avh service run --interval 1000
avh gate list
avh gate approve <workflow-id>:<gate-id> --note '已检查当前版本' [--expect-hash <看到的哈希>]
avh gate reject <workflow-id>:<gate-id> --note '需要修改'
avh task redo <task-id> [--note '修改意见']
avh task recover <task-id> --no-side-effects --note '确认单元不存在且未启动'
avh task recover <task-id> --reconciled --note '已核对 Run 产物'
avh cancel <task-id-or-run-id>
avh knowledge check /path/to/knowledge
avh knowledge annotate /path/to/knowledge/thresholds.yaml --sop-editorial
avh knowledge annotate /path/to/knowledge/thresholds.yaml --sop-editorial --write
```

`workflow show|cancel` 与 `task show` 接受 id 的唯一前缀（CLI 和 TUI 显示的短 id）；正式 Workflow 的阶段任务用 `workflow show` 或 TUI 的任务详情查看，`task show` 会指过去。

`workflow stage-tool show|select` 在 dev.0.1 已关闭：只要候选会改变已冻结的工具字节，命令就以 conflict 拒绝，并说明观察实现的依赖尚未可靠声明（dev.1.3 提供）；请按 D-59 新开制作流程。

`--version` 显示包版本、构建时的提交（源码检出时取 git HEAD，带未提交改动时加 `+dirty`）、本 Runtime 能打开的最高状态库 schema 与 Node 版本。

`deps` 列出本机依赖的状态：用途、是否必需、缺失时怎么获取。`deps install` 把缺的系统包合成一次 `pkexec apt-get install`，只请求一次管理员授权；用户级步骤（如 VPM CLI）随后执行，需要人工安装的（如 Unity）只给出说明。

`update check` 向 Harness 服务端查询该渠道上更新的软件版本，只列出签名验证通过的发行，不自动下载。`update knowledge` 列出服务端已签名的能力包发行；加 `--install <发行 id>` 会下载、核对大小与 sha256、安全解包，再用受信公钥验签并核对内容哈希后安装。安装不等于启用：新 Workflow 仍用当前能力包，要切换请在 GUI 核心管理或 TUI 核心页操作，已在运行的 Workflow 不受影响。这两条命令都只在执行时联网，服务端会看到本机的网络地址。

`project archive` 刷新并检查项目的工程档案（工程内的 `_harness/`）：先刷新仍在推进的 Workflow 的产物指纹，再观察工程、遍历工程归类文件，把状态库的投影写入工程并读回校验，最后与状态库做一致性检查；`--check` 只检查不写。项目可用 id、目录或唯一的目录名指定。写入失败或档案与状态库不符（`diverged`）时退出码为 1。格式与协议见[工程档案](project-archive.md)。

`project share` 把项目编译成可以继续制作的 7z 工程包（格式见[分享包与同版恢复](project-share.md)）。必须指定 `--purpose self`（本人迁移/备份）或 `--purpose others`（交给他人）。本人备份保留工程内已导入的付费素材，包仅限本人使用，不得转交；交给他人时检查转交权，`--permitted-only` 可只分享获准内容并将其他 A 层文件列为“接收端待补齐”。A 层（接续必需）总在；`--layers A,B` 加入全部 B 层可选项，`--exclude <项>` 去掉个别项；C 层敏感内容只能用 `--include <项>` 逐项选入。`--dry-run` 只编译清单并显示等级、阻断项、纳入与排除、可选项的 id 和接收端待补齐。有待分类文件、凭据、未检查的本机路径或 Blueprint ID 时受阻，不产出分享包，退出码为 1；转交权阻断只适用于交给他人。本机路径、Blueprint ID、订单号逐个检查后用 `--acknowledge <路径>` 确认；凭据没有放行选项。导出按清单暂存复制、打包，再做 `7z t`、成员逐项比对和冷解包校验，全部通过才写到 `--out`（缺省为配置的第一个导出目录，没有时为 `AVH_HOME/exports/`，文件名 `<名称>-<用途>-r<修订>-<时间>.7z`）；已存在的文件不覆盖。`--unity-check` 另用配置的 Unity 编辑器以批处理模式打开冷解包的工程。`--recipient` 只适用于交给他人，且只记在本机状态库。

`project restore <分享包>` 在同版 Harness 里恢复：先检查成员路径、清单、`7z t`、隔离解包与哈希，再决定新项目、同一项目的更新或并列副本（本机已有同一分享时不恢复，`--as-copy` 另存一份），通过后才放置工程并重建状态库，最后输出对账。`--check` 只检查不写；`--expect` 带上检查时看到的方式，变了就拒绝；`--allow-network` 允许向 Harness 服务端查找并安装缺的签名能力包。缺能力包的 Workflow 恢复为待安装，装好后用 `--complete <项目>` 补完。检查不通过时退出码为 1。

`project conversation` 在项目的完整对话里检索（恢复时选入了对话才有）；结果只给人看，不交给 Agent。

`--json` 输出完整报告，受阻时也一样；`--progress` 在标准错误上逐行输出 `progress {…}`，本地接口用它跟进后台任务。
`booth sync` 经运行中的 Runtime 服务同步已购 BOOTH 商品的索引，只取元数据，不下载素材包，并显示进度与计数；服务没有运行时报错并提示 `avh service start`。BOOTH 请求由服务统一执行，每秒最多 1 次。缺省是快速同步：读完素材库列表后，只重新读取列表条目有变化或上次没读到的商品详情，只对新文件以及大小、版本线索或可用状态未知的文件请求跳转地址并探测大小；`--deep` 深度同步重新读取全部商品、探测全部文件。结束时按探测结果列出文件数，例如 `head:http-403 range:ok` 表示 HEAD 被拒、一字节的 Range 请求取得了大小；大小仍未知的文件写明原因。`--json` 输出完整结果。

`booth pool` 列出 BOOTH 版本池（`AVH_HOME/materialized/pool/`）里的每个版本：sha256 前 12 位、大小、状态、来源与保留策略、引用它的计划与 Workflow、能否删除及原因。`pool pin|unpin` 固定或取消固定一个版本。`pool remove` 只删除没有任何引用、没有固定的 BOOTH 缓存版本的文件，其余逐个说明保留原因，有保留项时退出码为 1；`--dry-run` 只演练。版本用 sha256 或至少 12 位的唯一前缀指定；删除后版本记录仍作为历史保留。`booth plan release` 释放一个选择计划，它锁定的版本不再因这个计划保留。这几条命令直接读写状态库，服务在运行时使用也安全。版本池与缓存规则见[本地接口 · BOOTH 版本池](local-api.md#booth-版本池)。

`service` 子命令管理后台 Runtime 服务（调度＋本地接口），见[服务与本地接口](local-api.md)；TUI 经该接口工作。`gate approve/reject` 的 `--expect-hash` 表示只对你看到的那个版本作决定，产物已变化时拒绝。

`knowledge check` 扫描知识根中的阈值和流程定义：`tested` / `accepted` 条目缺少 `verification` 时列出 id 并返回非零退出码，同时显示按 `kind`、`verification.kind`、`visibility` 分组的数量。`knowledge annotate` 对有 `path:line@commit` 来源的条目计算 `source_id` 并补 `sop-editorial` 记录；默认仅预览，`--write` 才修改文件，无法取得原文的条目会单独列出。该命令直接使用所给路径，不读取本机配置。字段语义见[流程格式 v0.1.2 补遗](process-format-v0.1.md#9-v012-补遗)。

`workspace init` 创建 `config/`、`state/`、`reports/`、`runs/` 并写通用模板；已有配置原样保留。模板路径要替换为本机值后才能通过 `doctor`。导入报告保存到 `AVH_HOME/state/harness.db`，简报保存到 `AVH_HOME/reports/<报告 id>.md`；导入只读观察项目。`import-all` 逐个处理工作区顶层匹配命名规则的目录和历史目录下的项目，单项失败继续处理，最后列出失败原因并返回非零退出码。Windows 上 `AVH_HOME`、工作区和工程不能位于 OneDrive 同步目录；初始化、诊断、导入和创建任务会拒绝这类路径，建议移到本机未同步目录。`AVH_TOOL_PYTHON`、`AVH_TOOL_7Z` 和 `AVH_TOOL_GIT` 可指定工具命令；缺省从 PATH 查找。

| `config/harness.yaml` 字段 | 含义 |
| --- | --- |
| `workspaceRoot` | 工作区绝对路径 |
| `toolRoot` | 导入只读复核脚本所在目录的绝对路径 |
| `knowledgeRoot` | 流程定义、阈值和阶段规则所在目录的绝对路径 |
| `processDefinitions` | 流程 id 到定义文件路径的映射；值可为路径字符串，或 `{definition: 路径, stageRules: 路径, capabilities: 路径}`（后两项可选）；路径相对 `knowledgeRoot`。配了 `capabilities` 的流程可创建正式 Workflow，见[正式 Workflow 运行时](workflow-runtime.md) |
| `defaultProfile` | 批量导入及未指定 `--profile` 时使用的流程 id |
| `thresholdsFile` | `thresholds/0.1` 文件路径，供所有流程加载 |
| `stageRulesFile` | 可选的旧式阶段规则 YAML 文件路径，顶层按流程 id、次层按 stage id 分组；同一流程不能再配置 `processDefinitions.<id>.stageRules` |
| `exportRoots` | 工作区外的存档及交付根目录列表 |
| `knownBodies` | 可识别的素体名称列表 |
| `projectAliases` | 按项目目录名映射到该项目简称列表；例如 `ExampleProject: [ExampleAlias]`。列表写法会在加载时报错 |
| `sampleNames` | 样例项目目录名列表 |
| `stateDbPath` | 状态库路径；缺省 `state/harness.db`，必须位于 `AVH_HOME` 且在工作区外 |
| `import` | 可选的导入配置覆盖项；支持 `ImportConfig` 的命名规则、基准包、快照阈值、`decisionTables` 等；`toolRoot`、`exportRoots`、`knownBodies`、`projectAliases` 和 `sampleNames` 使用上述顶层字段 |
| `import.externalLedgerFiles` | 跨工程任务集内扫描的文件名通配列表；缺省 `[账本*.md, 停滞项_*.md, 待问用户*.md]` |
| `import.aliasGroups` | 组名到工程目录名列表的映射；勾选框主行未点名已知工程、只提组名时才展开成员 |
| `import.metaPrograms` | 长程任务目录名列表；列入的任务只在 `sample` 类工程简报显示，缺省为空 |
| `import.decisionTitlePatterns` | 时间线拍板标题正则列表；缺省 `[拍板]` |
| `providers` | Provider 列表；每项有唯一 `id`、`type`、`executable`、`roles`、`maxConcurrentRuns`、`writable`，可选 `sandbox`、`family`、`balanceCheck`、`model`、`effort`、`stateDirs`、`network`、`capabilities`、`toolRoot`、`sessionRoot`。同一 CLI 可有多个不同 id 的模型档位。`type` 可为 `codex-cli`、`claude-cli`、`pi-cli`、`legacy-dsh-task`、`agy`；`roles` 可含 `research`。`sandbox` 为 `self` 或 `outer`；Codex 与 DSH 缺省 `self`，Claude、pi 与 agy 缺省 `outer`，pi 只能是 `outer`。`self` 使用 CLI 自己的沙箱，`outer` 使用执行器的 Codex/bwrap 包装；两者在 Run 结束后都做越界扫描。`family` 为 `codex` 或 `dsh`，缺省 DSH CLI 属 dsh，其余属 codex。`balanceCheck` 是 dsh 系余额检查命令的 argv，退出码 0 表示高于储备线，非 0 表示不足，无法执行表示 unknown；不足或 unknown 均不派发。`model` 对应 Codex `-m` / Claude `--model` / pi `--model`，`effort` 对应 Codex `-c model_reasoning_effort=…` / pi `--thinking`。pi 另有 `upstream`、`baseUrl`、`secret`，见下文「pi 执行方」。`writable` 是 Provider 每次 Run 额外需要的可写目录；`stateDirs` 是 CLI 状态目录，二者都须已存在，支持 `~` 展开；CLI 状态目录不加入模型可写根。Run 的可写集合还包含任务 `allowedWrites` 与 Run 目录。`network` 缺省 `true`。Codex、Claude、旧 DSH 的 `stateDirs` 分别默认包含 `~/.codex`、`~/.claude`、`~/.dsh`；配置项会追加到默认值。旧 DSH 还须按本机配置加入槽位、快照及日志目录；agy 须显式配置自己的状态目录。所有列出的目录在加载时校验 |
| `providerPolicyVersion` / `providerProbeTtlMs` | 可选的路由策略版本及探测缓存毫秒数；缺省 `local/0.1` / `60000` |
| `contributionUpstream` | 可选 `{endpoint}`；只接受 HTTPS（或本机 HTTP）。每台安装向该服务器单独注册随机令牌，保存在本机凭据目录，不写入配置；用于把逐项授权的结构化候选评测报告回传服务器。服务器回执不在客户端触发晋升。 |
| `scanLimits.gitOutputBytes` / `scanLimits.hashBytes` | 可选正整数，单位字节；Git 状态输出上限缺省 256 MiB，疑似改动文件的内容哈希上限缺省 64 MiB |
| `routing` | 可选：默认按配置顺序选择满足角色、能力、健康、写权限、额度与并发约束的来源，不含个人工作时段偏好。`timezone` 缺省 `UTC`，`workdays` 与 `windows` 缺省空列表。显式配置周一=1 至周日=7 的日期列表及 `{start,end}` 的 `HH:MM` 时段后，才启用时段内 codex 系、时段外 dsh 系的高级策略。`codexQuotaThresholdPercent` 为兼容保留的字段名，缺省 85，适用于实际报告了用量的来源；未知用量不会伪装成零 |
| `unity` | 可选。`editor` 为 Unity 可执行文件的绝对路径，首次配置向导会写入它；只写 `editor` 就够了，它优先于 `runner`。旧写法用 `runner`：可以是 Unity 可执行文件，也可以是 `unity_run.sh`，后者只用来读出其中的本机 Unity 默认路径，Harness 从不执行它，这时 `UNITY_BIN` 可覆盖默认路径。`lockPath` 为与旧流程共用的 flock 锁文件绝对路径：Linux 缺省在 `AVH_HOME/state/unity-batch.lock`；Windows 缺省在 `%LOCALAPPDATA%\avh-unity\unity-batch.lock`，即 `AVH_HOME` 之外、按账户一份——它保护的 Unity 授权客户端（`LicenseClient-<账户>` 管道与 `Unity-LicenseClient-<账户>` 互斥量）本来就是全机按账户共享的，锁放在 HOME 里会让第二个 Harness 安装、另一个工作树和开发测试各拿一把锁而互不串行。锁是**一组计数槽**而不是一个文件：`AVH_UNITY_SLOTS` 给出槽数（缺省 Windows 2、Linux 1，上限 8），`1` 时就是上面那一个文件（Linux 的旧 flock 契约因此逐字节不变），大于 `1` 时第一个槽仍是 `<lockPath>` 本身、其后是 `<lockPath>.2`…`<lockPath>.N`（所以旧的一槽版本与新版至少会在第一个槽上相遇，而不是各锁一份互不相干的文件）；两个平台读同一个变量、用同一份计数代码。能并行是因为已经起来的客户端可以被共用——实测 Low 完整性的客户端同时服务第二个 Low 编辑器与一个普通完整性编辑器，而普通完整性的客户端会拒绝 Low 编辑器，所以本账户第一个需要客户端的是 Harness 时得到的是 Low 客户端。`busyExitCode` 缺省 5，`defaultTimeoutSec` 缺省 3600；`homeSeedFrom` 是真实 HOME 内要复制到隔离 HOME 的相对路径列表，可含目录；`projectScratch` 缺省 `[Library, Temp, Logs, UserSettings, obj]`；`passEnv` 缺省 `[DISPLAY, WAYLAND_DISPLAY, PATH, LANG, XDG_RUNTIME_DIR]`，显式配置时也始终补上 `PATH`，供 Unity 启动子进程；`XDG_RUNTIME_DIR` 让音频客户端找到音频服务，缺了它 Play 步骤可能卡在音频设备初始化 |

`provider list` 和 `doctor` 显示沙箱归属；`--probe` 调用本地 CLI 读取版本与可查询的登录态，额度无法确认时显示 `unknown`。`task add` 在创建时冻结探测和策略快照；配置变动只影响新任务。路由检查角色、能力、登录状态、周额度、DSH 余额及并发，再按时段偏好和配置顺序选择。Provider 占用数按其名下 `pending` 与 `running` 的 Run 统计，不按任务状态过滤；同一轮 `serve` 中，后续派发会看到前面已写入的 Run。占满时尝试下一个合格 Provider，否则任务记录 `route_waiting`：理由列出每个 Provider 的具体排除原因（如 `fake: concurrency 1/1`），并点名占用已满 Provider 槽的 Run、其所属任务及该任务状态；理由变化时才写新事件。`task show` 对 `READY` 任务显示「等待原因」（最近一次）和「等待开始」（本次进入 `READY` 后第一次记录等待的时间）。`provider_selected` 事件写明偏好、排除原因、最终选择及选择时的 `concurrency=n/max`。`serve --once` 只运行一轮；持续服务每 `--interval` 毫秒运行一轮。

同一状态库在同一时刻只允许一个 `serve` 调度周期推进状态。第二个 `serve --once` 会输出「另一个调度周期正在运行（持有者 …，到期 …）」并以 0 退出，不会进入周期；持续服务会在下一个间隔重试。周期租约写入状态库事件，运行中会续租；持有者退出后释放，崩溃留下的过期租约可由新周期接管并记录事件。正在运行的 Run 和 Unity 单元不会因调度租约而中断。

Provider 仅在退出码非零或结构化结果明确失败时分类错误；成功的 Run 不带 `errorClass`。限流信息包括 `rate limit`、`quota`、`usage limit` 等；数字 `429` 仅在邻近 `HTTP` 或 `status` 的状态码上下文中参与限流判定，路径和标识符里的数字不算。pi 的分类另见下文「pi 执行方」。

路由配置示例（命令和路径须按本机安装调整）：

```yaml
routing:
  timezone: Asia/Shanghai
  workdays: [1, 2, 3, 4, 5]
  windows:
    - {start: '09:00', end: '12:00'}
    - {start: '14:00', end: '18:00'}
  codexQuotaThresholdPercent: 85
providers:
  - {id: codex-daily, type: codex-cli, executable: codex, roles: [executor], sandbox: self, family: codex, model: gpt-6-sol, effort: medium, writable: []}
  - {id: codex-research, type: codex-cli, executable: codex, roles: [research], sandbox: self, family: codex, model: gpt-6-astra, effort: high, writable: []}
  - {id: dsh-daily, type: legacy-dsh-task, executable: node, roles: [executor], sandbox: self, family: dsh, balanceCheck: [/path/to/check-balance], writable: []}
  - {id: claude-research, type: claude-cli, executable: claude, roles: [research], sandbox: outer, family: codex, model: opus, writable: []}
  - {id: deepseek, type: pi-cli, upstream: deepseek}
  - {id: glm, type: pi-cli, upstream: zhipu, model: glm-5.3-flash}
```

### pi 执行方（DeepSeek、智谱 GLM）

流中断的恢复由同一 pi agent 会话承担：每次模型请求最多退避重试两次（5、10 秒），SDK 内层重试设为 0，避免层层放大；不自动重启整个 Run 或重放已经完成的工具。原生 HTTP 空闲超时为 5 分钟，请求超时为 10 分钟；Provider 的 `timeoutMs` 仍是整个 Run 的外层期限。取消会结束受监督进程树及退避。Windows 原生 PowerShell 工具避免 Git Bash 的 MSYS 共享对象在 Low 完整性令牌下拒绝访问。Runtime 注入宿主命令合同与真实工具列表同步，外层写边界保持生效。

运行日志中的 `auto_retry_start/end` 驱动正式项目的「AI 连接中断，正在退避重试」提示。重试耗尽后仍走原有工程核对和幂等恢复命令，无需重新描述要求。未确认执行、越界、已完成阶段和新版工具仍由原恢复条件检查，不把网络错误等同于没有副作用。

Run 结果保留 `connection.interruptions/retries`；流已经开始但未收到最终用量时标记 `usage.incomplete=true`，已完成用量仅加一次。**这只能防止本地任务和工具重复执行，不能保证厂商不会对中断的推理收费**；估算不包含未收到的用量，需查厂商账单。私有 stderr 中的 `harness_pi_transport` 仅记录请求序号、时间、HTTP 状态和标准错误码，排除 URL、头、请求体、凭据和模型文字；它是诊断证据，不授予恢复权限。


`type: pi-cli` 经 pi（pi coding agent 命令行，命令名 `pi`）用你自己的 API 密钥调用 DeepSeek 或智谱 GLM。它的 npm 包已从 `@mariozechner/pi-coding-agent`（最后一版 0.73.1）改名为 `@earendil-works/pi-coding-agent`；两者的命令都叫 `pi`，Harness 用到的参数与事件格式相同，0.73.1 与 0.87.1 都实测过。

| 字段 | 说明 |
| --- | --- |
| `upstream` | 必填：`deepseek`、`zai`（智谱 GLM 国际，z.ai）或 `zhipu`（智谱 GLM 国内，open.bigmodel.cn） |
| `model` | 缺省 `deepseek-flash`（DeepSeek）或 `glm-5.3-flash`（国内、国际 GLM）；普通文字与视觉任务均使用 Flash 默认值，不继承 pi 的文字模型默认值。高级选项可显式指定其他模型 |
| `imageModel` | 高级可选项：同一服务的图片任务模型；缺省使用该服务的 Flash 模型。不会更换服务、地址或凭据；实际请求模型记录在 Run 中 |
| `baseUrl` | 可选，替换接口地址；只接受 HTTPS（或本机 HTTP），不得含凭据、查询或片段。GLM 缺省走 GLM Coding Plan：国内 `https://open.bigmodel.cn/api/coding/paas/v4`，国际用 pi 自带的 `https://api.z.ai/api/coding/paas/v4`；没有 Coding Plan、按用量计费的密钥改为同一域名下的 `/api/paas/v4` |
| `secret` | 可选，密钥的凭据名；缺省 `pi-deepseek`、`pi-zai`、`pi-zhipu`。密钥在首次配置或设置页的「API 密钥」里保存（本地接口 `secret.set`），存在 `AVH_HOME/config/secrets/`，不写进 `harness.yaml`，保存后不再显示 |
| `effort` | 可选，对应 pi 的 `--thinking`：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`（`max` 要较新的 pi：0.87 有，0.73 没有）；缺省由 pi 按模型决定 |
| `allowedTools` | 可选，对应 pi 的 `--tools`；缺省为 `read`、`edit`、`write` 和宿主命令工具；Linux 用 `bash`，Windows Low 完整性沙箱用原生 `powershell`（需支持该工具的 pi，例如已验证的 0.87.1），显式列表中的 `bash` 在 Windows 同样映射到 `powershell`。`grep`、`find` 要本机装有 ripgrep、fd：Harness 不让 pi 在运行时下载它们 |
| `executable`、`roles` | 缺省 `pi` 与 `[executor, diagnostician, research]`，与首次配置的 Codex 相同，能承担正式流程的每个阶段 |

`sandbox` 只能是 `outer`：pi 没有自己的沙箱，Run 必须有 OS 级写边界（Linux 用 bwrap，Windows 用受限令牌加 Low 完整性），没有时在启动前失败，不降级为越界扫描。每个 Run：

- pi 的配置目录（`PI_CODING_AGENT_DIR`）与会话目录都在 Run 目录里（`pi-agent/`、`pi-sessions/`），不读写你的 `~/.pi`。启动参数带 `--no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes`，任何 `AGENTS.md`、扩展或技能都进不了提示词。`PI_OFFLINE=1` 关掉 pi 自己的更新检查、遥测、模型目录刷新与工具下载，不影响对模型服务的请求。
- 任务说明写在 Run 的 `task.txt`，从标准输入交给 `pi --mode json`，长度不受命令行限制，以 `-` 或 `@` 开头也不会被当成参数。
- 密钥在命令启动时以 pi 读取的环境变量（`DEEPSEEK_API_KEY` 或 `ZAI_API_KEY`）注入，`command.json`、`provider-request.json` 只记凭据名。pi 的 shell 工具会继承这个变量；模型若把它打印出来，Run 收尾时会从 `stdout.log`、`stderr.log` 与会话记录里替换成「[凭据已隐去]」，再解析结果。
- GLM 国内是把 pi 的 `zai` 指向 open.bigmodel.cn（Run 内的 `models.json`），`baseUrl` 也写在那里。
- Windows 上 pi 的 bash 工具用 Git Bash：与 Harness 用的 git 同一份，写进 Run 内的 `settings.json`。

`--mode json` 下即使模型服务拒绝了请求，pi 也以 0 退出，所以结果按最后一条 assistant 消息判定：`stopReason` 为 `error` 或 `aborted` 时 Run 失败，没有任何回答（包括空任务）记为 `protocol`。分类时服务返回的 HTTP 状态优先：401、403 与缺少密钥为 `auth`（等你处理）；402、429 与余额不足、欠费、用量上限为 `rate_limit`（稍后自动再试；智谱写明重置时间时，按北京时间等到那时）；5xx 与连不上为 `network`（Run 失败，可以重做）；其余为 `tool_failure`。原因以中文写进 Run 结果的 `errorMessage`。token 用量取服务报告的数；费用是 pi 按它的价目表估算，价目表里没有的模型记为未知。

探测时，版本来自 `pi --version`（不带任何凭据变量；Windows 上经 npm 的 `.cmd` 包装解析到 node 与脚本），「登录」就是密钥是否已保存，额度保持未知：DeepSeek 的余额接口给的是金额，对不上现有「已用百分比」的额度模型；余额或额度不足在 Run 时按 `rate_limit` 处理。

任务 YAML 示例（路径相对项目根）：

```yaml
schema: task/0.1
goal: 创建一个简短的结果文件
role: executor
provider: local-codex # 可选；省略时按候选顺序路由
allowedWrites: [result.txt]
expectedOutputs: [result.txt]
requiredCapabilities: []
checks:
  - id: readback
    path: result.txt
    contains: OK
  - id: command
    command: [python3, -c, "from pathlib import Path; assert Path('result.txt').exists()"]
    exitCode: 0
    timeoutSec: 30 # 可选；1–3600，缺省 30
  - id: structured
    json: run:report.json # 解析 JSON 后从根按字段路径取值
    field: summary.pass   # 点分路径；数组用下标，如 results.0.ok
    expect: true          # 与取到的值深度相等才通过
    scope: play           # 可选：edit、build、play、client，缺省 edit
    on: result.txt        # 可选：本检查证明的预期产物，缺省第一个
maxRetries: 1
resources: [unity_batch] # 可选；同名资源串行
unitySteps: # 可选；声明时必须同时声明 unity_batch
  - {method: Example.Batch.Run, quit: false, timeoutSec: 3600, env: {EXAMPLE_MODE: test}}
gate: # 可选；批准绑定当前产物 SHA-256
  id: approval
  question: 是否接受此结果？
  bind: result.txt
```

| 字段 | 约束 |
| --- | --- |
| `schema`, `goal` | 必需；schema 固定 `task/0.1` |
| `role`, `provider` | role 缺省 `executor`；`research` 只在标记该角色的 Provider 中选择；provider 可指定配置中的 id |
| `allowedWrites`, `expectedOutputs` | `allowedWrites` 必需、可为空；`expectedOutputs` 必需且非空；路径相对项目或带 `run:` 前缀 |
| `checks` | 必需且非空；每项在 `command`（期望 `exitCode`，缺省 0；`timeoutSec` 缺省 30）、`path`（`contains` / `equals` 文本读回）、`json`（`field` 与 `expect`）中选且只选一种；可选 `scope`（证据类别，缺省 `edit`）与 `on`（绑定的预期产物，须在 `expectedOutputs` 中，缺省第一个）；出现未知字段即报错 |
| `maxRetries`, `resources`, `requiredCapabilities` | 可选；缺省 0、空列表、空列表 |
| `unitySteps` | 可选；各步需要 `method`，`quit` 缺省 true，`timeoutSec` 缺省使用配置值，`env` 为字符串映射，不得覆盖隔离 HOME、`XDG_RUNTIME_DIR`、`WAYLAND_DISPLAY` 或 D-Bus 会话地址；必须配置 `unity` 并声明 `resources: [unity_batch]` |
| `gate` | 可选；`id`、`question` 与绑定的预期产物 `bind` |

只读核对示例；报告留在 Run 目录，不写客户工程：

```yaml
schema: task/0.1
goal: 阅读 baseline.txt，并把结论写入报告
role: executor
allowedWrites: []
expectedOutputs: [run:report.md]
checks:
  - id: report-readback
    path: run:report.md
    contains: baseline
```

`allowedWrites` 可以为空；`.` 表示整个项目；以 `/` 结尾表示目录，Run 开始前创建，使 OS 级写边界精确到该目录（否则尚不存在的路径只能挂载其最近的现存祖先，靠 Run 后扫描发现越界）。Run 后核对时，每个允许路径的同名 `<路径>.meta` 也视为允许，例如 `Assets/_X` 同时允许 `Assets/_X.meta`，不允许 `Assets/Y.meta`。`expectedOutputs` 必需且非空，项目内产物必须落在 `allowedWrites` 下；`run:` 表示当前 Run 目录下的相对文件，适用于预期产物、读回检查路径及 Gate 绑定。`command` 检查仍以项目为 cwd。Provider 收到 `AVH_RUN_DIR` 和 `AVH_PROJECT_DIR`。`writable` 只列 Provider 每次 Run 额外需要的可写目录（如缓存），与 `stateDirs` 一起加入 Run 可写集合，不参与 Provider 资格筛选。

独立检查在 Provider 退出后执行，执行期间 Run 仍持有项目锁与资源槽，同一项目的其他任务要等检查结束（离开 `VERIFYING`）才能开跑。`command` 检查以异步子进程运行：有 bwrap 时整个文件系统（含工程与 Run 目录）只读、无网络、私有 `/tmp` 与 PID 命名空间，只有 `Run/checks/<检查 id>/` 可写；环境变量只保留 `PATH` 与语言区域，另给 `HOME`（检查自己的临时目录）、`AVH_RUN_DIR`、`AVH_PROJECT_DIR`，不转发任何 API 密钥。没有 bwrap 时照样精简环境变量，但不隔离，Verdict 依据里写明 `isolation=none` 及原因。输出存到 `Run/checks/<id>.stdout.log`、`.stderr.log`；超时按进程组终止。`json` 检查缺文件或缺字段记 `no_data`，JSON 解析失败记 `error`，都不会通过。取消 `VERIFYING` 任务时，按 Run 目录里登记的进程号停止仍在运行的检查（任何进程发起都可以），确认全部退出后才进入 `CANCELLED`。检查失败进入 `BLOCKED`；修正后可用 `task redo` 明确授权新 Run。越界改动进入 `WAITING_HUMAN`，`task show` 列出未接受的路径、记录时间和下一步。审阅后执行 `task accept-changes <task-id> --note <文本>` 接受该工作流全部未接受的越界记录；可重复指定 `--path <路径>` 只接受所选记录，路径可用 `task show` 显示的 `workspace:` 形式或项目相对路径。命令回报本次接受数和剩余数，并记录人工说明。全部接受、没有待决 Gate 或警告且最近 Run 已退出时，任务回到 `VERIFYING`；下一轮 `serve --once` 复判已有 Run，不创建新 Run。旧任务若已是 `BLOCKED`，接受后状态不变，按提示使用 `task redo`。Gate 需要 `gate approve` 后再运行一轮 `serve`；拒绝只记录决定及注释，任务保持等待，随后可 `task redo`。产物哈希变化使旧批准失效，`gate list` 会显示 `stale`。`task show` 也列出每个 Run、结果、原因码和事件；`project brief` 附上此项目的 Task 摘要。
带 `unitySteps` 的任务会在 Provider 成功退出后由 `observe()` 启动独立的 systemd Unity 单元，`serve --once` 不等待步骤结束；`collect()` 只读取结果，绝不启动 Unity。后续轮询确认单元退出后才扫描并运行独立检查。Unity 是 Run 的内部阶段，任务保持 `RUNNING`，取消任务时也会停止并确认该单元；若 Provider 已退出而 Unity 尚未开始，取消会直接关闭 Run，并在结果中记录 Unity 步骤未开始。启动结果或退出状态无法确认时进入 `RECOVERY_REQUIRED`。单元有按各步超时总和设置的运行时限。Runtime 在 Node 中构造 Unity 的 `-projectPath -force-vulkan -batchmode -logFile -executeMethod` 参数；`quit: true` 添加 `-quit`，否则由入口自行退出。每步记录序号、方法、退出码、耗时、日志路径和末尾 200 行中的最多 20 条错误摘要，状态及证据保存在 Run 的 `unity-steps.json`。非零退出或超时停止后续步骤及检查，在 `maxRetries` 限额内重试。当前重试会重新调用 Provider；失败 Run 的结果、事件与下一轮 Provider 说明会标明“Unity 步骤失败，Provider 产物保留”，并附步骤及日志证据。

`task add` 创建的临时任务使用 `avh-task/0.1`：PASSED 后预期产物发生变化，`serve` 只记录一次 `evidence_invalidated` 事件，不自动新建或派发任务。`task show` 和 `task list` 提示产物已变化；需要重跑时由人执行 `avh task redo <task-id>`，下一轮 `serve` 才创建新任务。流程工作流使用自己的流程定义；产物变化导致阶段重开时，Runtime 仍按流程自动安排新任务。

Unity 使用 Run 目录内权限 0700 的隔离 HOME，设置 HOME、XDG 各目录、`XDG_CONFIG_DIRS=/etc/xdg`，只读引用真实 `.Xauthority`（存在时）；配置的种子文件复制为 0600，步骤结束后删除副本，种子路径和内容会从日志与证据中清除。Unity 还收到 `AVH_RUN_DIR`、`AVH_PROJECT_DIR`、配置的 `passEnv`（始终包含 `PATH`）和步骤 `env`。Unity 步骤要求 bwrap 可用，OS 级可写集合是整个项目目录、Run 目录与锁文件；锁文件以 `--bind <文件> <文件>` 单独挂载，不授予其父目录，并为 `/tmp` 提供私有空间且保留只读 X11 套接字。bwrap 用 tmpfs 遮住 `XDG_RUNTIME_DIR`，只绑回存在的 `pulse/native`、`pipewire-0` 和 `WAYLAND_DISPLAY` 套接字；会话总线与 systemd 用户实例套接字不可见。锁被占返回 `busyExitCode` 时，每 30 秒记事件并等待重试，最长不超过该步超时；与旧派工使用同一个 `lockPath` 的 flock 锁互斥。**授权客户端争用单独判、单独处置**：Windows 上 Unity 的授权客户端按账户全机共享（命名管道 `LicenseClient-<账户>` 与全局互斥量 `Unity-LicenseClient-<账户>`），同一账户同时拉起第二个编辑器时，抢不到客户端的那一个会等满 Unity 自己的 60 秒后**在步骤代码执行前**以退出码 199 中止，日志却把原因写在 `Licensing` 上。因此该步会核对「日志里的授权客户端特征行 + 退出码 199」两半，成立时先等持锁的授权客户端退出（至多 120 秒，退出后短暂停顿），再自动重跑，重跑至多 2 次。**为什么不是「等一会儿就能重跑」**：Harness 的批处理 Unity 跑在 Low 完整性、用自己的隔离 profile，本机实测在别的编辑器的授权客户端运行期间，它的通道连接被拒（`Connection Refused`）、自己启动的客户端又抢不到全局互斥量（`Failed to acquire global mutex Unity-LicenseClient-<账户>`），所以另一个客户端还在时重跑只会再花 60 秒得到同样的中止；反过来，占用者退出后再跑就能连上自己新起的客户端。**共用是有条件的**：已经起来的客户端能不能被连上，取决于它的完整性——实测 Low 客户端同时服务第二个 Low 编辑器与一个普通完整性编辑器（`connect: 0.00s`），普通完整性客户端则对 Low 编辑器回 `Connection Refused; code: 0x8000000a`。Harness 的编辑器一律跑在 Low，所以只要本账户第一个需要客户端的是 Harness，机器级槽就都能用（缺省 2 个，见 `unity` 配置里的 `AVH_UNITY_SLOTS`）。占用者不退出才把占用者（进程号、命令行里的工程）和「需要你做的：关闭那个 Unity 或等它结束」写进 Run 结果、`unity_step_failed` 事件与下一次重试的输入，而不是笼统报「Unity 失败」；等待期间 Run 目录里的 `unity-waiting.json` 记下第几次等待与起始时间，Runtime 据此写 `unity_waiting` 事件。同一把机器级锁也由测试夹具持有，夹具不会在正式 Run 在飞时拉起编辑器。Run 后扫描核对项目内写入，额外放行 `projectScratch` 和 `Packages/packages-lock.json`；`ProjectSettings/` 等其它越界修改仍作为违规证据。
已批准的同一产物哈希不可撤销；需要拒绝后续版本时先修改产物，使旧批准失效。

任务级 `allowedWrites` 在 Run 结束时按 Git 状态与提交独立检查。OS 级范围如下：`outer`（bwrap / `codex sandbox`）以 Run 目录为 cwd，可写 Run 目录、任务允许目录与 `writable`；bwrap 对已存在的文件使用 `--bind <文件> <文件>`，不扩展到父目录，尚不存在的路径只能挂载其最近的现存祖先；`codex sandbox` 与 `codex-cli`（self）的可写根只能是目录，文件路径按所在目录授予，后者以 `-C <Run 目录>` 运行并用 `--add-dir` 加入这些目录，但排除 CLI 状态目录。bwrap 负向探测依次尝试系统临时目录、工程上级目录、`AVH_HOME/probe`（按需创建为 0700）；三者都不在可写集合之外或宿主机不可写时，报告候选与白名单并判为不可用。`legacy-dsh-task`（self）只读任务以 Run 目录为 `--cwd`，旧脚本的 DSH 引擎只允许写 Run 目录，仍可读项目，且用 `--no-record --no-journal` 关闭自动留痕。旧脚本的 Codex 引擎在工作区外 cwd 会把整个工作区加入可写目录，因此只读任务强制使用 DSH 引擎；显式配置 Codex 引擎的只读任务会在启动前报错。写任务以项目为 `--cwd`，DSH 引擎的 OS 级可写根是整个项目，Run 产物由 Runtime 生成；旧脚本的 Codex 引擎另有工作区 `.git` 可写根。Run 后扫描按 `allowedWrites` 及对应同名 `.meta` 精确核对。任务项目必须位于 Git 仓库；Provider 不应提交 Git 变更。

Run 后扫描把项目内超出 `allowedWrites` 及对应同名 `.meta` 的改动记为 violation；Unity 步骤另放行 `projectScratch` 与 `Packages/packages-lock.json`。项目外的状态、元数据、提交路径及 HEAD 变化记入 `externalChanges`（运行期间的外部改动，含路径和扫描前后状态）；若该 Run 的沙箱为 `self` 或通过探测的 `outer`，它们不构成越界。仅 Git 扫描模式下，项目外实际文件变动及 HEAD 变化仍构成 violation。只有 Git 状态改变而文件类型、大小、mtime、inode 均不变的项目外条目，本身不算写入，只进入外部改动证据。系统沙箱不可用时退化为 Git 扫描，覆盖边界见执行器文档。

项目简称配置示例：

```yaml
projectAliases:
  ExampleProject: [ExampleAlias]
  OtherProject: [OtherAlias]
```

每次导入只使用对应项目目录名下的简称，并始终使用目录名与订单号检索外部账本。直接调用 `importProject` 时，`config.projectAliases` 仍为当前项目的简称列表。

跨工程账本和拍板标题示例；简报中的 `claimed` 若仅有文档存在证据会显示「文档存在（弱证据）」：

```yaml
import:
  externalLedgerFiles: ['账本*.md', '停滞项_*.md', '待问用户*.md']
  aliasGroups:
    三单: [ProjectA, ProjectB, ProjectC]
  metaPrograms: [_长程任务_样例统筹]
  decisionTitlePatterns: [拍板, 用户定]
```

待用户复核决定表配置示例；不配置时不扫描决定表。`glob` 相对工作区，列名由表格实际表头填写，`flag` 可以与 `id` 共用编号列（如 `2 ☆`）：

```yaml
import:
  decisionTables:
    - glob: '_长程任务_*/待用户复核_*.md'
      columns:
        id: 编号
        time: 时间
        flag: 编号
        project: 工程/任务
        question: 问题
        choice: 我选的
        answer: 你的意见
```

每流程一份阶段规则的配置示例：

```yaml
processDefinitions:
  avatar-flow:
    definition: process/avatar-flow.yaml
    stageRules: process/avatar-flow-stage-rules.yaml
```

该 `stageRules` 文件示例（`process` 必须等于配置中的流程 id，stage id 必须存在于流程定义中）：

```yaml
schema: stage-rules/0.1
process: avatar-flow
stageRules:
  packaging:
    claimPatterns: [打包完成]
    verificationIds: [delivery_archives]
    notApplicablePatterns: []
```

旧式 `stageRulesFile` 文件示例：

```yaml
avatar-flow:
  packaging:
    claimPatterns: [打包完成]
    verificationIds: [delivery_archives]
```

`doctor` 检查 Node、`node:sqlite`、配置路径、工具文件、流程、阶段规则及已声明 Provider 的版本和登录状态，并在临时目录运行执行器的写范围探测。探测成功显示“OS 级隔离可用”；受运行环境限制时显示“仅越界扫描”及原因。后一种模式只检查工作区 Git 仓库内的越界改动，具体覆盖限制见 [`src/exec/README.md`](../src/exec/README.md)。`doctor` 还会显示本机的 Unity 槽位数及其来源（`Unity 槽位`，例如 `2 个（缺省）` 或 `3 个（环境变量 AVH_UNITY_SLOTS）`）；`AVH_UNITY_SLOTS` 不是 1 至 8 的整数时，读取配置（`loadConfig`）就会以中文报错，`doctor` 把它记为一项 FAIL，而不是等到 Run 中途才由启动器发现。

启动前和 Run 结束后，工作区扫描记录每个 Git 状态条目的状态码、文件类型、大小、纳秒级修改时间与 inode；基线不读文件内容。状态码或元数据变化、出现和消失的路径视为疑似改动；对结束时存在且不超过 `scanLimits.hashBytes` 的普通文件补算 SHA-256，写进 Run 证据，超限则写明“未哈希（超过上限）”。仅状态码变化且元数据不变的项目外路径归入 `externalChanges`，不作为写入。项目内 `allowedWrites` 核对只执行 `git status -- <项目>`。Git 输出超过 `scanLimits.gitOutputBytes` 会报出明确上限错误。此扫描不能识别内容改变但这些元数据全部相同的文件。

创建 systemd 单元之前的扫描、参数或 Run 文件写入失败，会作为无副作用的 `tool_failure` 结束 Run，记录错误文本、关闭 outbox 并释放锁；按 `maxRetries` 重试，耗尽后任务进入 `FAILED`。只有启动结果无法确认时才进入 `RECOVERY_REQUIRED`。此时可用 `avh task recover <id> --no-side-effects --note '说明'`：默认须确认单元不存在且 Run 目录没有 `command.json`，旧 Run 标为 `abandoned`，outbox 关闭，项目和资源锁释放，任务回到 `READY`。若自动检查无法确认，人工核实后可加 `--force --note '说明'`。已经核对运行结果的情形使用 `--reconciled --note '说明'`，任务进入 `VERIFYING`：执行单元（及其 Unity 步骤）此时能确认已经结束的，照常收取它的结果并做越界扫描，越界改动照常待审阅；读不回来的才按人工核对记一个成功结果。恢复不启动任何东西。正式 Workflow 的阶段任务同样适用，任务 id 可用唯一前缀；进入 `RECOVERY_REQUIRED` 的事件原因写明哪一步无法确认（查询单元出错、单元既不在运行也没有退出记录、读取结果出错）。执行单元正在停止（`deactivating`）算作仍在运行；两次读取之间单元被回收、或读到已停止但进程尚未退净时，先重读三次再下结论。`avh cancel <task-id-or-run-id>` 遇到最新 Run 从未启动（单元不存在且 Run 目录没有 `command.json`）时，在同一事务内将 Run 标为 `cancelled`、记录 `noSideEffects: true` 和取消说明、关闭 outbox、释放该 Run 的全部项目与资源锁并写事件；任务同时进入 `CANCELLED`；命令回报已释放的锁数。取消 `RUNNING` 或 `RECOVERY_REQUIRED` 任务时，执行器确认单元停止并取回结果后，同一事务内把 Run 标为 `cancelled`（结果附取消说明）、关闭 outbox、记录越界改动并释放锁，任务进入 `CANCELLED`。

任务已是 `CANCELLED`、`FAILED` 或 `PASSED`，而名下仍有 `pending`/`running` 的 Run，这样的 Run 称为残留 Run；它占着 Provider 并发槽和锁。`serve` 每轮开头先清理残留：执行器确认单元从未启动、已退出、已不存在，或经执行器停止并确认后，把 Run 标为 `cancelled`（有 `exit.json` 时附退出码）、关闭 outbox、释放锁，并写 `orphan_run_closed` 事件（理由含任务状态与单元状态）。无法确认单元已停止时不关闭、不释放槽，写一条 `orphan_run_unconfirmed` 事件，理由不变就不重复写。`avh cancel <run-id>` 对已结束任务的残留 Run、`avh cancel <task-id>` 对已结束任务的全部残留 Run，做同样的收尾，逐条输出关闭的 Run、单元状态、退出码和释放的锁数；没有残留时输出「无残留」。两者都不改变任务状态；有残留无法确认时退出码为 2。

Claude Provider 强制使用 bwrap；状态目录由 tmpfs 覆盖，已存在的 `.credentials.json` 单文件可写回绑，`.config.json` 单文件只读回绑，`projects/`、`settings.json` 与 `CLAUDE.md` 使用只读遮罩。若 bwrap 不可用，Run 在启动前失败，不降级为 Git 扫描。Claude 使用 Run 内生成的无钩子设置文件、空设置来源、`--safe-mode` 与 `--no-session-persistence`；会话事件保存在 Run 的 `stdout.log`。Codex 使用 `--ignore-user-config`、`--ephemeral`，状态目录不加入模型命令可写根。`provider-request.json` 记录设置来源、挂载策略、自动记忆状态和发现的指令文件哈希。


协调探索的内部工作窗口会按真实有用观察自动续接，默认用户回复不显示次数。高级本地配置 `coordination: {maxExplorationOperations: 72}` 设置保守总停止边界，允许至少 24 的安全整数；GUI「设置→高级→素材探索深入程度」提供标准和更深入选项。修改后消费者按当前值继续读取既有回执，不清空观察或重放已执行操作；不会增加来源权限或取消 Provider 费用/超时约束。

数据协作说明版本为 2，明确同意事件也绑定版本。旧版说明或旧默认开启、旧启用事件不能静默启动新用途回传；再次选择加入须见到当前说明。本地制作和更新无需加入。

#### 接手分析的内部检查

`checks[].internal: takeover-output` 是固定的只读检查，必须同时声明三份 `_Harness/Recovery/` 输出并绑定 `facts.json`。它执行与最终入库相同的完整输出/事实路径/前序依赖校验；不运行任意命令，也不授予额外写权。拥有该检查的临时任务把既有 `maxRetries` 同步作为独立检查修复上限，普通临时任务的重试语义保持不变。失败依据传给下一次受管运行；额度耗尽后恢复失败且不记录候选事实。
