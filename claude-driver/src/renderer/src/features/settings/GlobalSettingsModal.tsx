// 使用方法：<GlobalSettingsModal open={bool} onClose={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局设置 Modal——复用通用 Modal 组件（width=640），
//           顶部横向 Tab 锚点导航 + 下方滚动内容区。
//           挂载时从主进程加载配置，卸载时自动取消。
//           各分区 onChange 回调收集变更，统一通过 IPC.CONFIG_WRITE 提交。

import { useState, useEffect, useRef, useCallback, type FC } from 'react'
import { useStore } from 'jotai'
import Modal from '../../components/Modal/Modal'
import { IPC } from '@shared/events/ipc-channels'
import type { DriverConfig, ProviderId } from '@shared/types/index'
import { setDriverConfig } from '../../capabilities/tokenCapability'
import { useT } from '../../i18n'
import ProviderSection from './sections/ProviderSection'
import LanguageSection from './sections/LanguageSection'
import PermissionsSection from './sections/PermissionsSection'
import TokenCostSection from './sections/TokenCostSection'
import NotificationSection from './sections/NotificationSection'
import PreferencesSection from './sections/PreferencesSection'
import MemorySection from './sections/MemorySection'
import StorageSection from './sections/StorageSection'
import AboutSection, { type UpdaterState } from './sections/AboutSection'
import './GlobalSettingsModal.css'

// ── 分区定义 ──────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'provider',    key: 'settings.tab.provider' },
  { id: 'language',    key: 'settings.tab.language' },
  { id: 'permissions', key: 'settings.tab.permissions' },
  { id: 'token-cost',  key: 'settings.tab.tokenCost' },
  { id: 'notification',key: 'settings.tab.notification' },
  { id: 'preferences', key: 'settings.tab.preferences' },
  { id: 'memory',      key: 'settings.tab.memory' },
  { id: 'storage',     key: 'settings.tab.storage' },
  { id: 'about',       key: 'settings.tab.about' },
] as const

type SectionId = typeof SECTIONS[number]['id']

// ── Claude settings 快照（只取用到的字段）────────────────────────────────────

interface ClaudeSettingsSnapshot {
  apiKey: string
  apiKeyHelper: string
  language: string
  permissionDefaultMode: string
  permissionAdditionalDirs: string[]
  permissionAllow: string[]
  ignorePatterns: string[]
  outputStyle: string
  syntaxHighlightingDisabled: boolean
  showThinkingSummaries: boolean
  spinnerTipsEnabled: boolean
  autoMemoryEnabled: boolean
  memoryDir: string
  cleanupPeriodDays: number
  // Provider 相关
  providerId: ProviderId
  providerBaseUrl: string
  providerModel: string
  providerLightModel: string
  providerBalancedModel: string
  providerPowerfulModel: string
  providerReasoningModel: string
  providerApiTimeoutMs: number
  providerDisableNonEssential: boolean
}

const CLAUDE_DEFAULTS: ClaudeSettingsSnapshot = {
  apiKey: '',
  apiKeyHelper: '',
  language: 'zh-CN',
  permissionDefaultMode: 'default',
  permissionAdditionalDirs: [],
  permissionAllow: [],
  ignorePatterns: [],
  outputStyle: 'Explanatory',
  syntaxHighlightingDisabled: false,
  showThinkingSummaries: false,
  spinnerTipsEnabled: true,
  autoMemoryEnabled: false,
  memoryDir: '',
  cleanupPeriodDays: 30,
  // Provider 默认
  providerId: 'anthropic',
  providerBaseUrl: '',
  providerModel: 'claude-sonnet-4-6',
  providerLightModel: 'claude-haiku-4-5-20251001',
  providerBalancedModel: 'claude-sonnet-4-6',
  providerPowerfulModel: 'claude-opus-4-7',
  providerReasoningModel: '',
  providerApiTimeoutMs: 60000,
  providerDisableNonEssential: false,
}

