/**
 * Anthropic Claude API Provider（支持 prompt caching + tool calling）
 */

import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, ToolCall } from './types'

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic()
  return _client
}

/** 将 OpenAI 格式的 tool def 转为 Anthropic 格式 */
function toAnthropicTools(tools: NonNullable<ChatOptions['tools']>): any[] {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }))
}

export const claudeProvider: LLMProvider = {
  name: 'claude',

  supportsCaching: () => true,

  listModels: () => [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5-20251001',
  ],

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    const systemMsg = messages.find(m => m.role === 'system')
    const chatMsgs = messages.filter(m => m.role !== 'system')

    const params: any = {
      model: options.model,
      max_tokens: options.maxTokens || 2048,
      messages: chatMsgs.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    }

    if (systemMsg) {
      params.system = [{
        type: 'text',
        text: systemMsg.content,
        cache_control: { type: 'ephemeral' },
      }]
    }

    if (options.temperature !== undefined) {
      params.temperature = options.temperature
    }

    // 原生工具定义
    if (options.tools && options.tools.length > 0) {
      params.tools = toAnthropicTools(options.tools)
      params.tool_choice = { type: 'auto' }
    }

    const resp = await getClient().messages.create(params)

    // 处理 tool_calls（Anthropic 格式）
    const toolUseBlocks = resp.content.filter((b: any) => b.type === 'tool_use')
    let toolCalls: ToolCall[] | undefined
    if (toolUseBlocks.length > 0) {
      toolCalls = toolUseBlocks.map((b: any) => ({
        id: b.id,
        type: 'function' as const,
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input),
        },
      }))
    }

    const textBlock = resp.content.find((b: any) => b.type === 'text')
    return {
      content: textBlock?.text || '',
      toolCalls,
      model: resp.model,
      usage: {
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        cacheReadInputTokens: (resp.usage as any).cache_read_input_tokens,
        cacheCreationInputTokens: (resp.usage as any).cache_creation_input_tokens,
      },
    }
  },
}
