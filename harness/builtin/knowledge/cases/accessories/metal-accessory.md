# 案例：金属小饰品的尺度、材质与导出

来自一个舌钉＋细链饰品的调研与制作（Blender 5.2、io_scene_fbx 5.15.0、Unity 2022.3、lilToon 2.3.4、Modular Avatar 1.18.1）。材质参数是起点值，需在 Play 下 A/B。

## 小饰品尺度：VR 可读性与首饰真实尺度要先和需求方对齐

- **症状**：按「VR 里看得清」选的链节尺寸（椭圆链节 4.0 × 3.0 mm、线径 0.8 mm、节距 2.4 mm）做完后，需求方觉得链子太粗、不像首饰，整条重做成细链（链节 1.6 × 1.2 mm、线径 0.25 mm）。
- **机制**：可读性与首饰质感互相拉扯。在 1080p、竖直视场角 60° 下，1 mm 在 1 m 处约 0.94 px、0.5 m 处约 1.87 px；真实 2.3 mm 的滚珠链在 1 m 处只剩 1.3 px 的节距、0.47 px 的线径——几乎看不见链节，只是一串闪光。调研按「0.5 m 读得出链节」把线径放大到真实的约 1.6 倍，但需求方要的是首饰质感。
- **判据**：开工前给出两三档尺寸在 0.5 m、1 m 游戏视距下的对照图（含真实首饰尺度一档），由需求方选；选定后才建模。面数预算随尺寸与细分一起算清。
- **修法**：以需求方选定的尺度为准；可读性不足时靠材质高光（MatCap）补，而不是把几何做粗。
- **适用条件**：所有毫米级饰品（链、耳钉、舌钉、戒指）。
- **证据等级**：单一案例（候选）。

## lilToon 金银材质：以 MatCap 为主，不依赖世界反射

- **症状**：用 lilToon 预设「金属（MatCap）」时，细链远看是一条暗线；照某些厂商做法把底色填黑时，着色器被屏蔽走 fallback 就成了黑色。
- **机制**：预设用的 `matcap_metal_realistic.png` 平均线性亮度只有 0.099，乘 1.5 后平均只有底色的 15%；很多世界没有反射探针，Metallic 1 的路线会发暗。细小链节上法线变化剧烈，一节就扫过 MatCap 的整个明暗范围，这正是链子「闪」的来源。
- **判据**：自做 256² 灰度 MatCap，目标分布平均 0.4–0.5、p10 ≤0.1、p90 ≥0.95（或用自带图并把 `_MatCapColor` 提到 3–4 再 A/B）；0.5 m 链节可辨、1 m 不爬行闪烁。
- **修法（起点值）**：不透明；底色填金属色而不是黑——银 `_Color` #FCFAF5，金从 #FFE39D 起调（由 PBR 金属 F0 线性值换算：银 (0.972, 0.960, 0.915)、金 (1.000, 0.766, 0.336)），需求方嫌金色太艳时可换低饱和的玫瑰金 #EFC2B0；`_UseShadow` 0；MatCap 1 为 Multiply、Blend 1、EnableLighting 0、Perspective 1、ZRotCancel 1；Reflection 块只取灯光高光（UseReflection 1、Metallic 0、Smoothness 0.9–1、ApplySpecular 1、SpecularToon 1、ApplyReflection 0）；`_GSAAStrength` 从 0 起，高光爬行时调到 0.3–0.5；关 Rim；不用法线贴图；`_LightMinLimit` 保持默认。不要把别的商品里的 MatCap 挪来用（许可风险）；lilToon 自带贴图是 MIT 许可。
- **适用条件**：lilToon 的金属饰品。
- **证据等级**：单一案例（候选）——调研推荐值，部分在建模渲图中使用，Play 下 A/B 未完成。

## 金银切换用 MA Material Swap

- **症状（风险）**：用动画写 `m_Materials.Array.data[N]` 或 MA Material Setter 切材质时，按**槽位下标**匹配；AAO 合并网格、重排材质槽之后，下标就对不上了。
- **机制**：MA Material Swap 在物体启用时把根子树里的 From 材质换成 To 材质（字段 `m_root`、`m_swaps`、`m_quickSwapMode`），配置时按**材质引用**查找，但构建时最终生成的仍是按槽位下标的曲线；常规流程里 AAO 合并材质槽时会重映射这些曲线，所以不怕合并。例外：MA 之后再由自写插件合并网格或新增子网格时，原物体上的 Swap 不会覆盖新槽，要在后置步骤里自己写（例如用一个材质状态层同时写新槽）。
- **判据**：两档材质在 Play 下切菜单后都真正进了渲染器（读 `renderer.sharedMaterials`）；装了 Light Limit Changer 的工程，两档都要拖它的滑杆看是否生效（它会克隆 lilToon 材质，只被 Swap 引用、不在渲染器上的那份是否被处理未证实）。
- **修法**：挂在带 MA Menu Item 的物体上，只占 1 bit；编辑期离屏渲图不一定烤进 Swap 的结果，以 Play 读回为准。
- **适用条件**：同一网格的两三档材质切换。
- **证据等级**：单一案例（候选）——调研结论，Play 未实测。

## Blender 导出饰品 FBX 与 Unity 导入设置

- **症状**：导出的饰品在 Unity 里缩放不对、骨数不对，或 PhysBone 找不到骨。
- **机制**：`export_scene.fbx` 默认 `apply_scale_options='FBX_SCALE_NONE'`（缩放错的头号原因）、默认加叶子骨、默认烘动画；`use_mesh_modifiers` 会阻止导出形态键；只导形变骨会把不蒙皮的载体骨、末端骨丢掉。Unity 侧勾 Optimize Game Objects 会把骨骼 Transform 收进 Avatar，PhysBone 就找不到骨。
- **判据**：导出后后台重导比对：骨数、顶点与三角数相等，权重差 0，根 scale 为 1；在 Unity 回读每根骨的世界坐标，与 Blender 差 < 0.1 mm；链骨段长按设计 ±0.05 mm，没有 >30 cm 的骨段。
- **修法**：`apply_scale_options='FBX_SCALE_UNITS'`、`mesh_smooth_type='OFF'`（只导法线，法线照样导出）、`add_leaf_bones=False`、`bake_anim=False`、修改器先手动应用；有不蒙皮的载体骨或末端骨时 `use_armature_deform_only=False`（本例早期建议 True，后改 False 才保住 37 根骨）；`global_scale` 1、建模单位米。Unity 导入：Scale Factor 1、Convert Units 勾选、Normals 选 Import、Tangents 用 Mikktspace、只在需要时导入 BlendShapes；Rig 选 Generic、不勾 Optimize Game Objects；材质 Remap 到自建 lilToon 材质。Bake Axis Conversion 开不开以回读世界坐标为准（有的素体 Head 骨在 Unity 里本身带约 105° 的 X 旋转）。
- **适用条件**：Blender 做的带骨饰品导入 Unity。
- **证据等级**：单一案例（候选）——一个饰品的多次导出与回导比对。
