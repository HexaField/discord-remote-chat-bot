import { describe, it, expect } from 'vitest'
import { sentenceSplit } from './ingest'
import { extractThemes } from './openCoding'
import { aggregateThemesToVariables } from './axialCoding'
import { extractCausalEdges } from './causality'

describe('causality extraction', () => {
  it('creates edges with polarity and confidence', () => {
    const text = 'Underperformance triggers resource allocation. Underperformance reduces performance.'
    const { spans } = sentenceSplit(text)
    const themes = extractThemes(spans)
    const { variables } = aggregateThemesToVariables(themes)
    const edges = extractCausalEdges(spans, variables)
    expect(edges.length).toBeGreaterThan(0)
    expect(edges[0].polarity === '+' || edges[0].polarity === '-').toBe(true)
    expect(edges[0].confidence).toBeGreaterThanOrEqual(0)
  })
})
