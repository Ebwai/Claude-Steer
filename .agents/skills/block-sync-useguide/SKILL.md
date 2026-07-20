---
name: block-sync-useguide
description: "建立或维护代码库文件夹层级到递归文档体系的映射：Architecture 设计文档（遵循 architecture-template.md）和 TDD 技术设计文档（遵循 tdd-template.md）的块文件创建、同步、级联。触发：建立架构文档体系、生成块文件、递归文档同步、配置 block_sync、architecture rules、架构规则、TDD 块文件。"
---

# 块级文档同步 — 递归文档体系规则

> 工具位置：`tools/block_sync/`，守护进程：`python start.py`（或 `start.bat`）。
> 通用 API 规则见 `tools/block_sync/block_sync_readme.md`（字段/路径/配置/hideRule），本 skill 聚焦**递归文档体系**的组织规则。

## 1. 两套递归体系

```
Architecture (顶→模块级)          TDD (模块级→底)
     docs/architecture.md              docs/TDD.md
          ↑ 汇总                          ↑ 汇总
     [src.md 等块]                    [模块块文件]
          ↑ 汇总                          ↑ 汇总
     [下级块文件]                    [下级块文件]
          ...                              ...
     递归到 模块级 ←————→ 从模块级接手
```

| 体系 | 顶层汇总 | 递归方向 | 起始 | 终止 | hideRule |
|------|---------|---------|------|------|----------|
| Architecture | `docs/architecture.md` | 顶→下 | 代码库下一级文件夹 | **模块级** | selective |
| TDD | `docs/TDD.md` | 顶→下 | **模块级** | 叶子文件夹 | selective |

**模块级**：两体系交汇点。由 AI 综合 `架构.md` + `docs/PRD.md` + 代码结构判定，**不是固定层级**。判定后须用户确认。

## 2. 块文件组织

### 2.1 位置：镜像代码库目录

块文件放 `.Codex/rules/architecture/`，按代码库目录结构镜像建文件夹：

```
代码库:  Codex-driver/src/main/services/
规则镜像: .Codex/rules/architecture/src/main/services.md

代码库:  Codex-driver/src/renderer/
规则镜像: .Codex/rules/architecture/src/renderer.md
```

> 顶层 `docs/architecture.md` 和 `docs/TDD.md` 不在 `.Codex/rules/` 下（它们是汇总文档，不是 Codex rule）。

### 2.2 块文件格式（每个块文件 = Codex rule + block_sync 块）

```markdown
---
paths:
  - "<项目根相对路径>/**/*"
---

# <文件夹名>

## <下级文件夹名 1>
...（按对应 template 写）...

## <下级文件夹名 2>
...（按对应 template 写）...

---

> 模块详情请阅读 [<下一级文档路径>](<path>)
```

**规则**：
- **frontmatter `paths`**：指向该块对应的代码文件夹 glob（如 `Codex-driver/src/main/**/*`），相对项目根。**顶层 `architecture.md` 和 `TDD.md` 不加 paths frontmatter**。
- **内容**：每块只描述**下一级文件夹**（不越级）。每个下级文件夹是一个 `##` 块。
  - Architecture 体系块：每个下级文件夹按 `architecture-template.md` 写（职责、边界、依赖、组件交互、数据流、技术选型、非功能设计）。
  - TDD 体系块：每个下级文件夹按 `tdd-template.md` 写（模块概览、API、数据模型、时序/状态机/异常/监控/测试）。
- **末尾**：写 `> 模块详情请阅读 <path>`，指向下一级文档。叶子节点（模块级的最底层）写 `> 详情请阅读对应 TDD 块文件`。
- **`##` 标题**：用文件夹名（非全路径），与 PRD 中的名称对应。

### 2.3 内容模板约束

