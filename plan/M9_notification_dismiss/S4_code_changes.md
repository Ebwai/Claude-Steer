# M9 S4 — 修改代码

> **目标**：实现"聚合通知支持点击关闭"功能的代码修改
> **父计划**：M9 — 聚合通知支持点击关闭

---

## T1 — 新增 IPC 通道

**位置**：`claude-driver/src/shared/events/ipc-channels.ts`

**当前内容**：
```typescript
/** 权限请求审批（y/n + 可选附加信息 → PTY stdin） */
PERMISSION_RESPOND: 'permission:respond',
```

**需要修改的内容**：
在 `PERMISSION_RESPOND` 后面添加：
```typescript
/** 关闭权限请求（只更新角标，不发送按键） */
PERMISSION_DISMISS: 'permission:dismiss',
```

**修改原因**：
- 需要一个新的 IPC 通道来处理"关闭"操作
- 关闭操作与审批操作不同，只更新角标，不发送按键到 PTY

---

## T2 — 主进程处理逻辑

**位置**：`claude-driver/src/main/index.ts`

**当前内容**（第 1991-2023 行）：
```typescript
// ── 权限请求审批（M4 S2 T5）─────────────────────────────────────────────

ipcMain.handle(IPC.PERMISSION_RESPOND, async (
  _event,
  payload: { sessionId: string; ptySessionId: string; approved: boolean; message?: string }
) => {
  try {
    // 权限响应：Claude Code 权限提示为 TUI 选项型（默认聚焦 Yes）
    // 同意：直接回车；拒绝：方向键下×2 到 No + 回车；附加信息：Tab + 文字 + 回车
    // 逐个按键发送，每个之间 50ms 延迟（TUI 需要逐个处理按键事件）
    const keys: string[] = []
    if (!payload.approved) {
      keys.push('\x1b[B', '\x1b[B')  // Down×2: Yes -> Yes-don't-ask -> No
    }
    const withMessage = payload.message?.trim()
    if (withMessage) {
      keys.push('\t', withMessage, '\r')  // Tab + 文字 + Enter
    } else {
      keys.push('\r')  // 直接 Enter
    }
    console.log(`[ipc] permission:respond → session=${payload.ptySessionId} approved=${payload.approved} msg=${!!withMessage} keys=${keys.length} seq=${JSON.stringify(keys)}`)
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 50))
      ptyManager.rawWrite(payload.ptySessionId, keys[i])
      console.log(`[ipc]   key[${i}] sent (${keys[i].length} chars)`)
    }
    NotificationService.decrementBadge()
    return { ok: true }
  } catch (err) {
    console.error('[ipc] permission:respond failed:', err)
    return { ok: false, error: String(err) }
  }
})
```

**需要修改的内容**：
在 `PERMISSION_RESPOND` 处理后面添加：
```typescript
// ── 权限请求关闭（M9）─────────────────────────────────────────────────

ipcMain.handle(IPC.PERMISSION_DISMISS, async (
  _event,
  payload: { requestId: string }
) => {
  try {
    console.log(`[ipc] permission:dismiss → requestId=${payload.requestId}`)
    NotificationService.decrementBadge()
    return { ok: true }
  } catch (err) {
    console.error('[ipc] permission:dismiss failed:', err)
    return { ok: false, error: String(err) }
  }
})
```

**修改原因**：
- 需要处理新的 `IPC.PERMISSION_DISMISS` 通道
- 关闭操作只更新角标，不发送按键到 PTY
- 需要记录日志以便调试

---

## T3 — 消息通知界面修改

**位置**：`claude-driver/src/renderer/src/features/notifications/NotificationsPage.tsx`

**当前内容**（第 50-59 行）：
```typescript
{groupItems.map((req) => (
  <div
    key={req.requestId}
    className={`nfp-item${selectedId === req.requestId ? ' nfp-item--selected' : ''}`}
    onClick={() => onSelect(req.requestId)}
  >
    <span className="nfp-item-tool">{req.toolName}</span>
    <span className="nfp-item-desc">{req.description}</span>
  </div>
))}
```

**需要修改的内容**：
```typescript
{groupItems.map((req) => (
  <div
    key={req.requestId}
    className={`nfp-item${selectedId === req.requestId ? ' nfp-item--selected' : ''}`}
    onClick={() => onSelect(req.requestId)}
  >
    <span className="nfp-item-tool">{req.toolName}</span>
    <span className="nfp-item-desc">{req.description}</span>
    <button
      className="nfp-item-dismiss"
      onClick={(e) => {
        e.stopPropagation()
        onDismiss(req.requestId)
      }}
      title={t('notifications.dismiss')}
    >
      ✕
    </button>
  </div>
))}
```

