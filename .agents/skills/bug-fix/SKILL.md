---
name: bug-fix
description: "当用户提到修改bug或类似表达，以及你识别出的bug时，必须使用这个skill"
---

# Bug Fix Skill

## 触发条件

- 用户提到修改bug或类似表达
- 你识别出bug时

> 触发时必须确保已经阅读了"\.Codex\rules\开发指南.md"，并遵循其中的规范，本文是修改时的具体过程细节

## Bug Fix流程
无论是用户提到还是你自己发现了bug，都需要按照以下流程进行修改：
1. 按照plan-management.md的规则新增一个M计划，然后按实际情况制定修改计划，其中必须包括的S级别计划有：阅读并修改PRD中的对应内容，查找到对应的Architecture类和TDD类文档，修改Achitecture类和TDD类文档的对应内容，修改代码，验收收尾。中间可以按需插入所需的S级Plan或者T级别的Plan。
2. 找到PRD中有关bug的全部相关地方，找到后暂停告诉用户PRD中关于bug需要修改的所有点，以及解决方案，等待用户确认
3. 用户确认后，你找到PRD对应的Architecture文档（通过调用codebase-index知道如何找到对应Architecture部分），找到文档中关于bug的部分，找到后暂停告诉用户你找到bug对应的Architecture文档的脉络路径以及Architecture类文档中关于bug需要修改的所有点，以及Architecture文档中的相关部分打算如何修改，等待用户确认
4. 用户确认后，你找到Architecture对应的TDD文档（通过调用codebase-index知道如何找到对应TDD部分），找到文档中关于bug的部分，找到后暂停告诉用户你找到bug对应的TDD类文档的脉络路径以及Architecture类文档中关于bug需要修改的所有点，以及TTD类文档中的相关部分打算如何修改，等待用户确认
5. 找到所有所需的Architecture和TDD文档类并修改后，按照Architecture和TDD的对应要求开始修改代码
6. 在修改和实测过程中可能会有大大小小的和对应的Architecture类和TDD类的对应内容有不一样的地方，没有关系，按照你实际的修改和实测结果修改进行，并在验收收尾的S级plan中将对应的和原来Architecture类和TDD类文档不一样的地方给修改过来了，并告知用户

## 规则
bug的修复一定要注意不要影响到了其它与之有耦合的功能，你可以调用lsp和serena帮助你进行确认
bug的修复要遵循代码本身的架构设计和规范