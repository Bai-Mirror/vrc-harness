# Process Definition Format v0.1

Public reference for the frozen `process/0.1` contract.

## 1. 顶层

```yaml
schema: process/0.1
id: pc-recolor-outfit          # 一类订单，不是某一单
version: <知识层提交>           # Workflow 启动时冻结
applies_to: {platform: pc}
artifacts: [assets, plan, fbx, scene, build, delivery_package]   # 本类订单跟踪的产物种类；Runtime 为每个项目记录各种类的当前哈希
stages: [...]
checks: [...]
gates: [...]
milestones: [...]
```

## 2. Stage

```yaml
- id: outfit
  needs: [setup]                  # 这些 stage 通过后才能开始
  when: plan.outfits              # 适用条件（方案字段非空）；为假时整个 stage 记 not_applicable（依据＝方案字段），见聚合规则 10
  produces: [scene]               # 本 stage 允许改变的产物种类；Run 改了别的种类记为越界（见聚合规则 8）
  requires: [skeleton_complete, refs_resolved]   # 通过所需的检查
  gates: []                       # 通过所需的人机缺口（一律是出口条件）
  invalidated_by: [fbx]           # 这些产物种类的哈希一变，本 stage 的通过状态作废
  source: docs/workflow.md:42@<commit>
```

## 3. Check

```yaml
- id: param_budget
  when: plan.toggles              # 可选：适用条件；为假时记 not_applicable（依据＝方案字段），不去取读值
  observe: menu.dump              # 由哪个 Capability 取读值
  on: build                       # 读值针对哪种产物；Verdict 记录该产物的哈希
  scope: build                    # edit | build | play | client：观测口径
  rule: synced_bits <= t.param_bits_max   # 闭式判据；t.* 引用知识层阈值表，数值不写在这里
  severity: blocking              # blocking | warning | advisory
  maturity: accepted              # candidate | tested | accepted | deprecated
  source: docs/workflow.md:42@<commit>
```

Verdict 结果：`pass | violation | no_data | undecidable | error | not_applicable`。**v0.1 只承认一种 not_applicable：检查的 `when` 为假**（绑定 plan 哈希，依据＝该条件）；验证器自报的 not_applicable 一律按非 pass 处理——适用性必须在定义里用 `when` 声明，杜绝「工具跑不起来就报不适用」。

## 4. Gate（人机缺口）

```yaml
- id: plan_approval
  kind: approve                   # approve 批准 | choose 选择 | do 需人亲手做
  binds: plan                     # 决定绑定该产物种类的当前哈希；哈希变了，决定作废
  source: docs/workflow.md:42@<commit>
```

Gate 挂在 stage 上是该 stage 的**出口条件**；挂在 milestone 上是该里程碑的**达成条件**。需要在某 stage 开始前拿到的决定，写成前一个 stage 的 Gate；流程起点由用户创建 Workflow 决定，不需要入口 Gate。

## 5. Milestone

```yaml
- id: UPLOAD_READY
  requires_stages: all            # 所有适用 stage 通过
  evidence_on: delivery_package   # 另外：所有适用的、on=delivery_package 的 blocking 检查，在当前交付包哈希上 pass
- id: CLIENT_VERIFIED
  after: UPLOAD_READY
  gates: [client_test]            # 用户上传并实测；binds 必须是 delivery_package
```

冷导入后的成品上要重跑的检查，**单独定义**为 `on: delivery_package` 的检查（同一种观测针对不同产物就是不同的 check id），列进打包 stage 的 `requires`；前面 stage 在 scene/build 上的 Verdict 只管各自 stage 能否通过，不能替代成品上的证据。

## 6. 聚合规则（Runtime 固定实现，不写进定义）

