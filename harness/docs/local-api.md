# Runtime 服务与本地接口 v1

TUI 和 GUI 不直接读写状态库。它们连接同机的 Runtime 服务，经版本化的本地接口读取视图、提交命令。服务是唯一的调度者；各条命令和 CLI 走的是同一套实现。下表列出主要接口；现行可调用方法以 src/gui/server.ts 的 GUI_METHODS 和 src/api/server.ts 为准，新增方法应同步更新本页。

脸型流程经 `project.face.candidates.preview` / `.image` 查看当前受管组合目标，`project.face.choose` 保存具体候选；补偿烘焙后的实际工程由 `project.face.preview` / `.image` 读取，`project.face.accept` 接收 projectId、workflowId、expectedHash 和 previewSha256，独立核对后保存当前效果确认。普通布尔 `gate.decide` 不能替代选项或实际效果确认；候选选择、技术检查、用户接受是不同证据，保留原脸无需追加外观确认。完整字段与失效规则见[工作流合同](workflow-runtime.md)。

`project.face.preview.images` 接收同版 projectId、workflowId、previewSha256 和 1–8 个唯一图片 ids，一次完整核验后读取标准图或选定发现组；每张仍核对清单、当前预览摘要、图片 SHA 和解码规格，返回完整身份与 dataUrl。预览只读消费者在最多两个工作线程中执行，数据库只读，不阻塞 Runtime 的停止、握手和状态查询；GUI 标准图与发现特写采用该批次接口，批次不完整或任一身份变化时不能确认。

配色与交付复用同一取图机制，只是图片来自该工作流的 Run 目录：`project.recolor.preview` 接收 projectId、workflowId 和 Gate 绑定的 materials 版本 `expectedHash`，返回该版本的档位（含方案选定档）与每档 × 每套服装的候选图清单；`project.recolor.preview.images` 再接收同一 `expectedHash`、清单摘要 `previewSha256` 和 1–24 个唯一 ids，逐张核对 Run 内路径、PNG 解码规格与 SHA。候选图必须来自记录在同一工作流 `stage_completion` 上的 recolor Run（成功退出、有 `unity_unit_intended` 事件）、同一机位规格，且配方里的每一档都有图；版本对不上或没有图时返回 missing，界面据此不给批准按钮。`project.delivery.photos` / `.images` 同理读取 regression Run 的 `photos/`，绑定当前 build 版本，只在工作流到 UPLOAD_READY/CLIENT_VERIFIED 后返回。两条通道都不返回本机路径，只返回标识、摘要、尺寸与 dataUrl；`ready` 结果带 `generatedAt`（该批图所属阶段被记为完成的时间），界面用它标出「生成于」。`project.face.preview` / `.candidates.preview` 也带同一字段。

`workflow.stageContract.show` / `.select` 仍是阶段工具采用的共用核验入口，但 dev.0.1 已关闭会改变已冻结工具字节的采用请求：Runtime 以 conflict 拒绝，并说明观察实现的依赖尚未可靠声明（dev.1.3 提供），请按 D-59 新开制作流程。其余活动 Run、锁、未核清越界及临时导入检查保留；原验收、Gate、独立观测和模型权限保持冻结。

`project.message.retry` 对当前失败的只读协调请求确认所有Run已停止且无未核清副作用后，保留原消息、修订与观察重新处理。协调Task已通过但提案消费失败也能续接；只在明确新续接时重开有限响应修复窗口，重复命令回执不重开。目录候选拒绝反馈明确资源及下一列表操作，由AI选择实际文件，用户无需填写内部编号。正式Manifest支持`texture`角色的PNG/JPEG冻结导入，生产纹理不自动成为角色参考图。

手动脸型经同一 Runtime 和效果接受接口执行，以下命令不调用 Provider；变更命令中的 `expectedRevision` 来自 `.state`。

| 方法 | 参数 | 作用 |
| --- | --- | --- |
| `project.face.manual.state` | `projectId` | 三种选择、交接状态、已接受版本及安装指引 |
| `project.face.mode` | `projectId, mode, expectedRevision` | `preserve / ai / manual`；保留证据，确认旧执行停止 |
| `project.face.manual.open` | `projectId, expectedRevision, targetId?` | 准备新受管工程和含全部键的 Blender 文件；原件只读 |
| `project.face.manual.launch` | `projectId, sessionId` | 启动受管 Blender GUI；缺失时提示安装及重新检测 |
| `project.face.manual.done` | `projectId, sessionId, expectedRevision` | 冻结保存文件，独立读取并进入现有流水线 |
| `project.face.manual.cancel` | `projectId, sessionId` | 确认本交接作业和 GUI 停止，保留文件与证据 |
| `project.face.manual.resume` | `projectId, sessionId` | 确认停止后，用新工作流续接同一输入 |
| `project.face.manual.rollback` | `projectId, sessionId, expectedRevision` | 指向所属项目旧接受版本，不修改旧产物 |

