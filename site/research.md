# 同类产品网站调研

调研日期：2026-09-28。方法：抓取各站首页的导航与页脚（首页为 JS 渲染、抓不到页脚的，用 `sitemap.xml` 补），记录有哪些页面、首页主标题与主按钮、默认主题。只读，不注册、不提交表单。

覆盖 12 个站点：AI 编程 / 智能体工具 6 个，VRChat 创作工具 4 个，AI 创作工具 2 个。原计划中的 Krea（服务器返回 header overflow）与 Midjourney（403）无法抓取，用 Runway 与 Luma 代替。

## 一、站点一览

| # | 站点 | 类别 | 首页主标题（原文） | 主按钮 | 默认主题 | 备注 |
|---|---|---|---|---|---|---|
| 1 | Cursor `cursor.com` | AI 编程 | "Cursor is your coding agent for building ambitious software." | Download for macOS | 浅色 | 页面最全，有 Learn、Workshops、Value Calculator、Brand 等扩展页 |
| 2 | Devin `devin.ai` | AI 智能体 | "Meet Devin, your team's autonomous software engineer" | Get started / Book a demo | 浅色 | 首页页脚为 JS 渲染，页面清单以 sitemap 为准；有 35+ 客户案例页 |
| 3 | Windsurf `windsurf.com` | AI 编程 | 308 跳转到 `devin.ai/desktop`（"Windsurf is now Devin Desktop"） | Download for MacOS | 浅色 | 独立品牌被并入 Devin；旧域名永久跳转，博客解释更名 |
| 4 | Factory `factory.ai` → `factory.com` | AI 智能体 | "Build Your Software Factory" | Start here（指向文档） | 未能判断 | 首页为文本极少的入口页；sitemap 显示 news 86 篇、articles 89 篇、案例 6 篇、招聘 47 条 |
| 5 | Warp `warp.dev` | 终端 / 智能体 | "Open infrastructure for cloud software factories" | request early access / download warp terminal | 浅色 | 有 Roadmap、Agent Kits、Research、Newsroom |
| 6 | Zed `zed.dev` | 编辑器 | "Zed is a minimal code editor crafted for speed and collaboration with humans and AI." | Download now / Clone source | 深色 | 有 Releases、Roadmap、Compare、Theme Builder、Yearly Recaps、Merch |
| 7 | VRChat Creator Companion `vcc.docs.vrchat.com` | VRChat 官方工具 | "The VRChat Creator Companion (VCC) provides everything you need for creating VRChat worlds and avatars in Unity!" | 指向 vrchat.com 的下载 | 浅色 | 文档站即官网；法务页在 hello.vrchat.com |
| 8 | Modular Avatar `modular-avatar.nadena.dev` | VRChat 非破坏工具 | "Drag-and-Drop Avatar Assembly" | Download（`vcc://` 一键加 VPM 仓库） | 浅色 | 英 / 日双语；页脚只有 Documentation 与 GitHub |
| 9 | VRCFury `vrcfury.com` | VRChat 非破坏工具 | "Non-Destructive Tools for VRChat Avatars" | Download VRCFury | 浅色 | 单栏文档式站点；GitHub 与 Discord 为社区入口 |
| 10 | Avatar Optimizer `vpm.anatawa12.com/avatar-optimizer` | VRChat 优化工具 | "Set of Anatawa12's non-Destructive Small Avatar Optimization Utilities." | 添加 VPM 仓库（推荐 ALCOM） | 浅色 | 英 / 日双语；有 Changelog、Bug Report Helper、Beta 文档、开发者文档 |
| 11 | Runway `runwayml.com` → `runway.com` | AI 创作 | "Building Real-World Intelligence" | Try Runway for free | 浅色 | 页面最多的一家：Creative / Dev / Robotics / Enterprise / Research 五条线 |
| 12 | Luma `lumalabs.ai` | AI 创作 | "Luma is your creative partner" | Try for free | 未能判断 | 首页页脚未抓到；News 兼作发布记录 |

## 二、页面矩阵

