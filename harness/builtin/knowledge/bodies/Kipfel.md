# 素体：Kipfel（MOCHIYAMA）

只在素体为 Kipfel 时注入。每节固定写适用范围、结论、判据、证据等级、失效条件。

## Kipfel：Body 形态键的分段与捏脸可选项

- **适用范围**：Kipfel 的脸部网格 `Body`（一份完整形态键报告，372 个键）。
- **结论**：
  - 键列表用名字由连字符包起来的分隔键分段：开头是 15 个口型键 `vrc.v.*`，之后依次是 `EYE`、`EYE_OPTION`、`EYE_CUSTOM`、`MOUTH`、`MOUTH_OPTION`、`EYE_BROW`、`OPTION`、`FACE_OPTION`、`MMD` 各段。
  - 绝大多数是表情与效果：眼、嘴、眉的表情键；`EYE_CUSTOM` 段是瞳孔样式（关瞳、白瞳、放大、缩小、竖瞳、上下左右移动等）；`OPTION` 段是脸红、苍白、泪、汗、黑眼圈、皱纹、嘟嘴、食物与特效；`MMD` 段是日文名的 MMD 兼容表情。
  - `FACE_OPTION` 段只有一个关耳朵的键 `other_earOFF`。可用于调整脸型的，主要只有 `EYE` 段里的 `eye_big`、`eye_small` 和瞳孔样式一类，脸型调整的可行域很小。
- **判据**：捏脸方案只能引用这份清单里的键；方向落不下来时如实报告可行域小，不发明键。
- **证据等级**：单一案例（候选）。
- **失效条件**：素体版本更新改键时，重新导出清单。

## Kipfel：属于まめふれんず共用素体，按企划名找适配

- **适用范围**：Kipfel 素体；按「共用素体企划」发布的服装。
- **结论**：Kipfel 属于まめふれんず（Mamefriends）共用素体企划。服装按企划名发布适配，而不是按角色名：例如 Hollow 的 26 个变体里没有 `Kipfel`，但 `Hollow_Mamefriends` 完全适用。按文件名排除，曾差点把三个包、43 套以上的服装白白排除。
- **判据**：比 FBX 骨骼名集合，人形主干零缺失。指纹：まめふれんず 的手指近节骨拼作 `IndexInterProxima`／`MiddleProxima`／`RingProxima`／`LittleProxima`，唯独 `ThumbProximal` 拼对；这种不一致的错法在四个厂商的 FBX 里一字不差，可用来确认服装是否按这个企划的骨架做。
- **证据等级**：单一案例（候选）。
- **失效条件**：企划修正骨名拼写后，指纹不再成立，但骨骼比对仍然有效。

## Kipfel：Body_Base 的收缩键与厂商换装动画

- **适用范围**：Kipfel 的身体网格 `Body_Base`，以及为 Kipfel 做的厂商服装动画。
- **结论**：
  - `Body_Base` 备有 `Shoulder_OFF`、`Upper_arm_OFF` 这类收缩键，以及完整的 `Foot_OFF`／`Toe_OFF`。
  - 厂商的 `kipfel_outfit_Shirt_ON.anim` 把 `Body_Base` 的 `Shoulder_OFF` 设为 100，只要参数为 1 就一直在播——收缩跟着参数走，不跟衣服走，穿着别的衣服时肩膀也会被收掉。处理方式：改成挂在衣服部件上的 Shape Changer，并把动画里写 `Body_Base` 的曲线改值为 0、不删曲线。
  - 有过四套服装一个脚部收缩键都不需要的情况：素体自带的靴子完全包脚、露趾凉拖（脚趾本就该露）、另两套赤脚。
  - 有过 `Shoulder_OFF` 在衣服穿着时读数为 0（厂商本意 100）的情况；要冻结 Animator、按 0／100 对照渲图判断有无可见后果，并先关掉盖住肩部的针织背心。
- **判据**：逐套判定「需要／不需要＋原因」；扫全部 clip 中写 `Body_Base` 的 `blendShape.*` 曲线。
- **在 Harness 流程里**：改挂 Shape Changer、把厂商曲线归零都做不到；装配检查 `vendor_blendshape_curves_zeroed` 会拦下这类服装，写明哪个 clip、哪些键，交人（换预制件或改方案）。
- **证据等级**：单一案例（候选）。
- **失效条件**：厂商更新动画或素体更新键名时重查。

## Kipfel：厂商服装参数的连带效果

- **适用范围**：Kipfel 素体包自带的服装参数层（工具链 Unity 2022.3、VRChat SDK 3.10、MA 1.17、NDMF 1.14 下实测）。
- **结论**：厂商的服装参数不只管网格显隐，还顺手写别的东西：
  - `Outfit_Cap`：经帽子层管帽子网格与 `Item_FishBone` 鱼骨发饰，经猫耳控制层管 `Cat_Ear` 网格与 KemoEar 左右骨骼姿势。只写帽子网格而参数仍为 1，厂商一直播「猫耳收起」，耳朵网格开着但骨骼折在头里。
  - `Outfit_Vest`：外套 ON 动画在 `Outfit_Shirts` 上写 `Necktie_spine_OFF=100`、`Shirt_spine_OFF=100`（把上衣下摆收进外套）；只关外套网格，上衣会一直缺一截。
  - `Outfit_Bag`：包、名牌，以及塞在骨架里的鱼玩具（`Bag.Root/Bag/ContentsPosition` 下，厂商 Bag ON/OFF 关的就是 `ContentsPosition`）；只关包网格，玩具留在原地飘着。
  - `Outfit_Shirts`：衬衫 ON 动画把 `Body_Base` 的 `Shoulder_OFF`、`Upper_arm_OFF` 写成 100；参数默认为 1 时一直在播，穿外挂整套时肩膀也被收掉。真正打在 `Body_Base` 上的身体收缩键只有这两个。
