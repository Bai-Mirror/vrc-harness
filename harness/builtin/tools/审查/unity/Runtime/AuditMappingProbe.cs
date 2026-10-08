// 【项目沉淀】
// 适用素体：无关（Unity 运行时探针组件，不依赖任何素体 / 服装）。
// 用途：T-12 构建期截获的「实例表」载体。
//
// 为什么是 Runtime 组件 + IEditorOnly：
//   AAO 的 `ComponentInformation<T>` 只能在「组件实例还在场」时被回调（AAO Optimizing 的
//   ObjectMappingContext.OnDeactivate 里 ApplySpecialMapping）。VRCSDK 在 `-1024` 回调里删
//   `IEditorOnly`，而 AAO 跑在 `-1025`，所以本组件能在 AAO 映射阶段活着、又在交付前被 SDK
//   自己删掉——不需要我们写清理代码（03 Q4 / F4）。
//
// 为什么字段是「平行数组」而不是自定义结构体：
//   Unity 序列化只认 [Serializable] 类/结构体与内置类型；内部审查工具不值得为它加一个类型。
//   `renderers[i]` 对应 `sourcePaths[i]`，它的键是 `keys[offset..offset+rendererKeyCounts[i])`。
//
// 为什么只 MarkEntrypoint、不 ModifyProperties（T-12 规格硬要求）：
//   ModifyProperties 会让 AAO 认为这些形态键「被组件在运行时改动」，从而阻止它自己的
//   AutoFreezeNonAnimatedBlendShape 冻结这些键——观测者效应会把要测的东西改掉。
//   AAO 自己的 FreezeBlendShape/MergeBlendShape 处理器无论如何都会 RecordRemoveProperty /
//   RecordMoveProperty，所以 TryMapProperty 仍能拿到真实映射。

using UnityEngine;
using VRC.SDKBase;

namespace AvatarAudit
{
    /// <summary>
    /// 构建期截获探针。pass A（Resolving，BeforePlugin(MA)）把它加到构建克隆的头像根上，
    /// 填好待映射的 SMR 与源键；AAO 映射阶段回调 <c>AuditMappingProbeInfo.ApplySpecialMapping</c>
    /// 逐键写 mapping.json。VRCSDK `-1024` 回调按 <see cref="IEditorOnly"/> 自动删掉它。
    /// </summary>
    public sealed class AuditMappingProbe : MonoBehaviour, IEditorOnly
    {
        /// <summary>声明路径解析出来的源 SkinnedMeshRenderer（构建克隆上的实例）。</summary>
        public SkinnedMeshRenderer[] renderers = new SkinnedMeshRenderer[0];

        /// <summary>每个 renderer 的源层级路径（相对头像根，与 decl.parts[].objects[].path 同口径）。</summary>
        public string[] sourcePaths = new string[0];

        /// <summary>扁平化的源键名，按 renderers 顺序分组。</summary>
        public string[] keys = new string[0];

        /// <summary>renderers[i] 的键数；`keys` 里对应的区间长度。</summary>
        public int[] rendererKeyCounts = new int[0];

        /// <summary>renderers[i] 的源网格序号（uv8.x 用），与 pass A 的 uniqueMesh 顺序一致。</summary>
        public int[] rendererMeshOrdinals = new int[0];

        /// <summary>取 renderers[i] 的键集合；数组长度不齐时按 0 处理，越界不抛。</summary>
        public string[] KeysFor(int rendererIndex)
        {
            if (rendererIndex < 0 || rendererKeyCounts == null || rendererIndex >= rendererKeyCounts.Length)
                return new string[0];
            int offset = 0;
            for (int i = 0; i < rendererIndex; i++) offset += rendererKeyCounts[i];
            int count = rendererKeyCounts[rendererIndex];
            if (keys == null || offset < 0 || offset + count > keys.Length) return new string[0];
            var outKeys = new string[count];
            System.Array.Copy(keys, offset, outKeys, 0, count);
            return outKeys;
        }
    }
}
