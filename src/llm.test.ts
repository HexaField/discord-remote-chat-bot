import { describe, expect, it, vi } from 'vitest'

// Mock the ollama module used in llm.ts
vi.mock('ollama', () => {
  return {
    default: {
      chat: vi.fn(() => {
        async function* gen() {
          // simulate streaming chunks
          yield { message: { content: '{"hello":"world"}' } }
        }
        return gen()
      })
    }
  }
})

import { callLLM } from './llm'

describe('callLLM', () => {
  it('returns JSON code-fence from ollama provider', async () => {
    const res = await callLLM('system', 'user prompt', 'llama3.2', 'ollama')
    expect(res.success).toBe(true)
    expect(res.data).toBeDefined()
    // should include a json code fence
    expect(res.data).toContain('```json')
    // should include the JSON key from the mocked chunk
    expect(res.data).toContain('"hello"')
  })
})
