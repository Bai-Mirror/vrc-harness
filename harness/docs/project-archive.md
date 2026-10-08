# 工程档案（`_harness/`）格式合同 v1

对应设计稿 [工程档案化与分层共享恢复方案](../../docs/zh/设计/2-功能模块/20_交付与恢复.md) 的前两步：**统一事实合同**与**工程内持久化**。实现在 `src/archive/`，状态库迁移为 `src/state/migrations/0022_project_archive.sql`。本文是格式合同：分享包编译器（7z、`manifest.json`/`files.json`、分层选择）和同版 Harness 恢复依据本文实现，见[可继续制作的工程分享包与同版恢复](project-share.md)（第 3、4 步）。

## 1. 边界

- **本机 SQLite 状态库是权威**。工程档案是它在工程目录里的投影：有版本、开放格式（JSON，另有一份 YAML 摘要）、只含相对路径，写入后读回校验。
- 档案写入失败**不影响制作**，只记录下来并阻断“可分享工程”（见第 10 节）。
- 分享包编译、7z 打包、导入分享包与界面见 [project-share.md](project-share.md)。
- 档案**不含**：运行中的锁、PID、租约、登录态与凭据、Provider 快照、Run 目录里的日志与观测原件、知识上下文正文（只有 sha256）、产物成员清单（接收端按冻结规格重算，见 12.3）。

## 2. 目录布局

`_harness/` 下的逻辑分区如下。文件一律 UTF-8、LF 换行；JSON 由 `JSON.stringify(值, null, 2)` 加结尾换行写出，文件的 sha256 按写出的字节计算。

| 逻辑分区 | 路径 | 分享层级 | 内容 |
| --- | --- | --- | --- |
| 清单 | `_harness/archive.json` | A | 档案清单：档案身份、修订号、摘要、每个文件的路径与 sha256（第 8.1 节） |
| state | `_harness/state/project.json` | A | 当前状态：身份、方向、造型、头像根、素材、Workflow 阶段与 Gate、任务、待处理项 |
|  | `_harness/state/project.yaml` | A | 旧版 `harness-project-state` 的可读摘要（0.2，可移植） |
|  | `_harness/state/facts.json` | A | A 层的全部事实记录（含历史） |
|  | `_harness/state/registry.json` | A | 分类登记表与最近一次扫描的待分类队列 |
|  | `_harness/state/workflows.json` | A | 每个正式 Workflow 的冻结流程、能力清单、阈值、工具与上下文哈希 |
| records | `_harness/records/decisions.json` | A | 方案修订、Gate 决定（及是否仍有效）、已确认决定 |
|  | `_harness/records/sources.json` | A | 导入报告摘要、项目素材来源与转交权、BOOTH 选材、VPM 操作 |
|  | `_harness/records/events.json` | B | 非人工的施工事件与 Run 摘要 |
| evidence | `_harness/evidence/index.json` | A | 检查结论、产物指纹版本、阶段完成、导入复核、输入观测 |
| recovery | `_harness/recovery/takeover.json` | A | Harness 校验后的接手记录：恢复任务、候选事实与问题的 id、未知项 |
|  | `_Harness/Recovery/`（接手分析 Task 的写入区） | C | AI 的原始分析：`analysis.json`、`recovery.md`、`facts.json`、`apply.json`、`distillation.md` |
| packs | `_harness/packs/index.json` | A | 本项目候选能力包的恢复信息（第 8.10 节） |
|  | `_harness/candidate-packs/<id>/` | A | 候选能力包草稿（已有目录，不由档案写入） |
| optional | `_harness/optional/facts.json` | B | B 层事实 |
| sensitive | `_harness/sensitive/facts.json` | C | C 层事实 |
|  | `_harness/sensitive/project.json` | C | 订单号、原始需求、人工事件的原话、Blueprint ID、Manifest 原话、导入源文件名 |
|  | `_harness/sensitive/conversation.json` | C | 完整对话：全部项目消息（分享时可单独选择） |
| share | `_harness/share/` | C | 按收件人保存的记录：恢复时写 `restore-<id>.json`（不含本机路径）。不在档案清单里，也从不随分享包转交 |

说明：

- `recovery` 分区有两个物理位置。AI 接手分析一直写 `_Harness/Recovery/`；Harness 自己的接手记录写 `_harness/recovery/takeover.json`。在 Windows 这类大小写不敏感的文件系统上，这两个目录是同一个目录；两者的文件名不重叠，登记规则按第 6 节的“并列取严”处理。
- Workflow 阶段自己在 `_harness/` 下写的产物（如 `_harness/plan/`、`_harness/intake/`、`_harness/setup/`、`_harness/delivery/`）**不是**档案分区，它们按 Workflow 产物登记。
- 档案文件总是全部写出（B、C 层文件可能为空列表），以便读者不必判断文件是否存在。

## 3. 路径规则

