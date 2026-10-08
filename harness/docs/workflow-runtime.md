# 正式 Workflow 运行时

> **当前实现边界：**正式流程的阶段依赖由流程定义决定；内置 PC 流程当前基本串行，调度器为同一项目的 Run 获取项目锁。dev0.1 规划中的多任务域上下文、意图路由与隔离副本并行不属于本页所述已实现能力，见[升级规划](../../docs/zh/设计/1-整体架构/产品升级规划.md)。

流程定义（[process/0.1](process-format-v0.1.md)）写明「什么必须成立」。本页说明 Runtime 怎样把它跑起来：由谁做、做在哪些文件上、怎么测、怎么判。临时任务（`avh task add`，`avh-task/0.1`）仍可用于零散工作；业务链由正式 Workflow 驱动。

## 1. 创建与冻结

```sh
avh project new <项目目录名>                         # 在工作区新建独立 Git 仓库的工程
avh workflow create <项目目录名> --profile <流程 id> [--manifest <输入 Manifest>]
avh workflow list
avh workflow show <workflow-id>
avh workflow cancel <workflow-id> --note '原因'
```

创建时冻结七样东西：流程定义、能力清单（第 2 节）、阈值数值、能力清单引用的每个工具文件（`{toolRoot}/…`）的哈希、阶段上下文原文与哈希、输入 Manifest、Provider 快照。之后知识层再改，也不影响这个 Workflow；`process_hash` 是流程、能力、阈值和工具的摘要。工具文件变了，Runtime 就拒绝运行它：观测记为 `error`，工具阶段不启动，并说明需要迁移 Workflow。引用的工具在创建时不存在，则拒绝创建。只校验参数里直接引用的文件，它们再加载的其他模块不在校验范围内。一个项目同时只能有一个进行中的正式 Workflow。项目必须是位于 `workspaceRoot` 内的独立 Git 仓库。

输入 Manifest 为 `manifest/0.1`：`profile`、`assets`（`store: library | client`、`item`，可选 `role: body | outfit | texture | other` 与 `variant`）与 `request`（用户原话）。它说明制作输入；怎么装配由方案产物决定，经 Gate 批准。`texture` 的PNG/JPEG通过SHA冻结清点、受管导入和读回，导入不代表材质已接线；它不自动进入角色参考图。可选 `requirements` 是有用户来源和替代关系的冻结要求解释，不授予权限；`referenceImages` 是最多 8 张项目内相对路径与 sha256 的原图快照。创建流程与生成 Provider 阶段任务时检查图像身份，派发时再次检查并作为真实附件传递；不能只把路径文字当作视觉输入。生产提案按当前关联参考图自动生成这些输入，用户不需要手填。

`avh serve` 每轮推进所有状态为 `active`、`upload_ready`、`client_verified` 的正式 Workflow。

### 早期失败遇到制作工具更新

用户仍从项目“核对并继续制作”发起 `project.production.resume`，不管理内部任务。Runtime 先核对执行已结束、结果与写入可解释、没有残留锁和新要求；仅原流程止于清点/计划、没有计划接受或任何施工成果时，允许以已更新的合同重新开始原目标。重新校验每个原文件 SHA、普通文件身份及素材目录授权，将旧清点/计划文件、冻结快照、输入和摘要保存到独立版本证据目录，再关闭旧流程并创建新流程。原失败 Task/Run 不改写；同命令回执去重，不产生新用户要求。已有施工或接受产物、输入漂移、授权改变或未知执行状态均拒绝自动从头重建。

上下文可靠性统计只把已退出且所属任务为 PASSED/FAILED 的尝试计入通过率；运行中、待验证、待用户接受、取消和未知恢复结果保留可读状态，不当作失败，也不据此自动停用本地候选。首次与重试仍分别计数。

## 2. 能力清单 `capabilities/0.1`

在 `config/harness.yaml` 里为流程指定：

```yaml
processDefinitions:
  pc-recolor-outfit:
    definition: process/pc-recolor-outfit.process.yaml
    capabilities: process/pc-recolor-outfit.capabilities.yaml
```

没有能力清单的流程只能用于导入复核，不能创建正式 Workflow。清单必须覆盖流程的每个产物种类、每个阶段、每个被检查使用的观测；多写或漏写都拒绝加载。

```yaml
schema: capabilities/0.1
process: pc-recolor-outfit
version: "1"
artifacts:                          # 产物种类 → 工程内文件
  plan: {paths: [_harness/plan.yaml], format: yaml}
  scene: {paths: [Assets/_Work/Scenes/Avatar.unity]}
  build: {paths: [_harness/build/], includeIgnored: true}
stages:                             # 阶段 → 谁来做
  plan: {mode: provider, goal: "按需求起草方案：{{manifest.request}}", allowedWrites: [_harness/]}
  recolor:
    mode: provider
    goal: "探查材质并实际完成候选设计"
    context: [context/recolor-avatar-v1.md]
    agentTools: {generate-candidates: [python3, "{toolRoot}/recolor.py"]}
    maxCheckRetries: 2
    allowedWrites: [Assets/_Harness/Recolor/]
    resources: [unity_batch]
    unitySteps: [{method: Harness.Recolor.Verify}]
  build: {mode: tool, command: ["{toolRoot}/harness/build.py", "--project", "{project}"],
          allowedWrites: [_harness/build/], resources: [unity_batch],
          unitySteps: [{method: Harness.Build.Run}]}
  regression: {mode: tool, unitySteps: [{method: Harness.Regression.Run}], resources: [unity_batch]}
observers:                          # observe → 怎么取指标
  menu.dump: {command: [python3, "{toolRoot}/observe/menu_dump.py", "{project}", "{out}"], timeoutSec: 600}
  avatar.observe: {runFile: observations/avatar.observe.json}
```

