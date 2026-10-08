# 素体：Shinano（しなの）

只在素体为 Shinano（Booth 商品 6106863）时注入。每节固定写适用范围、结论、判据、证据等级、失效条件。

## Shinano：只装 AMS 合并包，不再单独装普通版

- **适用范围**：Shinano ver 1.02 与改模支持附件 AMS（Avatar Modify Support）v0.0.12。
- **结论**：用合并包 `Shinano_ver1.02_AMSv0.0.12.zip`（约 846 MB）。它与「普通版包＋单独的 AMS 附件包」逐条目比对：贴图与 PSD 字节全同，差别只在一个 `.unitypackage` 的版本与几份 AMS 手册链接，内容包含两个原始包的全部。单独的 AMS 附件包可能在渠道下架或缺失。只装 AMS 版，不要再导一次普通版，两者会共存冲突。普通版与 AMS 版都没有带 `_autumn` 系列季节配色贴图，相关引用断链（11 条）是厂商没随包发，不是选错版本。
- **判据**：导入后 `Assets/Shinano/` 与 `Assets/AvatarModifySupport/` 都在，且素体只导入过一次。
- **证据等级**：单一案例（候选）。
- **失效条件**：厂商发布新版本或改变打包方式时。

## Shinano：原生服装、发型、耳尾的厂商参数与极性

- **适用范围**：Shinano 素体自带的 `Shinano_FX.controller` 与参数资产。
- **结论**：
  - 默认服装参数 `Sweater`、`Dress`、`Skirt`、`Tights`、`Boots`（Bool，`true`＝隐藏）；`Dress` 连带隐藏 `Cloth_under_bra`，`Tights` 连带隐藏 `Cloth_under_shorts`（同一份 clip）。
  - 原生发型参数 `Hair`（Int，4＝两侧全关）、`Half`、`Bangs`（Bool，`true`＝隐藏）。原生耳尾参数 `Ear`、`Tail`（Bool，`true`＝隐藏，默认 false；`true` 时播 `Ear_OFF.anim`／`Tail_OFF.anim`，分别控制 `Other_ear`、`Other_tail`）。另有体型相关的 `Hip`、`Breast`（径向）、`Backlit`（逆光效果）。`Shinano_parameters.asset` 的编辑期基线为 75 bit。
  - 外挂服装、发型、耳尾要替换本体对应部位时，驱动这些参数让原生部分隐藏，不要直接改网格的 `SetActive`；不驱动就会两层叠穿。
  - `Ear`／`Tail` 为 false 时播的是 `Dummy.anim`，0 条曲线：「显示」实际等于「用场景里的 `activeSelf`」。见过 `Other_ear` 的 `activeSelf` 默认是 false，参数设对了耳朵也不出现，必须同时在场景里把它打开。
  - 主菜单资产名是厂商拼写的 `Sinano_main.asset`，其下的表情子菜单为 `Facial_set` 与 `Facial_patrs`（应为 parts），都按原样引用。
- **在 Harness 的 pc-recolor-outfit 流程里**：菜单不能驱动厂商参数，场景里的 `activeSelf` 也改不了。要在外挂服装下去掉原生部分，只能在方案的 `hide_body_parts` 里点名网格（构建时永久剔除，`SetActive(false)` 加 `EditorOnly`）：参数连带的对象要一起列上（如 `Dress` 连带的 `Cloth_under_bra`），并在 `notes` 写明剔除不会带出参数的其他连带效果。需要按套切换的写进菜单设计（把厂商的 ON/OFF clip 登记为部件开关的 `vendor_clips`），做不到时交人。
- **判据**：极性读控制器里以参数为条件的转换与目标 clip，不按名字猜；显示态同时核对参数值与物件 `activeSelf`。
- **证据等级**：单一案例（候选）。
- **失效条件**：素体更新控制器时。

## Shinano：眼睛颜色变体是整张脸贴图，替换会连带改睫毛与贴花

