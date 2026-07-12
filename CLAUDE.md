# CLAUDE_Steer

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目核心需求

实现Claude Code的调度系统

## 环境

目前开发是在ubuntu系统中，这个软件需要在windows,mac和ubuntu三平台都可用


## 项目知识导航

| 文件 | 位置 | 作用 |
|------|------|------|
| overall_plan.md | `plan/` | 母目标/子目标/任务的完整计划（MST结构）|
| Knowledge_Guide.md | `knowledge/` | 所有参考资料的索引，告诉你从哪里查知识 |
| Important_Info.md | `knowledge/` | 项目特殊知识（与通识认知不同的关键点）|
| Code_Structure.md | 各功能模块目录下 | 架构图、流程图、模块代码说明 |
| 使用指南.md | 对应 M 计划目录下 | 每个母任务完整的运行使用说明 |

## 工作流程与规范

- 每次会话的工作流程见 `.claude/rules/workflow.md`（每次会话自动加载）
- Plan 管理规则见 `.claude/rules/plan-management.md`
- Important_Info 维护规则见 `.claude/rules/important-info.md`
- 代码规范见 `.claude/rules/code-standards.md`（编辑源码时自动加载）

## 在写代码时必须要遵守的点：
1. 在所有不确定和重要的点中必须添加输出日志到命令行中，方便定位问题

## 在思考时必须要遵守的点：
1. 假如有些信息你不太确定，严禁直接按照你猜测的点去制定计划或修改代码，只有确认真实信息了才可以制定计划或修改代码，遇到信息不确定的情况时先查找看能不能找到真实信息，假如找不到就立刻暂停询问用户或者在不确定的地方增加log输出点，实际运行得出真实信息，真实信息要及时更新到Important_Info中
2. 只要方向正确，且方向,结论,计划,修改都是基于真实的信息（不是靠猜测的来的）得出的，那就不要怕修改会涉及到很多地方，假如架构有错误也需要向用户提出来