待接受视图使用 `.state.current.viewProjectId / workflowId / expectedHash` 调用原有 `project.face.preview` 与 `project.face.accept`；每次接受才产生不可修改的新脸型版本。

## 服务

```sh
avh service run [--interval 毫秒] [--no-scheduler]   # 前台运行（systemd 单元执行的就是它）
avh service install [--interval 毫秒]                # 写入并启用 systemd 用户单元
avh service start | stop | status | uninstall
```

核心管理通过 `managed.candidate.evaluate` 请求 Runtime 使用安装包内的受信套件评测候选包。该调用不接受客户端提供的命令或套件路径；Linux 正式运行要求可用的 `bwrap`，并将基线与候选证据写入 `AVH_HOME/evaluations/`。

`managed.candidate.list` 将 `reportDecision`（已完成的当前版本观察可报告，失败、低分、单模型也可）与 `decision`（采用/发行验证）分开。`managed.contribution.authorize` 在明确加入协作和逐项授权后，仅投影结构化候选评测结果及分母，不复制候选知识/工具包或自由文本。`managed.contribution.submit` 核对完整内容白名单、用途/类别、冻结哈希和匿名贡献 UUID 对应回执；接收不改变本地采用或正式发布资格。关闭或撤回立即取消两种待发队列并删除未发送报告载荷；清理失败也保持取消。再次加入不会恢复旧授权，重新逐项授权会产生新授权修订与载荷哈希。

`update.check`、`knowledge.check` 与 `knowledge.install` 只在调用时联系 Harness 服务端。前两个只列出签名验证通过的发行；`knowledge.install {releaseId, channel?}` 由 Runtime 自己重新向服务端取清单，不接受客户端提供的清单或下载地址，下载后核对大小与 sha256，安全解包，再验签、核对内容哈希后安装。它只安装、不启用，启用仍走 `managed.activate`。

- 服务进程本身只处理接口请求，调度在子进程 `avh serve --interval <毫秒>` 里运行。子进程意外退出后，服务按 1、2、4 … 30 秒退避重启：状态库和 Run 单元都能承受崩溃。暂停（`service.pause`）向调度进程发 SIGTERM，等当前这一轮结束（安全点）后停下，不会中途打断一轮。
- 有 systemd 用户实例时，`install` 生成 `avh-runtime.service`（默认 `AVH_HOME`）或 `avh-runtime-<哈希>.service`，并设置 `TimeoutStopSec=150`，留给调度收尾的时间。没有单元时，`start` 以脱离的后台进程启动，日志写到 `AVH_HOME/logs/service.log`。
- 停止服务不会停止已派发的 Run：它们是独立的 systemd 单元，下次启动后对账接续。
- 要在注销后继续运行，需要 `loginctl enable-linger`；`doctor` 与 `service status` 会提示。
- 同一个 `AVH_HOME` 只允许一个服务。启动时如果端点上有服务应答，就拒绝启动；只剩残留套接字文件时，会把它移除。

## 端点与协议

Linux 端点是 `AVH_HOME/run/avh.sock`：目录权限 0700，套接字 0600，只有本用户能连接。Windows 端点是命名管道 `\\.\pipe\avh-<AVH_HOME 的哈希前 16 位>`，协议不变：管道按默认安全设置只对本用户开放，执行方所在的 Low 完整性进程连不上（实测被拒）。

消息是按行分隔的 JSON，单帧上限仍为 8 MiB，超过就断开连接；同次流读取中的多条合法帧分别核验。客户端请求携带 `responseChunks: "sha256-v1"` 后，超大响应将按 256 KiB 原始字节分块，经 socket 背压发送。每帧包含请求 `id`、`chunk.index/count/bytes/sha256/data`，其中 `data` 为 base64，SHA-256 绑定完整响应 JSON。客户端逐请求核对顺序、固定元数据、总字节数、完整摘要及内部响应身份，全部完成后才向 GUI/TUI 返回原始结果；错误、截断、超时或断开不会返回部分证据。完整响应读取范围为 512 MiB，旧客户端读取大结果会收到明确的更新提示。现有工程/产物/图片版本核验继续由 Runtime 执行，传输分块不替代这些检查。

```text
→ {"id": 1, "method": "workflow.show", "params": {"id": "…"}}
← {"id": 1, "result": {…}}
← {"id": 1, "error": {"code": "NOT_FOUND", "message": "…"}}
← {"event": "changed", "seq": 1234}      订阅后收到：状态有变化，刷新屏幕上的内容
← {"event": "service", "detail": "paused"}
← {"event": "progress", "detail": "provider-connection"}  流式重试状态变化，刷新实时制作状态
```

先调用 `hello`：`api` 字段不等于客户端支持的版本时，客户端应提示用户重启服务或更新 Harness。`changed` 通知来自事件表序号的增长，所以不管是经服务、CLI 还是调度进程写入的变化，都会通知到。`progress` 是不带审计序号的瞬时状态通知：Runtime 有订阅者时观察运行中的 pi 日志，仅在重试状态改变时发送；GUI/TUI 据此重新读取正式制作状态。它不写事件表、不授权恢复，也不重发模型请求。

