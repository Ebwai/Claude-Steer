// 使用方法：import { PROVIDER_PRESETS, PROVIDER_PRESET_LIST } from '@shared/constants/providers'
// 编译说明：纯数据文件，无副作用，main 和 renderer 进程均可 import
// 代码说明：多供应商预设定义（参考 cc-switch 开源项目）
//           每个预设包含 Anthropic 兼容 API 的 base URL、默认模型映射等

import type { ProviderId, ProviderPreset } from '../types/index'

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (官方)',
    baseUrl: '',
    defaultModel: 'claude-sonnet-4-6',
    defaultLightModel: 'claude-haiku-4-5-20251001',
    defaultBalancedModel: 'claude-sonnet-4-6',
    defaultPowerfulModel: 'claude-opus-4-7',
    reasoningModel: '',
    requiresAuthToken: false,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-v4-pro',
    defaultLightModel: 'deepseek-v4-pro',
    defaultBalancedModel: 'deepseek-v4-pro',
    defaultPowerfulModel: 'deepseek-v4-pro',
    reasoningModel: 'deepseek-reasoner',
    requiresAuthToken: true,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/anthropic',
    defaultModel: 'anthropic/claude-sonnet-4-6',
    defaultLightModel: 'anthropic/claude-haiku-4-5',
    defaultBalancedModel: 'anthropic/claude-sonnet-4-6',
    defaultPowerfulModel: 'anthropic/claude-opus-4-7',
    reasoningModel: '',
    requiresAuthToken: true,
  },
  siliconflow: {
    id: 'siliconflow',
    label: 'SiliconFlow (硅基流动)',
    baseUrl: 'https://api.siliconflow.cn/v1/anthropic',
    defaultModel: 'Pro/deepseek-ai/DeepSeek-V3',
    defaultLightModel: 'Pro/deepseek-ai/DeepSeek-V3',
    defaultBalancedModel: 'Pro/deepseek-ai/DeepSeek-V3',
    defaultPowerfulModel: 'Pro/deepseek-ai/DeepSeek-V3',
    reasoningModel: 'Pro/deepseek-ai/DeepSeek-R1',
    requiresAuthToken: true,
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/anthropic',
    defaultModel: 'MiniMax-M1',
    defaultLightModel: 'MiniMax-M1',
    defaultBalancedModel: 'MiniMax-M1',
    defaultPowerfulModel: 'MiniMax-M1',
    reasoningModel: '',
    requiresAuthToken: true,
  },
  custom: {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    defaultModel: '',
    defaultLightModel: '',
    defaultBalancedModel: '',
    defaultPowerfulModel: '',
    reasoningModel: '',
    requiresAuthToken: true,
  },
}

/** 适用于下拉选择的有序列表 */
export const PROVIDER_PRESET_LIST: Array<{ id: ProviderId; label: string }> = [
  { id: 'anthropic',   label: 'Anthropic (官方)' },
  { id: 'deepseek',    label: 'DeepSeek' },
  { id: 'openrouter',  label: 'OpenRouter' },
  { id: 'siliconflow', label: 'SiliconFlow (硅基流动)' },
  { id: 'minimax',     label: 'MiniMax' },
  { id: 'custom',      label: '自定义' },
]