- **判据**：部件开关用 Driver 让对应厂商参数（`Outfit_Vest`、`Outfit_Shirts`、`Outfit_Shorts`、`Outfit_Socks`、`Outfit_Boots`、`Outfit_Bag`）跟着开关走；帽子、眼镜（`Outfit_Cap`、`Outfit_Glasses`）直接用厂商参数作菜单开关，不新建层；身体收缩键改挂到衬衫部件的 MA Shape Changer（Set 100），厂商动画里那两条曲线归零。脚部经逐套渲染确认不需要身体收缩键。
- **在 Harness 流程里**：没有 Driver，开关不能让厂商参数跟着走；把厂商 ON/OFF clip 登记为 `vendor_clips`，连带的收缩键与骨骼曲线会一起复制。`Outfit_Shirts` 常驻写身体收缩键这类问题，装配阶段的检查会拦下，写明交人。
- **证据等级**：单一案例（候选）
- **失效条件**：厂商更新服装参数层结构时；该素体在别的工程里厂商换装层可能已被停用，先查层权重。

## Kipfel：Cat_Ear 的两个含义与「播一次就停」的猫耳控制层

- **适用范围**：Kipfel 素体的猫耳显隐与发型、帽子联动。
- **结论**：`Cat_Ear` 这个名字有两个含义：厂商参数 `Cat_Ear` 是 Int，管耳朵「动作」（0=Reset、1=Idle、2～6 为各种摆动），与显隐无关；GameObject `Cat_Ear` 才是耳朵网格。显隐与骨骼姿势由 `Outfit_Cap` 经猫耳控制层统一决定。这个控制层是「播一次就停」的：默认 Inactive →（帽子关）→ Active（耳朵开、骨骼立起）→ 无条件 → Empty，Empty 只有「帽子开 → 回 Inactive」一条出边；进 Empty 后不再写 `Cat_Ear` 网格。若在外挂发型的 clip 里写过猫耳关，切回原版发型后值会卡在关。
- **判据**：自己单开一层持续驱动猫耳网格显隐，排在发型层之后：「原版发型且帽子关 → 显示」，「帽子开」或「非原版发型」→ 隐藏（两条转移）；骨骼姿势仍交给厂商层，每次帽子状态变化它都会重新摆一次。外挂发型只关猫耳网格即可（网格一关，骨骼折成什么样都无所谓）。
- **在 Harness 流程里**：单开一层持续驱动做不到（部件开关只有独立两态层，没有组合条件）；不要把 `Cat_Ear` 列进任何 control 的 `objects`，写明取舍交人。
- **证据等级**：单一案例（候选）
- **失效条件**：厂商层权重为 0（被停用）时整条不适用。

## Kipfel：同一素体的不同工程里，厂商换装层可能已被停用

- **适用范围**：接手已有的 Kipfel 工程时。
- **结论**：在一个 Kipfel 工程里，换装是用户自建的 Motion Time 机制（一个 Float 参数拖一条阶梯关键帧 clip 切整套根物体，部件由 MA Object Toggle 管），厂商那套 `Outfit_*` 层（含猫耳控制层）权重全部为 0。于是厂商 `Outfit_*` 参数是死的、不会再写身体收缩键，「播一次就停」的猫耳陷阱也不适用，只是这些参数仍白占约 17 bit。加一套衣服等于给那条 clip 加一档，参数增量为 0；新建 Int 互斥轮盘会与它抢同一批 `m_IsActive`。
- **判据**：接手时先读厂商各层的权重与 LayerControl，再决定是否沿用另一工程的结论。
- **证据等级**：未实测
- **失效条件**：厂商层处于启用状态的工程。

## Kipfel：星星发饰依附原版发型的骨链

- **适用范围**：Kipfel 素体切换发型时。
- **结论**：`Extra_Stars` 星星发饰内部是 MA BoneProxy，挂在原版发型 `Hair_Back` 的骨链上，只有原版发型有这条链，所以它应归入原版发型那一组，随原版发型一起开关，而不是做成独立开关。
- **判据**：切到外挂发型时它是否一同隐藏。
- **在 Harness 流程里**：原版发型与星星发饰属于素体，部件开关管不到；随外挂发型隐藏的需求做不到时写明交人。
- **证据等级**：单一案例（候选）
- **失效条件**：素体版本调整发饰结构时。

## Kipfel：改装套件的长裤与原装下装、靴子、过膝袜互斥