- **可移植路径**：相对工程根，用 `/` 分隔，不含 `.`、`..` 或空段，不以 `/` 或盘符（`X:`）开头，不含 `\`、NUL 与换行。工程根本身写作 `.`。登记表里的目录（tree）以 `/` 结尾。判定函数：`isPortablePath`（`src/archive/contract.ts`）。
- 档案里的一切路径（清单的文件路径、定位 `locator.path`、失效条件的 `path`、登记路径、草稿路径）都是可移植路径，并且都相对**工程根**（不是相对 `_harness/`）。
- **大小写**：路径按字符串记录；比较时是否区分大小写跟随文件系统（Windows 不区分，Linux 区分）。同一份档案在两类系统上读作同一组文件，除非工程里真有仅大小写不同的两个路径。
- **绝对路径只作本机记录**。结构化字段按含义转换：工程内的路径转成相对路径；工程外的素材库文件只保留文件名（`location: {in: "library", file}`）；导入源、Run 目录、`toolRoot`、运行变量的值不进档案（运行变量只保留名称）。
- **自由文本**（事件理由、检查依据、复核说明、方案正文等）经 `portableText` 处理：工程内的路径改写为相对路径（工程根改写为 `.`）；工作区、`AVH_HOME`、用户目录下的路径**整段**替换为 `<工作区>`、`<AVH_HOME>`、`<本机路径>`（那里的目录名可能含客户名）；其余看起来是本机绝对路径的（Windows 盘符路径、UNC、`/home`、`/Users`、`/tmp` 等系统根下的 POSIX 路径）替换为 `<本机路径>`。Unity 层级路径（如 `/Avatar/Body`）与 URL 不受影响。因此工程搬迁后，含旧路径的自由文本在下一次写入时会改写，结构化内容不变。
- 写入后的读回校验逐个文件查找残留的本机路径（`localPathLeaks`）：当前工程根、工作区、`AVH_HOME`、用户目录（两种分隔符写法，Windows 不区分大小写），以及上述盘符、UNC 与系统根模式。发现即判写入失败。

## 4. 事实记录合同

每个业务结论是一条事实记录。同一对象、同一属性的**最新一条**是当前记录；旧记录保留为历史，永不改写（状态库有触发器禁止 UPDATE/DELETE）。

### 4.1 字段

| 字段 | 含义 |
| --- | --- |
| `id` | 记录 id。存储的记录是 UUID；派生记录见 4.6 |
| `objectId` | 业务对象 id：`类型` 或 `类型:键`，类型为小写字母与下划线（见 4.7） |
| `attribute` | 对象的属性名，`^[A-Za-z][A-Za-z0-9_.-]{0,63}$` |
| `value` | JSON 值；未知为 `null`；序列化后不超过 16 KiB |
| `source.type` | 来源类型：存储的 `import_scan`、`harness_scan`、`takeover_analysis`、`user`；派生的 `workflow`、`project` |
| `source.ref` | 来源引用，可移植：如 `import_report:<id>`、`ProjectSettings/ProjectVersion.txt`、`_Harness/Recovery/facts.json#/facts/3`、`verdict:<id>`、`gate_decision:<序号>`、`fact:<被确认的记录 id>` |
| `locator` | 依据在工程里的位置：`{path?, line?, object?}`，`path` 为可移植路径，`object` 为文件内对象（场景层级路径等） |
| `inputFingerprint` | 得出结论时输入的指纹（文件 sha256、产物指纹、导入快照哈希），可为 `null` |
| `observer` | 观察工具及版本，或确认人（`user`、`human`），如 `harness-import/<版本>`、`harness-scan/<版本>`、`takeover-analysis/1 via <执行方>` |
| `observedAt` | 观察或确认的时间（ISO 8601） |
| `status` | 记录时的状态（4.2）；当前状态见 `effectiveStatus` |
| `evidenceLevel` | 证据等级（4.3），与置信度无关 |
| `confidence` | 0–1 的置信度，可为 `null`；不能替代证据等级 |
| `scope` | 适用范围：`project`、`workflow:<id>`、`process:<流程>@<版本>`、`recovery:<恢复 id>`、`workspace` |
| `invalidation` | 失效条件列表（4.4）；任一条件成立即失效 |
| `shareLayer` | `A`、`B`、`C`、`excluded`；决定写进哪个档案文件（`excluded` 不进档案） |
| `supersedes` | 被本记录取代的记录 id（同对象同属性的上一条，或被确认的那条） |
| `recordedAt` | 写入状态库的时间 |

档案里的事实还带三个派生字段：`effectiveStatus`（现在的状态）、`current`（是否为当前记录）、`invalidatedBy`（成立的失效条件及输入现在的值，`[{condition, now}]`，`now` 为 `null` 表示不存在）。

### 4.2 状态

| 状态 | 含义 | 允许的证据等级 |
| --- | --- | --- |
| `observed` | 确定性观察器直接从当前输入读出；记录里的书面说法也按“记录声称”观察 | `observation`、`document` |
| `inferred` | 推断：AI 或启发式得出，待人确认 | `inference` |
| `user_confirmed` | 人的陈述：确认、更正，或对 Gate 的决定 | `attestation` |
| `verified` | Runtime 的独立检查结论，绑定产物哈希 | `verification` |
| `unknown` | 文件无法证明；值必为 `null` | `none` |
| `stale` | 派生状态：失效条件成立。记录时一般不写（恢复导入可保留导出时已失效的记录） | 任意 |

其他约束：`takeover_analysis` 只能记 `inferred`；`user_confirmed` 只能来自 `user`（派生的 Gate 决定除外）。

### 4.3 证据等级

由弱到强：`none`（0）< `inference`（1）< `document`（2，书面说法未经核对）< `observation`（3，从当前文件确定性读出）< `attestation`（4，人的陈述，意图与权利的权威）< `verification`（5，独立检查且绑定产物哈希）。比较函数 `evidenceAtLeast`。阶段要求“最低证据等级”时按这个顺序比较。

