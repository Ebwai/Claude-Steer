# CLAUDE_Steer

## 项目核心需求

见\docs\PRD.md和MRD.md

## 环境

目前开发是在ubuntu系统中，这个软件需要在windows,mac和ubuntu三平台都可用


## 项目重要文档

| 文件 | 位置 | 作用 |
|------|------|------|
| overall_plan.md | `plan\` | 母目标/子目标/任务的完整计划（MST结构）|
| codebase-index | `\.claude\skills\codebase-index`| 是可以被调用的skills，整个代码仓库的检索系统，查询代码和了解仓库必调用 |
| bug-fix | `\.claude\skills\bug-fix` | 是可以被调用的skills，当用户提到修改bug或类似表达，以及你识别出的bug时，必须使用这个skill|
| feature-add | `\.claude\skills\feature-add` | 是可以被调用的skills，当用户提到增加新功能或类似表达时，必须使用这个skill|
| 开发指南 |`\.claude\rules\开发指南.md` | 必须遵守的开发流程指引，关于各种情况下开发流程的规范化（比如，develop,feature,fix等等情况下的开发过程）|
| Important_Info.md | `knowledge\` | 项目特殊知识（与通识认知不同的关键点）|

## 规范

- Plan 管理规则见 `.claude/rules/plan-management.md`
- 搜索不要用web-search，调用any-search skills

## 在写代码时必须要遵守的点：
1. 在所有不确定和重要的点中必须添加输出日志到命令行中，方便定位问题

## 在思考时必须要遵守的点：
1. 假如有些信息你不太确定，严禁直接按照你猜测的点去制定计划或修改代码，只有确认真实信息了才可以制定计划或修改代码，遇到信息不确定的情况时先查找看能不能找到真实信息，假如找不到就立刻暂停询问用户或者在不确定的地方增加log输出点，实际运行得出真实信息，真实信息要及时更新到Important_Info中
2. 只要方向正确，且方向,结论,计划,修改都是基于真实的信息（不是靠猜测的来的）得出的，那就不要怕修改会涉及到很多地方，假如架构有错误也需要向用户提出来