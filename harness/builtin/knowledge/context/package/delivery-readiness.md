# 交付打包阶段：缺失项、干净副本与素材来源

写给执行交付打包的 AI。依据是 14 个历史工程与 7 个客户工程的交付物核查：这些问题都不影响编译，所以「能编译」不能当交付判据。

## 交付前缺失项五查

- **职责**：在交付或上传前证明工程里没有「编译不报错、但头像会坏」的缺失项。历史核查里 MissingScript 出现在两个工程（4 处、3 处）、InternalErrorShader 出现在四个工程的活跃根、多根与共用 blueprintId 出现在多个工程。
- **权威输入**：交付场景与工程文件（`Assets/**` 全部 `.unity` / `.prefab` / `.asset` / `.mat`，含备份预制体）；`Packages/**` 只用来建 GUID 索引；构建后的克隆（运行层检查）。
- **决策边界**：只读检查、出报告；可以列出建议清理项，不自行删除业务内容；有意保留的多个根如实报告，不当缺陷处理。
- **本流程里**：你在打包之前运行、只写 `diagnosis.json`。五查里能读文件判的照做，通过的写进 `verified`（附证据路径），命中的写进 `blockers` 并令 `verdict=blocked`；运行层检查（构建后克隆逐个渲染器读 shader、冷导入后的脚本丢失）由 Runtime 在你退出后做。
- **禁止事项**：查不了的项默认通过；只查场景不查源预制体；只按 `.mat` 文本判洋红（InternalErrorShader 是运行时替身，`.mat` 里查不到）。
- **产出要求**：五项各一节，每节一行结论（通过 / 命中 N 条 / 未核及原因），附命令或路径与命中清单（`文件:行号` ＋ 最近的 `m_Name`）；末尾汇总五项通过与否，以及不通过的项该回哪个阶段处理（本流程里分别落进 `verified` 与 `blockers`）。
- **怎么验证**：
  1. **零 MissingScript**：两种都查——`m_Script: {fileID: 0}`，以及 `m_Script` 的 GUID 在 `Assets/` 与 `Packages/` 里都找不到对应 `.cs.meta`；
  2. **零 InternalErrorShader**：文件层收集所有 `.mat` 的 `m_Shader`，带 GUID 的必须能解析到 `.shader.meta` / `.shadergraph.meta`，内置的（`type: 0`、无 GUID）对照内置 ID 白名单；运行层在构建后克隆上逐个渲染器读 shader 名；
  3. **引用全能解析**：YAML 资产里出现的每个 `guid:` 都能在 `Assets/` 或 `Packages/` 找到 `.meta`（内置资源排除），断链数为 0；
  4. **只有预期的描述器进构建**：列出交付场景里的活跃根，以及 `Assets/` 下其他带 VRCAvatarDescriptor 的预制体与场景（备份整头像的预制体最常见，放在 `Backup/` 一类目录里）；
  5. **blueprintId 已核**：列出每个非空 `blueprintId` 所在文件与物体，特别标出两个根共用同一个 ID（会互相覆盖线上版本）。
- **什么时候升级给人**：共用 blueprintId 要保留哪一个；有意的多根是否都要上传；缺失项涉及厂商资产、需要更换或重新下载时。

## 交付物从干净副本出，依赖要可复现

