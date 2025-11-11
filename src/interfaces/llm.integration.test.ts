import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
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

  for (const p of providers) {
    it(`provider ${p.provider} session reuse persists meta.json`, async () => {
      const exists = commandExists(p.cmd)
      expect(exists, `Required CLI '${p.cmd}' not found on PATH`).toBe(true)

      // Prepare per-provider session directory under the repo tmp tree
      const baseTmp = path.join(process.cwd(), '.tmp', 'audio-to-diagram', 'itest-sessions')
      fs.mkdirSync(baseTmp, { recursive: true })
      const sessionDir = path.join(baseTmp, `${p.provider}-${Date.now()}`)
      fs.mkdirSync(sessionDir, { recursive: true })

      const sid = `itest-${p.provider}-${Date.now()}`
      const expected1 = `integration-${p.provider}-1`
      const expected2 = `integration-${p.provider}-2`

      const systemPrompt =
        'You are a JSON-only responder. Output ONLY valid JSON with exactly two keys: "answer" (string) and "status" (string). Do not include any surrounding markdown or explanation.'
      const userPrompt1 = `Return a JSON object: {"answer":"${expected1}","status":"ok"}`
      const userPrompt2 = `Return a JSON object: {"answer":"${expected2}","status":"ok"}`

      const r1 = await callLLM(systemPrompt, userPrompt1, p.provider, p.model, { sessionId: sid, sessionDir })
      const r2 = await callLLM(systemPrompt, userPrompt2, p.provider, p.model, { sessionId: sid, sessionDir })

      // Basic expectations still hold
      expect(r1.success).toBe(true)
      expect(r2.success).toBe(true)
      expect(r1.data).toContain('```json')
      expect(r2.data).toContain('```json')

      // Validate meta.json persisted in the sessionDir with two entries
      const metaPath = path.join(sessionDir, 'meta.json')
      expect(fs.existsSync(metaPath)).toBe(true)
      const metaRaw = fs.readFileSync(metaPath, 'utf8')
      const meta = JSON.parse(metaRaw)
      expect(meta && typeof meta === 'object').toBe(true)
      // For CLI providers, we track outputs in providerData.cli.last (array)
      const last = (((meta || {}).providerData || {}).cli || {}).last || []
      expect(Array.isArray(last)).toBe(true)
      expect(last.length).toBeGreaterThanOrEqual(2)
      const joined = String(last.join('\n'))
      expect(joined).toContain(expected1)
      expect(joined).toContain(expected2)
    }, 60_000)
  }
})
