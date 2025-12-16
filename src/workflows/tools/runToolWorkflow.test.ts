import fs from 'node:fs/promises'
import path from 'node:path'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// Mocks
vi.mock('@hexafield/agent-workflow', () => ({
  runAgentWorkflow: vi.fn(),
  validateWorkflowDefinition: (d: any) => d
}))
vi.mock('./index', () => ({
  getToolWorkflowByName: vi.fn()
}))

import { runAgentWorkflow } from '@hexafield/agent-workflow'
import { getToolWorkflowByName } from './index'
import { runToolWorkflow } from './runToolWorkflow'

const TMP_TEST_ROOT = path.join(process.cwd(), '.tmp-test')

beforeEach(async () => {
  try {
    await fs.rm(TMP_TEST_ROOT, { recursive: true, force: true })
  } catch {}
})

afterEach(async () => {
  try {
    await fs.rm(TMP_TEST_ROOT, { recursive: true, force: true })
  } catch {}
})

describe('runToolWorkflow', () => {
  it('returns typed parsed output when workflow exists', async () => {
    const mockGet = getToolWorkflowByName as unknown as ReturnType<typeof vi.fn>
    const mockRun = runAgentWorkflow as unknown as ReturnType<typeof vi.fn>

    mockGet.mockReturnValue({ id: 'tools.transcribe.v1', model: 'gpt', description: 'transcribe' })

    mockRun.mockResolvedValue({
      result: Promise.resolve({
        rounds: [
          {
            steps: {
              step1: { parsed: { files: { 'audio.vtt': Buffer.from('data') }, response: 'hello world' }, raw: 'raw' }
            }
          }
        ]
      })
    })

    const sessionDir = path.join(TMP_TEST_ROOT, 'sess1')
    const out = await runToolWorkflow<{ files?: Record<string, unknown>; response?: string }>('transcribe', { url: 'https://a' }, { sessionDir })
    expect(out.parsed).toBeDefined()
    expect(out.parsed?.response).toBe('hello world')
    expect(out.parsed?.files?.['audio.vtt']).toBeDefined()
    expect(out.sessionDir).toBe(sessionDir)
  })

  it('throws when tool workflow is unknown', async () => {
    const mockGet = getToolWorkflowByName as unknown as ReturnType<typeof vi.fn>
    mockGet.mockReturnValue(undefined)
    await expect(runToolWorkflow('nope')).rejects.toThrow(/Unknown tool workflow/)
  })
})
