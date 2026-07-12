# T1-T3 — Plugins 面板实现（合并）

## 技术原理

Plugins 面板从全局监控左半画板左下角浮动按钮组的「🧩 Plugins」按钮触发，
点击后右半配置面板**替换**为 Plugins 界面（覆盖原有配置面板）。

Plugin 状态通过读取 `~/.claude/settings.json` 的 `enabledPlugins` 字段获取。

### Plugin 数据结构

```typescript
interface PluginInfo {
  id: string
  name: string
  version?: string
  description?: string
  scenarios?: string[]        // 应用场景列表
  mcpServers?: string[]       // 包含的 MCP servers
  skills?: string[]           // 包含的 Skills
  hooks?: string[]            // 包含的 Hooks
  subagents?: AgentConfig[]   // 包含的 Subagents（来自 plugin 的 agents/ 目录）
}
```

## 实现步骤

### 原子目标 T1 — 已安装 Plugin 列表 + 删除 [ ]
文件：`src/renderer/src/features/plugins/PluginsPanel.tsx`

**读取已安装 Plugin（PL1）**：
- `IPC.PLUGINS_LIST`：读取 `~/.claude/settings.json` 的 `enabledPlugins` 字段
- 同时扫描 Plugin 安装目录（未来：`~/.claude/plugins/`），合并展示

**列表 UI**：
- 每个 Plugin 卡片：Plugin 名称 + 版本号（如有）+ 简短描述
- 右上角 ✕ 删除按钮（`IPC.PLUGIN_DELETE`）：从 `enabledPlugins` 中移除该 Plugin
- 点击卡片主体 → 显示 Plugin 详情（右侧面板）

**右上角关闭按钮（✕）**：
- 点击 → 退出 Plugins 界面，恢复原配置面板

### 原子目标 T2 — Plugin 详情展示（PL4）[ ]
文件：`src/renderer/src/features/plugins/PluginDetail.tsx`

- 当用户点击某个 Plugin 卡片时，在右侧区域（或替换整个 Plugins Panel 右半）显示详情
- 内容：
  - **应用场景**：`scenarios` 数组，每条一行
  - **包含组件**：
    - MCP 服务器：`mcpServers` 数组
    - Skills：`skills` 数组
    - Hooks：`hooks` 数组
    - Subagents：`subagents` 数组（卡片展示）
  - 关闭按钮（返回 Plugin 列表）

### 原子目标 T3 — 添加 Plugin 按钮（第一阶段）[ ]

**添加按钮 UI**：
- 「＋ 添加 Plugin」按钮，样式与其他添加按钮一致（细边框）
- 点击后：弹出内层 Modal，内容：「还在开发中，敬请期待」
- **不执行任何安装操作，不调用任何 API**

**精品推荐区域**：
- 预留空白区域（含「精品推荐（即将上线）」占位文字）

## 新增 IPC 通道

- `PLUGINS_LIST` (invoke): `{}` → `{ plugins: PluginInfo[] }`
- `PLUGIN_DELETE` (invoke): `{ pluginId }` → `{ ok }`
- `PLUGIN_DETAIL` (invoke): `{ pluginId }` → `PluginInfo`

## 验收标准

- 点击「🧩 Plugins」：右半面板替换为 Plugins 界面
- 已安装 Plugin 列表正确显示（来自 `enabledPlugins` 字段）
- 点击 Plugin 卡片：右侧显示详情（应用场景/MCP/Skills/Hooks）
- 点击删除（✕）：Plugin 从列表消失，`enabledPlugins` 字段更新
- 点击「＋ 添加 Plugin」：显示「还在开发中」提示
- 点击面板右上角关闭（✕）：恢复原配置面板
