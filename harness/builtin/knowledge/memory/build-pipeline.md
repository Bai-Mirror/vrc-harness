# 构建流水线：顺序、改名与会被悄悄改写的设置

来自多个工程的构建产物读数与包源码核查（NDMF、Modular Avatar、VRCFury、AAO、lilToon、VRChat SDK）。每节写明适用版本。

## 构建回调顺序：NDMF、VRCFury、AAO 各在哪一步

- **适用范围**：VRChat SDK 3.10.4、NDMF 1.14.3、Modular Avatar 1.18.1、VRCFury、AAO 1.9.16、Triturbo 面捕框架（一个工程里读包源码核对）。
- **结论**：上传或完整预处理时，`IVRCSDKPreprocessAvatarCallback` 按 `callbackOrder` 执行：① NDMF 早段（First…Transforming）在 **−11000**（源码注释要求先于 VRCFury）；面捕框架在 Resolving / Generating；MA 在 Transforming，其中 MergeAnimator 先于 BlendshapeSync；② VRCFury 在 **−10000**；③ NDMF Optimizing…Last（含 AAO）在 **−1025**。MA 的 BlendshapeSync 是构建期组件，把目标曲线烘进片段后即被清除，运行时没有兜底；它的动画索引覆盖描述器的全部可播放层，不限 FX。
- **判据**：自写的构建期插件要写清自己排在哪一步（例：`BuildPhase.Transforming` 且 `AfterPlugin("nadena.dev.modular-avatar")`，即 MA 之后、AAO 之前）；要确认某一步做了什么，就克隆头像，按 `callbackOrder` 逐个手动调用各回调，每步前后统计目标对象。
- **证据等级**：单一案例（候选）——一个工程的包源码核查与批处理构建实测。
- **失效条件**：任一包大版本更新后复核顺序；VRCFury 某些功能（如 FullController）会注入动画，本次只核到修写默认值、首视角显示、骨架链接、参数上限类组件，不注入写形态键的片段。

## AAO 合并后形态键与物体会改名

- **适用范围**：AAO（1.9.16 实测）开启形态键合并、网格合并或 Trace and Optimize 时的构建产物。
- **结论**：参与合并的形态键被改名为 `AAO_Merged_<原名>_<序号>`，delta 相同的多个键会并成一个（一个面捕根的 Body 从 927 个键降到 274 个；口型与多个舌头表情键并进同一个合并键）；未参与合并的键保留原名。物体也可能被改名、搬家（形如 `<父名>$<物体名>$<序号>`）。AAO 会重映射它看到的已有曲线，所以在它之前写好的曲线仍然有效。
- **合并条件（AAO 源码判读）**：只把「默认权重相同、动画写入位置相同、只由 Animator 驱动」的键分组，满足条件且各帧权重一致才改名；合并时逐顶点把位移、法线、切线相加，并记录动画绑定的重映射。开启 MMD 兼容（默认开）时，按名字外部写入的键（MMD 表情）不满足「只由 Animator 驱动」，预期保留原名——这一点未实测，要依赖原名的键应显式加 AAO 保护，并在构建后断言原名仍在。
- **判据**：在构建产物上按原键名找绑定会 0 命中——断言、检测、读回都要同时匹配原名与 `AAO_Merged_<原名>_*`（或按 delta 比对映射）；读瞳孔、脚型等关键键时，要么在预处理前的源网格上读原名，要么按合并映射对回。按名字找物体同理，改用组件字段或层级关系识别。
- **证据等级**：多工程验证——Kaguya 工程（脚型键 `AAO_Merged_Foot_heel_OFF_____足_ヒールオフ_3`、链物体改名）、Kipfel 工程（瞳孔键只剩 `AAO_Merged_eye_pupil_big_26`）各自在构建产物上实测。
- **失效条件**：关闭形态键合并时不改名；AAO 版本变化时复核命名格式。

## AAO 会删掉「默认停用、又没有动画开关」的物体

