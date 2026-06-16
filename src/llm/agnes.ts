/**
 * Agnes AI Provider（OpenAI 兼容 API）
 *
 * 端点：https://apihub.agnes-ai.com/v1/chat/completions
 * 模型：agnes-2.0-flash
 *
 * 支持 tool calling，失败时由上层 fallback 到 DSF
 */

import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, ToolCall } from './types'

function getApiKey(): string {
  return process.env.AGNES_API_KEY || ''
}

export const agnesProvider: LLMProvider = {
  name: 'agnes',

  supportsCaching: () => false,

  listModels: () => ['agnes-2.0-flash'],

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    const body: any = {
      model: 'agnes-2.0-flash',
      max_tokens: options.maxTokens || 4096,
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

    const resp = await fetch('https://apihub.agnes-ai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`Agnes API error: ${resp.status}${errText ? ' ' + errText.slice(0, 200) : ''}`)
    }

    const data = await resp.json() as any
    const msg = data.choices?.[0]?.message as any

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

    return {
      content: msg?.content || '',
      rawContent: msg?.content || '',
      toolCalls,
      model: data.model || 'agnes-2.0-flash',
      usage: data.usage ? {
        inputTokens: data.usage.prompt_tokens || 0,
        outputTokens: data.usage.completion_tokens || 0,
      } : undefined,
    }
  },
}