- **适用范围**：Kipfel 素体加装厂商的默认服改装套件（长裤与配套鞋）时。
- **结论**：长裤与短裤、裙是二选一；原装袜是过膝款，上沿到大腿中段，长裤穿不住它，会从裤裆那截穿出来。做法：长裤开关层排在「裙裤」「鞋」开关层之后，开态写长裤与配套鞋为显示、同时把短裤、原装靴、过膝袜写成关；关态只写自己为关，短裤与原装靴的值由前面的层透传。长裤默认关，默认服仍是原来的下装。
- **判据**：长裤开、关两态下逐一渲染确认没有两层下装或袜子穿出。
- **在 Harness 流程里**：原装下装、靴、过膝袜属于素体，进不了 `disable_when_on`，排层与透传也由 Runtime 决定；做不到，写明交人。
- **证据等级**：单一案例（候选）
- **失效条件**：「关态只写自己」依赖构建后 WD=OFF；WD 被改写为 on 时改为在短裤、靴、袜各自的所有者层里纳入长裤条件。

## Kipfel：厂商菜单里可直接引用的子菜单与参数

- **适用范围**：为 Kipfel 自建或改造菜单时。
- **结论**：厂商 ExMenu 里有 `Motion`（表情动作）与 `Pet`（宠物模式）子菜单，可以原样引用挂进新菜单树；尾巴摆动可直接用厂商参数 `Cat_Tail` 做开关。插件（灯光、姿势、手势类）用各自 MA Menu Installer 的 `installTargetMenu` 路由到对应子菜单，不改插件预制体。
- **判据**：构建后菜单树里引用的厂商子菜单可达，插件菜单落在指定子菜单下。
- **在 Harness 流程里**：厂商菜单原样留在原位（Runtime 只新增「造型」子菜单），开关不能绑定厂商参数，也不调 `installTargetMenu`；这些子菜单与参数照旧由厂商菜单提供。
- **证据等级**：单一案例（候选）
- **失效条件**：厂商菜单结构改变时。

## Kipfel 兼容性：按骨骼名集合判断，不按文件名

- **陷阱**：很多日系素体属于共用素体企划，服装作者按**企划名**（まめふれんず / Mamefriends）发布适配，而不是按角色名。用「文件名里有没有 Kipfel」判断兼容，会把能穿的衣服误判为不能穿。
- **判据**：取「服装骨骼 ∩ 素体骨骼」，要求**人形主干零缺失**（Hips / Spine / Chest / Neck / Head / Shoulder / UpperArm / LowerArm / Hand / UpperLeg / LowerLeg）。服装多出来的骨（带包前缀，或 `.001`…`.00N` 链，如 `HL_Hoodie_strap.L.003`）是它自带的物理骨，MA Merge Armature 会一并带过来，不算缺失。实测三个服装包的 Mamefriends 版与 Kipfel 共有 56 / 56 / 44 根身体骨，Merge Armature 映射 55 根，prefix / suffix 均为空。
- **最强指纹**：Mamefriends 系 FBX 的手指近节骨拼作 `IndexInterProxima`、`MiddleProxima`、`RingProxima`、`LittleProxima`，唯独 `ThumbProximal` 拼对——这种不一致的拼法在四方 FBX 里一字不差，可用来确认同一骨架规格。
- **已验证能穿**：Hollow（BlueKuma）、シェルマリン（FuriMeow）、Medical Melty Nightmare（しゃけのいけす）的 Mamefriends 版本。
- **骨架根名**：Kipfel 的骨架根是小写 `armature`；服装可能是 `armature` 或 `Armature`，查找时忽略大小写。
- **在 Harness 流程里**：装配检查只要求服装骨架里与素体主干同名的骨都吸附上（服装本来不含的不算缺失）。装配阶段不能「不装」：不兼容的件在方案阶段就不列进 `outfits`（按原因列进 `unused`）。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的骨骼名比对与装配实测。

## Kipfel 眼睛：几十张叠层卡片，缩放只能分簇做

- **结构**：眼睛不是眼球，而是叠层卡片：单侧 17 张可见（整组 34 张；连深层共 23 张/侧），层间距最小 0.03 mm（实测 0.03 / 0.056 / 0.067 / 0.094 mm）。任何变换只要让层序错乱，就会穿插、冒白斑、眼线变粗。
- **深度两簇**：前组 17 张（深度 −72.5 ~ −54.4 mm，可见）；深组 6 张（−39.6 ~ −31.8 mm，在脸皮中位深度 −46.2 mm 之后，看不见）；两簇之间有 15 mm 空隙，193 对跨卡片接缝点没有一对跨越这条分界，所以按深度分组是安全的。
- **唯一实测成功的缩放**：前簇做完整三维相似变换，深簇只缩 x / z；深度中心只用前组计算。另外三种做法都失败过：钉死 y、平移回前缘、每张卡片绕自身中心缩放。
- **配套**：`Body_eye` 与 `Body_skin` 共用顶点数为 0，缩放不会撕裂网格；眼窝阴影画在脸部皮肤上，要给皮肤做一份带平滑衰减的同比收缩（半径 22 mm 内全量、34 mm 处归零，脸中线位移仅 0.022 mm）；表情键的位移同乘缩放系数即可，相似变换下闭合关系精确保持。
- **禁止**：按 z 阈值把眉毛拆出来单独处理——眼线卡片本身纵跨眼睛到眉毛的高度，任何水平切分都会把一笔连续线条切成两段。
- **实例**：一次捏脸定稿把眼睛缩到 87% 并内移 2.5 mm；定稿要俯视检查睫毛与眼窝之间有没有露出眼球。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的 Blender 实测与定稿。