**产物。** `paths` 是字面路径（文件或目录，目录代表其下全部文件），相对工程根。缺省列出 Git 已跟踪和未忽略的文件；`includeIgnored: true` 改为遍历文件系统，用于被忽略的构建输出。指纹对每个成员的路径和内容求哈希：任何成员变化、增加或消失都是新版本。指纹不是标准答案，也不要求不同工程生成相同内容；它只标识“当前这个工程的这一版”，用于把检查和人工批准绑定到实际看过的版本，并在上游变化后准确失效旧证据。`listed` 指向 `paths` 里的一个清单文件，由产出该产物的阶段写入，每行一个成员路径；用于导入后才知道目录名的厂商素材。清单列出工程外路径时拒绝。列出的文件或目录旁边的 Unity `.meta`（GUID 与导入设置）一并计入。一个成员也没有时视为产物不存在，而不是空产物；只剩一个 `.meta` 也算不存在。`plan` 必须是单个文件，并声明 `format`。

**阶段。** `mode` 取以下三种之一：
- `provider`：由执行方完成，必须写 `goal`。
- `tool`：由知识层工具完成，写 `command` 和/或 `unitySteps`。
- `none`：不执行任何工作，只按已有证据判定；有产出的阶段不能是 `none`。

`goal` 可以引用 `{{plan.<字段>}}`、`{{manifest.request}}`、`{{stage}}`、`{{profile}}`。Runtime 会在 `goal` 后面附上本阶段的验收检查（规则原文）、当前方案和输入 Manifest；执行方的自述不作为证据。

`context` 是 Harness 选择并冻结的阶段上下文；执行方不负责浏览 SOP 或决定该读什么。字符串条目兼容旧版，表示必选整份文件。结构化条目支持按 Markdown 标题抽取、事实触发、优先级、互斥、覆盖声明和模型家族变体：

```yaml
contextBudgetChars: 24000
contextCoverage: [menu.core, menu.vendor-conflict]
context:
  - {id: menu-core, path: context/menu.md, heading: 核心不变量,
     required: true, priority: 100, covers: [menu.core]}
  - id: vendor-route-b
    path: context/menu.md
    heading: 厂商控制器冲突
    priority: 80
    when: [{path: plan.menu.route, equals: B}]
    excludes: [legacy-route-a]
    covers: [menu.vendor-conflict]
    models: [codex*, claude]
```

`when` 全部成立才召回，`unless` 任一成立便排除；条件操作符为 `exists`、`equals`、`includes`。事实根包括 `plan`、`manifest`、`stage.id` 和项目记忆 `memory`，例如 `memory.project.identity.base`（素体）、`memory.project.packageIds`（VPM 包 id 列表）、`memory.history.failedStageIds`（失败过的阶段）。Runtime 先选必选项，再按优先级和稳定 id 排序，应用互斥和预算；覆盖不足直接拒绝派发。同一小节可以列多次，例如本阶段失败过时用高优先级、平时用低优先级各列一条；它只会被注入一次，由入选的第一条注入，其余记为跳过。任务正文列出每个条目的“注入/跳过”及原因、字符数和覆盖范围，因此上下文选择可检查而不是黑箱。Workflow 仍冻结引用文件全文与哈希，小节是在冻结副本上编译，不受后续能力包更新影响。`models` 已进入编译合同；模型家族的实际路由绑定与 GUI 预览仍需在后续版本接通。

`agentTools` 是只向 `provider` 阶段暴露的命名命令。命令所引用的 `{toolRoot}` 文件与观察器一样在 Workflow 创建时冻结哈希，启动 Run 前复核；它给 AI 提供底层操作能力，但“调用过工具”不构成通过，仍由后续 Unity 步骤与观察器验收。这样固定的是能力、安全边界和证据合同，而不是唯一制作步骤或唯一成品。

`maxCheckRetries` 是可由制作修复的独立检查失败后的自动修复次数。真实违规、缺少产物和普通未测指标仍按既有预算向 AI 反馈；预算耗尽保留为 `BLOCKED`。必需检查的 `error` 表示独立验证工具未建立有效证据，先保留为 `BLOCKED`，不让 AI 反复修改工程来修验证器。升级制作工具后，当前 setup 检查错误可以经原正式入口保存工程、核对执行回执及来源、复验祖先，再建立新制作版本；旧错误不能改为通过。审美 Gate、越界写入、警告接受、认证和权限仍按各自合同处理。`maxRetries` 继续只控制执行失败的重试。

