import { CausalEdge, Code, Graph } from './types'
import { defaultConfig } from './config'

export function consolidateEdges(raw: CausalEdge[], cfg = defaultConfig): CausalEdge[] {
  const map = new Map<string, CausalEdge>()
  for (const e of raw) {
    const key = `${e.fromVariableId}|${e.toVariableId}|${e.polarity}`
    const existing = map.get(key)
    if (!existing) {
      map.set(key, { ...e, evidence: [...e.evidence] })
    } else {
      existing.evidence.push(...e.evidence)
      // aggregate confidence (bounded average with slight uplift for more evidence)
      existing.confidence = Math.min(1, (existing.confidence + e.confidence) / 2 + 0.05)
    }
  }
  // prune
  return Array.from(map.values()).filter((e) => e.confidence >= cfg.pruneThreshold)
}

export function buildGraph(variables: Code[], edges: CausalEdge[]): Graph {
  return { variables, edges }
}
