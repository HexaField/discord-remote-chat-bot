import { describe, it, expect } from 'vitest'
import { sentenceSplit } from './ingest'

describe('ingest.sentenceSplit', () => {
  it('splits text preserving offsets', () => {
    const text = 'A. B! C?'
    const { spans, sentences } = sentenceSplit(text)
    expect(sentences.length).toBe(3)
    expect(spans[0].start).toBe(0)
    expect(spans[0].end).toBeGreaterThan(spans[0].start)
    expect(spans[1].start).toBeGreaterThan(spans[0].start)
  })
})
