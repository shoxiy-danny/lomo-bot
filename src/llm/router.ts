/**
 * LLM Router — 根据模型名路由到对应 provider
 */

import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse } from './types'
import { agnesProvider } from './agnes'
import { claudeProvider } from './claude'
import { deepseekProvider } from './deepseek'
import { mimoProvider } from './mimo'
import { minimaxProvider } from './minimax'

// provider 注册表
const PROVIDERS: LLMProvider[] = [
  agnesProvider,
  claudeProvider,
  deepseekProvider,
  mimoProvider,
  minimaxProvider,
]

// 模型名 → provider 映射
function findProvider(model: string): LLMProvider {
  for (const p of PROVIDERS) {
    if (p.listModels().includes(model)) return p
  }
  // Claude 模型支持任何 claude-* 前缀
  if (model.startsWith('claude-')) return claudeProvider
  // GPT 用 deepseek 的 OpenAI 兼容格式（需切换 baseURL，暂不支持）
  if (model.startsWith('gpt-')) throw new Error('GPT 模型暂未接入，请使用 Claude/DeepSeek/MiMo/MiniMax')
  throw new Error(`未知模型: ${model}，可用: ${PROVIDERS.flatMap(p => p.listModels()).join(', ')}`)
}

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<ChatResponse> {
  const provider = findProvider(options.model)
  return provider.chat(messages, options)
}

export function getProvider(model: string): LLMProvider {
  return findProvider(model)
}

export function listAllModels(): string[] {
  return PROVIDERS.flatMap(p => p.listModels())
}