## Kipfel 面部图集布局（4096²，不透明）

- 面部图集**不透明**（alpha 全 255），灰底只是没被 UV 采样的空白区，不是透明区。
- 大致布局（像素坐标）：第一行 y 0–1300、x 1050–3050 是左右两只大虹膜；第二行 y 1350–2300 是眼白与遮罩用的深色椭圆；第三行 y 2350–2900 是黑环与白圆；y 2965–4095 是眉/睫条带，以归一化 y = 0.785（y 3215）为界，之上算眉、之下算睫。
- Twinkle 眼睛贴图包的 PSD 与本素体图集**同布局同尺寸**，坐标能直接对上：它的猫爪瞳孔图层 bbox 约 x 1473–2623、y 705–871，正好落在两只瞳孔上（两眼共用一个 bbox，按包围盒中点切开后左右眼各算各的中心）。所以可以从 PSD 单抠图层贴过来，不必整张替换。
- 素体贴图另有无内裤版（`kipfel_body_skin_naked.png`）、mobile 版与 socksOFF 版，厂商自带但没接进任何开关。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的图集实测。

## Kipfel 厂商 FX：一个参数管着好几样

只写网格显隐、不动厂商参数，必漏。厂商参数（`VRCExpressionParameters` 的 `valueType`：Int=0 / Float=1 / Bool=2）：

| 参数 | 类型 / 默认 | 同时驱动 |
|---|---|---|
| `Outfit_Cap` | Bool / 1 | 帽子网格、`Item_FishBone`，以及 `Cat_Ear` 网格与 `KemoEar.L/R` 的骨骼姿势 |
| `Outfit_Vest` | Bool / 1 | 马甲网格，以及 `Outfit_Shirts` 上的 `Necktie_spine_OFF` / `Shirt_spine_OFF` |
| `Outfit_Bag` | Bool / 1 | `Item_Bag`、`Item_NameTag`、骨架里 `Bag.Root/Bag/ContentsPosition`（内含 FishToy） |
| `Outfit_Shirts` | Bool / 1 | 衬衫网格、`UnderWear_Tops`（反向）、`Body_Base` 的肩部收缩键 |
| `Outfit_Glasses` | Bool / 0 | `Item_Glasses` 与脸部形态键 `Item_Glasses_OFF` |
| `Cat_Ear` / `Cat_Tail` | Int / 0 | 耳朵（0=Reset、1=Idle、2–6 各种摆动）/ 尾巴的**摆动动作**，与显隐无关 |

- 厂商 FX 18 层：`--`、`[USER EDIT] Face`、`Outfit` ×8、`SleeveChange`、`Cat Ear Control`、`Cat Ear`、`Cat Tail`、`Hair PBColider Ground`、`Contact Pet Control`、`AFK`、`LipSync Control`。
- **症状实例**：`Outfit_Shirts` 驱动的肩部收缩键在穿别的衣服时仍生效，肩膀被收掉。
- **层权重实测**：在一个 Kipfel 工程里，厂商 `Outfit *` 层的 `m_DefaultWeight` 全为 0 且没有 LayerControl 抬权，厂商面捕菜单下的 9 个 Outfit 开关在 36 个状态里零效果；该工程实际生效的换装层是一条 weight=1、用 `m_TimeParameter` 驱动的「Clothes」层（20 帧 @60fps、全 stepped）。在这种结构下加一套衣服＝给换装片段加一档，参数零增量，不必另建 Int 轮盘。**先读实际层权重再决定写哪一层。**
- **在 Harness 流程里**：开关不能驱动厂商参数，只能把厂商的 ON/OFF clip 登记为 `vendor_clips`（Runtime 会连带骨骼、形态键曲线一起复制）；衣装轮盘由 Runtime 新建，不能给厂商换装片段加档。层权重照样先读，用来判断登记哪条 clip。
- 证据等级：单一案例（候选）——两个 Kipfel 工程的 FX 解析与 Play 实测。

## Kipfel 猫耳层是「播一次就停」的结构

- **结构**：`Cat Ear Control` 层默认在 Inactive；`Outfit_Cap == false` 时进入 Active（猫耳网格开、耳骨立起），然后**无条件**进入 Empty；Empty 只有一条出边：`Outfit_Cap == true` 回 Inactive。Empty 没有回 Active 的路。
- **后果**：一旦进入 Empty，这一层就不再写 `Cat_Ear.m_IsActive`。如果别处（例如自建的换发型开关）覆盖过这个属性，值会**永久卡住**。症状：换发型再换回来，猫耳消失；或者猫耳网格开着但骨骼折在头里。
- **当时的做法**（人工作业，供理解机制）：不要在自建层里直接写 `Cat_Ear` 的激活状态；要显示猫耳，走厂商参数 `Outfit_Cap` 的语义（关帽子＝出猫耳），并在 Play 里做「开→关→开」往返验证耳骨姿势。
- **在 Harness 流程里**：开关不能驱动 `Outfit_Cap`：复制帽子的 ON/OFF clip 只切帽子本身，厂商猫耳层不会跟着响应；不要把 `Cat_Ear` 列进任何 control 的 `objects`（会和厂商层抢写并卡住）。写明取舍交人。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的 FX 解析与修复。

