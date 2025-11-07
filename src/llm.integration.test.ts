import { spawnSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { callLLM } from './llm'

function commandExists(cmd: string): boolean {
  const res = spawnSync('which', [cmd])
  return res.status === 0
}

const providers: Array<{ provider: string; cmd: string; model: string }> = [
  { provider: 'ollama-cli', cmd: 'ollama', model: 'llama3.2' },
  { provider: 'opencode', cmd: 'opencode', model: 'github-copilot/gpt-5-mini' },
  { provider: 'goose', cmd: 'goose', model: 'github_copilot/gpt-5-mini' }
]

describe('LLM CLI integrations', () => {
  for (const p of providers) {
    it(`provider ${p.provider}`, async () => {
      const exists = commandExists(p.cmd)
      // Fail fast if the CLI isn't installed; the user requested tests to fail in this case.
      expect(exists, `Required CLI '${p.cmd}' not found on PATH`).toBe(true)

      const expectedAnswer = `integration-${p.provider}`
      const systemPrompt =
        'You are a JSON-only responder. Output ONLY valid JSON with exactly two keys: "answer" (string) and "status" (string). Do not include any surrounding markdown or explanation.'
      const userPrompt = `Return a JSON object: {"answer":"${expectedAnswer}","status":"ok"}`

      const res = await callLLM(systemPrompt, userPrompt, p.provider, p.model)

      // When real CLI runs, we expect success and a JSON code fence wrapper.
      expect(res.success).toBe(true)
      expect(res.data).toBeDefined()
      expect(res.data).toContain('```json')

      // Extract JSON block from the fenced response and parse it.
      const m = (res.data as string).match(/```json\s*([\s\S]*?)\s*```/)
      const jsonText = m ? m[1] : (res.data as string)
      let parsed: any
      try {
        parsed = JSON.parse(jsonText)
      } catch (e) {
        // If parsing fails, fail the test with helpful output.
        throw new Error(`Failed to parse JSON from LLM response: ${e}\nraw:${jsonText}`)
      }

      // Assert the JSON shape and values.
      expect(typeof parsed).toBe('object')
      expect(typeof parsed.answer).toBe('string')
      expect(parsed.answer).toBe(expectedAnswer)
      expect(parsed.status).toBe('ok')
    }, 60_000) // allow longer timeout for integration tests
  }
})
