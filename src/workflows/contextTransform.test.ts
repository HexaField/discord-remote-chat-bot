import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildToolInputsForContext } from '../tools'

const SAMPLE_TRANSCRIPT =
  'System reliability improved after adding more monitoring, and the on-call load dropped last quarter.'

let sessionDir: string

beforeAll(async () => {
  sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-transform-'))
})

afterAll(async () => {
  if (sessionDir) await fs.rm(sessionDir, { recursive: true, force: true })
})

test('context transform produces diagram transcript mapping', async () => {
  const { inputs, transform, target } = await buildToolInputsForContext(
    'diagram',
    'Please create a diagram for the attached meeting notes.',
    { content: SAMPLE_TRANSCRIPT },
    { sessionDir }
  )

  expect(target).toBeDefined()
  expect(transform).toBeDefined()
  expect(typeof inputs.transcript).toBe('string')
  expect(String(inputs.transcript)).toContain('System reliability improved')
}, 120_000)
