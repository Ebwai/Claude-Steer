# Knowledge_Guide — 参考资料索引

> 本文件是 Claude Driver 项目的知识地图。告诉你每类问题应该去哪里查资料。

---

## 一、项目核心文档

| 文件 | 路径 | 用途 |
|------|------|------|
| PRD（产品需求文档） | `PRD.md` | 功能需求、页面详述、原子功能清单（D.1–D.23）、验收标准 |
| 架构设计方案 | `架构.md` | DDD 建模、Clean Architecture 分层、目录结构、IPC 协议、版本兼容性 |
| 总体计划 | `plan/overall_plan.md` | M/S/T 三级计划、当前进度、架构选型理由 |
| 特殊知识地图 | `knowledge/Important_Info.md` | 与通识认知不同的关键点（避坑地图） |

---

## 二、UI 设计参考

| 文件 | 路径 | 对应页面 |
|------|------|---------|
| 全局监控页设计稿 | `UI设计 demo/global-monitor-page.html` | 全局监控页（M3） |
| 项目监控情形1 | `UI设计 demo/project_monitor_scene1.html` | 项目监控 · 单主线程 |
| 项目监控情形2 | `UI设计 demo/project_monitor_scene2.html` | 项目监控 · /branch 继承记忆 |
| 项目监控情形3 | `UI设计 demo/project_monitor_scene3.html` | 项目监控 · 多 Session 并行 |

> **说明**：HTML demo 仅作为美术风格参考，不代表需求的完整描述，需求以 PRD.md 为准。

---

## 三、参考项目（本地）

| 项目 | 路径 | 参考价值 |
|------|------|---------|
| claude-code-router | `参考资料/参考项目/claude-code-router/` | Claude Code 配置注入方式（settings.json）、statusLine 机制 |
| agent-flow | `参考资料/参考项目/agent-flow/` | 多 Agent 编排 UI 设计思路 |
| 飞书远程控制文档 | `参考资料/飞书远程控制CLAUDE_CODE.md` | cc-connect 飞书配置方法（M6 S3 参考） |

---

## 四、关键外部技术文档（按需联网查阅）

| 技术 | 查阅方向 |
|------|---------|
| electron-vite | 官方文档：主/渲染/Preload 三目标配置、native module externalize |
| @xyflow/react | API 文档：`useNodesState`、自定义节点、动态节点高度 |
| Jotai | `atom()` / `atomFamily()` / `useAtomValue()` / `store.set()` (Vanilla API for IPC bridge) |
| node-pty | Windows/Linux/macOS 差异、electron-rebuild 使用 |
| chokidar | `depth` 参数、跨平台 polling fallback |
| Claude Code Hooks | PRD 附录 B（事件类型速查） |
| Claude Code settings.json | PRD 附录 C（字段速查） |

---

## 五、查阅规则

1. **不知道某功能怎么实现** → 先查 `PRD.md` 附录 D（原子功能清单）
2. **不确定 UI 样式** → 打开对应 HTML demo，查看 CSS 变量和 class 命名
3. **遇到 Claude Code 机制问题** → 先查 `Important_Info.md`，再查 `参考资料/参考项目/claude-code-router/`
4. **遇到跨平台路径问题** → 查 `架构.md` 第 9 节（版本兼容性说明）
5. **遇到 Git 操作** → 查 `PRD.md` 附录 D.4（Git Manager 原子功能 G1–G9）
