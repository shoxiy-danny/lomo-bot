/**
 * MiniMax Provider — Anthropic Messages API 端点
 * 跟 Claude Code 一致，工具调用走原生 tool_use content block
 */

import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, ToolCall } from './types'

function getApiKey(): string {
  return process.env.MINIMAX_API_KEY || ''
}

// ── OpenAI → Anthropic 格式转换 ───────────────────────────────────

/** OpenAI 格式的 tool def → Anthropic 格式 */
function toAnthropicTools(tools: NonNullable<ChatOptions['tools']>): any[] {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }))
}

/** OpenAI 格式的 ChatMessage → Anthropic Messages API 格式 */
function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: any }>
} {
  const systemMsg = messages.find(m => m.role === 'system')
  const chatMsgs = messages.filter(m => m.role !== 'system')

  const out: Array<{ role: 'user' | 'assistant'; content: any }> = []

  for (const m of chatMsgs) {
    // user 消息（含 tool_result）
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
      continue
    }

    // tool 消息 → user role + tool_result content block
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id || '',
          content: m.content,
        }],
      })
      continue
    }

    // assistant 消息（可能带 tool_calls）
    if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const blocks: any[] = []
        if (m.content) {
          blocks.push({ type: 'text', text: m.content })
        }
        for (const tc of m.tool_calls) {
          let input: any = {}
          try { input = JSON.parse(tc.function.arguments) } catch {}
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          })
        }
        out.push({ role: 'assistant', content: blocks })
      } else {
        out.push({ role: 'assistant', content: m.content })
      }
    }
  }

  return { system: systemMsg?.content, messages: out }
}

// ── Anthropic 响应解析 ─────────────────────────────────────────────

function parseAnthropicResponse(data: any, model: string): ChatResponse {
  const blocks: any[] = data.content || []

  const toolUseBlocks = blocks.filter((b: any) => b.type === 'tool_use')
  const textBlocks = blocks.filter((b: any) => b.type === 'text')

  let toolCalls: ToolCall[] | undefined
  if (toolUseBlocks.length > 0) {
    toolCalls = toolUseBlocks.map((b: any) => ({
      id: b.id || '',
      type: 'function' as const,
      function: {
        name: b.name || '',
        arguments: JSON.stringify(b.input),
      },
    }))
  }

  return {
    content: textBlocks.map((b: any) => b.text || '').join('\n'),
    toolCalls,
    model: data.model || model,
    usage: data.usage ? {
      inputTokens: data.usage.input_tokens || 0,
      outputTokens: data.usage.output_tokens || 0,
    } : undefined,
  }
}

// ── Provider ────────────────────────────────────────────────────────

export const minimaxProvider: LLMProvider = {
  name: 'minimax',

  supportsCaching: () => false,

  listModels: () => ['MiniMax-M3'],

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    const { system, messages: anthropicMsgs } = toAnthropicMessages(messages)

    const body: any = {
      model: options.model,
      max_tokens: options.maxTokens || 4096,
      messages: anthropicMsgs,
    }

    if (system) body.system = system
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.tools && options.tools.length > 0) {
      body.tools = toAnthropicTools(options.tools)
    }

    const resp = await fetch('https://api.minimaxi.com/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`MiniMax API error: ${resp.status}${errText ? ' ' + errText.slice(0, 200) : ''}`)
    }

    const data = await resp.json() as any

    // Anthropic 端点也可能返回业务错误
    if (data.error) {
      throw new Error(`MiniMax error: ${data.error.message || JSON.stringify(data.error)}`)
    }

    return parseAnthropicResponse(data, options.model)
  },
}