## Kipfel 常用形态键与谁在写它们

- **网格分工**：`Body` 是脸（完整表情键、`瞳小` / `瞳大`、`eye_pupil_*`），`Body_Base` 是身体。按「写入键最多的网格」自动识别身体会认错：曾把 `Body` 当身体，其写入键 375 条里 303 条是表情键。
- **`eye_pupil_OFF`**（`Body` 上第 111 号）关掉瞳孔，想把瞳孔换成贴图图案时用它。**有 45 个动画在写这个键**（82 处写 0、8 处写 100），场景里设静态值会被表情层盖掉；要永久生效只能批量改动画，并先列出会连带失效的表情（写别的 `eye_pupil_*` 键的那些）。其他瞳孔键：`white`、`only`、`big`、`small`、`slim`、`slim_big`、`goat`、`up`、`down`、`left`、`right`、`center`、`outside`、`front`（均为 `eye_pupil_` 前缀）。
- **表情层**：`[ USER EDIT ] Face` 层（基线片段 `kipfel_facial_default`）由 `GestureLeft` / `GestureRight`（Int 0–7）与 GestureWeight 或 Dynamic Gesture 的参数驱动，不是 FX 菜单参数；测试某个表情要按转移条件设手势值。
- **构建后改名**：AAO 合并后瞳孔键只剩 `AAO_Merged_eye_pupil_big_26` 这类名字，原名不可见；要在预处理前的源网格读原名，或按合并映射对回。
- **`Body_Base` 的 `*_OFF` 系列（52 个）**：`Shoulder`、`Upper_arm`、`Elbow`、`Lower_arm`、`Wrist`、`Hand`、`Neck`、`Chest_01`、`Chest_02`、`Spine`、`Hip`、`Upper_leg_01`、`Upper_leg_02`、`Knee`、`Lower_leg_01`、`Lower_leg_02`、`Foot`、`Toe`，各带 `_left` / `_right` 变体。防穿模用，建议挂 MA Shape Changer 在衣服上，不要写进换装动画。
- **捏脸键**：放大眼睛用厂商自带的 `瞳大`（按眼部拓扑做的）；自加的捏脸键追加在形态键末尾（例如第 372 号），不打乱已有 372 个表情键的索引。
- **在 Harness 流程里**：批量改动画、给衣服挂 Shape Changer 本流程都没有通道；身体收缩只能来自厂商预制件自带的配置，缺了写明交人。读 Runtime 的构建证据时，形态键名按 `AAO_Merged_<原名>_*` 对回。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的动画扫描与构建产物读数。

## Kipfel 材质槽共用与贴图包的两种装法

- **共用关系**（换贴图前先查清，否则会改到不相干的部件）：`Outfit01` 被衬衫、短裤、袜子、马甲、靴子共用；`Outfit02` 被包、内衣、帽子、眼镜、猫尾第二槽、换装垫共用；`Silver` 被鱼骨发饰、名牌、帽子第二槽、靴子第二槽、侧发第二槽共用；身体皮肤是 `Body` 与 `Body_Base` 的槽 0；脸 / 眼 / 眉 / 睫在 `Body` 的槽 2。
- **两种贴图包**：先比对图集判断性质。
  - **整图重绘**（例：制服風 vol2，4096² 整张 outfit01 重绘）→ 直接换 `Outfit01` 的 `_MainTex`，影响所有共用它的部件，这是预期。
  - **覆盖图**（只画自己那块、其余透明；例：ゆるねこニーハイ 只画袜子、ハートバッグ 只画包）→ **绝不能换共用材质**，要复制一份材质（`new Material(Outfit01)` 连同 lilToon 全部设定一起拷）只换贴图，再只挂到具体网格的那个槽上（袜子挂 `Outfit_Socks`、包挂 `Item_Bag`）。
- **追加部件包里的 BlendShare 资产**：若指向未捏脸的原始 FBX、且工程没装 BlendShare，就不要用；真穿模改用 `Body_Base` 自带的 `Upper_leg_01_OFF`、`Knee_OFF` 挂 MA Shape Changer。
- **日志陷阱**：一次装配脚本把缺失项写在多行日志中间，Console 只显示第一行，路径写错被漏掉；缺失项要单独报错。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的图集比对与装配。

## Kipfel 骨架里的静态挂件会留在原地