| 体系 | 模板来源 | 章节结构 |
|------|---------|---------|
| Architecture | `.Codex/skills/docs-generator/references/architecture-template.md` | Overall Architecture, Module Boundary, Component Interaction, Data Flow, Technology Selection, Non-functional Design |
| TDD | `.Codex/skills/docs-generator/references/tdd-template.md` | Module Overview, API, Data Model, Sequence, State Machine, Exception, Monitoring, Testing |

**写块内容前必须先阅读对应模板**（`architecture-template.md` 或 `tdd-template.md`），按章节结构填充。Architecture 不讨论 API/数据库细节（留 TDD），TDD 聚焦技术实现不讨论产品价值。

## 3. 递归 = 每文档既是上层块又是下层汇总

关键：文档 D 可以是 aggregate_A 的 sourceFile（A 的块），同时是 aggregate_B 的 summaryFile（B 的汇总）。

```
改 services.md（底层块）
  → sync: 写 main/services/main.md（中层，作为 TDD 下层汇总）
    → watcher 检测 main.md 变更（作为上层 sourceFile）
      → sync: 写 src/main/main.md（作为 Architecture 下层汇总？或更上级）
        → ... 链式向上
          → 最终更新 docs/architecture.md 或 docs/TDD.md（顶层，非 sourceFile，终止）
```

**级联自动发生**：改底层块 → 逐层自动向上同步，顶层终止。级联是单向链式，非死循环。

## 4. hideRule 配置：selective 模式

```json
{
  "config": {
    "hideRule": {
      "mode": "selective",
      "keepContent": [
        "架构图", "定位与职责", "内部组成", "依赖与联动",
        "模块架构图", "模块概览", "API 概览"
      ]
    }
  }
}
```

| 关键 | 说明 |
|------|------|
| `mode: "selective"` | 白名单 ### 段保留标题 + 正文；其余 ### 只留标题行隐藏正文 |
| `keepContent` | 白名单 ### 标题列表，支持部分匹配 |
| 效果 | 导航类内容随 sync 级联传递；细节类只留标题骨架，按需读原文 |

**分层**：
| 体系 | 导航类（内容保留，会级联传递） | 细节类（只留标题，读原文） |
|------|---------------------------|------------------------|
| Architecture | 架构图、定位与职责、内部组成、依赖与联动 | 技术选型、非功能约束 |
| TDD | 模块架构图、模块概览、API 概览 | 数据模型、关键流程、状态机、异常处理、监控与测试 |

## 5. 操作流程

### 5.1 完整 SOP

**根据项目类型选择对应 SOP**：

| 项目类型 | SOP 文档 | 适用于 |
|---------|---------|--------|
| 有代码 | [SOP-existing-project.md](references/SOP-existing-project.md) | 已有代码库 + PRD，需要探索代码、对照差异、填写文档 |
| 无代码 | [SOP-new-project.md](references/SOP-new-project.md) | 仅有 PRD，按设计填写文档，代码尚未开始 |

**两个 SOP 的核心流程**：

1. **识别模块级**：读 `架构.md` + `docs/PRD.md` + 代码库结构，AI 判定模块级边界，**用户确认**。
2. **建文档骨架**：
   - 创建 `docs/architecture.md` + `docs/TDD.md`（顶层汇总，无 frontmatter）。
   - 创建 `.Codex/rules/architecture/` 镜像目录与块文件（frontmatter paths + template 内容 + 末尾指向）。
3. **配 registry**：统一 selective hideRule + keepContent 白名单，递归 aggregate 映射。
4. **添加父类标记**：运行 `python tools/block_sync/scripts/add_parent_markers.py` 为所有块文件添加 `<!-- parent: xxx -->` 标记。
5. **启动守护进程**：`python tools/block_sync/start.py`。级联自动生效。
6. **维护**：改块文件 → 级联自动更新顶层汇总。块文件原文不被修改。

### 5.2 maxCascadeDepth 配置（控制级联深度）

**问题**：默认级联会将所有下级内容递归到顶层，导致顶层文档包含大量嵌套的 `##` 标题，违背"按需查看颗粒度"原则。