脸型 `face_design` 的受管准备工具在预览之前失败时，更新制作能力后也可由同一 `project.production.resume` 入口续接。Runtime 先独立确认旧执行退出，再核对原始失败、Runtime 准备意图、私有进程回执、原工具摘要、命令及写入边界；必须没有活动 Run、锁、越界待处理记录、脸型选择或后续已接受成果。保存部分工程及证据后，按新版本独立复验 `intake`、`plan`、`environment`；只有合同、知识、工具、素材、产物和原批准仍有效的祖先才能继承。新完整制作版本从 `setup` 开始重新准备和观察；旧 setup 通过与 face_design 失败均不转成新版本通过，原输入与用户目标不要求重新生成。

这种技术续接将业务上下文与 `localMaintenance` 采用身份分别核对：目标、素材、范围或修订变化仍拒绝继承。若用户已采用本地修复，独立复验和创建后继版本使用同一个经人类决定回执、内容摘要、隔离评测与正式基线复核的候选。核对期间变更选择、配置或工程会拒绝迁移；备份、复验和最终事务失败均保留原制作指针及历史，不能用新工具追改旧失败。此入口目前仅覆盖上述可证明的预览前准备失败，不覆盖任意脸型执行中断或已接受成果的回滚。

GUI 的 `service.pause` 停止新派发，再收尾已经派发的 Run（含受管准备、Unity 和独立验证），不取消工程、不启动新的 Provider 交互、不派发修复轮次，也不启动尚未执行的 outbox intent。收尾期间保持 `pausing`，不能提前恢复另一个调度进程；暂停不以固定两分钟强杀收尾进程。已有调度停止但 Run 尚未回收时，再次暂停通过同一 API 启动仅收尾调度。无法确认退出的步骤进入 `RECOVERY_REQUIRED` 并保留原 Run 与锁，不能把暂停当成它已经停止，也不能盲重做。内部 `serve --drain` 只供这一生命周期使用，普通用户无需输入命令。

`allowedWrites` 是工程内相对路径，以 `/` 结尾表示目录：Run 开始前 Runtime 先建好该目录，OS 级写边界就精确到它，而不是退到最近的现存祖先。

`runtimeWrites` 是正式能力清单中仅供 Runtime 准备/Unity步骤写入的额外输出，与执行方 `allowedWrites` 不得重叠；临时任务 YAML 不能授予该权限。执行方派发不获得这些目录，最终变化核对仅在持久事件证明准备或Unity单元已由Runtime发起时纳入它们，原执行方越界结果仍保留。脸型预览与输出记录使用该边界，不能让模型预写截图再当独立渲染。

`runtimeTemporaryWrites` 同样仅供受管步骤使用，但必须是精确临时文件路径，不能声明目录、通配符或持久产物。派发写边界包含这些路径，`expectedOutputs` 不包含它们，原子替换成功后不要求遗留 `.writing` 文件。它不扩大 Provider 权限。

`providerWhen` 与非空 `otherwiseCommand` 必须成对用于 `provider` 阶段：条件只读取当前批准方案或冻结Manifest（使用 `path` 与 `exists/equals/includes`），不成立时执行已冻结的保留命令，免去不必要的模型调用；两条命令及工具依赖均在创建时冻结、派发前复核。它仍产生独立检查和持久结果，不是把检查跳过。

流程阶段的 `when` 支持原有 `plan.<path>` 真值测试、前置 `!`，以及与带双引号字符串的精确比较，例如 `plan.face.mode == "design"`。可选源阶段在当前批准方案下不适用时，下游不要求不存在的该阶段产物；方案变化与重新适用后的实际产物变化仍使下游失效。当前脸型分为可选 `face_design` 和受管 `face`：前者 AI 只提 2–5 个源形态键组合，后者根据批准方案执行选定烘焙或独立保留验证。

手动交接的 `manual-face` 工作流由现有 `face` 能力、独立检查、Unity Apply/Measure/Render 和 `face-output` Gate 派生；交接准备、读取、补偿、烘焙、重导入和渲染均为确定性工具，没有 AI 选择阶段。每次修改在新受管项目副本执行，原件与旧接受产物不改。交接完成回执绑定 descriptor/baseline 文件 SHA，Runtime 冻结 submitted.blend 的 SHA 并独立重读；仅键值及允许放宽的范围成为输入，网格、形态键顶点、其他对象和受保护键变化均拒绝。实际 SDK 和动画写引用决定保护集合，非目标对象只读；全部键保留在 Blender 文件中。

打开 Blender 保留现有制作选项。未接受的已保存草稿在来源、工具、Blender 与基线均未变化时可重新打开并修改；新提交归档旧保存文件，历史作业与输入事件保留。来源或工具变化时准备新副本；回退同时切换接受引用和当前预览。停止意图优先于在途“捏好了”请求，确认停树后的提交再次检查当前会话，不能把已停止的会话改回处理中。

交接可在任意阶段停止；正式恢复先确认旧进程树退出，新工作流沿用原输入和历史证据。建立隔离副本前先持久记录准备来源、源 SHA 和版本引用，逐文件复制期间入口仍可读取或取消；停止会等待在途文件复制结束，部分副本保留，正式续作重新核对来源后补齐，不重建用户草案。缺失 Blender 提示 4.2 或更新版本、官方下载及重新检测。待接受状态要求实际渲染 Run 和图片绑定有效；共享接受事务存储不可修改的版本和键值，回退仅更换当前版本引用。生产选择 `manual` 时，没有已接受输入则有效方案为 `preserve`，已有接受输入则经 Runtime SHA 投影交给原脸型执行工具，不等待用户。新脸型的独立测量还比较全部靠近变化脸部的实际头发/饰品网格；邻近结果是质量提示，仅覆盖默认姿势，未替代全装配、动态和客户端验收。

