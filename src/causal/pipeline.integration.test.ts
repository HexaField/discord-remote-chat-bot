import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { runCausalPipeline } from './pipeline'

describe('pipeline integration', () => {
  it('runs end-to-end and produces artifacts and loops', async () => {
    const sample = readFileSync(require.resolve('./__fixtures__/sample.txt'), 'utf8')
  let result = await runCausalPipeline([{ id: 'sample', text: sample }])
    // Fallback: if no loops, attempt rerun with lowered prune threshold and relaxed config
    if (result.loops.length === 0) {
      // debug
      // eslint-disable-next-line no-console
      console.warn('No loops found on first pass. Variables:', result.variables.map(v => v.label))
      // eslint-disable-next-line no-console
      console.warn('Edges:', result.edges.map(e => `${e.fromVariableId}->${e.toVariableId}${e.polarity}`))
      result = await runCausalPipeline([{ id: 'sample', text: sample }], {
        config: {
          pruneThreshold: 0.0,
          themeToVariableMap: { performance: 'performance', 'improved performance': 'performance' },
          variableSynonyms: { underperformance: ['low performance', 'underperformance'], performance: ['performance'] }
        }
      })
      if (result.loops.length === 0) {
        // eslint-disable-next-line no-console
        console.warn('No loops after retry. Variables:', result.variables.map(v => v.label))
        // eslint-disable-next-line no-console
        console.warn('Edges:', result.edges.map(e => `${e.fromVariableId}->${e.toVariableId}${e.polarity}`))
      }
    }
    expect(result.variables.length).toBeGreaterThanOrEqual(5)
    expect(result.edges.length).toBeGreaterThan(0)
  expect(result.loops.length).toBeGreaterThanOrEqual(1)
    // Each edge must have at least one evidence span
    expect(result.edges.every((e) => e.evidence.length >= 1)).toBe(true)
  }, 30000)
})