**解决方案**：在 `registry.json` 的 `config` 中添加 `maxCascadeDepth` 配置：

```json
{
  "config": {
    "hideRule": { ... },
    "maxCascadeDepth": 1
  }
}
```

| 值 | 效果 |
|----|------|
| `1` | 顶层文档只显示直接子级的 `##` 标题（推荐） |
| `2` | 显示两级嵌套 |
| `null` | 无限制，完全级联（默认，向后兼容） |

### 5.3 父类标记机制（<!-- parent: xxx -->）

**原理**：每个块文件在 frontmatter 之后添加 `<!-- parent: 父类名称 -->` 标记。过滤器根据标记判断 `##` 标题是否属于当前父级，只保留属于当前父级的 `##` 标题。

**自动添加脚本**：`tools/block_sync/scripts/add_parent_markers.py`

**何时运行**：
1. **首次建立文档体系时**（SOP 第 4 步）
2. **新增块文件后**（新文件需要添加标记）
3. **修改 registry.json 后**（父子关系可能变化）

**脚本原理**：
1. 读取 `registry.json`，从 `aggregate.blocks[].sourceFile` 推断父子关系
2. `summaryFile` = 父类 → 提取文件名作为父类名称（如 `lib.md` → `lib`）
3. 在每个子类块文件的 frontmatter 之后、第一个 `###` 之前插入 `<!-- parent: xxx -->`
4. 跳过已有标记的文件（幂等）

**执行命令**：
```bash
cd tools/block_sync
python scripts/add_parent_markers.py
```

**输出示例**：
```
[OK] src/main/lib/config.md -> parent: lib
[OK] src/main/lib/deps.md -> parent: lib
...
Summary: added=103, skipped=0, errors=0
```

### 5.4 重建脚本（清理残留 + 重新同步）

**何时使用**：
1. **历史遗留问题**：之前 daemon 运行时没有父类标记过滤，积累了重复的 `##` 标题
2. **大规模修改**：修改了 registry.json 或大量块文件后，需要重新同步整个文档链
3. **调试/验证**：确认文档层级是否正确

**执行命令**：
```bash
cd tools/block_sync
python scripts/rebuild_all.py
```

**脚本原理**：
1. **Phase 1**：清理所有中间文件（保留前言 + 重建 `##` 标题占位）
2. **Phase 2**：从叶子开始，bottom-up 重新同步所有块到父级
3. **Phase 3**：验证最终文档结构

**注意**：运行前需停止 daemon，运行后重启 daemon。

### 5.5 父类标记的工作原理

**过滤器逻辑**（`filter_by_cascade_depth` 函数）：

1. 解析内容，按 `## ` 标题分割
2. 对每个 `##` 标题，检查其 **subcontent 开头**（标题的下一行）是否有 `<!-- parent: xxx -->`
3. 如果提供了 `parent_title`（当前块的父类名称），只保留标记匹配的 `##` 标题
4. 标记不匹配的 `##` 标题及其内容被过滤掉

**示例**：
```markdown
## utils
<!-- parent: capabilities -->    ← 这个标记说明 utils 属于 capabilities
### 架构图
...
```

当 `capabilities.md` 同步到 `renderer.md` 时：
- `capabilities.md` 的父类是 `renderer`（从 `<!-- parent: renderer -->` 提取）
- `## utils` 的标记是 `<!-- parent: capabilities -->`
- `capabilities` ≠ `renderer` → `## utils` 被过滤掉
- 结果：`renderer.md` 的 `## capabilities` 部分不包含 `## utils`

## 6. 约束

- 每级只描述**下一级文件夹**，不越级。
- Architecture 不写 API/数据库细节（留 TDD），TDD 不写产品价值（已在 MRD/PRD）。
- 块文件原文不被 block_sync 修改（只过滤写入汇总的内容）。
- `##` 标题用文件夹名，**与 PRD 中的名称对应**。
- 代码块（```）内的 `#` 不会被 hideRule 误当标题（已内置处理）。
- 顶层两文档无 `paths` frontmatter（不是 Codex rule）。