- **适用范围**：开启 AAO Trace and Optimize 的工程（AAO 1.9.16 源码核对＋一个工程的实例）。
- **结论**：AAO 清理「未使用对象」时，默认停用（`activeSelf = false`）且没有任何动画曲线写它 `m_IsActive`（或渲染器 `m_Enabled`）的物体被判为永远不可见，整棵子树连同渲染器一起删掉——停用物体上的渲染器不能保命。实例：复制厂商控制器时只保留了部分层，唯一写宠物物体 `m_IsActive` 的那一层（一个混合树层）被裁掉，构建后宠物整个消失。
- **症状**：构建产物的动画里出现路径是一段提示文字的 `m_IsActive` 曲线（AAO 的 `ObjectMapping:DummyAnimationObject` 占位）——含义是「这条片段的所有目标对象都没了」，要查的是谁把它们删了，不是去改路径模式。
- **判据**：裁控制器、减层之前，从保留的控制器做 GUID 可达闭包，列出所有写目标物体 `m_IsActive` 的片段；一条都没有，AAO 必删它。裁层时参数按保留层的条件、混合树、驱动器实际引用来收集，不按参数名前缀；参数默认值回厂商原件取（丢了非 0 默认值，混合树会报参数不存在）。
- **修法**：保留写开关的层，或让自建层显式写该物体的 `m_IsActive`；需要 AAO 跳过时，排除项只对列出的物体本身生效、不递归子树，要保整棵子树就把每个物体都列进去。复制资产后裁层会留下大量不可达子资产（一例 3196 个，含断引用），裁完做一次可达性清理（内嵌片段也算可达）。
- **附**：构建后物体名里的 `$数字` 来自 AAO 合并骨，`$` 加 GUID 来自 MA Merge Armature；改名本身不是病因，AAO 会按实例 ID 重算动画路径。
- **证据等级**：单一案例（候选）——一个 Kaguya 工程的实例与 AAO 源码核对。
- **失效条件**：AAO 版本改变「未使用对象」判定时复核。

## 跟形态键和动画曲线有关的改动要在 AAO 之前做完

- **适用范围**：需要在构建期生成形态键、复制或改写动画曲线、改网格的插件与流程（NDMF 构建期插件、MA BlendshapeSync 类做法）。
- **结论**：构建后再按原键名去复制曲线不可行——AAO 已经改名、并键，没有一对一的目标。正确位置是 MA 之后、AAO 之前（Transforming 末尾）：此时所有驱动片段都已就位（面捕的覆写控制器、描述器原生 FX 都由 MergeAnimator 合进来了），AAO 随后会把你写的曲线与源曲线一起改名。
- **判据**：在 Optimizing 阶段加断言「写相关键的绑定集合 ⊆ Transforming 结束时的快照」，AAO 之后新出现的写者直接报错；AAO 之后核对自己生成的骨、物体、曲线绑定路径仍然有效。
- **证据等级**：单一案例（候选）——一个工程的构建产物核查。
- **失效条件**：若 AAO 被配置为不合并形态键，构建后按名处理也可行，但仍不推荐。

## 编辑器里的形态键外推值，客户端会钳到 0–100

- **适用范围**：Unity 2022.3、VRChat SDK ≥3.5.1、AAO 1.9.16、Gesture Manager 3.9.9；`PlayerSettings.legacyClampBlendShapeWeights`（Clamp BlendShapes）。
- **结论**：VRChat 客户端把形态键权重钳在模型定义的范围（FBX 默认 0–100）。编辑器里：VRChat SDK 每次脚本重载后把钳制开关置 1；AAO（其设置默认开启）在编辑模式置 0、进 Play 置 1、退出 Play 回到编辑模式再置 0；Gesture Manager 设置窗口里有手动开关。稳态是「编辑模式 0、Play 模式 1」，所以编辑模式预览里 >100 或 <0 的外推形状好看，进游戏会被截断。
- **判据**：任何用到外推值的捏脸或适配，都要在 Play（钳制 = 1）下渲图判定；扫描 `.anim`、Shape Changer 的 Set 值、场景与预制体的 `m_BlendShapeWeights` 里越界的值。编辑器在 Play 中被强杀时，AAO 来不及写回 0，`ProjectSettings.asset` 里会留下 1——提交前核对。
- **未决**：Play 下 `SkinnedMeshRenderer.GetBlendShapeWeight()` 返回的是写入值还是钳后值没有实测，不能直接拿读数推断客户端形变；没装 AAO 的工程在编辑模式是否恒为 1 未证伪。
- **证据等级**：单一案例（候选）——一个工程的包源码核查与 git 观察。
- **失效条件**：SDK 或 AAO 改变该行为时复核。