**需要添加的 props**：
在 `NotificationListProps` 接口中添加：
```typescript
interface NotificationListProps {
  requests: PermissionRequest[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDismiss: (id: string) => void  // 新增
  bare?: boolean
}
```

**需要添加的处理函数**：
在 `NotificationsPage` 组件中添加：
```typescript
const handleDismissRequest = useCallback(async (requestId: string) => {
  try {
    await window.api.invoke(IPC.PERMISSION_DISMISS, { requestId })
    setRequests((prev) => prev.filter((r) => r.requestId !== requestId))
    setSelectedId((prev) => (prev === requestId ? null : prev))
    console.log(`[Notif] dismissed: ${requestId}`)
  } catch (err) {
    console.error('[Notif] PERMISSION_DISMISS failed:', err)
  }
}, [setRequests])
```

**需要更新的调用**：
在 `NotificationList` 组件调用处添加 `onDismiss` prop：
```typescript
<NotificationList
  requests={requests}
  selectedId={selectedId}
  onSelect={setSelectedId}
  onDismiss={handleDismissRequest}  // 新增
  bare
/>
```

**修改原因**：
- 需要在每个权限请求条目上添加"关闭"按钮
- 关闭按钮点击后调用 `IPC.PERMISSION_DISMISS` 通知主进程
- 从 atom 中移除请求，更新 UI

---

## T4 — 项目监控界面修改

**位置**：`claude-driver/src/renderer/src/features/project-monitor/RequestApprovalPanel.tsx`

**当前内容**（第 69-144 行）：
```typescript
return (
  <div className="rap-card">
    {/* 来源 + 操作描述 */}
    <div className="rap-header">
      <span className="rap-agent">{req.agentName}</span>
      <span className="rap-separator">{t('projectMonitor.approval.requestExecute')}</span>
      <span className="rap-tool">{req.toolName}</span>
    </div>
    <div className="rap-desc">{req.description}</div>

    {/* 附加信息输入框（点击按钮后展开） */}
    {showInput && (
      <div className="rap-input-area">
        <input
          className="rap-input"
          placeholder={t('projectMonitor.approval.additionalInfo')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleDecide(true)
            if (e.key === 'Escape') setShowInput(false)
          }}
          autoFocus
        />
      </div>
    )}

    {/* 操作按钮 */}
    <div className="rap-actions">
      {!showInput ? (
        <>
          <button
            className="rap-btn rap-btn--approve"
            onClick={handleApprove}
            disabled={!!pending}
          >
            {t('projectMonitor.approval.approve')}
          </button>
          <button
            className="rap-btn rap-btn--deny"
            onClick={handleDeny}
            disabled={!!pending}
          >
            {t('projectMonitor.approval.deny')}
          </button>
        </>
      ) : (
        <>
          <button
            className="rap-btn rap-btn--approve"
            onClick={() => void handleSendWithoutMessage(true)}
            disabled={!!pending}
          >
            {pending === 'approve' ? '…' : t('projectMonitor.approval.approve')}
          </button>
          {message.trim() && (
            <button
              className="rap-btn rap-btn--approve-msg"
              onClick={() => void handleDecide(true)}
              disabled={!!pending}
            >
              {t('projectMonitor.approval.approveWithMessage')}
            </button>
          )}
          <button
            className="rap-btn rap-btn--deny"
            onClick={() => void handleSendWithoutMessage(false)}
            disabled={!!pending}
          >
            {pending === 'deny' ? '…' : t('projectMonitor.approval.deny')}
          </button>
        </>
      )}
    </div>
  </div>
)
```

