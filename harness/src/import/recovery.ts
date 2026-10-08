import { relative } from 'node:path';
import { stringify } from 'yaml';
import { TAKEOVER_FACTS_SCHEMA } from '../archive/contract.ts';
import { ANALYSIS_FILE, BRIEF_FILE, TAKEOVER_FACTS_FILE, TAKEOVER_OBJECT_TYPES } from '../archive/takeover.ts';

export type RecoveryMode='observe'|'shallow'|'deep';

export function recoveryAnalysisSpec(project:string,sourceKind:string,candidates:string[],warnings:string[]):string{
  const candidateText=candidates.length?candidates.map(path=>relative(project,path).split('\\').join('/')||'.').join('、'):'未确定';
  return stringify({schema:'task/0.1',role:'diagnostician',goal:[
    '分析用户声明为 VRC/Unity 工程的输入并恢复可继续工作的工程语义。不要仅因目录不符合常规布局而放弃。',
    `输入类型：${sourceKind}；候选 Unity 根：${candidateText}；确定性扫描警告：${warnings.join('；')||'无'}。`,
    '检查 Assets、Packages、ProjectSettings、场景、Prefab、Avatar Descriptor、依赖线索和已有菜单/参数/组件做法。',
    '先判断输入是 project、asset_bundle、mixed 还是 unknown，并给出 classificationConfidence 与依据。素材输入要列出 assetCandidates（路径、类型、用途、许可线索），复用 Harness 素材库，而不是伪造为工程。',
    `输出 ${ANALYSIS_FILE}：包含 classification、classificationConfidence、detectedRoots、selectedRoot、assetCandidates、missingDependencies、avatarRoots、risks、shallowPlan、deepPlan、distillationCandidates、ready。`,
    `输出 ${BRIEF_FILE}（Markdown，带标题）：用人能理解的方式说明工程如何还原、哪些内容不确定、浅接手和深改造分别会改变什么。`,
    `输出 ${TAKEOVER_FACTS_FILE}：把可以落到文件上的发现写成结构化候选事实，schema 为 ${TAKEOVER_FACTS_SCHEMA}，形如`+
      ` {"schema":"${TAKEOVER_FACTS_SCHEMA}","facts":[{"object":"avatar_root:Assets/Scenes/Main.unity#/Avatar","attribute":"descriptor","value":"present",`+
      `"locator":{"path":"Assets/Scenes/Main.unity","object":"/Avatar"},"basis":"该对象挂有 VRCAvatarDescriptor","confidence":0.9}],`+
      `"questions":[{"id":"menu-owner","question":"……","about":"menu:Main"}],"ready":true}。`,
    `object 取 ${TAKEOVER_OBJECT_TYPES.join('、')} 之一，写成「类型」或「类型:键」；缺少的依赖写成 dependency:<名称> 的 present=false；已有的菜单、参数、插件做法和风险分别用 menu、parameter、plugin、practice、risk。`+
      '每条都必须有 locator.path（依据所在的工程内相对路径，用 / 分隔，工程根写 .）和 basis；只能引用排在前面的候选时用 dependsOn（序号列表）。',
    '无法从文件证明的历史进度、批准和验证不要写成候选，也不要补写时间线；需要人回答的写进 questions。这些候选只作为待确认推断入库，不会被当作项目事实。ready 只表示三份输出结构齐全。',
    '只允许写恢复报告；不得移动或修改原始输入，不得读取、复制或记录任何账号凭据，不得写入本机绝对路径。'
  ].join('\n'),allowedWrites:['_Harness/Recovery/'],expectedOutputs:[ANALYSIS_FILE,BRIEF_FILE,TAKEOVER_FACTS_FILE],requiredCapabilities:[],resources:[],maxRetries:1,
    checks:[{id:'analysis-schema',json:ANALYSIS_FILE,field:'ready',expect:true},{id:'recovery-brief',path:BRIEF_FILE,contains:'#'},
      {id:'takeover-facts',json:TAKEOVER_FACTS_FILE,field:'schema',expect:TAKEOVER_FACTS_SCHEMA,on:TAKEOVER_FACTS_FILE},
      {id:'takeover-output-valid',internal:'takeover-output',on:TAKEOVER_FACTS_FILE}]});
}

export function recoveryApplySpec(mode:Exclude<RecoveryMode,'observe'>,distill:boolean):string{
  const shallow=mode==='shallow';
  return stringify({schema:'task/0.1',role:'executor',goal:[
    `执行工程${shallow?'浅接手':'深度改造'}。必须先读取 ${ANALYSIS_FILE} 与 ${TAKEOVER_FACTS_FILE}；候选事实只是推断，动手前按文件核对。`,
    shallow?'保持原工程的组织、菜单、参数和组件做法，只做恢复继续工作所需的最小改动；新增内容优先放入 Assets/_Harness/Patches。':'在这个已隔离的工作副本中，把工程重构为 Harness 的可重复产出结构；保留来源、映射与回退记录，不修改外部原件。',
    '使用 VPM/Unity 所需变更必须明确记录；不要启动上传，不要处理 VRChat 登录态。',
    `在 _Harness/Recovery/apply.json 写入 mode、changed、remainingRisks、ready；${distill?'并在 distillation.md（Markdown，带标题）记录可蒸馏做法、适用条件和反例，不能直接晋升能力包。':'不采集工程做法。'}`
  ].join('\n'),allowedWrites:shallow?['Assets/_Harness/Patches/','_Harness/Recovery/']:['.'],expectedOutputs:['_Harness/Recovery/apply.json',...(distill?['_Harness/Recovery/distillation.md']:[])],requiredCapabilities:[],resources:[],maxRetries:1,
    // A path check reads the file back and needs something to find in it: the reports are Markdown with headings.
    checks:[{id:'apply-ready',json:'_Harness/Recovery/apply.json',field:'ready',expect:true},...(distill?[{id:'distillation-record',path:'_Harness/Recovery/distillation.md',contains:'#'}]:[])]});
}