错误码：`BAD_REQUEST`、`UNKNOWN_METHOD`、`NOT_FOUND`、`STALE`（查看后产物变了）、`CONFLICT`、`UNAVAILABLE`、`FAILED`。

## 方法

| 方法 | 参数 | 说明 |
|---|---|---|
| `hello` | — | 接口版本、Runtime 版本、schema、pid、`AVH_HOME` |
| `subscribe` | — | 开始接收事件，返回当前序号 |
| `service.status` / `pause` / `resume` / `stop` | — | 调度进程状态、重启次数、上次退出、调度租约 |
| `config.reload` | — | 重新读取 `config/harness.yaml` |
| `doctor.run` | — | 运行 doctor，逐项返回 `{status, name, detail}` |
| `provider.list` | `probe?` | 执行方列表；`probe` 会调用各 CLI 查询版本与登录状态 |
| `secret.status` | `ids` | 各执行方凭据（API Key、长期令牌）是否已保存，只返回是/否 |
| `secret.set` / `secret.clear` | `id`, `value` / `id` | 保存或删除一项凭据。凭据存在 `AVH_HOME/config/secrets/<id>`，执行方读不到；任何方法都不会返回凭据内容。执行时由执行单元按名字注入环境变量，Run 记录里只有名字 |
| `asset.sources.list` | — | 本安装素材目录授权的 `{roots,revision,scope:'installation'}`；GUI 素材页可查看 |
| `asset.sources.grant/revoke` | `path,expectedRevision,consent:true`（grant） | 明确同意后授权一个真实目录，或撤销现有目录；版本过时拒绝。只持久更新素材授权，不热换冻结工具/Provider；源文件不改 |
| `project.list` | — | 项目、最近一次导入的判定计数、最新正式 Workflow、需要处理的任务数 |
| `project.create` | `name`, `mode?`, `request?`, `faceConcept?`, `assetIds?` | 在工作区新建工程目录并记录项目 Brief 与候选素材；当前界面尚未提供可恢复的新建草案或 AI 方案生成 |
| `project.brief.get/update` | `projectId` 等 Brief 字段 | 读取或保存用户需求与共同脸部方向；保存不等于批准方案 |
| `project.variant.list/save/remove`、`project.root.list/save` | 项目/方案/根字段 | 衣装方案与 Avatar 根谱系的登记接口 |
| `project.message.list/add/session` | `projectId`, `content?`, `commandId?`, `expectedRevision?`, `replyTo?` | 持久受管对话、澄清续接、命令去重与会话修订；制作结果为待批准提案，回复不等于施工 |
| `project.message.retry` | `projectId`, `id`, `commandId`, `expectedRevision`, `expectedTaskId` | 续接当前已失败的只读协调请求；所有旧 Run 已退出、无保留锁、输入未变才重新排队。命令去重在修订检查之前；重复回执返回原接受结果，不再派发。保留原要求、观察额度、历史任务和费用，不新增用户消息或修订；不适用于未知执行或制作重放 |
| `project.intent.list` | `projectId` | 从现有事实库读取当前要求解释：对象、属性、内容、来源消息/原文、来源修订和被替代记录；`content=null` 为明确撤回。解释属于 AI 推断，不是新增授权或已完成修改。GUI/TUI 可查看并通过普通消息纠正 |
| `project.production.list` | `projectId` | 返回制作目标、所选素材名称、绑定修订、批准状态及派生 `progress`（阶段最新 Task/Run、锁和未审越界）；Workflow active 不代表仍在施工 |
| `project.production.resume` | `projectId,id,commandId,expectedToken` | 核对旧执行后续接未完成制作，用户无需选择内部任务；复用 formal Task redo，保留原失败及接受成果。同命令去重、状态 token 过时或新要求拒绝；在途/未知结果/锁/越界不盲重放。仅清点/计划尚未施工的失败遇到安装合同更新时，重新核验原输入与目录授权、完整保留旧冻结记录，创建同目标新 Workflow；已有制作成果不自动从头重建 |
| `project.production.cancel` | `projectId,id,commandId,expectedToken` | 停止制作及终态 Task 的残留 Run；确认全部停止和写锁释放才关闭 Workflow。未确认返回 `confirmed:false`、保持 stopping，可用原命令查询/再次停止；不删除素材或接受产物 |
| `project.production.approve` | `id`, `revision`, `commandId` | 核对当前需求、素材选择与文件摘要后原子创建正式流程；同一命令重试返回原流程，过时批准拒绝 |
| `project.production.reject` | `id`, `revision` | 放弃尚未开始的制作提案；已开始的制作需走流程取消入口 |
| `asset.list/save/remove`、`project.asset.list/attach/detach`、`project.variant.asset.list/attach/detach` | 素材、项目与方案 ID | 登记本地素材及项目/方案关联；关联不是下载、导入或兼容性验证 |