### 4.4 失效条件

```json
{"kind": "file", "path": "ProjectSettings/ProjectVersion.txt", "sha256": "<64 位十六进制>|null"}
{"kind": "artifact", "workflowId": "<id>", "artifact": "plan", "hash": "<产物指纹>"}
{"kind": "fact", "factId": "<记录 id>"}
```

- `file`：该文件**最近一次被观察到**的 sha256（状态库的输入观测，见 5.3）与绑定值不同即失效；`null` 表示绑定时文件不存在。从未观测过的输入不判失效。
- `artifact`：该 Workflow 产物的当前指纹与绑定值不同即失效。当前指纹：Workflow 仍在推进（`active`/`upload_ready`）时取调度器记录的最新 `artifact_version`；已结束的 Workflow 取扫描观测到的 `artifact:<workflow>:<产物>` 输入，没有观测时退回最新 `artifact_version`。
- `fact`：所依据的记录的对象属性，其当前记录的值与依据时不同、为 `unknown`/`stale`、或自身失效，即失效。更正（值变化）因此使依赖它的结论失效；同值确认不会。

失效是**派生**的：不写任何记录，输入恢复原样后结论重新成立。所以档案是状态库的纯函数：同一个状态库投影出同样的字节。

### 4.5 当前记录与人的陈述

- 写入时，与当前记录结论相同（值、状态、证据等级、层级、范围、输入指纹、失效条件、置信度都相同）的新记录会被跳过：重复扫描、重复导入同一工程不增加记录。
- **人的陈述优先**：当前记录来自 `user` 且它自己的失效条件都不成立时，接手分析的推断不写入；导入与扫描的观察只有在它读到的某个文件自上次观测后变了才写入（再看一遍同样的文件不算新证据）。陈述已失效时，观察者照常写入新记录。为此，扫描与导入记下的“未知”编辑器版本与依赖声明绑定文件当时的状态（通常是不存在），文件出现即算变化。
- 确认（`confirm`）：保留值，文件绑定改取最新观测，依赖改指向依据的当前记录；确认 AI 推断时去掉对分析报告本身（其 `source.ref` 所指文件，如 `_Harness/Recovery/facts.json`）的绑定——人的陈述不依赖 AI 的报告。未知的记录不能直接确认。更正（`correct`）：新值，只保留文件绑定（同样去掉分析报告）。否定（`reject`）：记为 `unknown`，无绑定。三者都追加一条 `source.type = user`、`supersedes = 原记录` 的记录，并写一条人工事件（原话进 C 层）。只能对当前记录操作。
- 同一批里某条记录因重复或人的陈述而没有写入时，依赖它的后续记录改为依赖那条当前记录。

### 4.6 派生记录

不复制进 `project_fact`，由自己的表在投影时生成，形状相同：

| 来源 | id | 对象/属性 | 状态与绑定 |
| --- | --- | --- | --- |
| 最新 `artifact_version`（每个产物） | `workflow:<wf>:artifact_version:<序号>` | `artifact:<产物>` / `fingerprint` | `observed`；绑定该产物指纹 |
| 最新检查结论（每个检查） | `workflow:<wf>:verdict:<结论 id>` | `check:<检查>` / `verdict`，值 `{result, scope}` | `verified`；绑定检查对象产物（不适用时绑定 `plan`） |
| 最新 Gate 决定（每个 Gate） | `workflow:<wf>:gate_decision:<序号>` | `gate:<Gate>` / `decision` | `user_confirmed`/`attestation`；绑定 Gate 所绑产物 |
| 最新阶段完成（每个阶段） | `workflow:<wf>:stage_completion:<序号>` | `stage:<阶段>` / `completion`，值 `{artifactHashes}` | `verified`；绑定其中每个产物 |
| 警告接受 | `workflow:<wf>:warning_acceptance:<序号>` | `check:<检查>` / `warningAccepted` | `user_confirmed`；绑定该结论的产物 |
| 项目方向 | `project:<项目>:brief:<属性>` | `brief` / `intakeMode`、`status`、`faceConcept`（A）、`goal`（C） | `user_confirmed` |
| 已采纳消息 | `project:<项目>:message:<id>` | `decision:<id>` / `accepted` | `user_confirmed` |
| 头像根 | `project:<项目>:root:<id>` | `avatar_root:<场景>#<对象路径>` / `lineage`；`blueprintId` 在 C 层 | `user_confirmed` |
| 造型 | `project:<项目>:variant:<id>` | `variant:<id>` / `plan` | `user_confirmed` |
| 项目素材 | `project:<项目>:asset:<id>` | `asset:<id>` / `use` | `user_confirmed` |

只有项目**最新的正式 Workflow**产生派生事实；更早的 Workflow 是历史，只出现在 `records/decisions.json`（其决定的 `valid` 为 `null`），不会被显示为仍然有效。

### 4.7 对象类型

`project`、`record`（施工记录）、`stage`、`review`（导入复核）、`ledger`（账本条目）、`artifact`、`check`、`gate`、`brief`、`decision`、`avatar_root`、`variant`、`asset`、`question`（待回答的问题）；接手分析另可用 `unity_root`、`scene`、`prefab`、`dependency`、`package`、`menu`、`parameter`、`plugin`、`practice`、`risk`。