T1c 当前切片尚未把已完成整套装配的父项目自动派生为完整后继制作流程；接受后的新脸型版本及隔离工程已经保存，但不能将它们声称为整套服装、头发和饰品交付的自动更新。上线规格仍要求每次后续修改形成新项目版本并重跑受影响检查，这个后继消费者待补齐；旧接受产物不得原地覆盖。

`choose` Gate 可声明 `selection: face-candidate`，批准布尔值不能代替具体选择。`project.face.choose` 接收 `projectId/workflowId/candidateId/candidateSetSha256/previewSha256/expectedHash`；Runtime 独立检查当前真实受管预览及来源，将选项随 Gate 决定在同一事务持久保存。工具阶段 `selectionGate` 引用此 Gate；派发时再次验证并从数据库重建 `face-selection/0.1`，仅 Runtime 注入 `AVH_FACE_SELECTION_SHA256`。候选 JSON 自带选择字段、旧图、源漂移或模型写的选择文件都不授予执行权。`gate choose <gate-id> --candidate <id> --candidate-set-hash <sha> --preview-hash <sha> --expect-hash <artifact-sha>` 使用同一合同；普通 GUI 用户只查看实际候选图并选择。最终表情、眼部和外观资格与组合预览、选择是不同证据。

`approve` Gate 可声明 `review: face-output` 并绑定 `face`；可用同样的 `when` 在保留原脸时免除无必要确认。脸型技术检查分别要求表情补偿、损伤和平滑度、可测眼部验证，不以等待用户接受的完整资格字段造成循环。GUI 查看当前受管正/侧前后图后调用 `project.face.accept`（projectId/workflowId/expectedHash/previewSha256），Runtime 校验工程、来源、实际渲染 Run 与图片，保存 `face-output-acceptance/0.1`（artifactHash/previewSha256）到 Gate 决定的证据列。普通布尔批准不能替代这份确认，图片目录参与 face 指纹，后续变化使决定失效。高级命令 `gate accept <gate-id> --preview-hash <sha> --expect-hash <artifact-sha>` 使用同一合同。用户接受只证明外观决定，不把遮挡、穿插等未测覆盖写成已测通过。

`tool` 命令在 Run 目录下运行（与执行方相同）。它要求能阻止写入的沙箱，不会退化为只做越界扫描；不联网。有 bwrap 时用 Runtime 自己的 bwrap 挂载，没有才用 codex 沙箱：codex 沙箱会在每个可写目录里挂一个只读的 `.codex`，清空自己输出目录的工具会被它挡住（RC 实跑中打包阶段即因此失败）。`{toolRoot}`、`{project}` 在参数中替换，工程路径也可以从 `$AVH_PROJECT_DIR` 取。`unitySteps` 与任务 YAML 同义，需要 `resources: [unity_batch]`；每一步可加 `project`（工程内相对路径），在工程内的一份隔离副本上打开 Unity，此时只有副本和 Run 目录可写。SDK 构建会顺手改贴图 `.meta` 等工程文件，所以构建放在被 Git 忽略的副本（如 `_harness_build/`）里进行。工具与观测命令都会收到 `AVH_MANIFEST`（冻结的输入 Manifest）与 `AVH_PLAN`（当前方案），均为 JSON；另有 `AVH_STAGE`（当前阶段 id），同一个观测脚本可据此只计算本阶段检查要用的指标。阶段的 Unity 步骤同样收到这三个变量。

**观测。** 有两种来源：
- `command`：检查阶段在检查沙箱里运行。整个文件系统只读，无网络；工程、Run 目录和工具根只读可见。命令须把指标写到 `{out}`。
- `runFile`：由本阶段 Run 中 Runtime 控制的步骤写出，只能来自 `tool` 阶段或 Unity 步骤，路径必须位于 Run 目录的 `observations/` 下。Runtime 在自己的步骤开始前清空该目录，执行方预先放进去的文件不会被当作指标。

观测结果格式为 `observation/0.1`：

```json
{"schema": "observation/0.1", "metrics": {"param_bits": 118, "unresolved_layer_controls": 0, "animator_is_human": true, "coverage": null}}
```

指标只能是数值、真假值或 `null`。`null` 表示没有测到，和缺席一样不能让规则通过。数组、对象这类明细放可选的顶层 `details`（必须是对象），Runtime 不把它当指标读：

```json
{"schema": "observation/0.1", "metrics": {"fit_pierced_vertices": 0}, "details": {"fit_body_paths": ["Assets/Body.fbx"]}}
```

## 3. 规则与判定

`rule` 的语法：`or` 低于 `and`，`and` 低于 `not`；比较可连写（`t.lo <= n <= t.hi`），另有 `+ - * /`、一元负号、`abs()`、括号、`true`/`false`、指标名和 `t.<阈值>`。