`progress.canResume` 表示可以请求 Harness 核对，不是无副作用证明。继续命令先通过旧执行单元的只读 `settledResult` 回读，或读取 Runtime 独立确认的未启动/无副作用结果；不派发新 Run 来探测旧 Run。当前自动重做准入为无副作用，或仅替换未接受的 Provider 候选文件（规划专用 `_harness/` 子目录也允许）；有准备命令、Unity 或其他工具效果仍须先核清。阶段重做保留旧 Task/Run 并走原调度与独立验收，不能因此声称工程已产出。此处不开放普通用户 `force`、不自动接受越界、不覆盖已通过阶段。

素材授权在探索消费者和协调 Provider 派发前重新核对，包括历史取回及实际图片附件。撤销后尚未启动的只读协调任务停止，保留原消息/修订/观察计数与原证据，按当前授权自动重新整理；不要求用户管理任务或重新回答。派发竞态中的旧 payload 在外发前拒绝，确认未启动的 Run 关闭并释放其锁。已启动或未知 Run 不伪称内容已收回，不自动释放写权；已批准制作不自动取消，已有工程副本不删除。真实 GUI 已验目录撤销与确认页；系统目录选择器到新增授权的完整实机路径尚未验。

恢复回读新增差异若全部是后续 Runtime 档案投影，可以自动核清：原 Run 记录明确无越界、最新 verified 写入晚于原终态、清单字节摘要与数据库回执/修订一致、固定投影路径逐文件回读且无链接。最终请求事务再验同一清单；不修改原 Run 或接受未知变更，不按 `_harness/` 前缀豁免。篡改、旧写入、普通产物及原 Run 已有越界仍拒绝。普通提案同时冻结有效 brief.face_concept 为 Manifest.faceConcept；此文本传递本身不证明几何制作。

协调器的 `production.proposal` 支持 `{request,assetIds,selections?}`：`assetIds` 引用已关联素材，`selections` 为 `[{target:"已观察资源ID",kind:"avatar|outfit|texture|animation|package|other"}]`，可在提案中登记尚未关联的配套文件，合计 1–100 项、恰好一个素体。生产包沿用 select 支持的格式；独立 PNG/JPEG 仅作为 texture 类型，先校验实际格式，正式 Manifest 保留 texture 角色，按批准 SHA 清点并导入受管 Assets/_HarnessTextures/<SHA> 文件。独立 WebP 当前仅供图片观察；导入图片不等于已接入材质或完成效果验证。Runtime 只解析本项目已发放且当前授权内的资源，不接受路径、授权声明或批准；候选登记、全部所选文件摘要与提案在同一事务提交，任何失败撤销本次新增关联。短/完整 ID 指向同一文件也不能重复选；停用、拒绝、过时结果不被恢复。批准时再核对探索来源授权和文件摘要，撤销根授权或文件变化拒绝开始制作。此登记不消耗额外探索轮次、不启动施工；正式 Manifest 包含所有所选输入，名称只写在 request 中不构成绑定。GUI 现有提案卡片展示完整所选素材，由用户确认方案，不要求填写资源 ID；目录授权实机范围见上，端到端制作仍未完成。

受管协调任务可通过 `explore` 请求在已授权的 `assetSearchRoots` 中列目录、按关键词搜索目录树、观察文件/压缩包目录、关联待讨论候选；一批最多 8 项。Runtime 用 24 项的内部探索窗口，窗口中已有至少 8 项真实有用新观察且余量降到 8 项时自动继续至下一窗口；失败、空列表和控制回执不获取续探资格。模型只能引用 Runtime 先前发放的项目内资源 ID，不能自行提供任意路径；撤销根授权后旧 ID 也不能继续使用。Runtime 保存每轮请求、结果和任务关联后自动续接，内部观察不会伪装成用户消息或递增用户会话修订。上下文向协调模型提供跨 Run 计数、当前余量、窗口与当前总停止边界；默认用户回复不展示这些内部数字。coordination.maxExplorationOperations 默认 72，可在 GUI 设置→高级→素材探索深入程度选择标准或更深入（240），也可在高级配置用至少 24 的安全整数；这只是保守执行保护，不能替代费用/来源授权。正在运行的探索消费者重新读取该配置，保留原消息和历史观察，超额批次仍整批不执行。重复或超额请求最多返回两次调整反馈，最后保留观察并具体解释缺少的制作证据和下一步；不能因内部分批要求用户技术接管，只有偏好、新增来源或费用授权等有意义决定才询问。Provider 自身费用/并发/超时保护仍生效，不自动扩大授权或承诺不存在的检索能力。关键词搜索最多观察 5,000 项、返回 100 项，跳过缓存、隐藏目录和符号链接，截断或无法读取须如实披露。协议错误最多自动纠正两次。已退出且无保留锁的只读协调任务遇到网络错误，可在输入未变时自动恢复一次，保留观察，不重放施工。后续消息可读取最近 24 条历史观察，但不视为当前文件不变的证明。图片 inspect 保存按摘要绑定的快照，后续任务附带最近素材观察图，与用户参考图合计最多 8 张；正文列出实际发送的图片和附件索引。快照改变会被拒绝，根授权撤销后不再发送其图片。候选关联不表示授权、适配或制作批准，原件不解压覆盖。当前仍缺少普通界面的来源授权管理及完整网络素材探索，不能将该接口片段视为开放选材完成。