## 5. 各来源如何记录

### 5.1 导入扫描（`import_scan`）

`importProject` 只读工程；以下记录与导入报告写在同一事务里（`src/archive/import-facts.ts`），来源引用 `import_report:<id>`：

- `project`/`unity.version`（绑定 `ProjectVersion.txt`）、`project`/`vpm.locked`（绑定 `Packages/vpm-manifest.json`）：`observed`/`observation`；文件缺失时 `unknown`。
- `project`/`base.avatar`：由记录与资源路径中的提及次数推断，`inferred`，置信度为最可能者占提及总数的比例；没有线索时 `unknown`。
- `project`/`history.timeline`：有施工记录时 `observed`/`document`（值为条数与最近日期，绑定记录文件）；没有记录时 `unknown`。
- `project`/`history.approvals`、`project`/`history.verification`：**总是 `unknown`**，文件扫描无法证明批准和验证。
- `stage:<阶段>`/`history.progress`（范围 `process:<流程>@<版本>`）：导入判定 `verified` 记 `observed`/`observation`（记录声称完成且指定复核通过）；`claimed` 记 `observed`/`document`；只有文档存在的弱证据记 `inferred`；`not_applicable` 记 `observed`/`document`；`unknown` 记 `unknown`。导入**从不**记 `verified`。
- `review:<复核>`/`result`、`project`/`git.state`、`project`/`import.snapshot`：`observed`，输入指纹为导入快照哈希。
- 账本条目 `ledger:<id>`/`status`、状态头 `record`/`stateHeader`、已拍板 `record`/`decisions`、决定表 `record`/`pendingDecisions`：原文是经营者与客户的话，**C 层**。工程外（工作区）的来源写成 `workspace:<相对工作区的路径>`，不作定位。
- 导入时存在的每个文件都登记进分类登记表（5.1 的“导入基线”，见第 6 节）。

### 5.2 AI 接手分析（`takeover_analysis`）

接手分析 Task（`import/recovery.ts`）必须写三份输出：`_Harness/Recovery/analysis.json`、`_Harness/Recovery/recovery.md`（Markdown，带标题）、`_Harness/Recovery/facts.json`。`facts.json` 的格式：

```json
{
  "schema": "harness-takeover-facts/1",
  "facts": [
    {"object": "avatar_root:Assets/Scenes/Main.unity#/Avatar", "attribute": "descriptor", "value": "present",
     "locator": {"path": "Assets/Scenes/Main.unity", "object": "/Avatar"},
     "basis": "该对象挂有 VRCAvatarDescriptor", "confidence": 0.9, "dependsOn": []}
  ],
  "questions": [{"id": "menu-owner", "question": "……", "about": "menu:Main"}],
  "ready": true
}
```

校验（`validateTakeoverFacts`、`ingestTakeover`）：`analysis.json` 是对象、`ready` 为 `true`、`classification` ∈ `project`/`asset_bundle`/`mixed`/`unknown`；`recovery.md` 非空；`facts.json` 的 `schema`、`ready` 如上；`facts` ≤ 2000 条，`object` 为 4.7 中接手分析可用的类型，`attribute` 合法且**不能是 `history.*`**（历史只能写进问题），`value` 必填且序列化后 ≤ 4096 字节，`locator.path` 必填、可移植且在工程内存在（工程根写 `.`），`basis` 为 1–1000 字，`confidence` ∈ [0,1]，`dependsOn` 只能引用排在前面的序号；`questions` ≤ 200 条，`id` 唯一。

Task 通过后（调度循环或读取恢复记录时对账）：结构完整则每条候选记为 `inferred`/`inference`（范围 `recovery:<恢复 id>`，A 层），绑定 `facts.json` 的 sha256、定位文件的 sha256，以及 `dependsOn` 对应记录；问题记为 `question:<id>`/`open`；另记 `project`/`takeover.classification`。恢复记录置为 `ready`。任何一项不完整则什么都不记，恢复记录置为 `failed` 并写明原因。**`ready` 只表示三份输出结构齐全、候选已作为待确认推断入库**，不表示工程可交付或历史已恢复。AI 的 `basis` 原文留在 `facts.json`（C 层），接口在该文件未变时才显示它。改造（`project.recovery.apply`）要求恢复记录为 `ready`。

### 5.3 差异扫描（`harness_scan`）

- **轻扫描**（每个安全点）：重新观察 `ProjectVersion.txt`、`vpm-manifest.json`（记 `unity.version`、`vpm.locked`、`vpm.unresolved`——锁定了却没有 `Packages/<id>/package.json` 的包）；把每条存储记录绑定的文件的当前 sha256 记为输入观测（`project_input_observation`，只在变化时追加，按大小、mtime、inode 缓存）；最新正式 Workflow 已结束时，按冻结规格重算被事实绑定的产物指纹并记为输入观测。
- **树扫描**（经接口 `project.import` 导入后、`project.archive.refresh`/`avh project archive`、以及项目的任务有新事件后的下一个安全点）：登记 VPM 锁定包、最新 Workflow 产物的成员；计算项目候选包草稿的树哈希；遍历工程并记录待分类队列（`project_scan`）。

### 5.4 用户确认（`user`）

`project.fact.confirm`（第 11 节）。见 4.5。

### 5.5 Workflow 结果与项目表