判定结果如下：
- 缺指标时，逻辑按三值（Kleene）计算：`true or 未知` 为真，`false and 未知` 为假；最终仍为未知则记 `no_data`。
- 类型不符、未知阈值、除以零记 `error`。
- 真记 `pass`，假记 `violation`。

同一 Run 中每个观测只运行一次。Verdict 绑定检查 `on` 所指产物的当前哈希，并记录检查声明的 `scope`；依据（basis）写明规则和读到的每个值。`when` 为假时记 `not_applicable`，绑定方案哈希，依据为该条件；这是 `not_applicable` 的唯一来源。聚合规则见 [process-format-v0.1 §6](process-format-v0.1.md)。

## 4. 方案版本、Gate 与生命周期

**方案版本。** Runtime 每观测到一个新的方案文件哈希，就在 `plan_revision` 中保存一份内容快照，并用它更新 Workflow 的方案（`when` 据此判断）。批准绑定的是哈希；方案一改，批准就过期（stale），按 `when` 得出的不适用结论也随之作废。方案文件无法解析时，该版本记为错误且没有指纹，下游阶段都不会开始；`workflow show` 的「下一步」会说明原因。

**Gate。** `avh gate list` 列出待决定、已过期、已驳回、已批准的 Gate。

```sh
avh gate approve <workflow-id>:<gate-id> --note '已检查当前版本'
avh gate reject  <workflow-id>:<gate-id> --note '需要修改'
```

决定之前，Runtime 先重新读取所绑产物的指纹，再绑定当前哈希。所属阶段还没到需要决定的时候（检查尚未通过，或阶段正在重做、新版本还没出来），命令会拒绝。同一版本的批准不能撤回；要拒绝，先修改产物。只等 Gate 决定的阶段显示为 `deciding`（CLI 标 `!`，TUI 为「待你决定」）：要处理的是 Gate，待办里不再另列这个阶段的任务。拒绝只记录决定；TUI 的「驳回并重做」（接口 `gate.decide` 带 `redo: true`）同时把驳回原因作为修改意见交给该阶段重做。

配色候选 Gate 带 `preview: recolor-candidates` 时，TUI 隐去「批准」选项，只提示在同一项目的 GUI 查看 Unity 候选图后决定；它不能用普通布尔批准绕过查看。GUI/API 的 `gate.decide` 批准必须回传当前候选清单的 `expectedPreviewSha256`，Runtime 会重新读取同一 Run 的绑定图片并核对摘要；这不是 TUI 可补填的字段。

**生命周期。** `active` 表示进行中。达成 `UPLOAD_READY` 后转为 `upload_ready`；上传前证据失效时退回 `active`。达成 `CLIENT_VERIFIED` 后转为 `client_verified`，这是终态：交付已被接受，之后对工程的改动不会让它自动重跑，新工作应另建 Workflow。取消后为 `cancelled`：先取消全部未完成任务，全部确认后才标记。每次状态变化都写一条事件。

**重做。** 检查失败的阶段（`BLOCKED`）或等人的阶段（`WAITING_HUMAN`，如方案待批准）用 `avh task redo <task-id> [--note '修改意见']` 授权同一任务的新 Run；执行失败（`FAILED`）或被取消（`CANCELLED`）的阶段不会自己再跑，同样用 `task redo` 授权，这时新建任务（只能重做该阶段最新的任务，且 Workflow 仍在进行）；已通过的阶段在其 `invalidated_by` 产物变化时会自动重做，如需主动重做（例如对已批准的方案不满意），用 `avh task redo <task-id> --note '修改意见'`（TUI 里是项目详情的 `d`），这时新建任务。两种情况下意见都交给执行方：同一任务重做多次时，历次意见按时间先后全部列出，以最后一条为准；工具阶段与它的 Unity 步骤从环境变量 `AVH_FEEDBACK` 读到最新一条（例如改色重做时写「选 B」）。阶段重做期间，它的 Gate 不能决定，也不出现在待办里。任务在等人期间收到的重做请求，由随后那次 Run 回应；任务通过后不会再据此重做。新结果会使依赖它的后续阶段重新验证，其中方案的新版本需要重新批准。

**产物版本写明改了什么。** 产物指纹变化时，事件原因写明成员的增、删、改（前三个路径；负载里各列至多 50 个及总数），例如「fingerprint changed: 改 1（Packages/manifest.json）」。没人要求的阶段重跑，由此可以追到是哪个文件引起的。每个产物最近一个版本的成员表存在 `AVH_HOME/artifacts/<workflow-id>/<产物>.json`（不在工程里）；缺失时下一次查看先存一份。文件内容分块计算 SHA-256，超过 2 GiB 的交付包也能取指纹。

**被挡住的阶段随上游重跑。** 阶段的任务因检查不通过（`BLOCKED`）或等人（`WAITING_HUMAN`，如 Gate 未决）停住以后，只要它的 `invalidated_by` 产物与该任务开跑时记下的哈希不同（通常是人在上游重做并重新批准了），调度器就把旧任务记为取消（原因写明哪些产物变了），在新输入上重新安排；旧结果说的是已经不存在的产物，不再需要人处理。上游还在重跑时，这类旧任务不出现在待办和「下一步」里。

**越界改动。** 越界改动照常进入 `WAITING_HUMAN`，审阅后用 `avh task accept-changes` 接受。

