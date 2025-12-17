import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { generateMeetingDigest } from './meetingDigest.workflow'

const SAMPLE_TRANSCRIPT = `Speaker A: We agreed to switch the staging cluster to the new load balancer this week.
Speaker B: I'll lead the cutover on Thursday and document the steps.
Speaker C: Monitoring alerts still need tuning; let's finish that next sprint.
Speaker A: Decision: pause the legacy backup job after the cutover to avoid conflicts.`

let sessionDir: string

beforeAll(async () => {
  sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-digest-'))
})

afterAll(async () => {
  if (sessionDir) await fs.rm(sessionDir, { recursive: true, force: true })
})

test('meeting digest workflow extracts structured summary', async () => {
  const output = await generateMeetingDigest(SAMPLE_TRANSCRIPT, undefined, undefined, undefined, undefined, sessionDir)

  expect(Array.isArray(output.insights)).toBe(true)
  expect(Array.isArray(output.actionItems)).toBe(true)
  expect(Array.isArray(output.decisions)).toBe(true)
  expect(Array.isArray(output.openQuestions)).toBe(true)

  expect(output.insights.length).toBeGreaterThan(0)
  expect(output.decisions.length).toBeGreaterThan(0)

  const decisionTexts = output.decisions
    .map((d) => String(d.decision || ''))
    .join(' ')
    .toLowerCase()
  expect(decisionTexts).toContain('pause the legacy backup job')
}, 180_000)
