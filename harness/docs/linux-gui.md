# Linux 桌面界面

> **生效范围：**2026-10-02 整理。本页描述 `avh gui` 与 Tauri 桌面包在 Linux 上的实际行为与构建入口；**只有成功的 `tauri:build` 才能证明该构建宿主上的 Rust 外壳与 Linux 包可用**，前三条命令都不构成原生产物证明。
>
> 平台差异与已实测限制见 [Windows 交接](windows-handoff.md)。用户可见文字一律简体中文，本页是唯一的英文遗留文档，已按决定 D-23 改写。

`avh gui` 是发行安全的入口：它启动或连接每用户 Runtime，把 HTTP 主机绑定到 `127.0.0.1`，生成随机会话令牌，并以应用模式打开已安装的 Chromium 浏览器。`avh gui install` 在不需 root 的前提下添加每用户桌面项。**关闭窗口不会停止已批准的背景工作。**

界面覆盖首次配置、项目与接管扫描、创建 Workflow、需求方案、可编辑的全局素材与项目内用途角色、人工批准、活动、在线 Provider 探测与核心健康、带回滚的配置更新校验、`doctor` 结果，以及安全暂停/继续。**TUI 与 GUI 共用同一套 Runtime API 与 SQLite 迁移；两者都不从界面代码直接打开数据库。**

配置变更保留高级 YAML 字段，接受前校验完整结果配置，失败时恢复原文件。**改目录不会搬动已有项目、状态或交付文件。**

## Tauri 2 打包

`src-tauri/` 下的原生外壳打包编译后的界面、生产 Node 依赖，以及构建时所用的确切 Node 运行时。它在随机回环端口上启动该私有界面主机，并随窗口一起结束。**Webview 不获得任何 Tauri IPC 权限**；业务改动仍走 Runtime 白名单。

在 Debian/Ubuntu 上先装 Tauri 2 构建前置与 Rust：

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
rustup default stable
npm ci
npm run tauri:build
```

预期产物是 `.deb` 与 `.AppImage`。`npm run desktop:prepare` 可单独运行，用于在 Rust 编译前验证自包含的 JS/Node 资源树。

兼容性发行构建用 `./scripts/build-linux-baseline.sh`：它在 Debian 12 内构建，校验声明的 GTK 依赖替代项与最大 GLIBC 需求，然后把耐久产物导出到 `release/linux-debian12/`。常规的 `npm run build` 与 `npm run check` 会替换 `dist/`，但**从不删除该发行目录**。当某个发行作业拥有自己的产物路径时，用 `AVH_RELEASE_OUTPUT` 指定替代目录。

## 发行检查

```sh
npm run check
npm run desktop:prepare
npm run tauri -- info
npm run tauri:build
```

如前所述：前三条命令都不构成原生产物证明。另见 [Windows 交接](windows-handoff.md) 中关于 Linux 打包已按决定 D-1 移出 dev.0.1 范围的说明。