包内文本观察复用 `inspect`：`{op:"inspect",target:"资源ID",member:"Assets/Body.prefab",offset:0}`。ZIP 读取准确成员；UnityPackage 将 pathname 映射到同 GUID 的 asset，不向磁盘解包。ZIP 包装的 UnityPackage 可先用 `{op:"inspect",target:"ZIP资源ID",container:"Product/Avatar.unitypackage"}` 查看其目录，再加 `member` 读取其中的文本；仅支持这一层实际包装格式，嵌套包声明大小不超过 2 GiB，以流读取。支持 prefab/mat/asset/meta/clip/controller/txt/md/json/yaml/yml/xml/shader/cginc/hlsl；文本成员不超过 8 MiB，每页最多 32768 Unicode 字符。结果 `observation` 包含 container、member、原始字节 sha256、bytes、offset、content、nextOffset 和 truncated。摘要是该次观察身份，续读若摘要不同应重新分析，不拼接不同版本。重复成员、链接、二进制、非法路径、超限及读取期间包大小/修改时间变化均拒绝；扫描最多 10000 个 tar 条目、15 秒。每次读取仍校验当前项目和根授权并计入探索额度。文本可辅助分析结构和依赖，不能代替 Unity 导入、骨骼/几何适配或实际构建验证。其他嵌套格式与包内图片附件尚未接通。

制作提案的输入上下文包含所有未拒绝关联参考图的实际字节摘要，独立于 AI 选择的可导入素材列表。图像内容变化会使旧批准失效；批准时复制并核对项目内快照，冻结为 Manifest 的 `referenceImages`。正式 Provider 阶段经 `TaskSpec.inputImages` 传递实际图片附件；后续原件改变不改变运行中的快照，快照自身被修改则拒绝派发。工具阶段不接收模型附件。此通路不等于所有 Provider 已支持视觉输入，仍按适配器能力拒绝不支持的请求。

协调上下文中的观察历史是有界投影，优先给最新当前结果，每个普通回执最多约 6000 字符、长字符串最多 1200 字符；累计结果展示预算为 36000 字符（请求与溯源元数据另计）。每条含 `receiptId`、`projection.omitted` 与原记录长度；原始 SQLite 回执保持完整。`exploration.progress` 给出本次用户请求跨 Run 的实际操作数，不能按最后一个 Run 的新增操作判断整轮是否探索过。

