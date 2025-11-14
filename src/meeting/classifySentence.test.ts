import { describe, expect, it } from 'vitest'
import { classifySentence } from './classifySentences'
import { meetingOntology } from './meetingExtraction'

describe('classifySentence (strict JSON fence)', () => {
  it('returns a known label inside a JSON code fence', async () => {
    const s = 'We will need to ship the feature by next Tuesday.'
    const res = await classifySentence(s, [], meetingOntology)
    expect(res).toBeTruthy()
    expect(typeof res.label).toBe('string')
    expect(Array.isArray(res.relatedTo)).toBe(true)
  })
})
