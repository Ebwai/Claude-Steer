# T2 — settings.json 幂等合并注入 Hook 配置

## 技术原理

**原子写入防止文件损坏**：
- 写入 `~/.claude/settings.json` 时，先写入 `settings.json.tmp`，再 `fs.renameSync()` 替换原文件
- POSIX rename 是原子操作——要么完全替换，要么不替换，不会出现半截文件

**幂等合并**：
- 读取现有 `hooks` 字段，在对应事件类型（如 `PostToolUse`）的数组里查找是否已有 `type: "http", url: "...39521/hooks"` 的条目
- 若已存在则跳过（不重复添加），若不存在则 push 进去
- 只合并仪表盘自己的 Hook 条目，不触碰用户其他配置

**Hook 注册格式（Claude Code ≥2.1.x）**：
```json
{
  "hooks": {
    "PostToolUse": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:39521/hooks" }] }],
    "PreToolUse":  [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:39521/hooks" }] }]
    // ...其他 8 种事件类型
  }
}
```

## 原子步骤

### 步骤 1：创建 `src/main/lib/config/SettingsManager.ts`
- `readClaudeSettings()` — 读取 `~/.claude/settings.json`，不存在返回 `{}`
- `writeClaudeSettings(data)` — 原子写入（tmp + rename）
- `injectHookConfig(port)` — 幂等合并注入 9 种事件类型的 Hook
- `removeHookConfig(port)` — 移除仪表盘注入的 Hook 条目（应用退出时清理）

### 步骤 2：在 `src/main/index.ts` 中 `app.whenReady()` 后调用 `injectHookConfig`

### 步骤 3：在 `app.on('before-quit')` 中调用 `removeHookConfig`（可选，MVP 阶段可跳过）

## 验收标准

- [ ] `src/main/lib/config/SettingsManager.ts` 存在
- [ ] 多次调用 `injectHookConfig` 不产生重复条目
- [ ] `npm run typecheck:node` 通过