需要原文时单独调用 `{op:"recall",target:"o_回执标识",offset:0}`，每页最多 12000 字符，返回原始 request/result JSON 的片段、摘要及 nextOffset；不得与其他操作混批，以确保刚取回的一页能完整进入下一协调任务。只读既有记录，不重新观察当前文件，同样计入探索额度。标识绑定项目和原回执，碰撞/不存在/原素材根撤销均拒绝；禁止递归读取 recall 页或控制回执。撤销授权同时移除相关自动历史投影。已有最近 24 条跨交互窗口仍保留，尚未接通全历史索引检索，不能据此宣称所有长期证据都自动进入当前上下文。
| `booth.status/session.clear/catalog` | 按方法 | BOOTH 连接状态与索引读取；登录会话由桌面宿主安全采集。`booth.catalog` 的每个文件带 `byteSize`（未知为 null）、`remoteVersion`（版本线索）、`probe`（最近一次探测结果）、`cache`（`current`：池里有与当前远端一致的版本；`cached`：池里有版本，但无从判断是否最新；`outdated`：池里只有旧版本；`none`）、`materialized`（`cache` 为 `current` 或 `cached`）与 `versions`（池里的版本数） |
| `booth.sync` | `mode?` | 在后台同步索引，用 `booth.status` 跟进度与结果（`last.result`）。`quick`（缺省）只重新读取列表条目有变化的商品详情，只探测新文件和大小、线索或可用状态未知的文件；`deep` 全部重读、重新探测。结果含 `items`、`files`、`itemsRead`、`itemsUnchanged`、`filesProbed`、`filesUnchanged`、`newFiles`、`unavailableFiles`、`unknownSizes`、`probes`（探测结果 → 文件数）与 `requests` |
| `booth.plan.create/list/materialize` | 项目 ID、文件 ID 与用途（可带 `sha256`，锁定池里已有的版本）、计划 ID | 创建文件级选择计划并按需获取到版本池，获取时锁定所用版本；`list` 给出 `pinnedCount` 与 `readyCount`。当前 GUI 使用人工选文件作为兜底，AI 自动计划未接通 |
| `booth.plan.release` | `planId` | 释放计划，它锁定的版本不再因它保留；正在获取的计划不能释放 |
| `booth.pool.list` | — | `{root, entries}`：每个版本的 sha256、大小、路径、状态、`source`/`retention`、`pinned`、`versions`（下载项、文件名、版本线索、取回时间）、`plans`、`workflows`、`needed {archive, delivery}`、`removable` 与 `blockers` |
| `booth.pool.pin` | `sha256`, `pinned` | 固定或取消固定一个版本 |
| `booth.pool.remove` | `sha256`（一个或一组）、`dryRun?` | 只删除没有引用、没有固定的 BOOTH 缓存版本的文件，返回 `{removed, kept, freedBytes}`，`kept` 写明保留原因；BOOTH 任务进行中返回 `CONFLICT` |
| `project.import` | `path`, `mode?`, `distill?`, `profile?`, `kind?` | 安全导入文件夹、压缩工程或 UnityPackage，生成接手简报与 AI 分类/恢复任务；`deep` 始终使用隔离副本 |
| `project.recovery.list/apply` | `projectId` / `id` | 查看恢复记录（先对账已结束的 AI 分析）；分析结果结构齐全（`ready`）后才能执行浅接手或深改造 |
| `project.facts` | `projectId` | 工程档案：已知事实、待确认推断、缺失依赖、失效证据、下一步，另有未知项、档案写入与可分享状态（见 `project-archive.md`） |
| `project.fact.confirm` | `projectId`, `factId`, `decision`, `value?`, `note?` | 对一条事实作确认（`confirm`）、更正（`correct`，需 `value`）或否定（`reject`）；追加记录，不改旧记录。不是最新记录时返回 `STALE` |
| `project.files.classify` | `projectId`, `path`, `match?`, `shareLayer`, `rights`, `sensitivity?`, `category?`, `note` | 人工登记一个工程路径的分类、分享层级与转交权；Harness 自有分区与工程外路径返回 `BAD_REQUEST` |
| `project.archive.refresh` | `projectId` | 扫描工程并写入、读回校验工程档案，再做一致性检查；返回 `{write, check, status}` |
| `project.share.preview` | `projectId`, `layers?`, `include?`, `exclude?`, `permittedOnly?`, `acknowledge?`, `name?` | 在后台编译分享清单，不打包：等级与理由、阻断项、纳入与排除、可选项、接收端待补齐（见 `project-share.md`）。返回 `{id, started, startedAt}`，结果经 `project.archive.job` 取 |
| `project.share.export` | 同上，另有 `recipient?`、`out?`（绝对路径） | 在后台编译清单并写 7z 分享包：按清单暂存复制、`7z t`、成员比对、冷解包校验通过后才落到输出位置。受阻时不产出分享包，结果里列出原因 |
| `project.share.list` | `projectId` | 这个项目导出过的分享包（本机记录，含收件人） |
| `project.restore.check` | `path`（分享包的绝对路径）, `asCopy?`, `name?`, `allowNetwork?` | 在后台检查分享包：成员路径安全、清单与成员一致、`7z t`、隔离解包后逐个核对哈希与 Unity 检查、恢复方式（新项目/更新/已存在/冲突）与能力包；不写状态库。`allowNetwork` 时向 Harness 服务端查询缺的能力包有没有签名发行，不下载 |
| `project.restore` | 同上，另有 `expect?` | 在后台检查并恢复：通过全部检查后才放置工程并在一个事务里重建状态库；`expect` 为检查时看到的方式，变了就拒绝。`allowNetwork` 时按 `knowledge.install` 的方式下载、核对并安装缺的签名能力包。结果含对账 |
| `project.archive.job` | — | 正在进行与最近结束的分享或恢复：`{job, last}`；`job.progress` 为当前步骤，`last.result` 为完整报告（受阻时同样完整） |
| `project.restore.report` | `projectId` | 恢复对账：恢复了什么、路径变化、本机还缺的依赖、待安装的 Workflow、需要核对的任务、失效证据、可继续的阶段与下一步 |
| `project.restore.complete` | `projectId` | 本机装好能力包（或批准候选包试用）后，补完恢复时待安装的 Workflow |
| `project.conversation.search` | `projectId`, `query` | 在项目的完整对话里检索（恢复时选了对话才有）；只给人看，不交给 Agent |
| `project.recovery.adoptAssets` | `id` | 将 AI 判定为素材包/混合输入的候选项登记到素材库并关联项目 |
| `project.vpm.status/apply` | `projectId`, `action`, `packageId?`, `version?` | 通过官方 VPM CLI 检查、解析、添加、移除或迁移包；失败恢复 manifest |
| `project.upload.open` | `projectId` | 打开对应 Unity 和官方 VRChat SDK Panel；仅当该项目的正式 Workflow 已到 `UPLOAD_READY`（或已完成客户端验收）时可用，早了拒绝并说明；不保存登录态、不代替用户上传 |
| `project.brief` | `project` | 接手简报（Markdown） |
| `workflow.list` / `workflow.show` | `id` | 阶段、检查判定、Gate、里程碑、方案、下一步 |
| `workflow.create` | `project`, `profile`, `manifest?` | 创建正式 Workflow |
| `workflow.cancel` | `id`, `note` | 取消 |
| `plan.show` | `workflowId` | 当前方案内容与全部版本（哪个版本有过决定） |
| `task.list` | `project?`, `openOnly?` | 每个 Workflow 各阶段的最新任务 |
| `task.show` | `id` | 等待原因、Run、Verdict、未接受的越界改动、事件、下一步 |
| `task.add` | `project`, `spec` | 添加临时任务（任务 YAML 路径） |
| `task.redo` | `id`, `note?` | 重做；`note` 作为修改意见交给执行方 |
| `task.cancel` | `id` | 取消（任务或 Run） |
| `task.acceptChanges` | `id`, `note`, `paths?` | 接受越界改动 |
| `task.recover` | `id`, `mode`, `note`, `force?` | 恢复需要核对的 Run |
| `gate.list` | — | 临时任务与正式 Workflow 的 Gate |
| `gate.decide` | `gate`, `approve`, `expectedHash`, `note?`, `redo?` | **必须带 `expectedHash`**：用户看到的版本若已变化，返回 `STALE`。驳回时带 `redo: true`，把 `note`（此时必填）作为修改意见交给所属阶段重做；不属于阶段的 Gate 返回 `BAD_REQUEST` |
| `events.after` | `seq`, `limit?` | 活动流：某序号之后的事件 |
| `events.recent` | `limit?` | 最近的事件（最多 500 条） |