✓ 有独立页面或明确入口；△ 有但不独立（嵌在别的页面里 / 只是外链）；— 没有找到；？ 抓取受限，未能确认。

| 站点 | 首页 | 功能 | 价格 | 文档 | 更新日志 | 博客 / 新闻 | 下载 | 关于 | 隐私 | 条款 | 社区 | 招聘 | 企业 / 团队 | 安全 / 信任 | 状态页 | FAQ / 支持 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Cursor | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | △（Careers / Anysphere） | ✓ | ✓ | ✓（Community、Forum） | ✓ | ✓ | ✓ | ✓ | ✓ |
| Devin | ✓ | △ | ✓ | ✓（docs.devin.ai） | — | ✓ | ✓ | △（博客） | ✓ | ？ | ✓ | ？ | ✓ | ✓ | — | △（价格页 FAQ） |
| Windsurf → Devin Desktop | ✓ | △ | △（嵌在页内） | △（FAQ 文档） | — | ✓ | ✓ | — | ？ | ？ | — | — | △ | — | — | ✓ |
| Factory | ✓ | ✓ | ✓ | ✓（docs.factory.ai） | — | ✓（News、Articles） | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | — | — |
| Warp | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Zed | ✓ | ✓ | ✓ | ✓ | ✓（Releases） | ✓ | ✓ | ✓（About、Team、Values） | ✓ | ✓ | ✓（Discord、GitHub、Reddit） | ✓ | ✓（Business） | — | ✓ | ✓ |
| VCC | ✓ | △ | — | ✓ | — | △（News） | ✓（外链） | — | ✓（外链） | ✓（外链） | ✓（Discord） | — | — | — | — | ✓ |
| Modular Avatar | ✓ | △ | — | ✓ | — | — | ✓（vcc://） | — | — | — | ✓（Discord、GitHub） | — | — | — | — | — |
| VRCFury | ✓ | △ | — | ✓ | — | — | ✓ | — | — | — | ✓（Discord、GitHub） | — | — | — | — | ✓ |
| Avatar Optimizer | ✓ | — | — | ✓ | ✓ | △（日文一篇） | ✓（VPM 仓库） | — | — | — | ✓（Discord、GitHub） | — | — | — | — | ✓ |
| Runway | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓（移动端 App） | ✓ | ✓ | ✓ | ✓（Discord） | ✓ | ✓ | ✓ | ✓ | ✓ |
| Luma | ✓ | ✓ | ？ | — | △（News） | ✓ | — | ？ | ？ | ？ | — | ✓ | — | — | — | — |

## 三、观察

1. **两种信息架构，几乎不重叠。** 商业 AI 工具站是「营销站」：功能、价格、企业、安全、状态、招聘、法务一应俱全（Cursor、Warp、Runway 全部 16 项齐全或接近齐全）。VRChat 创作工具站是「文档站」：首页就是文档入口，页面只有安装 / 下载、文档、FAQ、Discord 与 GitHub，没有价格、法务、博客（VCC 的法务页也是外链到母站）。
2. **更新日志是 AI 工具站的标配**（Cursor、Warp、Zed、Runway），VRChat 工具里做得最认真的是 Avatar Optimizer。Harness 的「能力包由服务端签名发布、旧流程保持冻结」天然需要一份能按版本对照的更新日志。
3. **状态页出现在所有有服务端的产品里**（Cursor、Warp、Zed、Runway）。Harness 公开后有服务端（能力包签发、协作学习接收端），届时需要。
4. **VRChat 圈的「下载」是一次点击加仓库**（`vcc://` 或 ALCOM）。Harness 是桌面应用，公开版的下载页应写清平台、依赖与校验方式，这与它的「可验证」叙事一致。
5. **英 / 日双语在 VRChat 工具站里很常见**（Modular Avatar、Avatar Optimizer 都有 `/ja/`）。Harness 的受众包含日文圈，公开发布时应有日文版。
6. **默认主题以浅色为主**：12 家里只有 Zed 默认深色。Harness 当前 GUI 也是浅色，网站采用浅色默认、深色跟随系统，与产品和圈内站点都一致。
7. **首页文案的重心**：AI 工具主打 agent、速度与规模；VRChat 工具主打 non-destructive（非破坏）。「可以被验证」在两个圈子里都少见，是 Harness 该守住的差异点。
8. **品牌变动会留下痕迹**：Windsurf 被并入 Devin 后旧域名 308 跳转并用博客解释；Factory 与 Runway 都换了主域名。给 Harness 的启示是：域名与站点结构从一开始就定好，少改。
9. **抓取限制**：Devin、Luma 的页脚由 JS 渲染，首页抓不到法务链接，矩阵里标 ？，不代表没有。