**Unity 步骤。** 沙箱把 Run 的私有临时目录挂在 `/tmp`，Unity 拿到的 `TMPDIR` 就是 `/tmp`（Run 目录很深时，宿主路径会让 Unity 的 IPC 套接字超过 108 字节的路径上限）。编辑器还在加载工程（栈里有 `Application::InitializeProject` 或 `FinishLoadingProject`）时因致命信号退出的，视为启动期崩溃：还没轮到步骤方法，工程没被改动，Runtime 至多重试两次，崩溃那次的日志留作 `unity-N.log.startup-crash-K`；步骤方法运行后才崩溃的不重试。`avh project new` 建的工程默认忽略编辑器每次打开都会重写的文件（`.vscode/`、NDMF 的临时目录、lilToon 的 `CurrentRP.txt`），免得它们被当成阶段越界写入。

停止且未接受的脸型阶段原可经 `workflow.stageContract.show` / `.select` 采用已安装的内置编译工具修复；该采用通道在 dev.0.1 已关闭。只要候选会改变已冻结的工具字节，Runtime 就以 conflict 拒绝，并说明观察实现的依赖尚未可靠声明（dev.1.3 提供），请按 D-59 新开制作流程。原有的部署目标、SHA、`.meta` 与历史 Run 合同核验代码保留，供后续重新开放时使用。

## 5. 已知限制（RC 范围内）

- Unity 步骤所执行的编辑器代码如果在工程内，执行方可以改动它，进而影响 Unity 内产生的 `runFile` 观测。业务样例会把观测代码改为由 Runtime 从工具根装入，并校验哈希；阻断级检查优先采用进程外、直接解析资产的观测。同一个 Unity 进程里的其他工程代码仍能干扰进程内观测，这一剩余风险会写进发行说明。
- `tool` 阶段与 `command` 观测只校验参数里直接引用的工具文件。
- 调度每轮（默认每秒）重新计算所有进行中 Workflow 的产物指纹：内容按文件状态缓存，但成员列表与文件状态每轮都要重扫。样例工程（产物成员约 1.45 万个文件）空闲时调度进程约占 13–16% 单核（Linux 宿主机实测）。以后改为空闲降频或文件监听。
- `sandbox: self` 的执行方（codex-cli、旧 DSH）由 CLI 自己的沙箱限制写入，读取不受限：它们能读到 `AVH_HOME` 里的状态库、其他工程与 Run 目录。RC 实跑中 DSH 执行方就读了状态库里的事件和方案版本。状态库只影响执行方「知道什么」，改不了 Verdict 与 Gate（检查在执行方退出后独立运行，决定只经 Runtime 写入）。要遮住状态目录，需要改用外层 bwrap（`sandbox: outer`）并用 tmpfs 覆盖 `AVH_HOME`；公开发行前处理。

Windows Unity 使用 Runtime 为单次启动生成的短 junction 入口。授权目录、Low integrity 写根与工程版本身份始终为真实物理工程；仅编辑器 `-projectPath` 和 `AVH_PROJECT_DIR` 使用短入口。Runtime 最后写入不可由步骤配置覆盖的 `AVH_PHYSICAL_PROJECT_DIR` 与随机 `AVH_UNITY_ALIAS_NONCE`，Unity 消费者以受保护的 owner marker、nonce 和操作系统解析的真实目标核验根入口。工程内子目录和文件链接仍被拒绝。源目录引用/跨构建副本关系用物理身份比较，资产 IO 用短入口；跨副本性能基线使用物理长路径的 Windows 扩展读取形式。

setup 的 `runtimeWrites` 仅补入 Unity 自身产生的 `.vsconfig` 和 `_harness/face/preparation.json`，它们未加入 Provider 的 `allowedWrites`。短入口不增加写根，清理只解除已核验的 Runtime junction，不递归删除真实工程；退出后仍被编辑器占用的入口保守保留，后续启动不采用遗留或外来链接。
# 大型脸型补偿证据

原生 FBX 的候选收据包含逐状态补偿事实，真实商业输入可超过 128 MB。Runtime 在发出 Unity 前对冻结候选收据使用独立的 512 MB 本地读取范围；仍先核对收据 SHA、来源 FBX/meta、候选二进制及授权身份。临时导入事务与授权小记录的读取范围不随之扩大。超限时用中文说明读取限制，并保留工程与证据供更新后核对继续；不宣称几何失败，也不赋予外观接受。

### Outfit technical plan supplements

An outfit provider can submit a `shrinkkey_review` operation inside the existing observation-bound `local-operations/0.1` input. This repairs a missing writer review without changing the approved plan, accepted face, or historical Run contracts. The operation names the approved outfit root and the complete ordered `host->target:shape=Set/Delete` inventory, gives a rationale, and supplies textual expectations for `shoe_on_sock_on`, `shoe_off_sock_on`, and `barefoot`. It cannot contain approval or measured-status fields. `inspect-local-objects --section reviews` exposes Runtime inventory; legacy output is advisory and revalidated in Unity.