1. **Verdict 何时有效**：实测得出的 Verdict，其 scope 等于检查声明的 scope，且记录的产物哈希（`on` 所指）等于该产物种类的当前哈希；因 `when` 为假得出的 not_applicable，绑定的是条件所读产物（通常是 plan）的哈希。不满足即 stale，视同缺席。不同口径不能互相替代。
2. **Stage 通过**：`requires` 中 blocking 检查每个都有有效的 pass 或有依据的 not_applicable；warning 检查每个都有有效的 pass、有依据的 not_applicable，或绑定该 Verdict 的接受事件；`gates` 中每个 Gate 都已决定（approve/choose）或已完成（do），且所绑产物哈希仍是当前值。
3. **阻断**：blocking 检查为 no_data / undecidable / error / violation / 缺席 / stale，一律阻断。
4. **warning**：非 pass 时需要策略或用户接受才放行；接受记为独立事件并绑定那一条 Verdict，Verdict 失效则接受随之失效；原 Verdict 不改写。
5. **advisory**：只记录，不影响通过。
6. **maturity**：只有 accepted 的检查可以声明 blocking 或 warning；candidate 与 tested 只能声明 advisory，加载定义时校验，违反即拒绝加载；deprecated 不执行。
7. **失效**：某产物种类的当前哈希变化时，绑定旧哈希的 Verdict 与 Gate 决定变为 stale；`invalidated_by` 含该种类的 stage 失去通过状态，经 `needs` 依赖它的下游 stage 一并失效。哈希变化由 Runtime 在 reconcile 与每个 Run 结束时读取产物指纹得出，不依赖模型自报。
8. **越界改动**：Run 结束后，若哈希变化的产物种类不在当前 stage 的 `produces` 里，stage 进 BLOCKED，等人确认是否接受。
9. **Milestone 达成**：下列条件中**已声明的**全部成立（未声明的视为满足）——`after` 所指里程碑已达成且仍有效；`requires_stages` 全部通过；`evidence_on` 所指产物上的适用 blocking 检查全部有效 pass；milestone 自己的 `gates` 全部决定或完成，且所绑产物哈希是当前值。任一条件失效，里程碑随之失效。
10. **不适用的 stage**：`when` 为假的 stage，在它自己的 `needs` 全部满足后才记为 not_applicable（依据＝方案字段），此后对下游 `needs` 与 `requires_stages: all` 视同通过，不会让下游越过它的祖先提前开始；方案改变使 `when` 变真时，该 stage 转为待做，下游随之失效。

## 7. 不放进流程定义的东西

| 内容 | 放在哪 |
|---|---|
| 素体、服装、配色、开关等具体值 | 样例 Manifest 与方案（plan），经 Gate 批准 |
| 工具怎么调用、读写范围、锁、幂等与恢复 | Capability manifest（[`capabilities/0.1`](workflow-runtime.md)） |
| 阈值数值、单位、适用素体/插件版本、成熟度、出处 | 知识层阈值表（`t.*` 引用） |
| 诊断经验、案例、反例 | 知识层诊断条目，只在诊断任务里检索 |

## 8. v0.1.1 补遗

1. **阈值表文件**：加载器接收完整的阈值表文档。顶层包含 `schema: thresholds/0.1`、非空 `version` 和 `t` 映射。`t` 下每项包含 `value`、`unit`、`maturity`、`source`，可选 `applies_to`；`maturity` 为 `candidate | tested | accepted | deprecated`。流程定义中的 `t.<name>` 引用 `t` 映射下的同名项。旧的扁平表和 `t.` 前缀键不适用。
2. **`requires_stages`**：可写 `all` 或已定义 stage id 的列表。里程碑只要求某个 stage 及此前步骤时，可列该 stage；其 `needs` 链保证前序。发生在里程碑之后的人工动作应作为后续里程碑的 Gate。
3. **加载时校验**：
   - 任一 stage 的 `invalidated_by` 不得与该 stage 自己及其所有下游 stage（经 `needs` 可达）的 `produces` 相交。只读验证 stage 的 `produces` 应为空。
   - 任一 stage 的 `requires` 所引用的检查，其 `on` 不得是该 stage 任一下游 stage（经 `needs` 可达，不含自身）的 `produces` 产物种类；同一检查被多个 stage 引用时逐一校验。绑定当前 stage 自己产出的种类允许。
   - severity 为 `blocking` 或 `warning` 的检查，其 `rule` 引用的每个阈值都必须为 `accepted`。
