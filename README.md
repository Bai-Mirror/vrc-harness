# Harness

VRChat 头像改模的 AI 工作台：你说明想要的造型，AI 执行制作；Harness 冻结制作过程、独立检查每一步，并在关键节点请你批准。

*English: Harness is an AI workbench for modding VRChat avatars. You describe the look you want; AI agents do the work
inside a sandbox; Harness freezes the process, checks every step independently, and asks you at the decisions that
matter.*

> 本仓库是 dev.0.1（`0.1.0-dev.1`）的源代码，与 [harness.nymiro.moe](https://harness.nymiro.moe/download.html) 提供的
> Windows 安装包是同一版本。这是首个技术预览：一套真实订单的头像已在本版上从原图跑到交付包，但还不能保证任意头像都能
> 自动做完。本版还做不到的事，见[已知限制](https://harness.nymiro.moe/known-limitations.html)。
>
> Harness 与 VRChat Inc.、pixiv（BOOTH）没有隶属关系，也未获其背书。

## 目录

| 位置 | 内容 |
|---|---|
| [`harness/`](harness) | 客户端：Runtime、命令行、终端界面、桌面界面（Tauri）、内置的知识与工具 |
| [`server/`](server) | harness.nymiro.moe 的发行下发与协作回传服务 |
| [`site/`](site) | 宣传网站 |

## 从源码运行

需要 Node 24 或更高版本。

```sh
cd harness
npm ci
npm run native:build        # 仅 Windows：编译辅助程序 avh-win.exe，需要 Rust
npm run build
node bin/avh.js deps        # 列出依赖状态
node bin/avh.js gui         # 或 node bin/avh.js tui
```

`npm test` 运行测试；需要 Unity 的测试默认跳过，Windows 上要先完成 `npm run native:build`。Windows 版的说明见 [`harness/docs/windows-handoff.md`](harness/docs/windows-handoff.md)。

## 许可证

代码采用 [MIT 许可证](LICENSE)；文档（仓库里所有 `*.md` 文件）采用 [CC BY-NC 4.0](LICENSE-docs.md)。第三方声明见 [NOTICE.md](NOTICE.md)。

## 反馈

项目咨询：harness@nymiro.moe
