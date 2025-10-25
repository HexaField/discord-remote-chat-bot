import ollama from 'ollama'
import { debug } from './logger'

const modelSettings = {
  'llama3.2': {
    maxContext: 128000
  },
  'gpt-oss:20b': {
    maxContext: 32000
  }
} as const

const MODEL_MAX_CTX = 128000

export type LLMResponse<T = unknown> = {
  success: boolean
  data?: string
  error?: string
}

export async function callLLM<T = unknown>(
  systemPrompt: string,
  userQuery: string,
  model = 'llama3.2' as keyof typeof modelSettings
): Promise<LLMResponse<T>> {
  // debug('LLM payload', userQuery)

  // Combine the prompts and call the Python tokenizer to count tokens.
  const combinedText = `${systemPrompt}\n${userQuery}`

  const tokenCount = combinedText.length / 4 // Rough estimate: 1 token ~ 4 characters

  debug('LLM token count', tokenCount)
  if (tokenCount > 0 && tokenCount > MODEL_MAX_CTX) {
    // Log a visible warning for developers / operators.
    console.warn(
      `LLM prompt token count (${tokenCount}) exceeds model max context (${MODEL_MAX_CTX}). Prompt may be truncated or rejected.`
    )
  }

  const response = await ollama.chat({
    model,
    options: {
      num_ctx: modelSettings[model]?.maxContext || MODEL_MAX_CTX
    },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userQuery }
    ]
  })

  debug('LLM response status', response)

  return {
    success: true,
    data: response.message.content
  }
}