见 4.6：检查结论与阶段完成是绑定产物哈希的 `verified` 事实；Gate 决定是绑定产物哈希的人工确认。产物变化后它们在 `effectiveStatus` 上成为 `stale`，不再列为已知事实（验收样例 ⑦）。

## 6. 分类登记表

每个登记项：`path`、`match`（`file`、`tree`；内建规则另有 `root-suffix`）、`category`、`shareLayer`、`rights`（`transferable`、`not_transferable`、`unknown`）、`sensitivity`（`normal`、`sensitive`、`secret`）、`source`（`{type, ref}`）、`sha256`（登记时已知的内容哈希）、`restore`（被排除的路径如何取回：`vpm`、`regenerate`）、`reason`。

来源与优先级（`SOURCE_PRIORITY`）：

| 来源 | 优先级 | 登记什么 |
| --- | --- | --- |
| `harness` | 100 | 内建规则：档案分区、候选包草稿、接手分析区、导入原件区、`.git/`、根目录下的缓存（`Library/`、`Temp/`、`Logs/`、`obj/`、`Build/`、`Builds/`、`MemoryCaptures/`、`Recordings/`、`UserSettings/`、`_harness_build/`、`.vs/`、`.idea/`、`.vscode/`、NDMF 与 ZZZ 生成目录、lilToon 的 `CurrentRP.txt`、根目录的 `*.csproj` 等）。不可被覆盖 |
| `user` | 90 | 人的归类（`project.files.classify`）。不能登记 Harness 自有分区；`secret` 只能是 `excluded` |
| `vpm` | 70 | `Packages/<id>/`：VPM 锁定依赖，`excluded`，`restore: vpm` |
| `workflow` | 60 | 最新 Workflow 各产物的成员文件：A 层、转交权 `unknown`；`includeIgnored` 的构建输出为 `excluded`、`restore: regenerate`。已由内建规则覆盖的成员（如 `_harness_build/` 下的构建副本）不重复登记 |
| `import_scan` | 40 | 导入时存在的每个文件：按位置归类（`Assets/**` 为 `unity-asset`/`unity-meta`，A 层，转交权 `unknown`；`ProjectSettings/**`、依赖声明为 A 层、`transferable`；根目录 `.md`/`.txt` 工作记录为 C 层、`sensitive`；其他为 B 层、`unknown`） |
| `unity` | 20 | 内建的 Unity 配置默认：`ProjectSettings/`、`Packages/manifest.json`、`vpm-manifest.json`、`packages-lock.json`、`.gitignore`、`.gitattributes`、`.vsconfig`：A 层、`transferable`（内容仍须经导出时的敏感信息检查） |

判定（`classifier`）：取覆盖该路径的登记中优先级最高者；同优先级取最具体者（`file` 胜过 `tree`，长前缀胜过短前缀，`root-suffix` 最弱）；再同则取最新登记；仍并列（大小写不敏感的系统上同一目录的两种写法）则各属性取更严格者：层级 `excluded` > `C` > `B` > `A`，转交权 `not_transferable` > `unknown` > `transferable`，敏感度 `secret` > `sensitive` > `normal`。内建规则都锚定在工程根：插件内同名的 `Library/` 不受影响。

**待分类队列**：树扫描遍历工程（不进入 `walk: false` 的内建树，不跟随符号链接），任何登记都不覆盖的文件进入待分类（`project_scan.unclassified_json`，前 500 个，另记总数）。符号链接单列，一律需要人工处理。**目录本身从不授予分享资格**：Unity 工程主体里新出现的文件同样是待分类。档案自己的文件（`_harness/archive.json`、各档案分区、`_harness/share/`）不计入扫描的文件数与分层计数：扫描在每次写入之前进行，计入它们会让下一次扫描总与这一次不同。

权利：付费 BOOTH 素材默认 `not_transferable`（`records/sources.json` 的 BOOTH 文件），除非另有许可记录；来源不明的工程资源为 `unknown`。分享 A 层要求被选文件为 `transferable`。

每次登记追加一行；同一路径、同一匹配方式、同一来源类型的最新一行生效，与生效登记相同的登记不重复写入。

## 7. 修订与校验协议

安全点（`projectSafePoint`）：

1. 项目内没有 `RUNNING`/`VERIFYING` 的任务，也没有 `project:<id>` 锁（`safePointProblem`）。否则什么都不写，返回 `deferred`。
2. 对账已结束的接手分析（5.2），做轻扫描（必要时树扫描）。这些只写状态库。
3. 写档案（`writeProjectArchive`）：
   1. 先在只读快照里判断：数据库投影的摘要等于最新修订、该修订最近一次写入已校验、磁盘上的清单与之前写的逐字节相同且各文件大小相符——则返回 `unchanged`，不取写锁。
   2. 否则开 `BEGIN IMMEDIATE`（排他于其他写入者与 Run 派发），重新检查安全点，取得或建立档案身份（见下），**从状态库投影**全部文件，计算摘要。
   3. 摘要与最新修订不同则追加修订 `n+1`（`project_revision`）。同一修订一分钟内刚失败过的，安全点不重试（返回 `deferred`），显式刷新（`force`）才重试。
   4. 逐个写文件：内容与磁盘不同才写，写到同目录临时文件再改名替换（Windows 上改名被占用时短暂重试）；**清单最后写**。
   5. 读回：清单与各文件，校验 sha256、JSON 可解析、`schema` 与清单一致、清单摘要与文件列表一致、没有本机路径（第 3 节）。
   6. 追加写入记录（`project_archive_write`：`verified` 或 `failed` 与原因）；失败另写一条 `project_state`/`projection_failed` 事件（同一原因只写一次）。提交事务。
   任何一步异常：回滚，只留下失败事件，返回 `failed`。

