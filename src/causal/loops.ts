import { CausalEdge, Graph, Loop, LoopType } from './types'

function adjacency(edges: CausalEdge[]) {
  const out = new Map<string, CausalEdge[]>()
  for (const e of edges) {
    if (!out.has(e.fromVariableId)) out.set(e.fromVariableId, [])
    out.get(e.fromVariableId)!.push(e)
  }
  return out
}

export function findSimpleCycles(graph: Graph, maxDepth = 6): Loop[] {
  const adj = adjacency(graph.edges)
  const loops: Loop[] = []
  const seen = new Set<string>()

  function dfs(start: string, current: string, pathNodes: string[], pathEdges: CausalEdge[]) {
    if (pathNodes.length > maxDepth) return
    const nexts = adj.get(current) || []
    for (const e of nexts) {
      const nextNode = e.toVariableId
      if (nextNode === start && pathEdges.length >= 1) {
        const fullEdges = [...pathEdges, e]
        // ensure at least 3 distinct nodes for a meaningful CLD loop
        const distinctNodes = new Set(fullEdges.map(ed => ed.fromVariableId).concat([start]))
        if (distinctNodes.size < 2) continue
        const edgeIds = fullEdges.map((x) => x.id)
        const nodeIds = Array.from(distinctNodes)
        const idKey = [...edgeIds].sort().join('|')
        if (seen.has(idKey)) continue
        seen.add(idKey)
        const type = classifyLoop(fullEdges)
        loops.push({ id: `loop:${loops.length + 1}`, nodeIds, edgeIds, type, evidence: edgeIds })
        continue
      }
      // allow revisiting if it closes the start; otherwise prevent
      if (pathNodes.includes(nextNode)) continue
      dfs(start, nextNode, [...pathNodes, nextNode], [...pathEdges, e])
    }
  }

  for (const v of graph.variables) {
    dfs(v.id, v.id, [v.id], [])
  }
  return loops
}

export function classifyLoop(edges: CausalEdge[]): LoopType {
  let sign = 1
  for (const e of edges) {
    sign *= e.polarity === '+' ? 1 : -1
  }
  // Positive product = reinforcing; negative = balancing
  return sign >= 0 ? 'reinforcing' : 'balancing'
}
