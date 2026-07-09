<p align="center">
  <img src="assets/头图.png" alt="Claude Steer" width="100%">
</p>

<p align="center">
  <strong>一柄驾驭之舵，让人类将 AI 变为值得信赖的老伙伴</strong>
</p>

<p align="center">
  <a href="https://github.com/Ebwai/Claude-Steer/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg" alt="License"></a>
  <a href="https://github.com/Ebwai/Claude-Steer/releases"><img src="https://img.shields.io/github/v/release/Ebwai/Claude-Steer" alt="Latest Release"></a>
  <a href="https://github.com/Ebwai/Claude-Steer/releases"><img src="https://img.shields.io/github/downloads/Ebwai/Claude-Steer/total" alt="Downloads"></a>
  <a href="https://github.com/Ebwai/Claude-Steer"><img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform"></a>
  <br/>
  <img src="https://img.shields.io/badge/Electron-2C2C2C?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white" alt="Node.js">
</p>

<p align="center">
  <strong>中文</strong> | <a href="README.md">English</a>
</p>

---

## 什么是 Claude Steer?

Claude Steer 是一款跨平台桌面端 Harness AI 的辅助工具，它是：

- **一个工具** -- 像一柄驾驭之舵，使得人类可以驾驭 AI 变成一个可靠的老伙伴。我们知道 AI 在想什么，AI 也知道我们的操作并提供建议，也有一套高效的方式实现人与 AI（一群 AI）的双向交流交互。三平台均可使用：Windows、Linux (Ubuntu)、macOS
- **也是一个舞台** -- 现在的 v1 版本已经将毛坯舞台框架搭好了，但是目前还没有进行演出。未来会不断基于这个舞台引入更好的设备，演出优质的内容（因为目前里面并没有在框架中引入 Claude Code 以外的 Harness），未来的工作主要在于推送优质的"演出"，然后把舞台本身变得更好

> **说明**：当前 v1 是平台雏形，后续大版本将基于此框架逐步引入更丰富的能力与内容。
>
> 本项目在 Ubuntu 系统进行开发，并利用 Electron 框架结合一些平台的特性修改进行了多版本编译，所以在 Ubuntu 下对本软件的运行效果会最稳定。其中 macOS 版本因为应用签名的问题以及作者暂时没有 macOS 系统的电脑，暂时只支持源码下载编译运行的方式，未来会正式支持。

> **Why Claude Steer?** 在 AI Harness 还在探索阶段、没有形成范式的时候，我认为应该先找到一套有用的工具。就像你有 15 个箱子需要搬，在不知道怎么搬效率最好的时候，应该先考虑找一个合适的工具，而不是自己一个一个的搬。

>  介绍视频：痛点/需求-->新概念新机制详细介绍: https://www.bilibili.com/video/BV1MmMG6ME4J
>  实战演示demo1：https://www.bilibili.com/video/BV16uTR6gEof

---

## 目标用户

如果你正在使用 Claude Code（或计划使用），并且有以下任一需求，Claude Steer 可能适合你：

**工作流可视化**

- Claude Code 工作流程全程可视化
- 了解 Agent 的工作机制
- 学习汇聚了全人类智慧的 AI 是如何解决问题的

**多项目与多 Agent 管理**

- 多项目统筹管理
- 单项目深度管理
- 多 Agent 协同作业
- 多 Session 混乱治理
- 通知统一，保护心流

**计划、可靠性与效率**

- 三级 Plan 结构，防止 Agent 跑偏
- 幻觉识别与核验
- 上下文保持清洁
- 版本回滚，安全兜底
- 一键 Git，一键远程同步

**成本与配置**

- Token / 成本可量化
- 多 Provider 无缝切换
- Claude Code 配置直观管理

**紧跟前沿**

- 框架已就绪，可让你快速发现并迅速使用最新的 Agent 特性和能力（无论是 Claude Code 的新机制更新，还是你发现了某个 Skill 想立刻在项目中尝试）
- 精选高质量 AI 发展开源项目（cc-connect、openwolf、Skills、MCP Server 等）并持续推送更新
- 一键更新软件，无需复杂的手动删除更新

**复盘**

- 碎片化使用 Claude Code 时，很难手动整理交互过程形成系统性总结。Claude Steer 可以帮助自动复盘，总结经验，提升工作效率
- 多级分类的管理与可视化，方便你自己对历史交互进行回顾和复盘
- 万一 AI 犯了错，可以追溯到具体哪一步开始出错、怎么出的错

**远程**

