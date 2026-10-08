# 多组 avatar 配置合同

多组任务用 `schema: plan/0.3`。它保留 body/body_prefab、obligations、recolor、face、optimization 等原合同，增加唯一业务输入 `avatar_config`，禁止同时写旧 outfits/default_outfit/menu.selector。旧 plan/0.2 继续读取，四件同时穿戴的 activation: fixed 继续有效。

先列业务组，再用 plan_inspect 填每个成员真实来源。七档不等于七个商品；同包配色不能合并丢档。两款可换发型是独立 exclusive 组，不能为了共存写成 fixed。显示重名合法，身份用稳定 id。

`avatar_config.schema: avatar-config/0.1`，字段：

- instances：每条有 id、kind（outfit/hair/accessory）、item（清点原值）、prefab（该商品候选）。variants 为 `{id,prefab}`；Unity 比较展开的序列化结构，仅材质槽不同可共享物理实例，结构或行为不同则物化，并保持成员身份不变。无厂商挂点的发型/配饰需要实际骨骼观察后填 mount `{path,position:[x,y,z],rotation:[x,y,z]}`，不能猜 Head。components 为 `{id,objects:[实例相对路径]}`，只有已观察绑定才可写。
- groups：id、label、activation、members。member 有 id、instance、可选 variant、label。exclusive 必须有 default（成员 id）、selector 与 parameter；Float 配 radial，Int 配 discrete。independent 每个成员有 Bool parameter 和 Bool default。fixed 全部安装启用且无选择参数；厂商内部功能照旧。一个实例只能有一个顶层组；同实例多个变体可属于同一个 exclusive 组。
- shared_switches：每条有 id、label、Bool default、parameter、targets：`{instance,component}`。同一开关的全部入口引用同一个 id，换服装/发型不复位其值。没有实测共享部件时写 []，不能虚构鞋袜绑定。

多挂点用 instances[].mounts：每条 `{source: 实例相对路径,path: 实测头像骨骼路径,pose: relative|preserve,position:[x,y,z],rotation:[x,y,z]}`。source 空串表示根；多个 source 不得重叠。relative 将该源挂点设为目标骨骼的相对姿态；preserve 保留实际源世界姿态后挂接。不能同时写 mount/mounts，不能覆盖厂商 BoneProxy。耳/尾可分别挂 Head/Hips；名称相似不证明位置、缩放或合身，须读实际层级并核实姿态。

parameter 必须完整写 `{name,type: Float|Int|Bool,saved: true|false,synced: true|false}`。两个属性独立。同步 Float/Int 各 8 位，Bool 1 位，成品总计不超过 256 位；总参数不超过 8192。新增控制的预估不能冒充素体、厂商和完整插件构建后的总预算。默认 Float 取档中点，Int 的 0 映射默认成员，Bool 的 true 表示业务开启。

同名参数默认报冲突。明确采用已有公开参数可加 `adopt: true`：必须已有且类型、默认、保存、同步和真实消费者一致；继续由厂商完整行为控制组，逐成员构建读回核对正向业务极性。不能把反向开关或多个私有参数假装成同一参数；共享部件需要组合适配证据，未知复杂接管阻断，原功能保留。

menu 为 `{mode: assemble,vendor_policy: preserve_and_merge,tree:[...]}`。树叶引用 `{group: id}` 或 `{shared_switch: id}`；分组节点 `{id,label,children:[...]}`。每个可切换组和共享开关必须可达，显示树不复制成员/default。颜色先预设，技术 design.json 不能重定已接受组或删档。厂商写者重叠而无法证明适配时阻断；有许可问题的插件只在提案中占位，不造可执行参数，不计验证通过。

厂商菜单来自构建前冻结的来源预制体声明清单，构建后与已接受 menu.tree 独立对账名称、分组路径、控件类型、参数及值；参数还在不代表菜单保留。允许的差异仅为已证明的 8 控件溢出分页、来源 MA 自动参数/值分配，以及无参数子菜单不参与状态选择的 value；不允许删除、改名、搬组或未知插件菜单改写。无法解析的安装目标或菜单来源返回 unknown 并阻断。

相关 ParameterDriver 的目的参数、Copy 来源和状态机/动画依赖必须反向追到业务组或共享开关。当前认证不执行 VRChat Driver，单写者也不能认证：直接或经中间参数影响业务时返回 unknown、menu_coverage_complete 为 false。无关表情 Driver 不据此阻断多组业务认证。单成员 Int 使用常量状态，只有 Float 使用 Motion Time。

