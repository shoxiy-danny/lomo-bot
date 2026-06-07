/**
 * MiMo Provider（小米 MiMo API）— 支持原生 tool calling
 */

import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, ToolCall } from './types'

function getApiHost(): string {
  return process.env.MIMO_API_HOST || 'https://token-plan-cn.xiaomimimo.com'
}

function getApiKey(): string {
  return process.env.MIMO_API_KEY || ''
}

function stripThinking(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

export const mimoProvider: LLMProvider = {
  name: 'mimo',

  supportsCaching: () => false,

  listModels: () => ['mimo-v2.5', 'mimo-v2.5-pro'],

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

    const resp = await fetch(`${getApiHost()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': getApiKey(),
      },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      throw new Error(`MiMo API error: ${resp.status} ${await resp.text()}`)
    }

    const data = await resp.json() as any
    const msg = data.choices?.[0]?.message || {}

    // 处理 tool_calls
    let toolCalls: ToolCall[] | undefined
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      toolCalls = msg.tool_calls.map((tc: any) => ({
        id: tc.id || '',
        type: 'function' as const,
        function: {
          name: tc.function?.name || '',
          arguments: tc.function?.arguments || '',
        },
      }))
    }

    let rawContent = msg.content || ''
    const content = stripThinking(rawContent)

    return {
      content,
      rawContent,
      toolCalls,
      model: data.model || options.model,
      usage: data.usage ? {
        inputTokens: data.usage.prompt_tokens || 0,
        outputTokens: data.usage.completion_tokens || 0,
      } : undefined,
    }
  },
}
