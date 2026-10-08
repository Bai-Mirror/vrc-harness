# 可继续制作的工程分享包与同版恢复（格式合同 v1）

对应设计稿 [工程档案化与分层共享恢复方案](../../docs/zh/设计/2-功能模块/20_交付与恢复.md) 的第 3、4 步：**共享编译器**、**7z 打包**与**同版 Harness 恢复**。它建立在[工程档案格式合同](project-archive.md)之上。实现：

| 模块 | 内容 |
| --- | --- |
| `src/archive/share.ts` | 清单编译（`compileShare`）、导出（`exportShare`）、`恢复说明.md` |
| `src/archive/share-package.ts` | 包格式、成员比对、冷解包校验（发送端与接收端共用） |
| `src/archive/share-scan.ts` | 一次读文件：大小、SHA-256、CRC32 与内容检查（凭据、本机路径、Blueprint ID、订单号） |
| `src/archive/sevenzip.ts` | 7z 的固定调用：按清单打包、`7z t`、列成员、解包 |
| `src/archive/unity-check.ts` | 不开 Unity 的检查：工程骨架、`.meta` 配对、头像根可达的 GUID |
| `src/archive/packs.ts` | 能力包身份与冻结内容的核对 |
| `src/archive/restore.ts` | 恢复检查、恢复、对账、补完待安装的恢复、对话检索 |
| `src/state/migrations/0023_project_share.sql` | `project_share`、`project_restore`、`project_sync` |

## 1. 边界

- 导出时必须明确选择用途：`--purpose self` 是本人换电脑、重装或备份；`--purpose others` 是交给另一人。GUI 也要求先选择用途，再预览和导出。旧包没有用途字段时按“交给他人”解释。
- **本人备份**保留已导入工程、包括本人购买但不可转交的素材，不检查转交权，也不能使用“只分享获准内容”。恢复说明写明仅限本人使用、不得转交他人。它仍排除可再生缓存、本机凭据和未分类文件；这些安全与完整性检查照常执行。
- **交给他人**逐项检查转交权。缺少许可的付费素材不能随包发送；可以导出获准内容与待补齐清单，接收者需用自己的购买记录取得素材。当前恢复会显示缺项，不会仅凭素材名称自动关联购买记录或完成回填。
- **分享包不是成品交付包。**成品交付仍由 `package` 阶段的 `builtin/tools/harness/package.py` 生成，两者合同独立。
- 恢复的目标是**同版 Harness**。版本不同会提示；分享包的状态库 schema 高于本机时拒绝恢复。
- 分享包**不含**：凭据、访问令牌、私钥、登录态、本机配置目录里的任何文件、锁、PID、租约、Run 目录、可再生缓存（`Library/` 等）、VPM 锁定的包（接收端按 `vpm-manifest.json` 解析）、工程自己的 `.git/`、按收件人保存的 `_harness/share/`。
- 发送端只读工程：导出前的安全点会写 `_harness/` 档案（与 `avh project archive` 相同），不改工程的其他文件。

## 2. 分享包的布局

7z 压缩包的根目录：

```text
share/manifest.json      分享清单（harness-share/1）：是什么、需要什么、能做到哪一步
share/files.json         内容清单（harness-share-files/1）：逐个文件与排除理由
share/恢复说明.md         给人看的说明，不装 Harness 也能读懂关键路径与依赖
share/packs/<id>/…       随包提供的本项目候选能力包（只在本机候选库里有登记内容时）
Assets/ Packages/ ProjectSettings/ …   Unity 工程（相对工程根的原路径）
_harness/…               工程档案里选入的文件（A 层总在，B/C 按选择）
```

工程根目录下若本来就有顶层 `share/`，与说明目录重名，导出受阻。

## 3. 分层与逐项选择

