/**
 * DeepSeek Provider（OpenAI 兼容 API）
 */

import OpenAI from 'openai'
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, ToolCall } from './types'

// 过滤 <think>...</think> 标签
function stripThinking(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

let _client: OpenAI | null = null
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY || process.env.DS_KEY || '',
    })
  }
  return _client
}

export const deepseekProvider: LLMProvider = {
  name: 'deepseek',

  supportsCaching: () => false,

  listModels: () => [
    'deepseek-v4-pro',
    'deepseek-v4-flash',
  ],

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    const body: any = {
      model: options.model,
      max_tokens: options.maxTokens || 2048,
      messages: messages.map(m => {
        const msg: any = { role: m.role, content: m.content }
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
        if (m.tool_calls) msg.tool_calls = m.tool_calls
        return msg
      }),
      temperature: options.temperature,
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools
      body.tool_choice = 'auto'
    }

    const resp = await getClient().chat.completions.create(body)

    const msg = resp.choices[0]?.message as any

    // 处理 tool_calls
    let toolCalls: ToolCall[] | undefined
    if (msg?.tool_calls && msg.tool_calls.length > 0) {
      toolCalls = msg.tool_calls.map((tc: any) => ({
        id: tc.id || '',
        type: 'function' as const,
        function: {
          name: tc.function?.name || '',
          arguments: tc.function?.arguments || '',
        },
      }))
    }

    // DeepSeek Pro 返回 thinking 在 reasoning_content 字段
    const reasoningContent = msg?.reasoning_content || ''
    const replyContent = msg?.content || ''
    let rawContent = reasoningContent
      ? `<think>${reasoningContent}</think>\n\n${replyContent}`
      : replyContent
    const content = stripThinking(rawContent)

    return {
      content,
      rawContent,
      toolCalls,
      model: resp.model,
      usage: resp.usage ? {
        inputTokens: resp.usage.prompt_tokens || 0,
        outputTokens: resp.usage.completion_tokens || 0,
      } : undefined,
    }
  },
}