## 七档服装、两档发型、七个配饰的示例

这个结构对应原菜单的真实组数与独立开关语义。以下使用可分发的合成来源别名；执行时必须逐条从当前 plan_inspect 替换 item/prefab 并补身体、义务和改色等完整字段。默认值是提案的一部分，经现有方案审批接受，不冒充作者默认。

```yaml
schema: plan/0.3
avatar_config:
  schema: avatar-config/0.1
  instances:
    - id: dress_a
      kind: outfit
      item: catalog-item-a
      prefab: Assets/Synthetic/DressA/Black.prefab
      variants:
        - {id: black, prefab: Assets/Synthetic/DressA/Black.prefab}
        - {id: pink, prefab: Assets/Synthetic/DressA/Pink.prefab}
        - {id: white, prefab: Assets/Synthetic/DressA/White.prefab}
    - id: dress_b
      kind: outfit
      item: catalog-item-b
      prefab: Assets/Synthetic/DressB/Black.prefab
      variants:
        - {id: black, prefab: Assets/Synthetic/DressB/Black.prefab}
        - {id: navy, prefab: Assets/Synthetic/DressB/Navy.prefab}
    - {id: dress_c, kind: outfit, item: catalog-item-c, prefab: Assets/Synthetic/DressC.prefab}
    - {id: dress_d, kind: outfit, item: catalog-item-d, prefab: Assets/Synthetic/DressD.prefab}
    - {id: hair_a, kind: hair, item: catalog-hair-a, prefab: Assets/Synthetic/HairA.prefab}
    - {id: hair_b, kind: hair, item: catalog-hair-b, prefab: Assets/Synthetic/HairB.prefab}
    - {id: halo_gold, kind: accessory, item: catalog-halo, prefab: Assets/Synthetic/HaloGold.prefab}
    - {id: halo_silver, kind: accessory, item: catalog-halo, prefab: Assets/Synthetic/HaloSilver.prefab}
    - {id: head_gold, kind: accessory, item: catalog-head, prefab: Assets/Synthetic/HeadGold.prefab}
    - {id: wrist_l, kind: accessory, item: catalog-wrist, prefab: Assets/Synthetic/WristL.prefab}
    - {id: wrist_r, kind: accessory, item: catalog-wrist, prefab: Assets/Synthetic/WristR.prefab}
    - {id: ear_tail, kind: accessory, item: catalog-ear-tail, prefab: Assets/Synthetic/EarTail.prefab}
    - {id: ring, kind: accessory, item: catalog-ring, prefab: Assets/Synthetic/Ring.prefab}
  groups:
    - id: clothes
      label: 服装
      activation: exclusive
      selector: radial
      parameter: {name: AVH/Style/clothes, type: Float, saved: true, synced: true}
      default: a_black
      members:
        - {id: a_black, instance: dress_a, variant: black, label: 黑}
        - {id: a_pink, instance: dress_a, variant: pink, label: 黑粉}
        - {id: a_white, instance: dress_a, variant: white, label: 黑白}
        - {id: b_black, instance: dress_b, variant: black, label: 黑}
        - {id: b_navy, instance: dress_b, variant: navy, label: 藏青}
        - {id: c, instance: dress_c, label: 服装三}
        - {id: d, instance: dress_d, label: 服装四}
    - id: hair
      label: 发型
      activation: exclusive
      selector: radial
      parameter: {name: AVH/Style/hair, type: Float, saved: true, synced: true}
      default: hair_a
      members:
        - {id: hair_a, instance: hair_a, label: 发型一}
        - {id: hair_b, instance: hair_b, label: 发型二}
    - id: accessories
      label: 配饰
      activation: independent
      members:
        - {id: halo_gold, instance: halo_gold, label: 金光环, default: false, parameter: {name: AVH/Acc/halo_gold, type: Bool, saved: true, synced: true}}
        - {id: halo_silver, instance: halo_silver, label: 银光环, default: false, parameter: {name: AVH/Acc/halo_silver, type: Bool, saved: true, synced: true}}
        - {id: head_gold, instance: head_gold, label: 金头饰, default: false, parameter: {name: AVH/Acc/head_gold, type: Bool, saved: true, synced: true}}
        - {id: wrist_l, instance: wrist_l, label: 左腕饰, default: false, parameter: {name: AVH/Acc/wrist_l, type: Bool, saved: true, synced: true}}
        - {id: wrist_r, instance: wrist_r, label: 右腕饰, default: false, parameter: {name: AVH/Acc/wrist_r, type: Bool, saved: true, synced: true}}
        - {id: ear_tail, instance: ear_tail, label: 耳尾, default: false, parameter: {name: AVH/Acc/ear_tail, type: Bool, saved: true, synced: true}}
        - {id: ring, instance: ring, label: 戒指, default: false, parameter: {name: AVH/Acc/ring, type: Bool, saved: true, synced: true}}
  shared_switches: []
menu:
  mode: assemble
  vendor_policy: preserve_and_merge
  tree:
    - {id: styling, label: 造型, children: [{group: clothes}, {group: hair}, {group: accessories}]}
```

