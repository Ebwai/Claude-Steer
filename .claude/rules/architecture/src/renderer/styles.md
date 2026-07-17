---
paths:
  - "claude-driver/src/renderer/src/styles/**/*"
---


<!-- parent: renderer -->

### 架构图

```mermaid
graph TD
    Tokens["tokens.css :root"] -->|var(--..)| Components["各组件 CSS"]
```

### 定位与职责

- **职责**：全局 CSS Design Token 系统（权威）。Anthropic 暖色暗主题 + 响应式排版/间距 + 动画。
- **边界**：仅 token 定义 + 全局 reset；组件级样式在各组件 .css。

### 内部组成

- **tokens.css**：`:root` 自定义属性（color bg0-bg4/orange --or/green/purple/red/blue status；响应式 typography `clamp()` 800-2560px；spacing；layout sizes/radii；shadows；pulse/blink keyframes；reset；scrollbar）。

### 依赖与联动

- **内部依赖**：被所有组件 CSS 经 `var(--...)` 引用。
- **通信方式**：CSS 自定义属性；主题切换经 `document.documentElement.dataset.theme`。
- **关键交互场景**：全局主题；响应式适配。

### 技术选型

CSS Custom Properties（原生，零运行时；支持动态主题切换）。

### 非功能约束

- **注意**：`assets/base.css` 定义了独立的 `--ev-c-*` 旧 token（electron-vite scaffold），`styles/tokens.css` 为权威系统；`assets/main.css` 同时引用两者，旧 token 多为遗留。

> 详情请阅读对应 TDD 块文件：`docs/TDD.md` § renderer § styles（`.claude/rules/tdd/src/renderer/styles.md`）
