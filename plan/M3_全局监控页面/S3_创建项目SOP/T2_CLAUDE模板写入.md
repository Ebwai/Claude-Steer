# T2 — CLAUDE.md 模板变量替换写入 + 项目 settings.json 权限配置

## 技术原理

在主进程 `PROJECT_CREATE` IPC 中完成文件写入：
1. 创建项目目录（若不存在）
2. 写入 `CLAUDE.md`（内置模板，替换 `{{PROJECT_NAME}}`, `{{CREATED_AT}}`, `{{DESCRIPTION}}`）
3. 写入 `.claude/settings.json`（设置 `permissionMode: "acceptEdits"`）
4. 调用 `upsertProject` 将项目写入 projects.json

CLAUDE.md 模板提供项目标准规范提示，帮助 Claude 理解项目结构。

## 原子目标

- [x] IPC `PROJECT_CREATE` 实现：接收 `{ name, path, description? }`
- [x] 创建目录 + 写 CLAUDE.md（内置模板 + 变量替换）
- [x] 创建 `.claude/settings.json`（含 `permissionMode: "acceptEdits"`）
- [x] `upsertProject` → projects.json 新增条目
- [x] 返回 `{ ok: true, project: Project }`

## CLAUDE.md 内置模板

```
# {{PROJECT_NAME}}

## 项目简介
{{DESCRIPTION}}

## 创建日期
{{CREATED_AT}}
```

## 验收标准

完成创建流程后，项目目录下存在 `CLAUDE.md` 和 `.claude/settings.json`；projects.json 中有对应记录；canvas 出现新项目卡片。