**需要修改的内容**：
在 `rap-card` 中添加"关闭"按钮：
```typescript
return (
  <div className="rap-card">
    {/* 来源 + 操作描述 */}
    <div className="rap-header">
      <span className="rap-agent">{req.agentName}</span>
      <span className="rap-separator">{t('projectMonitor.approval.requestExecute')}</span>
      <span className="rap-tool">{req.toolName}</span>
      <button
        className="rap-dismiss"
        onClick={handleDismiss}
        disabled={!!pending}
        title={t('projectMonitor.approval.dismiss')}
      >
        ✕
      </button>
    </div>
    <div className="rap-desc">{req.description}</div>

    {/* 附加信息输入框（点击按钮后展开） */}
    {showInput && (
      <div className="rap-input-area">
        <input
          className="rap-input"
          placeholder={t('projectMonitor.approval.additionalInfo')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleDecide(true)
            if (e.key === 'Escape') setShowInput(false)
          }}
          autoFocus
        />
      </div>
    )}

    {/* 操作按钮 */}
    <div className="rap-actions">
      {!showInput ? (
        <>
          <button
            className="rap-btn rap-btn--approve"
            onClick={handleApprove}
            disabled={!!pending}
          >
            {t('projectMonitor.approval.approve')}
          </button>
          <button
            className="rap-btn rap-btn--deny"
            onClick={handleDeny}
            disabled={!!pending}
          >
            {t('projectMonitor.approval.deny')}
          </button>
        </>
      ) : (
        <>
          <button
            className="rap-btn rap-btn--approve"
            onClick={() => void handleSendWithoutMessage(true)}
            disabled={!!pending}
          >
            {pending === 'approve' ? '…' : t('projectMonitor.approval.approve')}
          </button>
          {message.trim() && (
            <button
              className="rap-btn rap-btn--approve-msg"
              onClick={() => void handleDecide(true)}
              disabled={!!pending}
            >
              {t('projectMonitor.approval.approveWithMessage')}
            </button>
          )}
          <button
            className="rap-btn rap-btn--deny"
            onClick={() => void handleSendWithoutMessage(false)}
            disabled={!!pending}
          >
            {pending === 'deny' ? '…' : t('projectMonitor.approval.deny')}
          </button>
        </>
      )}
    </div>
  </div>
)
```

**需要添加的处理函数**：
在 `ApprovalCard` 组件中添加：
```typescript
const handleDismiss = useCallback(async () => {
  try {
    await window.api.invoke(IPC.PERMISSION_DISMISS, { requestId: req.requestId })
    onDone(req.requestId)
    console.log(`[ApprovalCard] dismissed: ${req.requestId}`)
  } catch (err) {
    console.error('[ApprovalCard] PERMISSION_DISMISS failed:', err)
  }
}, [req.requestId, onDone])
```

**需要更新的 props**：
在 `ApprovalCardProps` 接口中添加 `onDone` 的类型说明（已有，无需修改）。

**修改原因**：
- 需要在每个审批卡片上添加"关闭"按钮
- 关闭按钮点击后调用 `IPC.PERMISSION_DISMISS` 通知主进程
- 从 atom 中移除请求，更新 UI

---

## T5 — 更新 i18n 翻译文件

**位置**：`claude-driver/src/renderer/src/i18n/locales/zh-CN.json` 和 `en.json`

**需要添加的翻译**：

**zh-CN.json**：
```json
{
  "notifications": {
    "dismiss": "关闭",
    "projectMonitor.approval.dismiss": "关闭"
  }
}
```

**en.json**：
```json
{
  "notifications": {
    "dismiss": "Dismiss",
    "projectMonitor.approval.dismiss": "Dismiss"
  }
}
```

**修改原因**：
- 需要为"关闭"按钮添加翻译文本
- 支持中英文两种语言

---

## 执行步骤

1. 打开 `claude-driver/src/shared/events/ipc-channels.ts`
2. 在 `PERMISSION_RESPOND` 后面添加 `PERMISSION_DISMISS` 通道
3. 打开 `claude-driver/src/main/index.ts`
4. 在 `PERMISSION_RESPOND` 处理后面添加 `PERMISSION_DISMISS` 的处理逻辑
5. 打开 `claude-driver/src/renderer/src/features/notifications/NotificationsPage.tsx`
6. 修改 `NotificationListProps` 接口，添加 `onDismiss` prop
7. 修改 `NotificationList` 组件，添加"关闭"按钮
8. 在 `NotificationsPage` 组件中添加 `handleDismissRequest` 函数
9. 更新 `NotificationList` 组件调用，传入 `onDismiss` prop
10. 打开 `claude-driver/src/renderer/src/features/project-monitor/RequestApprovalPanel.tsx`
11. 在 `ApprovalCard` 组件中添加 `handleDismiss` 函数
12. 在 `rap-card` 中添加"关闭"按钮
13. 打开 i18n 翻译文件，添加"关闭"按钮的翻译文本
14. 运行 `npm run dev` 测试功能

---

## 验证标准

- `IPC.PERMISSION_DISMISS` 通道已添加到 `ipc-channels.ts`
- 主进程能处理 `PERMISSION_DISMISS` 事件，只更新角标
- 消息通知界面每个权限请求条目有"关闭"按钮，点击后通知消失
- 项目监控界面每个审批卡片有"关闭"按钮，点击后通知消失
- 角标计数正确更新（-1）
- i18n 翻译文件已更新
- 代码无 TypeScript 错误