- **事实**：`armature/Hips/Spine/Chest/Bag.Root/Bag/ContentsPosition/FishToy` 是挂在骨架内部的静态网格（MeshFilter + MeshRenderer），不跟 `Item_Bag` 的显隐走。
- **症状**：关掉包时，这个小鱼玩具留在原地飘着。
- **查法**：按组件类型搜索 MeshFilter，一次捞出所有静态网格——骨架里的挂件几乎都是 MeshFilter，衣服是 SkinnedMeshRenderer。换装开关要把这类挂件一起纳入。
- **在 Harness 流程里**：素体自带件（如包与鱼玩具）不在衣装根下，进不了 `objects`；要做开关只能把厂商的 `Outfit_Bag` ON/OFF clip 登记为 `vendor_clips`（它会连带玩具一起切）。衣装里的静态挂件照样列进 `objects`。
- 证据等级：单一案例（候选）。

## Kipfel 眼部贴图包（Berrixy「夜空の夢」）装配与调色

- **装法**：该包的专用材质 `YY_Body` 带 Emission 发光、MatCap 反光和 Alpha 遮罩，不能只改素体 `Body_eye` 的贴图槽了事；要把渲染器上的 `Body_eye` / `Body_skin` 槽换成包里的 `YY_Body` / `YY_Bodyskin`。按厂商说明：主贴图放头像自带图集，眼色用贴图选择器换；装反会整个丢眉毛。
- **换眼色**：同时换 `_MainTex` 与 `_EmissionMap`，否则发光仍是原来的颜色。色板索引 07 在四组里都是纯红（圆周平均色相 0.8°–7.6°）。
- **眼睛偏灰的两个原因**：① `_UseMain2ndTex = 1`，第二层贴的是肤色（#E7C9B1）、BlendMode Normal 且遮罩为空，等于往虹膜上盖了一层肤色——关掉第二层（厂商说明也要求不用 2nd カラー）；② 贴图本身是柔和风格（饱和度约 0.26），同样饱和度下绿、蓝仍读作绿、蓝，红会被感知成棕或藕粉，所以红色尤其要提饱和：用 lilToon 的 `_MainTexHSVG`（x 色相偏移、y 饱和、z 明度、w Gamma），实例取饱和 1.75、`_EmissionColor` 1.414。贴图上看着发闷是正常的，渲染时还会被放大。
- **预制体实例改动**：脚本改了渲染器的 `sharedMaterials` 后要调 `PrefabUtility.RecordPrefabInstancePropertyModifications`，否则实例覆写会丢。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的装配与渲图调参。

## Kipfel 服装、发型与插件装配的分支

- **Merge Armature 标准装法**：`mergeTarget` 指素体骨架根 `armature`，`LockMode = BaseToMerge`，调 `InferPrefixSuffix()`；装后核对映射骨数与 prefix/suffix。
- **预制体自带 Bone Proxy**（例：SweetyHair 的 Kipfel 版绑 Head）：说明厂商按「绑到单根骨」设计，**不能再加 Merge Armature**——加了会映射 0 根骨并干扰 Bone Proxy。
- **厂商已配好 Merge Armature**（例：Halo Ring Hair 的 kipfel 版）：不要重复添加。
- **配色文件夹编号不一致**：同一服装不同颜色文件夹里的材质编号不对应（如一色是 663/664、另一色是 654/655），不能按文件名替换，只能按文件夹内排序逐个对应，并核对替换槽数。
- **Hollow（BlueKuma）配色**：42 个配色不是 42 张贴图，只有 3 张共用贴图，每个配色是一整套 lilToon 颜色参数（`_Color`、`_Color2nd`、`_Color3rd`、`_ShadowColor`、`_Shadow2ndColor`、`_RimColor`、`_OutlineColor`），静态色卡不准，必须装到身上渲染比较；三个部位（Hoodie、Underwear/Shoes、Headset）各有全套配色，可按材质文件名在同目录切换；耳机带保持原黑色。
- **插件**：GoGoLoco、Light Limit Changer（V2）、PoLKA、Dynamic Gesture 都用各自的 Modular Avatar 版预制体，挂成头像根的子物体即可。**PoLKA 的 `PolkaSettings.avatar` 默认为空，不填会在构建时报 "Avatar is not selected." 并中止整个 VRChat SDK 构建**；可用 SerializedObject 按字段名写入描述器引用，避免编辑器程序集引用插件程序集。
- **在 Harness 流程里**：装配由 Runtime 按方案做（四类探测、自带 BoneProxy 的不加 MergeArmature、都没有的调 MA Setup Outfit），执行方不挂组件；换配色文件、挂插件预制体、填 PoLKA 字段本流程都没有通道，需要的写明交人。PoLKA 的 `avatar` 字段为空会让构建中止，方案用到它时要提前写明。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的装配脚本实测。

## Kipfel 头发材质变体断链的修法

