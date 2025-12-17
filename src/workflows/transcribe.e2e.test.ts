import { runAgentWorkflow, validateWorkflowDefinition } from '@hexafield/agent-workflow'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCliArgs } from '../tools'
import { transcribeWorkflowDocument } from './transcribe.workflow'

const transcribeWorkflowDefinition = validateWorkflowDefinition(transcribeWorkflowDocument)
const VIDEO_URL = 'https://www.youtube.com/watch?v=JhU0yO43b6o'

describe('transcribe workflow e2e (real CLIs)', () => {
  let sessionDir: string

  beforeAll(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcribe-e2e-'))
  })

  afterAll(async () => {
    if (sessionDir) await fs.rm(sessionDir, { recursive: true, force: true })
  })

  it('produces VTT base64 and transcript from real youtube audio', async () => {
    const response = await runAgentWorkflow(transcribeWorkflowDefinition, {
      user: { url: VIDEO_URL },
      sessionDir,
      workflowId: transcribeWorkflowDefinition.id,
      workflowSource: 'user',
      workflowLabel: transcribeWorkflowDefinition.description,
      runCliArgs
    })

    const result = await response.result
    const lastRound = result.rounds[result.rounds.length - 1]
    const emitStep = lastRound?.steps?.emit as any
    const parsed = emitStep?.parsed as any

    const files = parsed?.files as Record<string, any>
    expect(files?.['audio.vtt']).toBeDefined()
    expect(files?.['transcript.txt']).toBeDefined()

    const vttBuffer = files['audio.vtt']
    const vttText = Buffer.isBuffer(vttBuffer) ? vttBuffer.toString('utf8') : String(vttBuffer)
    expect(vttText).toContain('WEBVTT')

    const transcriptText = typeof parsed?.response === 'string' ? parsed.response : String(files['transcript.txt'])
    expect(transcriptText.length).toBeGreaterThan(10)

    const normalize = (text: string) =>
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n')

    const expected = `Hey there, this is a quick and silly video to allow you to experiment a little bit with
the process of transcription on YouTube.
All I'm looking for you to do here is to use the YouTube tool to transcribe this message
and then click "Sync" and set the timing so you can get a quick idea about how the whole
process works.
Well, this wraps up the video, good luck, and I will talk to you about it soon.`

    expect(normalize(transcriptText)).toBe(normalize(expected))
  }, 600_000)
})
