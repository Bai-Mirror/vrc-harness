# 只读项目导入 `import/0.1`

入口是 `importProject(db, { workspacePath, projectPath, definition, config?, kind? })`，其中 `db` 来自 `openDatabase`，`definition` 是已加载的 `process/0.1` 定义。函数返回 `ImportReport`，同时将相同报告追加到 `import_report` 表并记一条事件。`getImportReport(db, id)` 从库回读；`handoffMarkdown(db, id)` 只用库内报告生成稳定的接手简报。状态库必须放在被导入项目外。

`DEFAULT_IMPORT_CONFIG` 公开所有命名约定：`_施工记录.md`、`施工记录.md`、`_任务账本.md`、`_历史工程`、`_长程任务_*`，以及客户单和私单的目录名规则。样例项目由 `sampleNames` 列出；项目简称由 `projectAliases` 列出。规则无法唯一判定 kind 时需显式传 `kind`。工具根目录缺省指向本仓库的 `开发工具/通用工具`，可由 `toolRoot` 覆盖。`packageBaselineByProject` 以项目目录名为键，记录建单时冻结的 locked 版本；未配置时尝试读取该项目 git 历史中首次提交的 `Packages/vpm-manifest.json`。`packageBaseline` 仅作全局基准信息。`deliveryArchives` 可列出待测压缩包相对名，`exportRoots` 列出工作区外的存档或交付根目录。`knownBodies` 列出可识别的素体名。私单目录名第 2 组若是已知素体则直接采用；否则按本工程 `Assets` 路径和施工记录中的提及次数排序，候选需达到首选的一半，简报显示次数。

示例：

```ts
const report = importProject(db, {
  workspacePath: '/workspace', projectPath: '/workspace/order-001_Example',
  definition,
  config: {
    sampleNames: ['ExampleSample'], projectAliases: ['Example'],
    packageBaselineByProject: { 'order-001_Example': { 'com.vrchat.avatars': '3.10.4' } },
    exportRoots: ['/delivery/archive', '/delivery/export'],
    knownBodies: ['BodyAlpha', 'BodyBeta'],
    decisionTables: [{
      glob: '_长程任务_*/待用户复核_*.md',
      columns: { id: '编号', time: '时间', flag: '编号', project: '工程/任务', question: '问题', choice: '我选的', answer: '你的意见' },
    }],
    stageRules: {
      packaging: {
        claimPatterns: ['打包完成'],
        documentPatterns: ['装配报告*.md', '_捏脸*/'],
        verificationIds: ['delivery_archives', 'delivery_cleanup'],
      },
      face_tracking: { notApplicablePatterns: ['本单无面捕'] },
    },
  },
});
const brief = handoffMarkdown(db, report.id);
```

评估从 `unknown` 起步。配置了 `stageRules[stageId]` 后，状态头或时间线明确写该 stage 已完成，可升级为 `claimed`；没有这类更强证据时，`documentPatterns` 匹配到项目根相对路径的文件或目录，也可升级为 `claimed`，最多列出 3 条路径及本地修改时间。仅由文档得到的 `claimed` 在报告 JSON 标记 `weakEvidence: true`，阶段表显示「文档存在（弱证据）」。文档存在是弱证据，文档存在 ≠ 阶段完成，不能仅凭它升级为 `verified`。规则内的 `verificationIds` 中每项复核都通过，且有该 stage 的明确完成记录，才升级为 `verified`。只读文件存在复核只能证明文件存在；是否足以证明某阶段由调用方在规则中明确映射。`not_applicable` 只接受指定模式匹配到的直接记录。后续阶段完成、其他阶段通过、缺工具、缺基准均不会补全前一阶段。

账本 `[x]` 为完成、`[-]` 为用户决定不做、`[~]` 为进行中、`[ ]` 为未开始，和是否有「负责：」无关。有「— 负责：」时首词作 ID；否则首词须以字母开头并含连字符或数字，未满足时用 `unknown-<行号>`。同一 ID 的本地、长程和归档条目按来源文件修改时间取最新状态，保留全部来源。只在归档出现的未关闭条目显示为「归档回收」；dropped 只计入「已关闭」。`externalLedgerFiles` 缺省扫描 `账本*.md`、`停滞项_*.md`、`待问用户*.md`，可在导入配置覆盖。外部账本只按勾选框主行匹配工程名，子项、标题和锚点不参与。CLI 把配置中的全部工程简称与工作区顶层 Unity 工程目录传入已知工程集合；ASCII 名按词边界匹配，CJK 名按子串匹配。`aliasGroups` 可将组名映射到多个工程目录名；仅当主行未点名任何已知工程时才按组名展开成员。主行同时涉及多个已知工程时列入「关联的跨工程条目（涉及本工程，但不是本单独有的任务）」。未收结条目主行最多 240 字符、最新注记最多 160 字符；跨工程条目主行最多 160 字符，只附出处与涉及工程。超长内容以「…」结尾，可按出处回看全文。