**摘要**：`sha256(canonicalJson([[路径, sha256], …]))`，按路径以 UTF-16 码元排序；清单本身不计入。`canonicalJson` 见 `src/pack-hash.ts`。

**档案身份**：`archiveId` 是项目在档案里的稳定 id（UUID），与状态库 id 无关（导入项目的状态库 id 由绝对路径派生，换目录即变）。项目首次写档案时，若工程里已有合法的 `archive.json` 且其 `archiveId` 未被本库其他项目占用，则**沿用**（`origin: adopted`）；否则新建（`created`）。

**写入时机**：调度器每轮结束时（正式 Workflow 所在项目，项目内无 Run 时）；接手分析结束后的调度循环；接口里改动项目状态的方法（经 `writeProjectState`）；`project.archive.refresh` 与 `avh project archive`（含树扫描、强制重试，并先刷新仍在推进的 Workflow 的产物指纹）。

## 8. 各文件

所有 JSON 文件顶层都有 `schema`。未列出的字段以代码为准；读者遇到不认识的 `schema` 应拒绝该文件。

### 8.1 `_harness/archive.json`（`harness-project-archive/1`）

```json
{"schema": "harness-project-archive/1", "archiveId": "<UUID>", "revision": 3, "digest": "<sha256>",
 "createdAt": "<修订建立时间>", "producer": {"name": "harness", "version": "<包版本>", "stateSchema": 22},
 "files": [{"path": "_harness/state/project.json", "schema": "harness-project-state/1", "partition": "state",
            "layer": "A", "sha256": "<sha256>", "bytes": 1234}]}
```

`revision` 与 `digest` 必须等于状态库 `project_revision` 中同号修订的摘要（一致性检查据此判断档案是否出自本库）。

### 8.2 `state/project.json`（`harness-project-state/1`）

`archiveId`；`project`：`kind`、`lifecycle`、`identity`（`kind`、`unityVersion`、`packages`、`base`；编辑器与包取当前有效的事实——观测到的或本人确认的——没有则取导入时的身份；**不含订单号**）；`brief`：`intakeMode`、`status`、`faceConcept`（原始需求在 C 层）；`variants`；`roots`（不含 Blueprint ID）；`assets`：`{id, name, kind, status, role, location}`，`location` 为 `{in: "project", path}` 或 `{in: "library", file}`；`workflow`（最新正式 Workflow，无则 `null`）：`id`、`profile`、`status`、`createdAt`、`frozenAt`、`processHash`、`knowledgeVersion`、`plan`（`hash`、`revisions`、`approved`、`error?`）、`stages`（`id`、`status`、`display`、`reasons`、`codes`、`task`、`gates`、`produces`、`checks[{id, severity, on, verdict{result, recordedAt, current}}]`）、`milestones`、`gates`（`gate`、`kind`、`binds`、`owner`、`status`、`artifactHash`）、`next`；`tasks`：项目全部任务的 `{id, workflowId, formal, stage, status, attempts, updatedAt}`；`attention`：待人或恢复处理的任务（`WAITING_HUMAN`、`BLOCKED`、`FAILED`、`RECOVERY_REQUIRED`）及最近一次转移的理由；`cases`：与 compact 相同的历史案例。

### 8.3 `state/project.yaml`（`harness-project-state/0.2`）

旧版 0.1 的形状去掉绝对路径与时钟：没有 `project.path` 与 `generatedAt`，素材路径换成 `location`，`brief` 不含原始需求，头像根不含 Blueprint ID，身份不含订单号；多一个 `archive` 字段指向清单。只供人阅读与 Git 审阅；机器读 `project.json`。

### 8.4 事实文件（`harness-project-facts/1`）

`state/facts.json`、`optional/facts.json`、`sensitive/facts.json` 形状相同：`{schema, layer, facts: [...]}`，`facts` 为该层的全部记录（存储记录含历史；派生记录只有当前的），字段见 4.1，按 `objectId`、`attribute`、`recordedAt`、`id` 排序。

### 8.5 `state/registry.json`（`harness-file-registry/1`）

`precedence`（来源优先级表）；`rules`：内建规则（第 6 节）；`entries`：生效的登记，按相同属性分组为 `{source, category, layer, rights, sensitivity, restore, reason, paths: [{path, match, sha256, order}]}`（`order` 为登记顺序，用于“同级取最新”）；`scan`：最近一次树扫描 `{scannedAt, files, unclassified, unclassifiedSample, symlinks, layers, rightsUnresolvedA, truncated}`，从未扫描为 `null`。`scannedAt` 是这个扫描结果**第一次出现**的时间：结果相同的重复扫描不改变档案，因此只重新遍历的刷新或分享不写新修订。

### 8.6 `state/workflows.json`（`harness-project-workflows/1`）

每个正式 Workflow：`id`、`profile`、`status`、`processId`、`processHash`、`knowledgeVersion`、`frozenAt`、`current`、`definition`、`capabilities`、`thresholds`、`tools`（工具路径 → sha256）、`contexts`（知识路径 → sha256，**不含正文**）、`variables`（运行变量**名称**）、`manifest`（`schema`、`profile`、`assets[{store, role, variant, name, item}]`、`variants`；工程外的 `item` 只留文件名；用户原话在 C 层）。