## lilToonSetting.json 随图形 API 改写是设计行为

- **适用范围**：lilToon 2.3.4、Unity 2022.3.22f1、VRChat SDK 上传构建。
- **结论**：lilToon 的编辑器启动钩子比较当前图形 API 与记录值，不一致就重写 `ProjectSettings/lilToonSetting.json` 并重编译整套 lilToon shader——切到 Vulkan 时会把几十个未使用的贴图功能开关打开。这不是损坏，也不进上传包：上传构建前 lilToon 会按该头像实际用到的材质与动画重算开关、重写 shader，构建后再恢复全开。例外：经 NDMF「Apply on Play」进 Play 时，若 `isOptimizeInNDMF` 为 false，会跳过按头像的优化、直接用盘上的全开 shader（只影响预览变体数，不改画面）。
- **判据**：全程只用一个图形 API；每切换一次都会重写 json 并重编译几十秒。Vulkan 与 VRChat PC 端路径更接近、没有 32 个采样器上限；OpenGL 下 lilToon 只启用工程材质真正用到的贴图，受 32 采样器上限约束。不要拿两种 API 下的截图互相比对。
- **做法**：把该 json 的改写视为预期噪音，不必回滚；在工程说明里写明它会随图形 API 自动变化。
- **证据等级**：单一案例（候选）——一个工程的包源码核查。
- **失效条件**：lilToon 大版本变化时复核。

## 批处理与 Play 会顺手改写 ProjectSettings

- **适用范围**：Unity 2022.3 批处理（`-batchmode`）运行编辑器脚本、进出 Play 模式的自动化测试。
- **结论**：自动化运行会留下与任务无关的设置改动：批处理拍摄脚本跑完后，两个工程的 `ProjectSettings` 里 iOS 支持项 `m_Automatic` 都从 0 变成 1；进出 Play 会改写 `ProjectSettings.asset`（钳制开关等）；一次修复提交就混入了 Play 副作用；每次 SDK 构建还会改写大量贴图 `.meta`（一个工程 290 个）并把 `GraphicsSettings` 的 `m_FogStripping` 从 0 改成 1。
- **判据**：每次批处理或 Play 测试后看 `git status`；与任务无关的 `ProjectSettings/*` 改动要识别并还原，不能混进修复提交或交付包。
- **证据等级**：多工程验证——同一批拍摄任务在两个工程上都出现；另一个工程的修复提交里出现过 Play 副作用。
- **失效条件**：无。

## 会让构建中止的几种组件配置

- **适用范围**：VRChat SDK 构建 / 上传前的完整预处理。
- **判据**：构建失败时先读日志里第一条插件或 SDK 报错；装配后逐个检查插件组件的必填引用与合并组件的成员；构建开头打日志确认自写插件确实执行。
- **结论**（各条分别来自一个工程）：
  - **PoLKA**：`PolkaSettings.avatar` 默认为空，不填会报 "Avatar is not selected." 并中止整个构建。装配后逐个检查插件组件里指向头像描述器的引用字段（`avatar`、`targetAvatar`、`descriptor` 等）是否为空。
  - **MA Merge Animator 没指定控制器**：报 `[MA-1300] 未指定要合并的 Animator`。脚本添加该组件时必须同时赋值。
  - **空的 MergePhysBone**：没有成员的合并组件会让头像构建不了（一个 Milfy 工程压 PB 数时先查出的真因；历史核查也记有「无效 MergePhysBone 会中止构建」）。删减或合并 PB 后，逐个确认合并组件仍有有效成员。
  - **构建期插件没注册**（静默失效，不报错）：NDMF 插件只继承 `Plugin<T>`、没写 `[ExportsPlugin]` 时，`Configure()` 从不执行，插件的所有 pass 都不跑；构建开头打日志确认插件真的执行了。
  - **构建期插件找不到预期的键**：例如插件取错了 Body 或键已被前序插件改名，报错后整个 `OnPreprocessAvatar` 返回 false。先读日志里第一条插件报错，再看其后 AAO 报告前后有无断言失败。
- **做法**：修补型改动写成只修目标组件的幂等入口（断言其他根不变），不要重跑整个安装流程。
- **证据等级**：单一案例（候选）——每条各自来自一个工程的构建日志。
- **失效条件**：插件版本更新后报错文本可能变化。