4. **产物种类粒度**：按实际修改对象区分产物种类。若多个 stage 修改同一种类，后续哈希变化会使先前绑定旧哈希的 Verdict 失效。

## 9. v0.1.2 补遗

以下字段只加在阈值条目（`t.<id>`）和检查（`checks[]`）上，均为可选。v0.1 的必填键、`t.*` 引用和聚合规则保持原样；旧定义可直接加载。编译器、蒸馏器或导入器在**写入断言时**填写能确定的字段，人工决定和复核由对应的人或事件填写；无法确定的事实留空，不伪造。

| 键 | 语义、填写者与缺省 |
|---|---|
| `kind` | 断言类型：`decision | observation | spec | hypothesis | case | candidate`。写入者按来源填写；缺失视为 `spec`（存量 SOP 编译条目）。`hypothesis`、`case` 不能作为 blocking / warning 检查，也不能被这两类检查的 `rule` 引用；advisory 可引用。 |
| `asserted_by` | 断言主体：`human:<who> | compile:<run id> | distill:<run id> | import`。写入者记录实际主体；缺失表示未知。`accepted` 只是成熟度，不代表 Harness 已实测。 |
| `source_id` | 被引内容的 SHA-256 前 12 个小写十六进制字符。文本按行引用时先去掉行尾空白、统一 LF 再求哈希；渲染图、JSON 结果、日志文件等非文本证据，对整个文件的原始字节求哈希。采集来源时填写；缺失表示未计算。导出时保留 `source_id`，剥掉 `source` 路径。 |
| `applies_to` | 适用平台、插件、插件版本等条件的映射，所有 `kind` 均可填；由断言者在当时记录，缺失表示未声明适用范围。 |
| `environment` | 取得 `observation` 的环境映射，写明嵌套沙箱、宿主机或真机及关键版本；观察写入者必填。其他类型可省略。 |
| `recorded_at` | 写入者记录的 UTC ISO 时间，如 `2026-09-27T01:02:03Z`；缺失表示未知。 |
| `verification` | 复核记录列表，元素含 `kind`、`ref`，可含 UTC ISO `at`；缺失视为空列表。`kind` 为 `sop-editorial | harness-regression | human-approval | field-report`；`ref` 是 Run、Verdict、事件 id 或 `source_id`。复核发生时由复核者追加。`sop-editorial` 仅指「SOP 写明，未经 Harness 实测」。发布校验要求 `tested` / `accepted` 条目至少有一条验证记录；加载时不强制。 |
| `visibility` | `local | shareable`；缺失即 `local`。写入者可声明；翻转机制及事件等贡献功能留待实现，目前只接收和校验该键。 |
| `validity` | `unknown | valid | questioned | invalid | disputed`；缺失视为 `unknown`。由复核者或写入者按当时证据填写。 |
| `supersedes` | 被纠错的旧条目 id；纠错时新增条目并填该 id，旧条目标为 `deprecated`，不改写旧值，也不自动删除。缺失表示没有声明替代关系。 |

`avh knowledge check <知识根>` 是发布门：扫描 `thresholds/0.1` 和 `process/0.1` 定义，对 `tested` / `accepted` 且 `verification` 为空的条目报违规，并统计 `kind`、`verification.kind`、`visibility`。`avh knowledge annotate <文件> --sop-editorial` 只预览可追溯到 `path:line@commit` 的存量条目；核对后加 `--write` 写回，无法读取原文的条目单独列出。

蒸馏候选将带 `task_family`，至少区分 `harness-dev` 与各流程 id；这一标签可由候选所在 Program 或工程推出，因此本版不增加加载校验。蒸馏不得改写 `check_question` 原文；来源冲突时并列保留，标 `validity: disputed`，不合并。