- 远程操控 Claude Code（基于 [cc-connect](https://github.com/nicepkg/cc-connect)）


---

## 前置依赖

Claude Steer 启动时会自动检测以下依赖，缺失任意一项都会弹窗阻止进入主界面。

| 依赖 | 最低版本 | 说明 |
|:-----|:---------|:-----|
| **Node.js** | >= 18（推荐 22 LTS） | Claude Code CLI 运行时依赖；源码编译需 >= 22.12.0 |
| **npm** | 随 Node.js 自带 | 安装全局包和项目依赖 |
| **Git** | 任意现代版本 | 项目版本控制、Git 操作功能所需 |
| **Claude Code CLI** | 最新版本 | Claude Steer 的核心 -- 通过 PTY 驱动 Claude Code 进程 |

<details>
<summary><strong>各平台安装指南</strong></summary>

### Windows

```powershell
# Node.js（包含 npm）
winget install OpenJS.NodeJS.LTS

# Git
winget install Git.Git

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
```

### macOS

```bash
# Node.js
brew install node@22

# Git（通常随 Xcode Command Line Tools 一起安装）
xcode-select --install

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
```

> **说明**：从 Dock/Launchpad 启动时，Claude Steer 会自动读取你的 `.zshrc` / `.bash_profile` 来恢复完整 PATH，无需手动配置。

### Ubuntu / Debian

```bash
# Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Git
sudo apt-get install -y git

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
```

</details>

---

## 快速上手

### 方式一：预编译安装包（推荐）

从 [GitHub Releases](https://github.com/Ebwai/Claude-Steer/releases) 下载对应平台的安装包：

| 平台 | 文件 |
|:-----|:-----|
| Windows | `claude-steer-x.x.x-setup.exe` |
| Linux | `claude-steer-x.x.x.AppImage` |

```bash
# Linux：赋予执行权限并运行
chmod +x claude-steer-*.AppImage
./claude-steer-*.AppImage
```

### 方式二：从源码编译

```bash
git clone https://github.com/Ebwai/Claude-Steer.git
cd Claude-Steer/claude-driver
npm install
npm run dev
```

> `npm install` 会触发 `postinstall`，为当前 Electron 版本编译 `node-pty` 原生模块。需要 Node.js >= 22.12.0。

### 首次启动会发生什么？

1. **依赖检测** -- 逐项检查 Node.js、npm、Git 和 Claude Code CLI；缺少 CLI 时提供一键安装
2. **配置注入** -- 向 `~/.claude/settings.json` 写入 Hook 事件和 statusLine 桥接脚本（合并写入，不覆盖已有字段）
3. **日志初始化** -- 在 `~/.claude-steer/logs/` 下创建会话日志文件

---

## 架构

### 技术栈

| 层级 | 技术 |
|:-----|:-----|
| 语言/运行时 | TypeScript, Node.js |
| 框架 | Electron, React, Vite (electron-vite) |
| 可视化 | React Flow (@xyflow/react), Xterm.js |
| 状态管理 | Jotai |
| 国际化 | i18next |
| 测试 | Vitest, React Testing Library |
| 构建/打包 | electron-builder |
| CI/CD | GitHub Actions |

### 项目架构

本项目的架构经历过一次大的重构，为了实现一个适合Agent来阅读来更新的架构，如何用较少的token，就可以让Agent在有限的上下文窗口内对大项目进行阅读，索引，乃至遵循一些规范基于大型项目进行升级，以及过程中用于给人看的一些文档的自动生成，这些都是作者还在尝试的一些课题，目前公开的版本是删减一些用于Agent构建项目的内容，目前作者也在不断这一Agent介入开发的架构和流程范式，合适的时间并且验证成熟的时候会更新到本项目公开的代码中或者另开一个仓库
---

## 常见问题
>  目前版本的Claude Steer可能存在一些bug，但是软件设计了保底机制, 任何情况下点击历史工作面板每个主线框底下的打开终端就可以解决大部分可能的bug，因为这里打开的终端所有的视图和交互都原生自claude code，只要cc没有出现bug，还是可以正常回到工作的。并且claude steer中各种功能在设计上是尽可能解耦的，只要不是底层能力出现bug，在某一点出现bug之后大部分其他功能依然可以正常使用，由于初代版本是个人独立开发的产品，加上作者在开发的时候临近毕业，大量的事在同时并行，难免在开发claude steer的某些细节上留有一些非致命bug暂未修复，希望大家谅解，之后的版本更新会逐步解决。

### Claude Steer 发送指令后一直处于转圈状态且没有新的视觉输出

大概率是触发了新版本 Claude Code（>2.1.153）的特性：`AskUserQuestion` 被硬编码进交互流程，而非基于 Tool 机制触发。本软件暂时未对此特性进行适配。

**解决方式**：通过每个 Agent 面板下的"打开终端"按钮，使用 Claude Code 原生命令行操作。所有未适配的特性都可以通过此入口正常交互。

### macOS 从 Dock 启动后提示 "command not found"

macOS 从 Dock/Launchpad 启动的 GUI 应用只继承 launchd 的最小 PATH。Claude Steer 会自动读取你的 `.zshrc` 或 `.bash_profile` 来恢复完整 PATH。如果仍然找不到命令，尝试从终端启动：

```bash
open /Applications/claude-steer.app
```

### node-pty 加载失败

如果启动时报 "node-pty 未正确编译"：

```bash
cd claude-driver
npm run postinstall
npm run dev
```

### 端口 39521 被占用

Claude Steer 的 Hook Server 使用端口 39521。如果该端口被其他程序占用，启动时会弹窗提示。你可以在全局设置中修改端口号，应用会自动更新 Hook URL 和 statusLine 桥接脚本。

### Windows PowerShell 执行策略限制

Claude Steer 已在注册 statusLine 桥接脚本（`.ps1`）时使用 `-ExecutionPolicy Bypass` 参数，通常无需额外配置。

---

## 后记

本项目最初立项于 2026 年 4 月 4 日，正值清明节假期。原本计划最晚在五一劳动节前推出 v1 公开版本，但在制作过程中需求逐渐迸发。作者有点设计洁癖，假如想到了一个需求，并且优先级很高的需求，那么不在第一个v1版本推出就会浑身难受，就好像身上有根刺没有被拔掉一样。

最初只是因为学习了 Claude Code 官方文档后想做一个可视化工具应用学习成果，但随着自己使用vibe coding的时候经常用到claude code官网教程中的一些机制和概念，摸索出了这些机制和概念的使用场景和规律，又想去把claude code的常用机制按照应用场景放在它们该出现的地方，既提醒自己去使用，又可以提高交互的效率，于是决定把claude code的机制和概念抽了出来做成了交互，

之后随着在实习中高强度在真实业务场景下的vibe coding中我也逐渐对harness有了更深的认识和体会，于是抽出了一部分可以最快速提高vibe coding效率和规范的需求，引入了诸如三级plan，多个长期项目管理，单个项目的多agent管理，多session管理，多branch管理，甚至多subagent管理等等，项目的定位从最初的"可视化交互"逐渐演变为更偏向"工具"的定位。

因为作者也喜欢关注ai最新的一些进展，于是也收集了一些不错的给vibe coding（特别是claude code）使用的其他开源项目（比如cc-connect,openwolf，一些skills，mcp等等），也逐渐融入到了这个软件中

需求越做越多，我也低估了边实习，边考试，边毕业答辩，边找工作四线并行对空闲时间的挤压，期间也发生大大小小的一些随机不可控事情需要优先处理占用了原本分配给开发这个项目的时间，项目的代码最终在2026.6.1日才基本完成，之后又做了一些多平台分发，测试和适配修改，以及关于本项目如何推广的一些事情，最终在今天（2026.7.08）终于发布了首个正式版本。

说来也可笑，本来这个项目是为了设计一个框架融入我的学习和实践成果，但其实在开发这个项目的过程中也在不断的获取新的理论和实践体会，所以项目的需求越做越多的一部分原因也是在开发这个项目的本身所产生的，并且由于设计的初期我还没有形成自己对harness的范式认识，所以在过程中整个项目的架构也进行了一次巨大的重构（为了支持更庞大的设想，也为了让架构更加AI native，可以在未来的升级中利用有限上下文中和更少的 token 基于整个项目进行非破坏性遵循规范的升级开发，一个适合AI未来开发而不只是人类开发的架构），

需求越做越多，至今依然有很多设想没有被实现，但还是想尽快发布一个公开版本给大家一个选择，一个在harness还未形成的范式的时候可以用上的一个工具，一个可以提高自己的效率，可以和AI共同进步和双向反馈的不断积累的工具。于是发布了现在这个毛坯版本，希望这个项目能真的帮助到正在用agent提效（不管你是主动还是被动提效度dogae），我会持续更新和优化这个项目，但是作者最近比较忙，一个人的力量也是有限的，也依然处于学习的阶段，所以如果使用过程中遇到了一些bug或设计不成熟的地方希望可以谅解，如果可以提issue那就更好了，另外如果有志同道合的朋友也想一起参与这个项目，也欢迎联系我，或提交commit，之后有时间的时候，我会发出commit的规则。

最后，如果这个项目真的帮助到了您，希望可以给一个 **star**，或者给我一些鼓励，谢谢！

---

## License

本项目基于 [GNU General Public License v3.0 (GPLv3)](LICENSE) 开源。

如有合作需求或定制版本需要，请联系：tonygithub@163.com

作者也有一些基于本项目但超脱出本项目的一些关于 Agent 在智能眼镜上的想法，个人认为智能眼镜是最符合 Agent 落地到每个人生活中的最佳载体，如果有兴趣，也可以通过邮箱联系我

---

<p align="center">
  <a href="https://www.buymeacoffee.com/tonyleung" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" style="height: 60px !important;width: 217px !important;">
  </a>
</p>