- **症状**：atelier-kotone 渐变发包里的 `4.blueWhite.mat` 装上后，头发不是素体调好的观感。
- **机制**：它是 Material Variant，父材质的 GUID 没随包发出，工程内也不存在（Kipfel 1.1.0 / 1.1.1 / 1.2.0 都没有）。父级缺失后，该材质只有 3 张贴图、3 个浮点、2 个颜色被序列化，其余约 700 行 lilToon 设定全部回落到 shader 默认值。
- **当时的修法**（人工作业，供理解机制）：就地断开变体（`parent = null`），`CopyPropertiesFromMaterial(素体 Hair.mat)` 继承完整 lilToon 设定（含 shader、keywords、renderQueue），再盖回渐变发包真正有意义的几条：`_MainTex`（渐变贴图）、`_LightMinLimit` 0.18、`_MonochromeLighting` 0.4、`_OutlineWidth` 0.083、`_OutlineColor`，并 `SetOverrideTag("VRCFallback", "Toon")`。
- **禁止**：换 GUID 或另建新材质替换——渲染器按 GUID 引用（该材质已赋给 8 个渲染器）。
- **判据**：修前后打印 `isVariant`、`parent`、keywords 数、renderQueue、`_ShadowColor` 等，确认设定已从素体材质继承。
- **在 Harness 流程里**：本流程修不了：setup 就地改会在下次解包时计为内容冲突，改色的副本每次从原件重抄、断链照旧。写明材质路径、症状与可参照的素体材质，交人。
- 证据等级：单一案例（候选）。

## Kipfel 眉睫改色与 PSD 抠图层

- **眉睫改色配方**：用遮罩隔离眉/睫（该遮罩与眼睛图层零重叠，实测过），在遮罩区内按亮度 2%/98% 分位把每个像素映射到 `c_lo`～`c_hi` 之间取值——笔触层次靠这一步保住。`c_lo = 头发实测渲染色 × LO + (0, 1, 8)`（往冷调推一点，避免发黄发脏），`c_hi = 头发实测色 × HI`，再按 WHITE 比例往纯白拉（纯白那部分不吃发色偏）。单纯把系数往上推会顶到 255 削顶、丢层次。
- **先出候选再定档**：出 A–E 五档对比图（LO/HI/WHITE：0.74/1.00/0.45 偏白发飘 → 0.44/0.78/0.00 深银灰），让需求方挑，不直接改工程图集。实例选的是 C 档（0.60 / 0.90 / 0.10），遮罩内均值约 RGB 166,166,175。
- **瞳孔图案**：原瞳孔用 `eye_pupil_OFF` 关掉后，只把新图案画在瞳孔位置，不用擦原瞳孔；径向渐变时一张图覆盖两只眼，要按包围盒中点劈成两半，左右各算中心。白色星星叠在已改成亮银白的睫毛上会看不见，要改成带色调的粉白。
- **PSD 抠图层的两个坑**（psd-tools）：目标图层在默认隐藏的组里时，`group.composite()` 返回全空；对隐藏层要用 `layer.numpy()` 取原始像素（`composite()` 给出的 alpha 是 0），再按 `layer.bbox` 放回整张画布。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的面部图集合成。

## Kipfel 鞋床、腿环与赤脚档的高度修正

- **素体前提**：Kipfel 没有抬脚跟的形态键；脚与鞋的高度冲突只能靠改鞋、改件的位置或用下压类键解决。
- **厚底拖鞋（Hollow 默认档）**：脚底陷进厚鞋床（左脚 464 个脚底点里 388 个在鞋床以下，中位 7.9 mm），五个脚趾圆头被鞋床前沿横切。修法：拖鞋网格副本按高度渐变整体下移约 8 mm（原件保留）；修后陷脚中位 6.6 → 2.2 mm，脚趾陷入 >6 mm 的点 162 → 0；代价是外底入地约 11 mm（在地面以下看不见，看不到鞋底纹）。
- **赤脚档**：脚底离地 10.2 mm。在这些套装根上挂 MA Shape Changer 写 `Foot_down` = 100，离地降到约 1.3 mm（这些档已强制关鞋袜，不冲突）。
- **长裤档**：长裤开关顺带关掉了袜子，乐福鞋口露出脚背。厂商做法是长裤档保留短袜并设 `Short_key` = 100——袜子要先应用 BlendShare 的 `kipfel_add` 才有这个键。
- **客户自备腿环**：1088 个顶点里 111 个埋进皮肤（最深 3.0 mm）。只放大该件 1.10 倍后降到 1 个（−0.02 mm），但环上缘露出的灰色无毛底面更显眼，那是件本身的造型，缩放修不了。
- **可接受的小偏差**：乐福鞋外底入地 5.7 mm、只穿袜时袜底悬空 8.7 mm，量级小时记录后接受。
- **在 Harness 流程里**：这些修法都要改装配层（网格副本、Shape Changer、缩放、BlendShare），本流程没有通道；读数写明，交人。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的几何取证与修复；部分取舍是代需求方做的推荐选择，待需求方复核。

## Kipfel 捏脸后闭眼破面：捏脸值要随眼睑淡出

