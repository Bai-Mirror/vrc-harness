# AAO 与 PhysBone 优化判据

## AAO Trace And Optimize 实际做的三件事与各自的验法

Avatar Optimizer（1.9 系列）的 Trace And Optimize 在构建期做三件事。下面的数字来自一个多套服装工程（贴图内存 671.0 → 160.7 MB，约 −76%）。

1. **删除「永远关着」的渲染器**：该例删掉素体自带的 `Cloth_*`、`Hair_*`、`Other_ear/tail` 共 89,072 面，所以 AAO 之后的面数可能低于基线。验它删得安全不靠渲图（渲图只看得到默认那一档），靠引用：在菜单与动画资产（`.anim`、`.controller`、`.asset`）里搜被删物件的名字，**没有任何 clip 引用 = 永远关着 = 删得对**；只有探针的文本日志提到它不算数。反过来，有 clip 引用却被删了，是真缺陷，要查 AAO 的追踪为什么没看到这条引用。
2. **UV 重打包与单色区域降成 1×1**：在 `Packages/nadena.dev.ndmf/__Generated/**` 下生成 `xxx (AAO UV Packed).asset`（2048² → 512×1024 这个量级）与 `AAO Monotone RGBA(...).asset`（1×1，用于采样区域恒定的贴图）。该例贴图内存下降的主要来源是这一项，不是压缩格式。贴图清单里材质的贴图指到 `__Generated/` 是正常的；这些资产每次构建重新生成，不随交付包走。
3. **合并蒙皮网格**：生成 `$$AAO_AUTO_MERGE_SKINNED_MESH_N`。只合并显隐动画完全相同的网格，不会把两个独立开关的件并到一起。

第 2、3 项在 Harness 的优化阶段是关闭的（见下一节），Harness 里实际发生的只有第 1 项。

- AAO 不做网格简化：面数下降必须能全部归因到第 1 项删掉的永远关着的渲染器。
- 骨骼、形态键、蒙皮网格数在 AAO 之后不应高于基线。

## AAO 默认开启项的收益与代价

- Trace And Optimize 里的 `allowShuffleMaterialSlots`（材质槽重排）与 `optimizeTexture`（按功能对应上一节的 UV 重打包与单色贴图）在 AAO 里**默认开启**。
- 收益：在有拆解数据的例子里，贴图内存的大头来自 UV 重打包与单色贴图。代价：可能出现材质错位与贴图接缝。
- **Harness 的优化阶段固定关闭这两项和 `mergeSkinnedMesh`**：避开材质错位与接缝，并保留每套衣服各自的物体层级，供回归按件判定。设计里不能重新打开；`aao.rationale` 只说明为什么保留这套安全配置，以及因此放弃了哪部分贴图收益。
- 在 Harness 之外手动开启时，最终回归必须逐件复检材质错位与贴图接缝。
- AAO 配错会直接中止构建；中止时撤销最近一个 AAO 配置、保留失败日志，不叠加第二个猜测性修复。

## PhysBone 256 与其他 SDK 硬上限：按构建后的头像计数

- **本流程里**：PhysBone 只能在 `design.json` 写 `remove_duplicate`（逐字段等价、碰撞体为保留项子集）或 `remove_noop`（无子骨、无 Endpoint），所有可证明冗余的都要处理，不许合并不同骨链。超过 256、或厂商的 MergePhysBone 为空、用这两种动作解决不了时，写明交人；不改厂商资产，不开 Unity。下面「在场景里真删或真合」「反射读面板」是自己开 Unity 时的做法。
- SDK 面板报 `Phys Bone Components: N - Avatar exceeds the maximum limit (256)` 不是评级差，是硬上限：SDK 的 `AvatarValidation.cs` 常量 `MAX_AVD_PHYSBONES_PER_AVATAR = 256`，构建期会对**处理后**的头像再校验一次并抛 `ValidationException`，上传拿不到 bundle。同一处的其它硬上限：PhysBone 碰撞体 256、Contact 256、Constraint 2000、Raycast 80（按 VRChat SDK 3.10.4 的源码核对，SDK 升级后复核）。
- **面板统计跑在构建前的场景对象上**：一例面板显示 520，构建后是 497。AAO 的 MergePhysBone 是构建期合并，减不了面板上的数；要让面板那条 Error 消失，只能在场景里真删或真合。
- **空的 AAO MergePhysBone 不是白挂，是构建不过**：`componentsSet` 为空时，AAO 的验证阶段报 `MergePhysBone:error:noSources`，NDMF 预处理返回 false，表现为 `VRCBuildPipelineCallbacks.OnPreprocessAvatar` 返回 false，而日志里没有任何异常文本。预处理莫名返回 false 时，先数一遍 `componentsSet.mainSet.arraySize == 0` 的 MergePhysBone；要么填上源列表，要么删掉，不留空的。
- **不靠人看面板读剩余问题**：反射取开着的 `VRCSdkControlPanel` 实例 → `ResetIssues()` → 调 `VRCSdkControlPanelAvatarBuilder.OnGUIAvatarCheck(descriptor)` → 读 `GUIErrors` / `GUIWarnings` 两个字段（`Issue.issueText`），逐根跑，改完立刻复验。

## 动骨开销的两个口径：评级数字与每帧真实开销

- VRChat 性能评级把**停用的组件也算进去**，CPU 每帧只跑激活的那些。多套服装的头像，停用组件常常占一半以上。
- **评级数字**决定徽章颜色，但徽章往往已被面数、材质槽独立锁死，动骨怎么优化都不动它；**每帧真实开销**才影响帧数，其分母只有评级数字的一半左右。
- 报收益两个口径都给，并说清哪个对应帧数：只报评级数字会让人以为白干了，只报真实开销会让人以为徽章会变。
- 碰撞检查数 = Σ(每条链的受影响骨数 × 该链挂的碰撞体数)。摘掉一个碰撞体的收益等于那条链的骨数，与碰撞体大小无关；给一条链多挂一个碰撞体，每帧就多「该链骨数」次检查。