| 层 | 选入方式 | 内容 |
| --- | --- | --- |
| A 接续必需 | 总是 | Unity 工程与 `.meta`、档案 A 层文件（事实、决定、证据索引、恢复信息、能力包恢复信息）、Workflow 产物、候选能力包草稿。交给他人时须有转交许可；本人备份保留本人已导入素材 |
| B 可选非敏感 | `--layers A,B` 选入全部 B 项，`--exclude` 去掉个别项；默认不选 | `_harness/records/events.json`、`_harness/optional/facts.json`、导入登记为 B 层的其他文件等 |
| C 可选敏感 | **只能逐项** `--include <项>`；只写 `--layers C` 不选入任何东西 | `_harness/sensitive/conversation.json`（完整对话）、`_harness/sensitive/project.json`（原始需求、订单号、人工决定原话、Blueprint ID、导入源名称）、`_harness/sensitive/facts.json`、`_Harness/Recovery/`（AI 接手分析原文）、工程根目录的施工记录等 |

可选项的 id 是 `<层>:<路径>`：档案文件用它在档案清单里的路径（如 `C:_harness/sensitive/conversation.json`），其他文件用决定它归类的登记路径（如 `C:_施工记录.md`、`C:_Harness/Recovery/`）。预览列出全部可选项及其文件数与大小。旧的 C 层选择不会自动套用到下一次分享：每次都由人逐项选择；收件人名称只记在本机状态库。

## 4. 清单编译

`compileShare` 先做一次完整安全点（刷新仍在推进的 Workflow 的产物指纹、观察、遍历、写档案并读回校验），然后：

