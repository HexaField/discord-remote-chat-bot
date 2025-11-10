import { describe, it, expect } from 'vitest'
import { extractThemes } from './openCoding'
import { sentenceSplit } from './ingest'

describe('open coding', () => {
  it('extracts themes with evidence spans', () => {
    const text = 'Underperformance triggers resource allocation. Rework improves design quality.'
    const { spans } = sentenceSplit(text)
    const themes = extractThemes(spans)
    expect(themes.length).toBeGreaterThan(0)
    const under = themes.find((t) => t.label.includes('underperformance'))
    expect(under?.evidence?.length).toBeGreaterThan(0)
  })
})