此配置新增理论同步成本 23 位，基础静态状态 1792 格。逐成员、每配饰双态、边界、跨组切回与完整构建/冷导入均须观察；参数保存同步的客户端读回另记证据。

## 独立材质轴

材质组写 `kind: material`（旧组省略即 instance），activation 固定 exclusive，Float/radial、Int/discrete、saved/synced 同其他选择组，default 必填。成员不装配新实例，结构 `{id,label,materials: {绑定id: 预设id}}`，必须覆盖每个绑定。发型组继续独占显隐；材质轴同时更新所有目标实例，即使当前隐藏；换发型不写发色参数。

绑定是 groups[].bindings 的 `{id,instance,renderer,slot,source_material}`：renderer 为真实源实例内的相对路径，slot 为观察所得的整数槽位，source_material 为该源槽当前实际材质的 Assets/ 完整路径。不能按 hair 名称、材质父目录或商品目录猜槽位，丝带、宝石等邻槽不能顺带改；装配阶段重核源槽与安装证据，未知绑定阻断。两个材质组不能同槽，原实例变体编译器让出材质轴拥有的槽；厂商动画仍写这些槽则阻断，不能删厂商功能过关。

avatar_config.material_presets 每条 `{id,material}` 指向厂商现成材质；可选 `adjustment: {hue_shift: -180..180,saturation: 0..2,value: 0..2}` 要求 recolor 从独立副本产出多份运行时预设。只支持 _MainTexHSVG 或 _Color 的相对 HSV，不烘贴图，缺可调整属性返回 unknown；原件、贴图、alpha、邻槽和 shader 均保留。recolor.candidates 是制作时选一档的候选，不能表示运行时多档。

现成 gold/silver 材质按实际槽位与引用贴图核对，名称不是颜色验收。本版独立发色轴只落厂商已有的配色（银灰、金两档）：由程序生成的发根到发梢渐变本版不提供（`决定记录/D-120`，并入 dev.1.2b 的 AI 创作型调色）。订单点名渐变时按 deviations 合同逐条登记并如实说明未提供，不能用纯色或近似档冒充。PSD gradientmap 不在当前分层执行器支持范围内；素体 Hair.psd 不能代替外购发型自己的 PSD，已有 gradientmap 层也不证明已有根到梢渐变成品。

运行时预设在 recolor 落为可引用的真实材质和精确来源/配方证明，独立重载读取保存的默认材质并核对全部预设；菜单、完整构建、回归及冷导入都验证每个材质档×所拥有实例的激活档、Float 边界、切走切回、参数增量保留及最终单写者，菜单树与厂商菜单保留对账。

示例中材质、路径、槽位是合成数据，只有观察确认后才换成实际值；`default` 写成员 id 而非预设 id，菜单树增加 `{group: shade}`，不同发型各用不同厂商预设时分别绑定各自预设 id。

```yaml
material_presets:
  - {id: steel, material: Assets/Vendor/Steel.mat}
  - {id: warm, material: Assets/Vendor/Warm.mat}
# 与上面的实例组同属一个 avatar_config。
groups:
  - id: shade
    kind: material
    label: 发色
    activation: exclusive
    selector: radial
    parameter: {name: AVH/Shade, type: Float, saved: true, synced: true}
    default: shade_steel
    bindings:
      - {id: short_slot, instance: short, renderer: Surface, slot: 0, source_material: Assets/Vendor/Source.mat}
      - {id: long_slot, instance: long, renderer: Nested/Strands, slot: 1, source_material: Assets/Vendor/Source.mat}
    members:
      - {id: shade_steel, label: 银灰, materials: {short_slot: steel, long_slot: steel}}
      - {id: shade_warm, label: 金, materials: {short_slot: warm, long_slot: warm}}
```
