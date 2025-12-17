import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chooseToolForMention } from '../tools'

describe('tools chooser workflow', () => {
  let sessionDir: string

  beforeAll(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-chooser-'))
  })

  afterAll(async () => {
    if (sessionDir) await fs.rm(sessionDir, { recursive: true, force: true })
  })

  it('selects transcribe when an audio URL is provided', async () => {
    const result = await chooseToolForMention({
      question: 'Please transcribe this audio: https://example.com/audio.mp3',
      referenced: { attachments: ['https://example.com/audio.mp3'] },
      sessionDir
    })
    expect(result.tool).toBe('transcribe')
  }, 120_000)

  it('selects diagram for diagram requests with text', async () => {
    const result = await chooseToolForMention({
      question: 'Create a causal loop diagram of this system.',
      referenced: {
        content: 'Increased marketing raises signups, which increases load on support and slows responses.'
      },
      sessionDir
    })
    expect(result.tool).toBe('diagram')
  }, 120_000)

  it('selects meeting_summarise for meeting summary asks', async () => {
    const result = await chooseToolForMention({
      question: 'Summarise the meeting notes and list actions.',
      referenced: {
        content: 'Team agreed to ship v2 Friday; Alice will update docs; need decision on rollout steps.'
      },
      sessionDir
    })
    expect(result.tool).toBe('meeting_summarise')
  }, 120_000)
})