读取在服务进程内执行，只读。会改状态或可能耗时的命令交给 `avh` 子进程执行：取消与恢复要等执行单元确认停止，决定 Gate 前要重新计算产物指纹，导入要读整个工程。所以命令运行期间，读取仍能及时应答。

分享预览、导出、恢复检查与恢复可能要读几个 GB，调用立即返回，命令（`avh project share|restore … --json --progress`）在后台运行，一次只有一个，同时再发起返回 `CONFLICT`。客户端轮询 `project.archive.job`：命令结束时服务还会广播一次 `changed`。
## 数据与协作

| 方法 | 参数 | 返回或行为 |
|---|---|---|
| `sharing.state` / `sharing.notice` | — | 当前明确选择、队列、安装所有权、待送达撤回 / 当前用途、类别、接收方与期限说明；读取说明不会加入 |
| `sharing.choose` | `noticeShown?`, `enabled?`, `surface?` | 当前说明下明确加入或关闭；`surface=tui` 记录终端来源，其余沿用 GUI 来源。关闭立即清空未发送记录和报告载荷，不停止本地工作 |
| `sharing.flush` / `sharing.records` | — | 复核当前授权并发送有限批次 / 查看结构化本机记录；不补传关闭期间的历史 |
| `sharing.remoteStatus` / `sharing.revoke` | — | 以本机安装所有权查看服务器记录 / 停止并请求撤回；离线时保留待送达状态，不声称服务器已删除 |
| `managed.contribution.preview` | `candidateId` | 返回实际上传的白名单结构化报告、其摘要和评测/候选版本绑定；另给仅本地显示的原因、基准、评测信息与案例×模型组合比率分母。不授权、不排队、不发送 |
| `managed.contribution.list/authorize/submit` | 授权需 `candidateId`, `consentText`；可同时锁定 `expectedEvaluationId`, `expectedContentHash`, `expectedReportHash`；发送需 `id` | 已完成候选的结构化报告逐份授权和发送；任一预览绑定变化返回 `STALE`，不创建新授权；报告授权不意味着候选被采纳、启用或发布 |
| `managed.contribution.trace` | 需 `receiptId` 或 `candidateId` | 先读一次服务器安装状态并记录它报告的采纳，再用本机事实回答整条链：回执 → 候选 → 评测 → 纳入的签名发行（releaseId／packId／版本／状态／安装与启用时间）→ 本机已安装版本与是否启用。只读；服务器不可达时链保持原状并如实报告读取失败，不编造采纳。用户入口：`avh managed trace`，以及 GUI 核心管理里每份已回传报告的「查看溯源」 |

TUI 在「6 设置 → s 数据与协作」消费这些接口。短终端可滚动读取完整说明，读到末尾后才能明确加入；关闭、服务器记录、有限待发记录、候选报告和停止并撤回都在同一设置入口。选择候选只打开预览：先展示版本与原因、基准与候选的统计/分母、实际上传范围，查看到末尾后才允许明确授权，并绑定所见版本。取消确认不改变授权，远端撤回待送达时不能重新加入绕过撤回。