### 8.7 `records/decisions.json`（`harness-project-decisions/1`）

`workflows[]`：`workflowId`、`current`、`plans[{order, hash, observedAt, error?, decided}]`、`currentPlan`（仅最新 Workflow 的当前方案内容）、`gates[{order, gateId, result, artifactHash, recordedAt, binds, valid}]`（`valid`：仅最新 Workflow 计算，产物仍是该哈希为 `true`，否则 `false`；旧 Workflow 为 `null`）、`rejections[{order, gate, artifactHash, at}]`；`accepted[{content, at}]`。

### 8.8 `records/sources.json` 与 `records/events.json`

`sources`（`harness-project-sources/1`）：`imports[]`（报告 id、时间、流程与解释版本、快照哈希、抽样文件数、身份、阶段判定、复核状态、计数）；`assets[]`（`location`、`license`、`tags`、`rights`）；`booth[]`（选材计划及文件：商品 id/名称/店铺/URL/分类、文件名、版本、大小、sha256、取回状态，`rights: not_transferable`）；`vpmActions[]`。

`events`（`harness-project-events/1`）：项目各 Workflow 的事件，以及项目、导入报告、恢复、消息、素材关联的事件，**不含人工事件**——人工事件（Gate 决定、重做意见、事实确认等，理由是人写的原话）只在 `sensitive/project.json` 的 `humanEvents`：`{order, at, workflowId, actor, entityType, entityId, action, reason, payload}`；`runs[{id, taskId, attempt, status, provider, exitStatus, errorClass}]`。

### 8.9 `evidence/index.json`（`harness-project-evidence/1`）

`workflowId`（最新正式 Workflow）；`verdicts[{id, checkId, scope, result, basis, artifact, artifactHash, recordedAt, current}]`；`artifacts[{order, kind, hash, observedAt, latest}]`；`completions[{order, stage, artifactHashes, runId, recordedAt}]`；`importReviews`（最近一次导入的复核及其依据）；`inputs[{input, fingerprint, observedAt}]`：每个输入的最新观测，`input` 为 `file:<路径>`、`artifact:<workflow>:<产物>` 或 `pack-draft:<候选 id>`；`outOfBounds[{order, stage, artifact, accepted, recordedAt}]`：阶段在产物之外的写入（未接受的会让阶段等人处理，恢复后同样如此）。旧档案没有 `outOfBounds` 时，恢复从 `state/project.json` 阶段理由里的 `out-of-bounds change: …` 取回未接受的那些。

### 8.10 `recovery/takeover.json` 与 `packs/index.json`

`takeover`（`harness-project-takeover/1`）：`recoveries[{id, sourceKind, sourceHash, mode, distill, status, analysisTaskId, applyTaskId, candidateRoots, warnings, createdAt, updatedAt, candidates, questions}]`（后两者为事实 id）；`unknown[{objectId, attribute, factId}]`：所有当前为未知的结论。导入源的绝对路径不进档案，文件名在 C 层。

`packs`（`harness-project-packs/1`）：`candidates[]`：`id`、`registered`、`basePackId`、`version`、`contentHash`、`sourceKind`、`status`、`permissions`、`authorityAudit`、`evaluation{status, suiteId, suiteVersion, isolation, finishedAt}`、`draft{path, treeHash, matchesContent}`、`restoreFrom`：`project-draft`（工程内草稿的树哈希等于登记的内容哈希，可直接从工程恢复）、`local-store`（只有原机 `AVH_HOME/managed/candidates/<id>` 有登记内容，分享时须另外带上并按 `contentHash` 校验）、`unregistered`；`authorings[]`；`trials[{id, candidateId, contentHash, mode, status, workflowId, restrictions, createdAt, activatedAt, disabledAt}]`（试用范围与限制）。树哈希算法为 `packTreeHash`（`src/pack-hash.ts`）。试用机制本身不变。

### 8.11 `sensitive/project.json`（`harness-project-sensitive/2`）

`identity.orderNumber?`、`brief.goal`、`humanEvents[]`、`manifests[{workflowId, request}]`、`blueprints[{rootId, blueprintId}]`、`recoverySources[{id, name}]`。

v1（`harness-project-sensitive/1`）另有 `messages[]`，其余相同。v2 把消息移到 `sensitive/conversation.json`，使分享能单独带上（或留下）完整对话。读者两种都认：v1 档案恢复时从这里取消息。

### 8.12 `sensitive/conversation.json`（`harness-project-conversation/1`）

`messages[{id, role, status, content, at}]`：项目的全部消息（完整对话）。新对话仍从事实生成的 compact 开始，不读这个文件。

## 9. 一致性检查

`checkProjectArchive` / `avh project archive --check`：

| 结果 | 条件 |
| --- | --- |
| `missing` | 工程里没有 `_harness/archive.json` |
| `diverged` | 清单无法解析或 schema 不对；`archiveId` 与本库记录的不同；状态库没有该修订，或修订摘要不同；任一文件缺失、内容与清单不符、schema 不符、含本机路径；清单摘要与其文件列表不符 |
| `outdated` | 档案完好且出自本库，但状态库现在投影出的内容已不同（`changed` 列出会变的文件），等下一个安全点写入 |
| `consistent` | 以上都没有，且现在的投影与磁盘完全相同 |