`decisionTables` 缺省为空；配置后只扫描所列工作区相对通配。`columns` 将逻辑字段映射到实际 Markdown 表头，必填 `id`、`project`、`question`、`choice`、`answer`，可选 `time`、`flag`；`flag` 可与 `id` 共用列。仅 `answer` 空白、且 `project` 列匹配本工程的行进入「等你处理」；星标优先，编号提取数字，内容最多显示 120 字符并附出处。关联长程任务仅从顶层匹配目录的任务书、任务账本及施工记录状态头识别，列状态、时间和逐文件提及次数，计数旁标明被计数文件的出处。`metaPrograms` 缺省为空；列入的长程任务目录只在 `sample` 类工程简报列出。

简报身份信息后依次是「当前现状」「最近施工」「等你处理」「下一步建议」「未收结条目」「交付包」「只读复核」「阶段状态」「已拍板」「关联长程任务」「关联的跨工程条目（涉及本工程，但不是本单独有的任务）」「已关闭」「未解析记录」。「只读复核」内部依次为复核表、「完整性问题」「工作副本的交付前清理项」「与工具链基准的差异」「记录里提到、现在不存在（可能已清理）」。当前现状列状态头全部字段、标题时间与出处；出处行号指向「## 当前状态」标题；「下一步」「未决 / 等用户」行含已关闭账本 ID 时标注账本状态和出处，并汇总落后行数。「不许动」原样作为约束显示。「最近施工」取最近 `recentTimelineCount` 条，含日期、标题、执行者、结果。时间线或最新提交晚于状态头时提示可能过时。时间线同时接受有时分和仅有日期的标题；无法解析的条目单列在「未解析记录」。账本「已拍板」小节后追加时间线标题匹配 `decisionTitlePatterns`（缺省 `拍板`）的最近 10 条，超出时显示总数。阶段表只列有证据的非 unknown 阶段，其余汇总计数。「下一步建议」只取状态头下一步；缺失时取前五条本工程未关闭条目。「等你处理」依次列状态头「未决 / 等用户」、负责人为用户的本工程及跨工程未关闭条目（跨工程的标出涉及工程，且不再于「关联的跨工程条目」重复）、依赖未关闭用户条目的「等你先拍板」关系、决定表待复核行（☆ 优先）；每组有小标题，相同内容只出现一次，复核未运行不在此列。

「完整性问题」只收完整性复核失败，不代表工作卡点；包含指纹工具失败、本工程锁定版本偏离建单基线、已找到交付包的 `7z t` 失败、声称产物的完整性失败。「工作副本的交付前清理项」是对当前工作副本的只读检查，不代表交付包状态；交付包见其独立小节。它从 `strip_audit.py --check --json` 的 findings 中分列 `present` 且 `strip: true` 的「待清理」和 `undecidable` 且 `strip: true` 的「需核实」，每项按 JSON `action` 写出动作，如删除目录或编辑 JSON 删除依赖；`strip: false` 不计，退出码非零但 JSON 有效时仍按 findings 解释；它不构成阻断。CLI 的「复核失败」只计阻断类复核，「待清理」单独计清理项个数。复核表里 `delivery_cleanup` 显示「待清理（N 项）」和/或「需核实（M 项）」；都没有则为「无残留」，`toolchain_baseline` 显示「有差异（N 项）」或「一致」；报告 JSON 状态不变。「与工具链基准的差异」只列本工程锁定版本不同或本工程独有的包；基准独有的包只计数，仅供参考。复核表中的命令输出会截短，不呈现原始 JSON。

产物声称只接收根目录路径或常见扩展名；全角标点与路径后的全角括号注记会被切分。路径中的 `{x,y}` 先按逗号展开一次，不支持嵌套与区间。含 `*`、`?`、`…` 或 `...` 的路径不做存在性判断，也不列入「记录里提到、现在不存在」。在项目、工作区和 `exportRoots` 依次查找；记录里提到而现在不存在的路径只列项目根下 `Assets/`、`Packages/`、`ProjectSettings/` 或实际存在的一级目录开头的相对路径；裸文件名、其它相对路径、绝对路径不列不报；信息节最多列五条和总数，不当作完整性失败。交付包除施工记录和 `deliveryArchives` 外，还按订单号、目录名、简称在 `exportRoots` 递归寻找 `.7z/.zip`，逐包列出路径、大小、修改时间与 `7z t` 结果；成功摘要解析文件数和大小，失败摘要列退出码和最后一条 `ERROR:`，不截取原始输出尾部。未找到匹配包时明确写出。

项目快照记录非 `Library/`、`Temp/`、`Logs/` 文件的 SHA256 与符号链接目标，按块读取文件。超过 `snapshotSampleThresholdBytes`（默认 64 MiB）的文件改用大小、纳秒修改时间、inode、开头和结尾各 1 MiB 的 SHA256 组成抽样指纹；报告和接手简报列出这些文件。导入前、复核后、数据库事务内各回读一次；不一致则报错，事务内变化会回滚。外部指纹写到临时目录；7z 只调用 `t`；设置 `maxDeliveryArchiveBytes` 后，超过上限的包跳过 `7z t` 并记 `not_run`，默认无上限。清理审查只调用 `--check`。缺少工具或待验目标时复核为 `not_run`。导入不会打开 Unity 或改项目文件。

# Runtime 视图的来源

Runtime 生成的简报和导入报告只从状态库中的导入报告重建；不得把生成的视图解析回事实源。
导入期读取人工维护的状态头是迁移例外，相关产出标记为 `claimed`，不作为已验证事实。
报告的 `generated_from` 记录 Harness、知识层和导入解释规则的来源版本。