## 本地记忆与 SOP 采用

`project.maintenance.show {projectId}` 返回本地来源、候选版本、隔离评测程度、当前选择、历史和状态令牌。`project.maintenance.adopt {projectId,scope,candidateId,expectedHash,expectedToken,commandId}` 是本用户控制面操作：`scope` 为 `project`（本项目后继制作）或 `local`（本机后继制作默认政策），`candidateId:null` 表示回到正式版本；采用候选时必须提交刚读到的内容摘要。重复命令返回原回执，过时状态拒绝，项目单独选择优先于本机默认。

GUI 在项目「设计目标 → 记忆与 SOP · 本地修复」、TUI 在项目对话按 `l` 使用同一接口，可根据项目问题生成候选、检查结构、明确采用或回退。结构检查不证明实际工程效果，只能供本项目后继制作验证使用；本机默认要求与修复相关的隔离对照结果。现有普通评测按钮只运行结构套件，相关业务验证尚须受管评测入口取得，不伪装成已经完成。

Runtime 复核候选权限、内容、共同基线、完整同覆盖评测及对应用户决定回执，正式新 Workflow 冻结所选工具和上下文。候选不能自授默认政策、权限或验收修改，普通协调 AI 仅只读消费当前选择。上游基线变更要求重新生成并验证或回到正式版本；严重可靠性退化停止后继采用并保留历史。已运行的版本、已接受成果和失败工程不会因切换而改变，后者仍需恢复点核对。官方签名、贡献授权和本地采用分别管理。

## BOOTH 版本池

BOOTH 文件按需获取到全局不可变版本池（对应[升级规划](../../docs/zh/设计/1-整体架构/产品升级规划.md) §5），实现在 `src/booth/`，状态库迁移为 `0025_booth_version_pool.sql`。

- **布局**：`AVH_HOME/materialized/pool/<sha256 前两位>/<sha256>/<文件名>`。同一内容只存一份，文件只读，从不覆盖或修改。保留文件名，工具据扩展名区分 `.zip` 与 `.unitypackage`。`pool_blob` 按 sha256 记录内容，`booth_file_version` 记录下载项、文件名、大小、sha256、版本线索与取回时间；卖家以同一下载项换了文件，就多一个版本。
- **迁移**：0025 之前取回的文件留在原处（`materialized/assets/<下载项>-<文件名>`），登记进池，不搬动，因为已冻结的 Workflow Manifest 可能写着这个路径。旧计划的引用改为锁定当时的 sha256；被 404 改成 `<下载项>.bin` 的文件名按取回时的文件名找回。旧表 `materialized_file`、`materialized_ref` 改为同名视图，只供按 0015 写的读取方使用。
- **锁定**：计划获取文件时锁定所用版本（`asset_selection_pin`），Workflow Manifest 写的是锁定版本的路径。再次获取同一计划时，版本文件完整就直接使用，不访问 BOOTH；文件不在了，只有 BOOTH 仍提供同样的字节才能补回，否则计划失败并说明原因，新字节另存为新版本。
- **缓存命中**：没有锁定时，先问 BOOTH 现在提供的文件：跳转地址里的文件名，再探测大小、ETag 与 Last-Modified。池里某个版本的线索与之一致（文件名与大小相同，双方都有的 ETag、Last-Modified 也相同），并且文件仍能哈希到它的 sha256，才复用；否则下载。下载到相同字节时不新增版本，只更新这个版本的线索。
- **探测**：大小先用 HEAD；失败或没有长度时，发 `Range: bytes=0-0` 的 GET，读 `Content-Range` 的总长；服务器忽略 Range 返回 200 时取 `Content-Length`。两种请求都不读取正文，立即断开。网页（`text/html`）的长度不当作文件大小。两步都失败才记为大小未知，`booth_file.probe_outcome` 记录每一步的结果，如 `head:http-403 range:ok`、`head:timeout range:network`。实际下载后，索引的大小与线索改为实测值。
- **安全**：带签名的文件地址只在当次使用，不写入状态库、事件、日志或错误信息；会话 Cookie 只发给 BOOTH 自己的主机。素材库列表为空而本地有已拥有的商品时视为会话失效，索引不动；网页不会被当成文件。
- **不可用**：404、410、没有跳转地址，或从完整读取的素材库列表里消失的下载项记为 `unavailable`，文件名、大小与版本历史都保留。池里仍有版本时，新计划可以用 `sha256` 锁定它。
- **清理**：从不自动进行。只删除未固定、`retention` 为 `cache`、没有未释放的计划锁定、也不是未取消 Workflow 输入的版本。是否可删的判断与文件移出在同一个事务里完成，与正在进行的获取不冲突。版本记录保留为历史（状态 `removed`），以后再取回时放回原路径。`source`（`booth`/`local`）与 `retention`（`cache`/`keep`）为本地导入预留：本地原件是唯一副本，按 `keep` 保留，不会被清理。