1. 按登记表（[档案合同 §6](project-archive.md#6-分类登记表)）遍历工程（不进入 `walk: false` 的缓存目录，不跟随链接），逐个文件决定：
   - 顶层 `share/`：受阻；`_harness/share/`：排除（按收件人保存）；
   - 没有任何登记覆盖：**待分类，受阻**（目录名本身从不授予分享资格）；
   - 登记为 `excluded`：排除，写明理由与取回方式（`vpm`、`regenerate`）；
   - 档案分区里不在档案清单中的旧文件：排除；
   - 档案文件按档案清单的层级与拼写（Windows 上可能与磁盘大小写不同）；其他文件按登记的层级；
   - B/C 项没有选：排除（“可选内容：没有选择”）；
   - 用途为交给他人时，选入的非档案文件转交权不是 `transferable`：完整分享受阻；“只分享获准内容”时排除，A 层的列入**接收端待补齐**（`restore: acquire`）。本人备份不执行转交权检查。
2. 随包的候选能力包：工程内草稿的树哈希等于登记内容哈希时随工程文件走；否则本机候选库里的登记内容（先按 `packTreeHash` 核对）放进 `share/packs/<id>/`。两种情况下可执行文件的权限位都记在清单里（包的内容哈希含权限位）。
3. **`.meta` 成对**：资源与它的 `.meta` 只一起进包；一方进不了，另一方也不进（列出理由，A 层的列入待补齐）。文件都没进包、但 `.meta` 进了的文件夹作为空文件夹条目保留（GUID 不丢）。
4. 大小写冲突（两个路径只差大小写）与 Windows 无法创建的名字（保留设备名、`<>:"|?*`、结尾的点或空格）：受阻。
5. 逐个文件读一遍：大小、SHA-256、CRC32 与内容检查（§5）；结果缓存在 `AVH_HOME/cache/share-scan/`（按大小、修改时间、文件 id；检查规则或本机凭据变了缓存就作废）。**缓存只是线索，不是身份**：只有交互式预览（`avh project share --dry-run`、`preview: true`）可以复用缓存；导出、清单和记录一律按内容重读一遍（`DigestCache.verified`），大小与修改时间都没变而内容变了时以内容为准，并在报告里写明“已按内容重新扫描”（`DATA/D6`）。
6. **引用闭包**：从登记的头像根所在场景出发，沿文本序列化资源里的 GUID 引用走（`.meta` 建 GUID 索引，含 VPM 包目录），记下每个引用落在哪：包内、VPM 依赖（`vpm:<id>`）、可再生（`regenerate:<路径>`）、没随包（`missing:<路径>`，使结果降为需补依赖）、工程里本来就没有（`absent`，只提示）。二进制场景记为未检查。
7. 必需项与等级（§5.3）、依赖（Unity 版本、VPM 锁定、每个 Workflow 的能力包身份、候选包）、接收端要做的事。

## 5. 打包前检查：受阻或降级，不静默裁剪

### 5.1 受阻（不产出分享包）

| 代码 | 条件 | 人怎么处理 |
| --- | --- | --- |
| `projection_failed` / `projection_missing` / `projection_outdated` / `active_run` / `scan_missing` / `archive_inconsistent` / `archive_missing` | 档案没有校验通过的当前修订、有 Run 在工作 | 等任务结束、刷新档案 |
| `unclassified` | 待分类文件（按目录分组） | 登记：可转交 / 不能转交 / 不分享 |
| `rights` | 选入文件的转交权不允许或未确认（完整分享） | 确认转交权，或选“只分享获准内容” |
| `secrets` | 凭据、令牌、私钥、登录态（§5.2） | 移除或改写文件；**没有“放行”** |
| `needs_review` | 本机绝对路径、Blueprint ID、订单号 | 逐个检查后确认（`--acknowledge <路径>`）；逐项选入的 C 层敏感项视为已知 |
| `symlinks` | 符号链接、目录联接（登记为排除的除外） | 换成实际文件或移出工程 |
| `case_collision` / `windows_names` / `reserved_share` | 见 §4 | 改名 |
| `too_many_files` / `no_7zip` | 遍历超限、没有 7-Zip | — |

### 5.2 内容检查（`share-scan.ts`）

在每个选入文件的**全部字节**里找凭据：私钥头、`sk-`/`sk-ant-` 类 AI Key、GitHub 令牌、AWS 访问密钥、Google API Key、Slack 令牌、JWT、BOOTH 会话 cookie（`_plaza_session_nktz7u`）、VRChat `authcookie_`、智谱 API Key、文本里的 `password`/`api_key`/`token` 类赋值（值须同时含字母与数字、20 字符以上）；Harness 自己保存的每项凭据（`AVH_HOME/config/secrets/*`、BOOTH 会话）按原值精确比对；与 `AVH_HOME/config/` 下任一文件内容相同的副本。按文件名：`.env*`、`id_rsa` 类私钥、`.pem/.p12/.pfx/.jks/.keystore/.ppk`、`.git-credentials`、`.netrc`、`booth-session`。

只在文本文件（前 8 KiB 没有 NUL）里找：本机绝对路径（工程根、工作区、`AVH_HOME`、用户目录的两种分隔符写法，以及 Windows 盘符/UNC 路径和 `/home`、`/Users`、`/tmp` 等系统根下的路径）、Blueprint ID（`avtr_…`）、项目的订单号。

报告只写路径、行号与检查名，**从不回显凭据的值**。

### 5.3 等级

| 等级 | 条件 |
| --- | --- |
| `observe_only` 只能观察（无法直接续做） | 必需项缺失：工程是 Unity 工程但包里缺 `ProjectVersion.txt`/`Assets/`/包清单；档案 A 层不全；仍在推进的 Workflow 所用的本项目候选能力包内容不可用 |
| `needs_dependencies` 需补依赖 | 接收端待补齐不为空；Workflow 产物的成员没有全部进包（相关检查与批准在接收端会失效）；头像根引用的资源没随包；候选能力包部分不可用 |
| `continuable` 可直接续做 | 以上都没有。VPM 依赖总由接收端解析（Harness 可代为执行），不算降级 |

## 6. 打包与校验

1. 在输出位置旁的隔离目录 `.harness-share-<id>/stage/` 里**按清单**逐个复制，边复制边算 SHA-256，与清单不符（导出途中被改动）即失败；复制件的修改时间固定为 2000-01-01（不带出发送端的文件时间）。
2. 写 `share/files.json`、`share/manifest.json`、`share/恢复说明.md`。
3. 7z 只按成员清单打包（列表文件，UTF-8）：`7z a -t7z -spd -sse -scsUTF-8 -r- -mx=5 -mtc=off -mta=off -mtm=on @members.txt`。`-spd` 关闭通配，`-r-` 关闭递归：没有目录通配，也没有 Agent 拼的命令。
4. `7z t` 必须通过；`7z l -slt` 列出的每个成员与清单逐项比对（路径、文件/目录、大小、CRC）。
5. 删掉暂存目录，把压缩包**冷解包**到干净目录，逐个核对大小与 SHA-256、清单之外没有多余文件；档案清单自洽（摘要、每个文件的哈希与 schema，缺的只能是没选的 B/C 层文件）；Unity 骨架齐全；`.meta` 配对不比清单声明的差；头像根可达的每个 GUID 在包内或在清单里声明为外部依赖。
6. 可选（`--unity-check`，配置了 Unity 编辑器时）：用 Unity 批处理模式打开冷解包的工程，要求正常退出。VPM 依赖在冷目录里没有解析，含 VRChat SDK 脚本的工程通常会因编译错误失败，所以默认不做。
7. 通过后才把压缩包移到输出位置（已存在的文件不覆盖），记录 `project_share` 与导出同步点 `project_sync`。

**确定性**：同一输入得到同一成员列表与同一 `share/files.json`（按路径排序，不含时间与 id）；重复刷新（只重新遍历）不产生新的档案修订。**不承诺 7z 字节相同**：每次导出的 `share/manifest.json` 带新的分享 id、时间与此前导出的谱系，压缩结果还取决于 7-Zip 版本与线程数。

## 7. `share/manifest.json`（`harness-share/1`）

| 字段 | 含义 |
| --- | --- |
| `shareId`、`createdAt` | 这次分享 |
| `producer` | `version`（Harness 包版本）、`stateSchema`、`archiveSchema`、`sevenZip` |
| `project` | `name`（接收端的目录名；名称含订单号且没选 C 层原始资料时换成中性名）、`archiveId`、`revision`、`digest`（等于包内 `_harness/archive.json`）、`sourceProjectId`（发送端状态库的项目 id，用于改写事件）、`lineage`（这个状态继承自的全部分享 id） |
| `selection` | `layers`、选入的可选项 `items`、`permittedOnly` |
| `level`、`levelText`、`levelReasons` | §5.3 |
| `required` | `unity-project`、`archive`、`workflow-artifacts`、`project-packs`：`included`/`partial`/`missing`/`not_applicable` |
| `optional` | 每个 B/C 项：`id`、`layer`、`text`、`included`、文件数与大小 |
| `dependencies` | `unity`、`vpm`（id → 版本）、`packs`（每个 Workflow：`id`、`version`、`channel`、`contentHash`、`current`、`status`；能力包身份为 pack.json 的 id——换过内容的自带包取 `bundledFrom`——、版本与内容哈希）、`projectPacks`（`id`、`version`、`contentHash`、`from`、`usedBy`）、`missing`（接收端待补齐，按目录分组） |
| `references` | `seeds`、`checked`、`external`（GUID → 去向）、`unread` |
| `integrity` | 文件数、空文件夹数、字节数、`filesSha256`（`share/files.json` 的 SHA-256）、`metaPairs`、`archive`（清单路径、修订、摘要、文件数） |
| `receiver` | 接收端要做的事 |

## 8. `share/files.json`（`harness-share-files/1`）

`entries[]`：`path`（`/` 分隔；空文件夹以 `/` 结尾，`kind: dir`）、`kind`、`layer`、`category`、`source {type, ref}`（登记来源，`archive` 为档案文件，`local-store` 为随包的候选包）、`size`、`sha256`、`crc32`（与 7-Zip 列出的格式相同）、`reason`（选入理由）、`item`（所属可选项）、`mode`（候选能力包——`share/packs/` 下的或工程内草稿——的可执行文件为 `0o755`）。

`excluded[]`：`path`（文件、登记的目录或可选项路径）、`count`、`bytes`、`reason`、`restore`（`vpm`、`regenerate`、`acquire` 即接收端待补齐，或 `null`）。

## 9. 恢复

### 9.1 写入之前的检查（`checkRestore` 只做这些，不写任何东西）

1. `7z l -slt` 列成员：每个路径都是可移植路径（不含 `..`、盘符、`\`），没有链接，没有重复或只差大小写的成员，不超过 50 万个、256 GiB；必须有 `share/manifest.json` 与 `share/files.json`。
2. 读清单：schema 认识；分享包的状态库 schema 不高于本机；档案格式认识；Harness 版本不同只提示。
3. 成员与 `share/files.json` 逐项比对（路径、大小、CRC）；`7z t`；工作区剩余空间足够。
4. 解到工作区里的隔离目录 `.harness-restore-<id>/`，做 §6 第 5 步的全部校验；档案每个文件的 schema 本机都认识（旧档案的 `harness-project-sensitive/1`，对话在其中，也认识）。校验通过后才按清单恢复候选包的权限位（POSIX 直接设置；Windows 在树旁写 `.modes.json`，写进工程里的那份记入恢复同步点的内容清单）。
5. 决定恢复方式（§9.2）与目标位置，核对能力包（§9.4）与候选包（按内容哈希），列出本机还缺的东西。

### 9.2 新项目 / 同一项目的更新 / 并列副本

以档案身份 `archiveId` 与谱系判断，不看路径（换盘符不产生重复项目）：

| 方式 | 条件 | 做法 |
| --- | --- | --- |
| `new` | 本机没有这个 `archiveId` | 放到工作区的新目录 |
| `same` | 本机这个项目已经经过这个分享包（它的谱系含这个分享 id） | 不恢复；要另存一份用 `--as-copy` |
| `update` | 分享包的谱系含本机这个项目的最后一个同步点（导出或恢复），本机在那之后状态库没有新修订，工程文件（档案自己的文件除外）与同步点记录的内容逐个相同，也没有任务在执行 | 原位更新：旧目录改名为 `<目录>.before-restore-<时间>` 保留，`.git/` 移到新工程里，状态库按记录的 id 追加新的内容 |
| `conflict` | 其他情况（两边都改过、来自另一条修改线、本机的项目正在执行或目录不见了） | 恢复为**并列副本**：新目录、新的档案身份，所有记录换新 id；本机原项目不动 |

恢复调用可以带上检查时看到的方式（`--expect`）：方式变了就拒绝，要求重新检查。

### 9.3 放置与状态库重建

先把分享包的 `share/` 移出，再把工程放到位（Windows 上文件被短暂占用时重试），没有 `.git/` 就 `git init`（产物指纹按 Git 可见文件计算）。状态库在**一个事务**里重建，失败则撤回放置的目录：

| 来源 | 写成 |
| --- | --- |
| `state/project.json`、`sensitive/project.json`（选了时） | 项目（本机路径、档案身份）、方向（原始需求只在选了 C 层原始资料时）、造型、头像根（Blueprint ID 同上）、工程内素材 |
| 对话（`sensitive/conversation.json`，或旧档案的 `sensitive/project.json`） | 全部项目消息；没选时只有已确认的决定（A 层派生事实） |
| 三个事实文件 | 存储记录连同历史，按记录时间与 `supersedes` 的顺序原样追加（保留 id） |
| `state/registry.json` | 登记（转交权照原样，它描述文件而不是收件人） |
| `state/workflows.json` | Workflow 与冻结定义：工具路径与上下文正文取自本机匹配的能力包并逐个按冻结哈希核对；运行变量取本机设置（素材库默认 `AVH_HOME/materialized/assets`）；输入 Manifest 的工程内路径改为本机路径，原始需求没选时换成说明文字 |
| `records/decisions.json`、`evidence/index.json` | 当前方案、产物版本、检查结论、Gate 决定（驳回写成事件）、阶段完成、警告接受、越界改动 |
| `state/project.json` 的任务、`records/events.json` 的 Run（选了 B 层时） | 任务与 Run（§9.5） |
| `records/events.json`（B）、`sensitive/project.json` 的人工事件（C） | 事件历史；另记恢复本身 |

恢复后立刻对产物重新计算指纹：与原机记录不同的产物追加新版本，绑定旧版本的检查、决定、阶段完成随之失效。随后做一次完整安全点写本机档案，记下恢复同步点（本机修订、内容清单、谱系）。工程里另写一份不含本机路径的 `_harness/share/restore-<id>.json`。

### 9.4 能力包

- **通用能力包**按精确的 id、版本与内容哈希匹配本机已安装的受管包；同版 Harness 自带的包在需要时安装；本机没有时，经人同意（`--allow-network` / 界面上的“从 Harness 服务器查找能力包”）按既有更新机制下载同一签名发行并核对；都没有时标为**待安装**：Workflow 与它的任务、证据照样恢复，但不写冻结定义，调度器不会运行它。装好后 `avh project restore --complete <项目>`（接口 `project.restore.complete`）补完。原机能力包身份未知（开发目录）时，按冻结的工具与上下文哈希逐个核对本机已安装的包。
- **本项目候选能力包**从工程内草稿或 `share/packs/<id>/` 按内容哈希重验，再经候选登记的知识与权限审查，只恢复为**候选**（`generated`，需要重新评测）；不启用、不成为正式包，原机的试用批准不带过来。用候选包运行的 Workflow 等本机批准试用后才能补完。

### 9.5 任务与批准

| 原机任务状态 | 恢复后 |
| --- | --- |
| `PASSED`、`FAILED`、`CANCELLED`、`BLOCKED`、`READY`、`PENDING` | 照原样（`READY` 的任务由本机调度继续派发） |
| `WAITING_HUMAN`，阶段在等人的决定（Gate、越界改动、警告接受） | 照原样 |
| `RUNNING`、`VERIFYING`、`RECOVERY_REQUIRED`、其他 `WAITING_HUMAN` | `RECOVERY_REQUIRED`：原机上的执行结果本机无法确认；有 Run 记录就沿用，没有就补一个占位 Run，供 `task recover` 核对 |

每个恢复的任务另记一条 `restored-><状态>` 事件，后续的重做请求按它判断先后。不导出锁与 PID。批准只在它绑定的产物哈希与本机重新计算的一致时有效，否则显示为失效，需要重新批准。

### 9.6 对账

`project.restore.report` / 恢复结果里的 `reconciliation`：恢复方式与来源、恢复了什么（事实、Workflow、任务、结论、决定、消息、登记、事件的数量）、路径变化、本机还缺的依赖、待安装的 Workflow、候选包结果、需要核对的任务、失效的证据、可以继续的阶段、下一步，以及现在的等级（分享包的等级，再按本机还缺的东西降低）。**只解开了文件从不算恢复成功**：状态库重建与校验没完成，恢复就失败并撤回。

## 10. 对话

完整对话（全部项目消息）是档案 C 层的一个文件 `_harness/sensitive/conversation.json`，分享时逐项选择。恢复后写回项目消息，可以检索（`avh project conversation <项目> --search <文本>`，接口 `project.conversation.search`）；新对话仍只从事实生成的 compact 开始，旧对话不自动交给新 Agent（compact 只含已确认的决定）。

## 11. 接口与命令

- 本地接口（见 [local-api.md](local-api.md)）：`project.share.preview`、`project.share.export`、`project.share.list`、`project.restore.check`、`project.restore`、`project.archive.job`、`project.restore.report`、`project.restore.complete`、`project.conversation.search`。预览、导出、检查与恢复都会读整个工程或分享包，作为后台 `avh` 命令运行，一次一个，经 `project.archive.job` 跟进度与结果。
- 命令（见 [cli.md](cli.md)）：`avh project share`、`avh project restore`、`avh project conversation`。

## 12. 状态库表（迁移 0023，全部只追加）

| 表 | 用途 |
| --- | --- |
| `project_share` | 每次导出：档案修订与摘要、等级、选择（含收件人，只在本机）、输出路径、包的哈希与大小、`files.json` 的哈希、报告 |
| `project_restore` | 每次恢复：分享 id、档案身份与修订、方式、待安装的 Workflow（含冻结定义，补完时用）、对账的固定部分 |
| `project_sync` | 同步点：导出或恢复时本机的修订、摘要、谱系与工程内容清单（相对路径 → SHA-256，档案文件除外）；判断“同一项目的更新”用 |

## 13. 已知限制

- 7z 字节不可复现（§6）。
- 候选能力包的内容哈希含权限位：发送端以 `umask 002` 生成的包在 Windows 接收端无法复现哈希，这时不登记并写明原因（同平台时按记录的权限位恢复）。
- 原位更新保留 `.git/`，不搬 `Library/` 与已解析的 VPM 包：Unity 重新导入，VPM 需要重新解析。
- 同步点只记分享包里的文件。发送方工程里另有没随包的文件（付费素材、未选的可选内容）时，对方改完再发回来的分享包在发送方判为冲突并恢复为并列副本：原位更新会让那些文件只留在备份里，所以不做。
- 恢复只重建当前方案的内容，更早的方案版本只在档案文件里保留哈希。
- 临时任务、接手分析记录、BOOTH 选材计划与原机的试用批准不重建，只在对账里说明。
- 没有匹配能力包的**已结束**历史 Workflow 只作记录（没有上下文正文）。