## 10. 可分享状态

`archiveStatus` 的 `shareable.blockers`（导出编译器取其中档案与运行相关的几项，再按实际选入的文件逐个检查分类、转交权、链接与内容，见 [project-share.md §5](project-share.md#5-打包前检查受阻或降级不静默裁剪)）：

| 代码 | 含义 |
| --- | --- |
| `projection_failed` | 最近一次写入失败（原因见 `write.error`） |
| `projection_missing` | 从未有校验通过的写入 |
| `projection_outdated` | 状态库有尚未写入档案的变化 |
| `active_run` | 项目里有 Run 在工作 |
| `scan_missing` | 从未做过树扫描 |
| `unclassified` | 有待分类文件 |
| `symlinks` | 有符号链接 |
| `rights_unresolved` | 有 A 层文件的转交权不是 `transferable` |

## 11. 接口与命令

本地接口（见 `local-api.md`）：

- `project.facts {projectId}`：五个部分——`known`（已知事实：`observed`、`verified`、`user_confirmed`）、`inferred`（待确认推断，含接手分析的依据原文）、`missing`（缺失依赖：未解析的 VPM 包、未知的编辑器版本、推断缺少的依赖、未取回的 BOOTH 文件）、`stale`（失效证据及原因）、`next`（下一步）；另有 `unknown`、`archive`（第 10 节）、`recoveries`。读取时会先对账已结束的接手分析。
- `project.fact.confirm {projectId, factId, decision: confirm|correct|reject, value?, note?}`：见 4.5；完成后在安全点写档案。
- `project.files.classify {projectId, path, match?: file|tree, shareLayer, rights, sensitivity?, category?, note}`：追加一条人的登记。
- `project.archive.refresh {projectId}`：执行 `avh project archive <id> --json`，返回 `{write, check, status}`。
- `project.context`：与之前一样返回 compact 与状态，并在安全点写档案。

命令：`avh project archive <项目 id|目录|目录名> [--check] [--json]`。不带 `--check` 时先刷新仍在推进的 Workflow 的产物指纹，再做完整安全点（含树扫描、强制重试），然后检查。写入失败或一致性检查为 `diverged` 时退出码为 1（`--json` 时报告仍完整输出）。

## 12. 给分享编译器与恢复的约定

以下约定已由 [project-share.md](project-share.md) 实现；那里写明了每一条落实的方式与限制。

1. **选文件**：以登记表的判定（第 6 节）和档案清单为准，不按目录名推断。待分类文件、符号链接、`secret`、`excluded` 不进包；A 层文件的转交权须为 `transferable`；付费 BOOTH 内容默认不可转交。
2. **档案本身**：分享前先做一次安全点写入并确认一致性为 `consistent`，把 `archive.json` 列出的文件按其层级选入；清单的 sha256 即包内校验依据。
3. **产物成员**：档案不存成员清单。接收端按 `workflows.json` 中冻结的 `capabilities.artifacts` 规格，对解出的工程用 `artifactFiles`/`membersFingerprint`（`src/workflow/artifacts.ts`，Git 可见文件）重算指纹，与 `evidence/index.json` 的 `artifacts` 比对；不同即对应的结论、决定在接收端为失效。
4. **重建状态库**：存储记录连同历史按 `recordedAt`/`supersedes` 顺序原样追加（`current` 与 `effectiveStatus` 是派生值，不必保存）；派生记录来自 Workflow 表，重建 `workflow_definition`（知识正文按 `contexts` 哈希从同版能力包取回并核对）、`artifact_version`、`verdict`、`gate_decision`、`stage_completion`、`plan_revision`（只有当前方案带内容）后自然再现。运行中或状态未知的任务按设计置为待核对，不导出锁与 PID。
5. **能力包**：`restoreFrom: project-draft` 的候选从 `_harness/candidate-packs/<id>/` 恢复为项目候选；`local-store` 的须由导出方随包提供登记内容。两者都要按 `contentHash`（`packTreeHash`）重验，不自动升为正式包；试用按 `trials` 的范围与限制重新批准。
6. **身份**：以 `archiveId` 与 `revision` 判断“新项目 / 同一项目的更新 / 冲突副本”。

## 13. 状态库表（迁移 0022）

全部只追加（触发器禁止 UPDATE/DELETE）：

| 表 | 用途 |
| --- | --- |
| `project_fact` | 事实记录（4.1），`value_json`、`locator_json`、`invalidation_json` 为 JSON |
| `project_input_observation` | 输入的最新观测：`input`（`file:…`、`artifact:…`、`pack-draft:…`）、`fingerprint`（`NULL` 为不存在） |
| `project_file_entry` | 登记项（第 6 节）；`tree` 的路径必须以 `/` 结尾 |
| `project_scan` | 树扫描结果与待分类样本，`summary_json` 含各层文件数与 A 层权利未定数 |
| `project_archive_identity` | 项目的 `archiveId` 与来源（`created`/`adopted`） |
| `project_revision` | 已确定的修订号与摘要 |
| `project_archive_write` | 每次写入的结果：`verified` 必须无错误，`failed` 必须有错误 |

分享与恢复的表（迁移 0023：`project_share`、`project_restore`、`project_sync`）见 [project-share.md §12](project-share.md#12-状态库表迁移-0023全部只追加)。