- **适用范围**：Shinano 的眼睛颜色变体（`Assets/Shinano/Texture/Color/Eye/`）。
- **结论**：
  - 眼睛颜色靠整张脸贴图切换（`Shinano_face_<色名>.png`，14 张，每张 4096²），配套材质 `Shinano_face_eye_*.mat` 与默认面部材质只差 `_MainTex`。
  - 虹膜掩膜可由两张颜色变体相减得到，占图约 15%，与厂商自带的 `Shinano_face_color_mask.png` 重合（后者同时盖住虹膜与眼白，约 26%）。面部材质已挂 `_MainColorAdjustMask`，可用 `_MainTexHSVG` 微调虹膜饱和度与明度，不必重绘。高光走 `_EmissionBlendMask`（`Shinano_face_emission_mask.png`）乘 `_EmissionColor`。腮红是贴图上的贴花，走 `_Main2ndTex` 妆容层时另有 `_Color2nd` 可调。
  - 变体贴图与默认贴图的差异**不只在虹膜**：睫毛、眼线块会连带变色；顶部一处发光贴花在默认贴图上是青色线条，所有颜色变体里都是纯白。整张替换会丢掉这处贴花；要保留，就按掩膜把变体的虹膜区合成进默认贴图（脚本合成，不是重绘）。
  - 贴图名不可信：名字像「桔梗」的 `kikyo` 实测是粉红。默认贴图的虹膜读感偏灰，不是蓝。
- **判据**：选色按贴图实测色值，不按文件名；替换前比对变体与默认贴图的差异区域。
- **证据等级**：单一案例（候选）。
- **失效条件**：厂商更新贴图集时。

## Shinano：实测基线值（主干骨、身高、参数位、脸部形态键数）

- **适用范围**：Shinano AMS 版，用作装配与回归时的自检基线。
- **结论**：人形主干 19 项，骨名为点号分隔的厂商命名（`Hips`、`Spine`、`Upper_arm.L`、`Shoulder.L`、`Upper_leg.L`、`Lower_leg.L`、`Foot.L`、`Toe.L` 等）。身高自检：`head.y`＝1.1323、`footL.y`＝0.1064，推算约 1.179 m，与商品标称约 1.18 m 一致，各阶段反复核对未漂移。参数声明编辑期基线 75 bit。脸部渲染器 `Body` 的形态键数为 526。皮肤贴图默认色约 `#FFF6F3`，没有独立换色参数，改肤色要改贴图。
- **判据**：装配、菜单、优化各阶段后身高推算值不变；外挂件骨骼映射主干零缺失。
- **证据等级**：单一案例（候选）。
- **失效条件**：素体版本更新时。

## Shinano：眼尾上挑键的实测强度与一条方向存疑的键

- **适用范围**：Shinano 捏脸时调整眼尾上挑或下垂。
- **结论**：同一方向厂商给了好几条键，强度差一倍以上。读顶点实测，上挑最强的是 `eyelid_turi1`（+0.00223）；`eyelid_tail_up` 只有 +0.00124，配 15～30 的数值折算下来接近没生效，曾让三组候选的眼尾差异完全没有做出来。`eyelid_turi2`（turi＝吊り目，按名字应当抬眼尾）读顶点是 −0.00100，往下垂；这一读数与看渲染图的结论不一致，至今没有解决。
- **判据**：做眼尾上挑优先用方向没有争议的 `eyelid_turi1`；绕开 `eyelid_turi2`；各组候选的 `实测倾斜量 × 数值/100` 要拉开可见量级。
- **证据等级**：单一案例（候选）。
- **失效条件**：厂商更新后键的形变改变；`eyelid_turi2` 的方向问题一旦用更可靠的方法查清，以新结论为准。

## Shinano：认准正版骨架，同名的 shinano 文件夹可能属于别的素体

- **适用范围**：Shinano（Booth 商品 6106863，在 ver 1.02 上观察到）。
- **结论**：Silent Twilight 包内的 `avatar/shinano/` 属于另一个同名的 shinano（Cresveil／Mana-Apparel 的共享企划），比对下来人形主干 19 项缺 5 项（`Head`、双小腿、双脚），plain 与 MA 两个变体都一样。按文件夹名判兼容，会装出一件穿不上的衣服，而且编辑期看起来「装上了」，要到动骨或换姿势才暴露。
- **判据**：比 FBX 骨骼名集合，人形主干零缺失；找真正的变体时，先开包列出 prefab 路径名初查，不必先导入。缺骨的记为「不用」并写原因。
- **证据等级**：单一案例（候选）。
- **失效条件**：厂商补出适配正版 Shinano 的变体时。

