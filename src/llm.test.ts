import { describe, expect, it, vi } from 'vitest'

// Mock the ollama module used in llm.ts; capture messages for session history validation
const ollamaMessagesPerCall: any[] = []
vi.mock('ollama', () => {
  return {
    default: {
      chat: vi.fn((args: any) => {
        if (args?.messages) ollamaMessagesPerCall.push(JSON.parse(JSON.stringify(args.messages)))
        async function* gen() {
          // simulate streaming chunks
          yield { message: { content: '{"hello":"world"}' } }
        }
        return gen()
      })
    }
  }
})

// Partially mock ./llm to override runCLI while keeping the real callLLM implementation.
vi.mock('./llm', async () => {
  const actual = await vi.importActual<typeof import('./llm')>('./llm')
  return {
    ...actual,
    runCLI: vi.fn(async (cmd: string, args: string[], input: string) => {
      // Return a simple JSON string regardless of the CLI
      return '{"answer":"session-ok","status":"ok"}\n'
    })
  }
})

import * as llm from './llm'

describe('callLLM', () => {
  it('returns JSON code-fence from ollama provider', async () => {
    const res = await llm.callLLM('system', 'user prompt')
    expect(res.success).toBe(true)
    expect(res.data).toBeDefined()
    // should include a json code fence
    expect(res.data).toContain('```json')
    // should include the JSON key from the mocked chunk
    expect(res.data).toContain('"hello"')
  })

  it('uses sessionId with ollama to accumulate message history across calls', async () => {
    const sid = `sess-ollama-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    ollamaMessagesPerCall.length = 0
    const r1 = await llm.callLLM('sys', 'first', 'ollama', 'llama3.2', { sessionId: sid })
    const r2 = await llm.callLLM('sys', 'second', 'ollama', 'llama3.2', { sessionId: sid })
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    // First call: [system, user]
    expect(Array.isArray(ollamaMessagesPerCall[0])).toBe(true)
    expect(ollamaMessagesPerCall[0].length).toBe(2)
    expect(ollamaMessagesPerCall[0][0].role).toBe('system')
    expect(ollamaMessagesPerCall[0][1].role).toBe('user')
    // Second call should contain previous assistant reply: [system, user, assistant, user]
    expect(Array.isArray(ollamaMessagesPerCall[1])).toBe(true)
    expect(ollamaMessagesPerCall[1].length).toBeGreaterThanOrEqual(4)
    expect(ollamaMessagesPerCall[1][0].role).toBe('system')
    expect(ollamaMessagesPerCall[1][1].role).toBe('user')
    expect(ollamaMessagesPerCall[1][2].role).toBe('assistant')
    expect(ollamaMessagesPerCall[1][ollamaMessagesPerCall[1].length - 1].role).toBe('user')
  })
})