The frozen compiler validates the original observation/plan and asset hashes, exact actual writer sequence, duplicate reviews, set/delete conflicts and conflicting Set values. `OutfitMeasure` reloads the output and validates the supplement again; the receipt is not authority. A valid supplement is recorded as `runtime_verified` with `visual_scenarios: pending_regression`; it is a technical plan revision, never an appearance acceptance or three-state measurement. Invalid evidence returns a concrete failure for bounded stage rework. Scope or appearance choices still require the existing human confirmation/feedback path with Chinese options; no user edits to internal YAML are required.


## 配色来源补齐与阶段工具采用

`recolor` 的冻结工具 `inspect-material-dependencies` 只观察已确认输入的同商品目录公共 ZIP/unitypackage，返回来源、锚点和 SHA。AI 在本层 `Assets/_Harness/Recolor/dependencies.json` 提出 `material-dependencies/0.1`（`packages` 每项为 `anchor/archive/sha256`，可选 `missing_shader_replacement` 为已安装 shader 的准确名称）。Runtime 在 prepare 与 Unity 步骤注入当前 `assetSearchRoots`，执行九个受管编译器的 SHA 部署校验；完整预检来源授权、原输入/包哈希、路径和 GUID 冲突后，只把材质/贴图数据写入未接受的 `Recolor/Dependencies`。不导入公共包代码，不修改原资产或接受层。Runtime 重写来源回执，Unity 再核包、资产及 `.meta` 哈希；伪造回执、撤销授权和不明来源均拒绝。仅真实缺失 shader 的派生副本使用替代 shader。

配方生成器固定使用 LF 字节；独立观测器仍按重放 SHA 核验，不能靠宽松比较隐藏手改。

眼色目标可识别启用的 `_Main2ndTex` 眼部贴图层，并只调整 `_Color2nd`；未启用、无法识别的层不能满足 `eye`，不能删要求或改整张脸代替。

CLI 的 `avh workflow stage-tool show <id> --stage <stage> --pack <id>` 与 API `workflow.stageContract.show` 使用同一核验；`select` 还须传 `--expect-token` 与 `--note`。dev.0.1 对会改变已冻结工具字节的请求统一返回 conflict：观察实现的依赖尚未可靠声明（dev.1.3 提供），请按 D-59 新开制作流程。旧清单漏列、但 setup 已部署的编译器仍只可从原冻结工具包恢复输入 SHA；不接受任意现有文件。历史 Run 与服务进程升级边界保持不变。

尚未创建 Task 的已定义阶段也受上述关闭规则约束；会改变已冻结工具字节的 `show` / `select` 请求仍返回 conflict，不能借此绕过 D-59 新开制作流程的边界。

若既有眼部遮罩关闭，`iris_layers` 明确提出 `material_guid/texture_guid/source_sha256/expected_enabled/enable:true`。Unity 校验当前方案含 eye、真实材质及眼部遮罩 GUID、材质 SHA 和开关值，并拒绝没有落到实际素体眼色槽的提案；只启用派生副本。未提案的关闭图层仍不映射，妆容遮罩和漂移证据仍拒绝。

跨阶段采用的来源绑定与输入投影代码保留，但 dev.0.1 不产生新的工具采用事件；每个 Run 的冻结选择与 prepare 写权仍只来自该次选版，不把历史部署合集变成施工授权。

菜单的 local_operations.py prepare 以 Runtime 的 AVH_PROJECT_DIR 定位工程；ToolExecutor 的 cwd 是独立 Run 目录，不能当工程使用。显式 --project 保持兼容，无 Runtime 环境时才回退工作目录；部署仍完整预检当前/目标 SHA 和 Runtime 当次来源列表。

配色配方的来源数值先规范为浮点表示，再生成规范 LF 字节；YAML 的 `1.0` 与 Runtime JSON 的 `1` 可被同一独立 SHA 回放接受，真实数值/换行编辑仍拒绝。装配当轮同步导入局部操作回执，避免后继 Unity 为前序补 `.meta` 而造成输入漂移；已有失败和越界证据保留，经正式技术审阅和前序重做复验恢复，不手改 verdict 或完成记录。

静态空材质槽观察仅排除已关闭且无已登记动画启用写者的粒子渲染器；查询 Animator、VRChat 描述符和 MA 合并控制器的实际 clip。名称匹配采取保守判定，可能同名写者也保留检查。启用粒子、带启用写者的关闭粒子、普通禁用或未激活网格仍计入；这不是运行时脚本/全菜单状态验证。

### Accepted face input and managed production successors

Face acceptance, switching production mode and rollback share a transactional adoption entry. The submitted preference revision must still match the displayed revision. Acceptance checks the gate evidence, preview digest and handoff source identity, stores immutable values, adopts a formal input revision and records an idempotent `production_continuation` in the same transaction. The GUI and CLI appearance acceptance paths carry this token; the CLI option is `--expect-face-revision`.