## Shinano：脚部键名与用过的组合

- **适用范围**：Shinano 工程中出现的脚部形态键。
- **结论**：删除类 `Shrink_Foot=100` 让脚缩短 32%、体积近乎减半，用在开口露脚背的鞋上时鞋口里是空的。改用姿态类后，某双鞋最终用 `Toe_heels=100`＋`Toe_highheels=100` 两键叠加贴合——与某些素体上「两个姿态键互斥」不同，叠加是否成立要看键的设计。同一张两类键对照表里还有 `Foot_heel_OFF`（姿态类）、`Shrink_Ankle`、`Foot_OFF`、`Toe_OFF`（删除类），但它们是否属于 Shinano 未单独核实。
- **判据**：两键叠加必须有渲图或几何证据（脚部包围盒长度变化 < 5%、脚在鞋内）；删除类只给完全包住的鞋。
- **证据等级**：单一案例（候选）。
- **失效条件**：素体版本更新改变键设计时。

## Shinano：鞋袜与部件的已知情况

- **适用范围**：Shinano 工程中用过的服装与素体默认装。
- **结论**：
  - Violet Nocturne 与 Winter Cozy Knit 补脚型键时挂在 `Shoes`／`boots` 上，关鞋后脚从袜子里顶出——两件袜子身上没有脚型键，袜开状态也要由袜那一侧写脚型。
  - Violet Nocturne 的 `Straps`（材质 `Anklet`）是脚踝绑带，不是上衣件；鞋或袜任一开就显示，要新开一层当唯一所有者。
  - 素体默认服装的 `Sweater`、`Dress` 等五件不是独立衣服，而是默认服装的 `*_OFF` 叠穿开关。
  - いたずらメイド 的 `mimi_Im` 参数 `true` 表示隐藏；厂商私密菜单里「贴片」本是单独开关（`bansoukou_off`），被并进内裤开关后粒度变粗。
- **判据**：鞋袜四组合读回；部件归属按穿法与厂商 clip 定，不按名字。
- **在 Harness 流程里**：鞋袜上的脚型写者来自厂商预制件，执行方挂不了；「只穿袜」脚型不对时写进方案 `shrinkkey_review` 的风险或交人。
- **证据等级**：单一案例（候选）。
- **失效条件**：厂商更新预制件时重查。

## Shinano 脚型键：Toe_heels 与 Toe_highheels 两套命名并存

- **键**：`Body_base` 上的脚型键是 `Toe_heels` 与 `Toe_highheels`（不是 Milfy 的 `Foot_heels` / `Foot_highheels`，也不是 Kaguya 的 `Foot_heel_OFF`）；收缩类有 `Shrink_Foot`、`Shrink_Ankle`、`Shrink_Knees`、`Shrink_Lower_leg`、`Shrink_Upper_leg2`、`Shrink_Spine_1`，另有 `Stocking2`。
- **双命名的后果**：两个键分别出自不同厂商的鞋包目录，都写向 `Body_base`；鞋类开关之间又不互斥，「同时开两双鞋」是可达状态，这时两个键会同时生效，归属不统一。
- **实例**：一双冬靴（Winter Cozy Knit 套装）的 MA Shape Changer 给 `Body_base` 写 `Toe_heels` = 100；该状态下正常穿靴时脚趾区穿出斑块应 <0.5 cm²，把 `Toe_heels` 改成 0 时应 >2 cm²（检测样例的预期值）。多双鞋各自把 `Toe_heels` 置 0 属于同一套装的重复登记，不是冲突。
- **当时的做法**（人工作业，供理解机制）：换鞋时按鞋查它写哪个键、写多少；「两双鞋同开」要么在菜单里做成互斥，要么明确哪个键优先并渲图确认。
- **在 Harness 流程里**：装配层写的键改不了，脚部键要在方案的 `shrinkkey_review` 里复核。两双鞋在同一衣装里时，可以在 `design.json` 用一个开关的 `objects`／`disable_when_on` 做成二选一（另一双不能再有自己的开关）；不同衣装的鞋由衣装轮盘天然互斥；做不到的写明交人。
- 证据等级：多工程验证——三个 Shinano 历史工程的档案都独立指出双命名；取值实例来自一个客户工程。