const DRIVER_DEFAULTS: DriverConfig = {
  tokenPriceInputPerM: 3.0,
  tokenPriceOutputPerM: 15.0,
  monthlyBudgetAlertUsd: 50,
  desktopNotificationsEnabled: true,
  themePreference: 'dark',
  uiLanguage: 'zh-CN',
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 从 env 块的 ANTHROPIC_BASE_URL 推断 providerId */
function detectProvider(env: Record<string, string>): ProviderId {
  const baseUrl = env.ANTHROPIC_BASE_URL || ''
  if (!baseUrl) return 'anthropic'
  if (baseUrl.includes('deepseek')) return 'deepseek'
  if (baseUrl.includes('openrouter')) return 'openrouter'
  if (baseUrl.includes('siliconflow')) return 'siliconflow'
  if (baseUrl.includes('minimax')) return 'minimax'
  return 'custom'
}

// ── 组件 ────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
}

const GlobalSettingsModal: FC<Props> = ({ open, onClose }) => {
  const store = useStore()
  const { t } = useT()
  const [activeSection, setActiveSection] = useState<SectionId>('provider')
  const [claude, setClaude] = useState<ClaudeSettingsSnapshot>(CLAUDE_DEFAULTS)
  const [driver, setDriver] = useState<DriverConfig>(DRIVER_DEFAULTS)
  const [appVersion, setAppVersion] = useState('—')
  const [updaterState, setUpdaterState] = useState<UpdaterState>({ status: 'idle' })
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  // 导出/导入状态
  const [exportMsg, setExportMsg] = useState('')
  const [importMsg, setImportMsg] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)

  // ── 挂载时加载配置 ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    console.log('[GlobalSettingsModal] Loading config...')

    const load = async (): Promise<void> => {
      try {
        // 读 driver config + 版本号
        const dr = await window.api.invoke(IPC.DRIVER_CONFIG_READ) as DriverConfig & { appVersion?: string }
        const { appVersion: ver, ...driverFields } = dr
        const mergedDriver = { ...DRIVER_DEFAULTS, ...driverFields }
        setDriver(mergedDriver)
        // 同步到 renderer atom，供费用派生计算使用
        setDriverConfig(store, mergedDriver)
        if (ver) setAppVersion(ver)

        // 读 settings.json 中的 env 块（provider 配置）
        try {
          const providerEnv = await window.api.invoke(IPC.PROVIDER_CONFIG_READ) as Record<string, string>
          if (providerEnv && Object.keys(providerEnv).length > 0) {
            // 从 env 块反向推断 providerId
            const detectedId = detectProvider(providerEnv)
            setClaude(prev => ({
              ...prev,
              apiKey: providerEnv.ANTHROPIC_AUTH_TOKEN || providerEnv.ANTHROPIC_API_KEY || '',
              providerId: detectedId,
              providerBaseUrl: providerEnv.ANTHROPIC_BASE_URL || '',
              providerModel: providerEnv.ANTHROPIC_MODEL || '',
              providerLightModel: providerEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
              providerBalancedModel: providerEnv.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
              providerPowerfulModel: providerEnv.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
              providerReasoningModel: providerEnv.ANTHROPIC_REASONING_MODEL || '',
              providerApiTimeoutMs: parseInt(providerEnv.API_TIMEOUT_MS || '60000') || 60000,
              providerDisableNonEssential: providerEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1',
            }))
          }
        } catch { /* provider env 读取失败，使用默认 */ }

        // 读 settings.json 中的非分组字段（语言/权限/记忆/偏好等）
        try {
          const rawClaude = await window.api.invoke(IPC.CLAUDE_SETTINGS_READ) as Record<string, unknown>
          if (rawClaude && typeof rawClaude === 'object') {
            setClaude(prev => ({ ...prev, ...rawClaude as Partial<ClaudeSettingsSnapshot> }))
          }
        } catch { /* claude settings 读取失败，使用默认 */ }

        console.log('[GlobalSettingsModal] Config loaded:', { driverFields, ver })
      } catch (err) {
        console.error('[GlobalSettingsModal] Failed to load config:', err)
      }
    }

    void load()
  }, [open])

  // ── 监听更新状态推送 ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return

    const unsub = window.api.on(IPC.UPDATER_STATE_CHANGED, (payload: unknown) => {
      console.log('[GlobalSettingsModal] Updater state:', payload)
      const state = payload as UpdaterState
      setUpdaterState(state)

      // "已是最新" 或 "下载完成" 不自动重置，由 AboutSection 中的 UI 逻辑控制
    })

    return () => {
      unsub()
      // modal 关闭时重置更新状态
      setUpdaterState({ status: 'idle' })
    }
  }, [open])

  // ── 更新操作 ──────────────────────────────────────────────────────────────
  const handleCheckUpdate = useCallback(() => {
    void window.api.invoke(IPC.UPDATER_CHECK)
  }, [])

  const handleDownloadUpdate = useCallback(() => {
    void window.api.invoke(IPC.UPDATER_DOWNLOAD)
  }, [])

  const handleQuitAndInstall = useCallback(() => {
    void window.api.invoke(IPC.UPDATER_QUIT_AND_INSTALL)
  }, [])

  // ── 变更收集 ──────────────────────────────────────────────────────────────
  const handleChange = useCallback((scope: 'claude' | 'driver', key: string, value: unknown): void => {
    if (scope === 'driver') {
      setDriver((prev) => ({ ...prev, [key]: value }))
    } else {
      // 处理嵌套 key（如 permissions.defaultMode）
      setClaude((prev) => {
        const flat = { ...prev }
        if (key === 'permissions.defaultMode') flat.permissionDefaultMode = value as string
        else if (key === 'permissions.additionalDirectories') flat.permissionAdditionalDirs = value as string[]
        else if (key === 'permissions.allow') flat.permissionAllow = value as string[]
        else (flat as Record<string, unknown>)[key] = value
        return flat
      })
    }
  }, [])

  // ── 保存 ──────────────────────────────────────────────────────────────────
  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setSaveMsg('')
    console.log('[GlobalSettingsModal] Saving settings...')
    try {
      // 逐字段写入 driver config
      const driverEntries = Object.entries(driver) as [keyof DriverConfig, unknown][]
      for (const [key, value] of driverEntries) {
        await window.api.invoke(IPC.CONFIG_WRITE, { scope: 'driver', key, value })
      }
      // 逐字段写入 claude settings
      const claudeMap: Record<string, unknown> = {
        apiKey: claude.apiKey,
        apiKeyHelper: claude.apiKeyHelper,
        language: claude.language,
        outputStyle: claude.outputStyle,
        syntaxHighlightingDisabled: claude.syntaxHighlightingDisabled,
        showThinkingSummaries: claude.showThinkingSummaries,
        spinnerTipsEnabled: claude.spinnerTipsEnabled,
        autoMemoryEnabled: claude.autoMemoryEnabled,
        memoryDir: claude.memoryDir,
        cleanupPeriodDays: claude.cleanupPeriodDays,
        ignorePatterns: claude.ignorePatterns,
        'permissions.defaultMode': claude.permissionDefaultMode,
        'permissions.additionalDirectories': claude.permissionAdditionalDirs,
        'permissions.allow': claude.permissionAllow,
      }
      for (const [key, value] of Object.entries(claudeMap)) {
        await window.api.invoke(IPC.CONFIG_WRITE, { scope: 'claude', key, value })
      }
      // 写入 provider env 块（非 Anthropic 时构建完整 env，Anthropic 时传空对象触发清空）
      const providerEnv: Record<string, string> = {}
      if (claude.providerId !== 'anthropic') {
        if (claude.providerBaseUrl) providerEnv.ANTHROPIC_BASE_URL = claude.providerBaseUrl
        if (claude.apiKey) providerEnv.ANTHROPIC_AUTH_TOKEN = claude.apiKey
        if (claude.providerModel) providerEnv.ANTHROPIC_MODEL = claude.providerModel
        if (claude.providerLightModel) providerEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = claude.providerLightModel
        if (claude.providerBalancedModel) providerEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = claude.providerBalancedModel
        if (claude.providerPowerfulModel) providerEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = claude.providerPowerfulModel
        if (claude.providerReasoningModel) providerEnv.ANTHROPIC_REASONING_MODEL = claude.providerReasoningModel
        providerEnv.API_TIMEOUT_MS = String(claude.providerApiTimeoutMs)
        if (claude.providerDisableNonEssential) providerEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
      }
      console.log('[GlobalSettingsModal] Writing provider env:', Object.keys(providerEnv))
      await window.api.invoke(IPC.PROVIDER_CONFIG_WRITE, { env: providerEnv })
      // 保存成功后同步 driverConfig 到 renderer atom（价格修改即时生效）
      setDriverConfig(store, driver)
      setSaveMsg(t('settings.saved'))
      console.log('[GlobalSettingsModal] Settings saved successfully')
    } catch (err) {
      console.error('[GlobalSettingsModal] Save failed:', err)
      setSaveMsg(t('settings.saveFailed') + String(err))
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 3000)
    }
  }

  // ── 导出配置 ──────────────────────────────────────────────────────────────
  const handleExport = async (): Promise<void> => {
    setExportMsg('')
    const targetPath = await window.api.invoke(IPC.DIALOG_SAVE_FILE, {
      defaultName: 'claude-steer-config.json',
    }) as string | null
    if (!targetPath) return
    const result = await window.api.invoke(IPC.CONFIG_EXPORT, { targetPath }) as { ok: boolean; error?: string }
    setExportMsg(result.ok ? t('settings.exportSuccess') : t('settings.exportFailed') + result.error)
    setTimeout(() => setExportMsg(''), 3000)
  }

  // ── 导入配置 ──────────────────────────────────────────────────────────────
  const handleImport = async (): Promise<void> => {
    setImportMsg('')
    const sourcePath = await window.api.invoke(IPC.DIALOG_OPEN_FILE, {
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }) as string | null
    if (!sourcePath) return
    const result = await window.api.invoke(IPC.CONFIG_IMPORT, { sourcePath }) as { ok: boolean; error?: string }
    if (result.ok) {
      // 重新加载 driver config
      const dr = await window.api.invoke(IPC.DRIVER_CONFIG_READ) as DriverConfig & { appVersion?: string }
      const { appVersion: ver, ...driverFields } = dr
      setDriver({ ...DRIVER_DEFAULTS, ...driverFields })
      if (ver) setAppVersion(ver)
      setImportMsg(t('settings.importSuccess'))
    } else {
      setImportMsg(t('settings.importFailed') + result.error)
    }
    setTimeout(() => setImportMsg(''), 4000)
  }

  // ── Tab 点击滚动 ──────────────────────────────────────────────────────────
  const scrollToSection = (id: SectionId): void => {
    setActiveSection(id)
    const el = scrollRef.current?.querySelector(`#gsm-section-${id}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('settings.title')}
      width={640}
    >
      {/* 顶部 Tab 锚点导航（sticky，吸附在 modal-body 滚动容器顶部） */}
      <div className="gsm-tabs">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`gsm-tab ${activeSection === s.id ? 'gsm-tab--active' : ''}`}
            onClick={() => scrollToSection(s.id)}
          >
            {t(s.key)}
          </button>
        ))}
      </div>

      {/* 内容滚动区 */}
      <div ref={scrollRef}>

        {/* Provider */}
        <section id="gsm-section-provider" className="gsm-section">
          <div className="gsm-section-title">{t('settings.section.provider')}</div>
          <ProviderSection
            providerId={claude.providerId}
            apiKey={claude.apiKey}
            providerBaseUrl={claude.providerBaseUrl}
            providerModel={claude.providerModel}
            providerLightModel={claude.providerLightModel}
            providerBalancedModel={claude.providerBalancedModel}
            providerPowerfulModel={claude.providerPowerfulModel}
            providerReasoningModel={claude.providerReasoningModel}
            providerApiTimeoutMs={claude.providerApiTimeoutMs}
            providerDisableNonEssential={claude.providerDisableNonEssential}
            onChange={handleChange}
          />
        </section>

        {/* 语言 */}
        <section id="gsm-section-language" className="gsm-section">
          <div className="gsm-section-title">{t('settings.section.language')}</div>
          <LanguageSection language={claude.language} onChange={handleChange} />
        </section>

        {/* 权限 */}
        <section id="gsm-section-permissions" className="gsm-section">
          <div className="gsm-section-title">{t('settings.section.permissions')}</div>
          <PermissionsSection
            defaultMode={claude.permissionDefaultMode}
            additionalDirectories={claude.permissionAdditionalDirs}
            allowList={claude.permissionAllow}
            ignorePatterns={claude.ignorePatterns}
            onChange={handleChange}
          />
        </section>

        {/* Token 费用 */}
        <section id="gsm-section-token-cost" className="gsm-section">
          <div className="gsm-section-title">{t('settings.section.tokenCost')}</div>
          <TokenCostSection driverConfig={driver} onChange={handleChange} />
        </section>

        {/* 通知 */}
        <section id="gsm-section-notification" className="gsm-section">
          <div className="gsm-section-title">{t('settings.section.notification')}</div>
          <NotificationSection driverConfig={driver} onChange={handleChange} />
        </section>

        {/* 偏好 */}
        <section id="gsm-section-preferences" className="gsm-section">
          <div className="gsm-section-title">{t('settings.section.preferences')}</div>
          <PreferencesSection
            claudePrefs={{
              outputStyle: claude.outputStyle,
              syntaxHighlightingDisabled: claude.syntaxHighlightingDisabled,
              showThinkingSummaries: claude.showThinkingSummaries,
              spinnerTipsEnabled: claude.spinnerTipsEnabled,
            }}
            driverConfig={driver}
            onChange={handleChange}
          />
        </section>

        {/* 记忆 */}
        <section id="gsm-section-memory" className="gsm-section">
          <div className="gsm-section-title">{t('settings.section.memory')}</div>
          <MemorySection
            autoMemoryEnabled={claude.autoMemoryEnabled}
            memoryDir={claude.memoryDir}
            onChange={handleChange}
          />
        </section>

        {/* 存储 */}
        <section id="gsm-section-storage" className="gsm-section">
          <div className="gsm-section-title">{t('settings.section.storage')}</div>
          <StorageSection
            cleanupPeriodDays={claude.cleanupPeriodDays}
            driverConfig={driver}
            onChange={handleChange}
            onCheckUpdate={handleCheckUpdate}
          />
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="gsm-btn" onClick={handleExport}>{t('settings.export')}</button>
            <button className="gsm-btn" onClick={handleImport}>{t('settings.import')}</button>
            {exportMsg && <span className={`gsm-status ${exportMsg.startsWith('✓') ? 'gsm-status--ok' : 'gsm-status--err'}`}>{exportMsg}</span>}
            {importMsg && <span className={`gsm-status ${importMsg.startsWith('✓') ? 'gsm-status--ok' : 'gsm-status--err'}`}>{importMsg}</span>}
          </div>
        </section>

        {/* 关于 */}
        <section id="gsm-section-about" className="gsm-section">
          <div className="gsm-section-title">{t('settings.section.about')}</div>
          <AboutSection
            appVersion={appVersion}
            updaterState={updaterState}
            onCheckUpdate={handleCheckUpdate}
            onDownloadUpdate={handleDownloadUpdate}
            onQuitAndInstall={handleQuitAndInstall}
          />
        </section>

      </div>

      {/* 底部保存栏 */}
      <div style={{
        marginTop: 16,
        paddingTop: 12,
        borderTop: '1px solid var(--bd)',
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        justifyContent: 'flex-end',
      }}>
        {saveMsg && (
          <span className={`gsm-status ${saveMsg.startsWith('✓') ? 'gsm-status--ok' : 'gsm-status--err'}`}>
            {saveMsg}
          </span>
        )}
        <button className="gsm-btn" onClick={onClose}>{t('settings.cancel')}</button>
        <button className="gsm-btn gsm-btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
      </div>
    </Modal>
  )
}

export default GlobalSettingsModal