- **症状**：捏脸改过眼形的 Kipfel，闭眼或眨眼时眼部破面；手势表情与捏脸值叠加后，个别眼部键的有效值到 110。
- **机制**：该工程的面捕是 Fermata（给 FBX 打补丁的面捕方案），它的闭眼片段只把分侧键（`eye_*_left` / `eye_*_right`）清零——这是它防止改脸后破面的做法；而捏脸写在双侧键上（如 `eye_jitome`，共 20 个键写成 `Body` 的静态值，FX 第 0 层再用同一片段写一遍），不在清零范围内，于是面捕闭眼与捏脸线性叠加，全闭时眼区顶点被额外推开最多 1.62 cm。另外，场景里有一个 MA Merge Animator（物体名 `GameObject`，FX 层优先级 999、在最顶层）一直播放 `kipfel_facial_default.anim`，把捏脸值写死，盖过面捕（Fermata）与手势层；把捏脸值改写到分侧键也没用——闭眼时分侧值同样不归 0（31 个状态实测）。把该层优先级降低则睁眼时捏脸会被表情层清零。
- **修法**：把这个单片段换成混合树，由面捕的眼睑参数 `OSCm/Proxy/v2/EyeLidLeft/Right` 驱动，让分侧捏脸值随闭眼淡出。线性淡出时半闭（0.4）眼形已明显回到厂商原样（睫毛变厚、双眼皮线消失），所以先实测「捏脸全值下从哪一档眼睑开始破面」，只在那一段淡出，半闭时尽量保持捏脸眼形。修后手势自带的眼部表情值被捏脸值覆盖（原先叠加会越界到 110），接受覆盖。
- **材质槽陷阱**：脸部网格 `Body` 的第 1 个材质槽实际是**眉毛**；为修脸颈色差把它换成发色材质，会连眉毛颜色一起改掉——槽位含义先渲图确认。厂商 PC 版脸部材质里前发是半透明的（能透过刘海看到眉眼），这是厂商设计，换成不透明会丢掉它。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的实测与修复，淡出区间方案经需求方看图确认保留。

## Kipfel 面捕补丁改了材质名：脸和身体出现色差

- **症状**：脸偏橙、脖子和身体偏粉白，接缝明显；需求方以为是「面捕方案与脸部贴图不兼容」。
- **机制**：面捕补丁（Fermata，用差分补丁改 FBX）把 FBX 里的材质名改了（`Body_skin` → `Body_skin.001`、`Hair` → `Hair.001`、`Body_alpha` → `Body_alpha.001`）；`Kipfel.fbx.meta` 的外部材质映射只认旧名，导入时就自动提取出一套 `*.001.mat`，只挂厂商原贴图——与身体用的 `Body_skin.mat` 差 84 项属性（第二层皮肤贴图 `_UseMain2ndTex` 为 0、没有 MatCap 与 Rim、描边宽 0.08 对 0.14）。脸部网格的槽 0、1、3 用了这些未配置材质，身体 `Body_Base` 用的是配置好的材质。
- **判据**：逐槽读脸部与身体网格的材质，确认同类槽用同一份配置好的材质；色差只在**同一张图内**比较脸和脖子（不同快照之间光照不稳定）。补丁还给脸部网格加了 94 个形态键和 80 个面（舌头，用皮肤材质），删了第二套 UV——对照补丁前后的网格核对这些变化。
- **当时的修法**（人工作业，供理解机制）：把脸部各槽重新指向配置好的材质（注意槽 1 是眉毛，眉色按原样保留）；根因是装配时的材质重映射断了，不是贴图本身不兼容。
- **在 Harness 流程里**：本流程改不了槽的指向（装配层按方案重建，改色只按 hair／eye／outfit 调 HSV）：写明哪几个槽用了未配置的 `*.001.mat`，交人。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的诊断（第二个模型复核后纠正了「不兼容」的说法）。

## Kipfel 衬衫下的肩臂收缩键：待机不穿，动作时才穿

- **症状**：待机姿势下「衬衫下肩臂收缩键有没有开」渲图差 0 像素，看起来无所谓；但举手、趴下、坐姿表情时肩部与前胸会穿出衬衫。
- **机制**：穿衬衫时 `Body_Base` 的 `Shoulder_OFF` / `Upper_arm_OFF` 为 0（未生效）；这类穿模只在特定姿势出现。
- **判据（动作扫描）**：只开衬衫、关外套（最坏情况），取素体自带动作层控制器里的人形片段（每条取 5 帧，含 VRChat 的 emote 与坐姿代理动画）加一组合成的抬臂网格，共 85 个姿势；每个姿势 6 个方位渲图，比较「键 0」与「键 100」两张图的差异像素（320 px 图、阈值 12/255）；先做阳性对照（待机只渲身体时两张图差 1015–3177 px）。结果 85 个里 28 个有差，最大是双臂上举 140 px，其次趴下 74、耸肩抬臂 66；待机与坐下为 0。辅助指标：待机时被衬衫包住的 228 个顶点，沿法线 8 cm 内打不到衬衫即算露出——键 0 时 55 个姿势有新露出（最多 17 个顶点），键 100 时几乎全为 0。最近点符号法在这里给出反向结果，不可信，已弃用。
- **当时的修法**（人工作业，供理解机制）：穿衬衫时由衬衫上的 Shape Changer 写 `Shoulder_OFF` / `Upper_arm_OFF`；量级小（特写几十到几百像素），是否修交需求方定。
- **在 Harness 流程里**：给衬衫挂 Shape Changer 本流程做不到；Runtime 也不跑动作扫描（在 `coverage.json` 的 `not_ran` 里）。写成未测项与风险，交人决定。
- 证据等级：单一案例（候选）——一个 Kipfel 工程的动作扫描。
