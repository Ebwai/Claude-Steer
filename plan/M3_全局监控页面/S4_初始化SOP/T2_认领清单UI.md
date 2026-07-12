# T2 — 项目认领清单 UI（三态 1/0/-1，-1 默认）

## 技术原理

Jotai `projectsAtom` 持有 `Map<string, Project>`，`pendingProjectCountAtom` 派生计数。  
InitSopModal 在 App.tsx 层面控制显示：首次启动（projects.json 不存在）或有 claimStatus=0 的待确认项目时显示。  
三态逻辑：扫描结果默认 -1（忽略），用户点击 toggle 切换为 1（认领），确认后保存。

## 原子目标

- [x] InitSopModal.tsx：  
  - 首次启动模式：选择根目录 → 扫描 → 认领选择 → 确认  
  - 待确认模式：仅显示 claimStatus=0 的项目供用户处理  
- [x] 每条扫描结果：`path` + `name` + git 标识 + 忽略/认领 toggle（默认忽略）
- [x] 确认按钮：调用 `PROJECT_UPDATE` IPC 批量写入 claimStatus → 更新 `projectsAtom`
- [x] 跳过按钮：不扫描，直接关闭 modal（保留 -1 默认状态）
- [x] `pendingProjectCountAtom` 驱动底部标签页角标"N 待确认"

## 验收标准

打开 app（首次启动），InitSopModal 弹出；选择包含 CLAUDE.md 的目录并扫描；点击认领若干项目；确认后 modal 关闭，canvas 出现对应项目卡片，底部角标归零。