## 四、Harness 站点地图建议

### 开发期（现在 → 首个开发版）

只做能兑现的页面，不做会引来「在哪下载 / 多少钱」的页面。

| 路径 | 内容 | 状态 |
|---|---|---|
| `/` | Coming Soon：一句话定位、开发状态、阶段路线、页脚声明 | 本轮已出稿 |
| `/product.html` | 已实现功能（配界面图）与明确标注的规划中 | 本轮已出稿 |
| `/articles/` | 开发日志列表页 + 文章（模板已出：`articles/demo.html`） | 列表页待做 |
| `/articles/<slug>.html` | 每次里程碑一篇：为什么这样设计、改了什么 | 按需 |
| 页脚 | 与 VRChat Inc.、pixiv（BOOTH）无隶属关系的声明；不收集数据的说明（站点无统计脚本） | 本轮已出稿 |
| 不做 | 价格、下载、企业、状态页、社区（仓库私有）、评价 | — |

### 公开发布

| 路径 | 内容 | 来源依据 |
|---|---|---|
| `/` | 首页：定位、核心机制、下载入口、最近更新 | 所有商业站 |
| `/product` | 功能总览（沿用现有产品页结构） | — |
| `/how-it-works` | 13 个阶段、冻结、独立判定、闸门的深入说明（可由开发日志升格） | Warp/Zed 的产品子页 |
| `/download` | Linux / Windows 安装包、校验和或签名、环境依赖清单（对应设置页） | VRChat 工具的一键安装 + 桌面应用惯例 |
| `/docs` | 安装、环境依赖、执行方登录、素材登记、能力包、项目记忆、FAQ、故障排除 | 所有 VRChat 工具站以文档为核心 |
| `/changelog` | 应用版本与能力包版本两条线 | Cursor/Warp/Zed/AAO |
| `/articles` | 博客 / 开发日志 | Cursor/Warp/Zed/Runway |
| `/security` | 沙箱、工作区外写入阻止、凭据对执行方不可见、能力包签名、协作学习的数据说明与退出方式 | Cursor/Warp/Runway 的 Security 页 |
| `/status` | 服务端状态（能力包签发、协作学习接收端） | 所有有服务端的产品 |
| `/community` | Discord / GitHub Discussions（若开放） | 全部 VRChat 工具站 |
| `/about` | 作者、项目状态、联系方式 | Zed/Warp |
| `/legal/privacy`、`/legal/terms`、`/legal/trademarks` | 隐私、条款、商标声明 | 全部商业站 |
| `/ja/` | 日文版：首页、产品、下载、文档要点 | Modular Avatar / Avatar Optimizer |
| 视情况 | `/pricing`：只有在确定有付费部分时才做；现在没有事实依据 | — |

## 五、来源

- https://cursor.com/
- https://devin.ai/ 、https://devin.ai/pricing 、https://devin.ai/sitemap.xml
- https://windsurf.com/ （跳转至 https://devin.ai/desktop）
- https://factory.ai/ （跳转至 https://factory.com/ ）、https://factory.com/sitemap.xml
- https://www.warp.dev/
- https://zed.dev/
- https://vcc.docs.vrchat.com/
- https://modular-avatar.nadena.dev/
- https://vrcfury.com/
- https://vpm.anatawa12.com/avatar-optimizer/en/
- https://runwayml.com/ （跳转至 https://runway.com/ ）
- https://lumalabs.ai/
- 未能抓取：https://www.krea.ai/ （header overflow）、https://www.midjourney.com/home （403）
