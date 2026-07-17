# SOP：无代码新项目 → Architecture + TDD 文档体系

## 前置条件
- MRD + PRD 已通过 docs-generator skill 确认（`docs/MRD.md` + `docs/PRD.md`）
- block_sync 已部署在 `tools/block_sync/`，hideRule=selective + keepContent 白名单

## 流程（5 步，自底向上效率最大化）

### Step 1: 从 PRD 提取模块清单

1. 读 `docs/PRD.md`
2. 提取所有**概念**（concept）和**机制**（mechanism）的名称
3. 每个概念/机制记录：
   - 名称（与 PRD 一致，后续 Architecture/TDD 中保持不变）
   - 一句话职责
   - 依赖的其他概念/机制
4. 按 PRD 中的层级关系画出**概念依赖树**（哪些是上层模块、哪些是子模块）

输出：模块清单 `module-list`（含名称、职责、依赖）。

### Step 2: 建文档骨架 + 配 registry

1. **确定模块级边界**：基于 PRD 的概念层级，判定 Architecture 的终点和 TDD 的起点
2. **创建块文件目录**：`.claude/rules/architecture/` 下按模块层级镜像建文件夹
3. **创建块文件**：每个模块一个 `.md`，含 `paths` frontmatter（指向对应代码目录，即使代码尚未创建，预填预期路径）+ 占位内容 + 末尾指向下一级
4. **创建顶层汇总**：`docs/architecture.md` + `docs/TDD.md`（含手写占位 + 注册块占位）
5. **配 registry.json**：递归 aggregate 映射（architecture 链 + TDD 链），含 selective hideRule
6. **验证**：`python -m app.registry` 确认加载无误

### Step 3: 从叶子开始填 TDD（自底向上）

按依赖顺序（**无依赖的叶子模块先填**）：

1. 定位叶子模块（模块清单中最底层、不依赖其他模块的）
2. 按 `tdd-template.md` 写块内容：
   - **导航类**（内容保留，会级联传递）：模块架构图（mermaid）、模块概览（职责/输入/输出）、API 概览（接口设计草稿）
   - **细节类**（只留标题，AI 按需读原文）：数据模型、关键流程、状态机、异常处理、监控与测试
3. **每填完一组叶子** → `python tools/block_sync/start.py` 手动跑一次全量 sync（或保持 daemon 常驻），sync 自动级联更新中层。
4. 看到中层汇总有新内容后，继续填下一批模块（此时可以从中层开始，或者继续叶子）。

> **效率最大化点**：块同步让"填叶子 → 自动更新上层"无需手动维护。填完即可看到骨架，减少重复劳动。

### Step 4: 从下往上填 Architecture

叶子 TDD 内容就绪后，逐级向上填 Architecture：

1. **每级的 `### 内部组成`**：列出子模块名 + 各一句话作用（基于 TDD 中已写的模块概览提炼）
2. **每级的 `### 依赖与联动`**：描述本层内部的子模块依赖关系和通信方式（基于 TDD 中已写的接口依赖）
3. **每级的 `### 架构图`**：用 mermaid 画子模块依赖拓扑（节点=下级模块，边=依赖）
4. **每级的 `### 定位与职责`**：总结该级在整体架构中的位置
5. **每级的 `### 技术选型` + `### 非功能约束`**：有则写

每填完一级 → sync 自动级联到更上层。

### Step 5: 手写顶层内容

- `docs/architecture.md` 的 `## 整体架构`（手写）：设计理念、关键决策、全局技术选型总览、顶层模块依赖图（mermaid）
- `docs/TDD.md` 的 `## 概述`（手写）：设计原则、测试策略、统一规范

### 约束

- PRD 中的概念/机制名称 → Architecture/TDD 块文件的 `##` 标题保持**完全一致**
- 只描述下一级，不越级
- 块文件`###`标题不可改（hideRule 白名单锚点）