The existing Runtime service loop consumes continuation requests. It reconciles old Runs before copying and does not infer that a writer exited from a lease timeout. Before the first face/face_design dispatch after verified setup, Runtime saves a file manifest and a managed baseline. A request made before face work adopts in place. After face work has run, Runtime prepares a separate project and full Workflow from that baseline, inherits the frozen contract and explicit stage tool selections with their own Manifest relocated through the verified copy checklist, and references eligible intake/plan/environment/setup evidence only when hashes and contracts match. Ordinary baseline copies also reconcile the current predecessor against the baseline and content-bound Runtime-generated files before publication. Added, changed or deleted unrelated files require an explicit report-bound decision to retain that difference only in the predecessor; a late source change invalidates publication. A formal resume records a refresh request, then the consumer waits for the predecessor safe point, retains the old report and decision in history, refreshes its inventory and generates a new report requiring a new decision. The retired reports also travel in the required production archive checkpoint. Face and its descendants execute and observe again, including same-byte replacements and rollback. A predecessor with an accepted delivery remains accessible and cannot dispatch additional work after a successor is enabled. The logical upload entry follows the persistent production head, refuses pending/blocked adoption and requires that current Workflow to reach UPLOAD_READY or CLIENT_VERIFIED; a previous delivery cannot qualify a new requirement. Official upload opens the resolved successor project root.

Preparation persists its checklist before filesystem work. Restart verifies copied members; publication cannot overwrite a concurrently created target. Cancellation or replacement during copying revokes publication. Cancelled preparation retains the requirement, projects and delivery records; the user can explicitly resume it with the current revision. The logical project's stored production head selects its current internal Workflow. The face panel reports current requirements, the version currently being produced, application progress and accepted delivery history. An active intended/running/verifying Run identifies the production version from its immutable input snapshot, independently of a newer requirement; the delivery read endpoint verifies retained package bytes and returns their local file locations.

The archive's required production input document includes immutable accepted content and SHA, Workflow input revisions, Run snapshots and their ownership, required stage tool selections independently of optional process history, input-aware evidence bindings, and portable continuation/delivery references. Manual session lineage is restored in two passes using the archive ID mapping, before acceptance becomes immutable. Missing, cross-project or cyclic parent references become explicit recovery problems and block dispatch; existing accepted lineage is never rewritten. Cold restore binds selected snapshots to their exact installed capability pack, verifies its frozen tools and contexts, and checks each relocated project material against its source SHA. Missing selected packs or project materials block successor publication and dispatch, with a Chinese recovery reason. Selected repair packages are separate share dependencies. The existing complete-restore entry retries the exact selected pack identity and frozen content, maps selection events, and restores the affected historical Run inputs before clearing their specific missing flags. This retry does not change face preferences or adoption revisions; late restoration preserves the original selection order for future Runs. A restored live Run needs recovery; source paths or missing compiler-selection records cannot be fabricated into valid snapshots. Missing content is reported and blocks dispatch rather than silently adopting preserve. Preparation references carry their original contract, terminal Run identity, input/output SHA and dependent observations/decisions; cold restoration validates them against the local frozen contract and actual files without creating fictitious source projects or Runs. A validated baseline restoration or successful frozen successor rebuild rechecks and releases the corresponding missing-baseline stop while retaining the recovery provenance. A single-project share can retain references to other project versions without transporting their engineering files; those absent targets remain explicit missing inputs.

Historical projects without a pre-face baseline use a persistent frozen rebuild checklist: preserve the original, seed SHA-verified original inputs and approved plan, run environment/setup in an unpublished full Workflow, reconcile unexplained original files, then publish. A newer approved plan also takes this path instead of restoring older plan bytes from the first baseline. Original input members inside the project are relocated to the same relative position in each successor only after the copy manifest and destination bytes verify against their frozen SHA; source metadata and continuation provenance are retained. External inputs keep their external identity and remain explicit content dependencies. Only preparation stages can dispatch before publication. Explicit reconciliation retains named unrelated edits in the predecessor; unexplained edits cannot disappear into a new delivery silently. Candidate and predecessor file identities are rechecked after reconciliation, on publication retry and in the final publication transaction. Failed preparation can resume only after managed writers have confirmed outcomes; cancellation uses the existing Scheduler cancellation protocol.

An incompatible old process requires explicit official successor package selection. The GUI shows the complete old/new contract, binds adoption to the package tree, old frozen snapshot, current face revision and preparation revision, and records immutable human adoption. The new full Workflow freezes exactly the selected package instead of consulting the active package. Preparation evidence with changed hashes, checks, tools or thresholds is rejected until independently reconciled; original accepted plan inputs are never regenerated by a planning agent.

**Remaining implementation/verification gaps:** historical missing source content, changed preparation/check contracts without independent revalidation, and replay of unexplained engineering patches require further recovery evidence; the current reconciliation action can explicitly retain an unrelated patch in the predecessor but does not authorize arbitrary patch replay into a successor. `resumeEarlyProductionVersion()` retains its original pre-construction boundary. Cross-project cold restore currently retains portable lineage references rather than recreating unavailable projects or resuming an unfinished copy from an external baseline. Real full-order construction, post-assembly hair/accessory and eye behavior, build-copy face identity, package cold import, client testing, CI and deployed Runtime behavior need separate evidence. Runtime tests with expensive executors substituted are orchestration evidence, not proof of those real-tool outcomes.

Native FBX continuation preserves both frozen file-unit factors, including the original-unit history field. The exporter keeps physical scale while retaining the source file unit header; independent Blender observation verifies both factors before geometry and skinning readback. Unity retains strict metadata-byte and complete importer-settings equality. Native import diagnostics preserve before/candidate/restored importer JSON and metadata SHA so an export mismatch remains observable after the source transaction restores its bytes.
