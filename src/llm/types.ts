/**
 * LLM Provider 统一接口
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string  // JSON string
  }
}

export interface ChatOptions {
  model: string
  maxTokens?: number
  temperature?: number
  stream?: boolean
  tools?: ToolDef[]
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string }
}

export interface ChatResponse {
  content: string
  model: string
  rawContent?: string
  toolCalls?: ToolCall[]
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  }
}

export interface LLMProvider {
  name: string
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse>
  supportsCaching(): boolean
  listModels(): string[]
}