## Shinano 默认装五件是独立叠穿开关，不是互斥

- **结构**：厂商菜单 `Sinano_costume.asset`（厂商拼写如此）里有五个 Toggle，参数 `Sweater`、`Dress`、`Skirt`、`Tights`、`Boots`，在 `Sinano_parameters.asset` 里各自独立、默认值 0；对应动画开关是 `*_OFF`：0 = 穿着，1 = 脱掉那一件。五项各有独立的层，默认权重 1。
- **结论**：这是厂商设计的叠穿，不是「衣服之间没做互斥」的缺陷；三个历史工程里这份菜单资产逐字节相同。
- **未决**：外装（第三方服装）打开时这五件是否自动隐藏，静态读不出来，要在 Play 里看。
- **厂商 FX**：`Shinano_FX.controller` 是素体原件，多个工程里保持未改；只有两个工程改过它并加了 `Cloth` 轮盘（单状态＋`m_TimeParameter` 拖时间轴的换装轮盘）。
- **在 Harness 流程里**：外装下要去掉这五件，只能在方案 `hide_body_parts` 里点名（永久剔除），或把厂商的 `*_OFF` clip 登记为部件开关的 `vendor_clips`（变成用户手动的开关，不随换装自动切）；是否被外装盖住看回归阶段的换装照。
- 证据等级：多工程验证——三个历史工程的菜单资产核对与第二个模型复核一致。

## Shinano 工程的脚甲与丝袜

- **脚甲网格**：一款脚甲饰品（An-Labo HoroNail）左右一体，只有 `Toe_heels`、`Toe_highheels`、`Shrink_Foot` 三个键，都由 MA BlendshapeSync 跟随 `Body_base`。
- **显隐惯例**：鞋或袜遮住脚时脚甲隐藏，露趾款除外——这是需求方定下的惯例，要写进工程约定，逐双检查袜子露不露趾；按惯例处理的「只穿袜也压脚甲」不算缺陷。
- **症状**：一套服装（Violet Nocturne）的丝袜是单腿薄丝袜（只包左脚到脚趾，右脚裸露）；只穿袜时左脚大脚趾尖有一小点脚甲穿出丝袜（此时身体 `Toe_heels` = 100、`Shrink_Foot` = 100）。
- **当时的修法**（人工作业，供理解机制）：量左脚脚甲顶点到丝袜表面的有向距离（正 = 在袜外），复制脚甲网格并新增一帧只动左脚脚甲的键，沿丝袜法线向内收「最大穿出 + 0.5 mm」，由丝袜上的 Shape Changer 在只有丝袜可见时写 100；两个头像根都换用新网格。
- **在 Harness 流程里**：给脚甲网格加帧、换网格、按鞋袜组合隐藏脚甲都没有通道（装配层按方案重建，菜单没有组合条件，脚甲也不在衣装根下）；HoroNail 这类要人在 Unity 里执行的件，本流程也没有等人的步骤。写明交人。
- 证据等级：单一案例（候选）——一个 Shinano 客户工程。

## Shinano 工程的多根、面捕预设与余量

- **重复的根**：一个客户工程里同时有面捕根（`…FaceTracking[HD(Quest,Pico)+HD(Pico)]` 这类按设备命名的预设）和一个重复的非面捕根；Play 测试时要关掉重复的根，只留一个，否则工具会接管错误的根。面捕预设名里的设备组合要对照需求方的设备，不要默认。
- **预算零余量**：一个 Shinano 历史工程 PhysBone 数为 255/256；一个客户工程 PhysBone 142 个仍是 Very Poor，需求方决定只做「逐字段相同链」的零手感合并、接受 Very Poor。
- **贴图**：一个客户工程有贴图没开 Mip Streaming，列为遗留项。
- **在 Harness 流程里**：本流程只造一个头像根；PhysBone 只能写 `remove_duplicate` 或 `remove_noop`；Mip Streaming 由 Runtime 在构建副本里开。
- 证据等级：单一案例（候选）——各条分别来自一个工程。