## 7. Architecture 与 TDD 块文件 `###` 标题清单

selective hideRule：白名单 ### 段保留标题+正文（导航类），其余只留标题行（细节类）。

### Architecture 块文件（每代码文件夹一个块）

`##` = 下级文件夹名（如 `## main`、`## renderer`）

| `###` 标题 | 分类 | template 来源 | 说明 |
|-----------|------|-------------|------|
| `### 架构图` | **导航** | Overall Architecture | mermaid 图：该级子模块依赖拓扑 |
| `### 定位与职责` | **导航** | Module Boundary | 该文件夹在架构中的位置+核心职责 |
| `### 内部组成` | **导航** | — | 包含的子文件夹/模块列表+各自作用 |
| `### 依赖与联动` | **导航** | MB+CI+DF 三合一 | 内部子模块依赖关系+通信方式+数据流 |
| `### 技术选型` | 细节 | Technology Selection | 关键技术（有则写） |
| `### 非功能约束` | 细节 | Non-functional Design | 解耦/复用/扩展等（有则写） |

### TDD 块文件（每模块一个块）

`##` = 模块名（如 `## service-a`、`## lib-x`）

| `###` 标题 | 分类 | template 来源 | 说明 |
|-----------|------|-------------|------|
| `### 模块架构图` | **导航** | — | mermaid 图：该模块内部组件/文件依赖 |
| `### 模块概览` | **导航** | Module Overview | 职责、输入、输出 |
| `### API 概览` | **导航** | API | 关键接口签名列表 |
| `### 数据模型` | 细节 | Data Model | 涉及的表/结构名（字段细节读原文） |
| `### 关键流程` | 细节 | Sequence | 正常+异常流程步骤概要 |
| `### 状态机` | 细节 | State Machine | 如有，状态+转换规则 |
| `### 异常处理` | 细节 | Exception | 分类+降级+重试策略 |
| `### 监控与测试` | 细节 | Monitoring+Testing | 日志点+测试清单 |

## 8. AI 动作规则（必须严格遵守）

代码库的任何变更，AI **必须同步更新**对应的块文件。以下是具体映射：

### 8.1 Architecture 块文件

| 代码变更 | 必须更新的 `###` | 动作 |
|---------|-----------------|------|
| 新建文件夹/模块 | `### 内部组成` | 加入新条目的名称和一句话说明 |
| 删除文件夹/模块 | `### 内部组成` | 移除对应条目 |
| 移动/重命名文件夹 | `### 内部组成` + `### 架构图` | 更新名称 + 更新 mermaid 图 |
| 模块间依赖关系变化 | `### 依赖与联动` | 更新依赖描述和交互方式 |
| 引入/替换技术框架 | `### 技术选型` | 更新技术列表和选型理由 |
| 架构拓扑变化 | `### 架构图` | 更新 mermaid 图（节点和边） |

### 8.2 TDD 块文件

| 代码变更 | 必须更新的 `###` | 动作 |
|---------|-----------------|------|
| 新增/删除接口 | `### API 概览` | 更新接口签名列表 |
| 接口签名变化 | `### API 概览` | 更新对应接口的签名和返回值 |
| 模块职责/边界变化 | `### 模块概览` | 更新职责、输入、输出描述 |
| 新增/变更数据表 | `### 数据模型` | 更新表名和用途 |
| 流程变化 | `### 关键流程` | 更新流程步骤概要 |
| 组件/文件依赖变化 | `### 模块架构图` | 更新 mermaid 图 |

### 8.3 通用规则

- **每次代码变更后**，AI 必须检查上述映射表，更新所有受影响的块文件。
- **块文件改后**，block_sync 自动级联更新所有上层汇总。AI 不需要手动更新上层文档。
- **不确定是否要更新时**，默认更新——宁可多记不漏。
- `###` 标题**不可改**（它们是 hideRule 白名单锚点，也是级联骨架）。