- **职责**：保证客户拿到的工程能在一台新机器上打开、编译并上传，而且不夹带制作方的开发残留。
- **权威输入**：交付状态的工程（或原交付包＋修复件）、`Packages/manifest.json` 与 `packages-lock.json`、`vpm-manifest.json`、`git log -- ProjectSettings`。
- **决策边界**：只清理明确属于开发残留的项；业务资产、修复产物一律保留；覆盖服务器上已有的交付包必须先得到确认，旧包改名留底。
- **本流程里清理与打包都不由你做**：打包工具在你退出后从交付副本出包，只剔除 Harness 自己的 `_HarnessTools` 与 `_BuildArtifacts`；工程 zip、排除项、冷导入都由它与 Runtime 做，你不得修改前序资产。按下面的判据核查，发现开发残留（如 `com.coplaydev.unity-mcp`、`com.vrcfury.temp`、带 `blueprintId` 的备份整头像预制体）、`file:`／git 依赖、`ProjectSettings` 偏离基线时，写进 `blockers` 并令 `verdict=blocked`，由人回对应阶段处理。
- **禁止事项**：直接拿开发工作副本当交付物（里面有审查代码、编辑器连接包、测试产物）；交付包里保留 `file:` 或 `git#master` 这类只在制作方机器上有效的依赖；把批处理或 Play 带来的 `ProjectSettings` 改动混进交付。
- **产出要求**：清理清单（每项路径、大小、依据）；交付包清单（成员、大小、SHA256）；冷导入结果。本流程里只有清理清单这一项由你写（进 `blockers`），交付包清单与冷导入结果由 Harness 产出并独立验收。
- **怎么验证**：
  - 开发残留为 0：审查或测试工具目录（例 `Assets/AvatarAudit/`）不存在；`manifest.json` 与 `packages-lock.json` 里没有编辑器连接类包（7 个工程都带着一行 `com.coplaydev.unity-mcp`）；`Packages/com.vrcfury.temp/`、截图与探针日志已清；带 `blueprintId` 的备份整头像预制体已移出 `Assets/`（`find Assets -path '*Backup*' -name '*.prefab'` 后 grep `blueprintId` 为空）。
  - 依赖可复现：manifest 里 grep `"file:`、`git`、`.git?path=…#master` 为 0（历史上 14 个工程里 7 个有这类依赖，存档解出来打不开）；VPM 包在包内或可从公开源解析。
  - `ProjectSettings` 回到交付基线：用 `git log --stat -- ProjectSettings` 找出批处理、Play 带来的改动（如 iOS 支持项、形态键钳制开关、随图形 API 改写的 `lilToonSetting.json`），还原后与基线 diff 为空。
  - 冷导入：从成品包解到一个没有 `Library/Temp/Logs` 的新目录，用同版本 Unity 批处理导入，退出码 0，`error CS`、`Compilation failed`、依赖解析错误均为 0。
- **什么时候升级给人**：要覆盖或替换已交付的包；清理项里有拿不准是否属于开发残留的文件；依赖只能从付费或私有来源取得。

## 交付说明写清素材来源与付费资产

- **职责**：让客户知道工程里每类素材从哪来、哪些要自己买，避免再分发付费资产。
- **权威输入**：客户素材包清单、制作方额外用到的素材原包、工程里的私有 shader 与模板资产、厂商许可条款。
- **决策边界**：只陈述来源与许可事实；拿不准来源的写「未找到对应商品页」，不猜。
- **本流程里**：交付说明.txt 由 Harness 生成，你写不了；素材来源、附赠付费资产与许可写进 `diagnosis.json` 的 `material_summary`，它会渲染进给客户看的《客户端验收与诊断》，所以不写内部出处、待补项与内部路径。素材 zip 也由打包工具生成：`<名>_素材/` 目前留空，素材库里取的原始包进 `_追加素材（非客户自备）/`。发现付费原包被附进交付件时写进 `blockers`。
- **禁止事项**：把付费原包（BOOTH 付费 zip、Patreon 限定 shader 等）随交付件附上；在客户版说明里留下内部出处标注、待补项、内部路径。
- **产出要求**：交付说明的【素材来源】一节：客户素材包内素材；制作方额外用到的素材（每项注明「付费资产属制作方额外附赠，客户如需更新或重装请自购」）；私有模板资产的来源与许可（例：基于 Unity 内置 Standard 改写的双面 shader，MIT 许可，可随工程分发）。客户版与带出处的内部底稿分成两份。
- **怎么验证**：客户版 grep 内部出处标记、待补、内部路径为 0；每个非客户自备的厂商目录都能在来源说明里找到对应条目。
- **什么时候升级给人**：发现付费原包已被附进交付件、或素材许可不允许随工程分发时。
