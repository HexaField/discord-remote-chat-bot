import { CausalEdge, Code, Polarity, Span } from './types'
import { defaultConfig } from './config'

function indexSynonyms(variables: Code[], cfg = defaultConfig) {
  const index = new Map<string, string>() // token -> variableId
  for (const v of variables) {
    const canon = v.label
    const list = [canon, ...(cfg.variableSynonyms[canon] || [])]
    for (const term of list) {
      const key = term.toLowerCase()
      index.set(key, v.id)
    }
  }
  return index
}

function polarityFromSentence(sentence: string, cfg = defaultConfig): Polarity | null {
  const s = sentence.toLowerCase()
  for (const p of cfg.cueLexicon.negative) if (s.includes(p)) return '-'
  for (const p of cfg.cueLexicon.positive) if (s.includes(p)) return '+'
  for (const p of cfg.cueLexicon.generic) if (s.includes(p)) return '+' // default generic to positive causal linkage
  return null
}

function findMentionedVariables(sentence: string, variables: Code[], cfg = defaultConfig) {
  const idx = indexSynonyms(variables, cfg)
  const found = new Map<string, string>() // varId -> surface
  const s = sentence.toLowerCase()
  for (const [term, varId] of idx.entries()) {
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeReg(term)}(?:[^a-z0-9]|$)`, 'i')
    if (re.test(s)) {
      found.set(varId, term)
    }
  }
  return Array.from(found.keys())
}

function escapeReg(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function estimateConfidence(sentence: string, pol: Polarity | null, varIds: string[], cfg = defaultConfig) {
  let score = cfg.confidence.base
  const s = sentence.toLowerCase()
  // cue bonuses
  const cues = [...cfg.cueLexicon.positive, ...cfg.cueLexicon.negative, ...cfg.cueLexicon.generic]
  const hits = cues.filter((c) => s.includes(c)).length
  score += Math.min(1, hits * cfg.confidence.cueWeight)
  if (pol === '+') score += cfg.confidence.positiveBonus
  if (pol === '-') score += cfg.confidence.negativeBonus
  // bound
  return Math.max(0, Math.min(1, score))
}

export function extractCausalEdges(sentenceSpans: Span[], variables: Code[], cfg = defaultConfig): CausalEdge[] {
  const edges: CausalEdge[] = []

  for (const sp of sentenceSpans) {
    const sentence = sp.textPreview
    const pol = polarityFromSentence(sentence, cfg)
    if (!pol) continue

    // Prefer directional extraction using cue split
    const dirEdges = directionalEdgesFromSentence(sentence, variables, pol, sp, cfg)
    if (dirEdges.length > 0) {
      edges.push(...dirEdges)
      continue
    }

    // Fallback: pairwise among mentioned variables
    const vars = findMentionedVariables(sentence, variables, cfg)
    if (vars.length < 2) continue
    const maxEdges = cfg.confidence.maxPerSentenceEdges
    let created = 0
    for (let i = 0; i < vars.length; i++) {
      for (let j = i + 1; j < vars.length; j++) {
        if (created >= maxEdges) break
        const fromId = vars[i]
        const toId = vars[j]
        const confidence = estimateConfidence(sentence, pol, [fromId, toId], cfg)
        const id = `e:${fromId}->${toId}:${pol}`
        edges.push({ id, fromVariableId: fromId, toVariableId: toId, polarity: pol, confidence, evidence: [sp] })
        created++
      }
      if (created >= maxEdges) break
    }
  }

  return edges
}

function directionalEdgesFromSentence(
  sentence: string,
  variables: Code[],
  pol: Polarity,
  sp: Span,
  cfg = defaultConfig
) {
  const s = sentence.toLowerCase()
  const cues = [...cfg.cueLexicon.positive, ...cfg.cueLexicon.negative, ...cfg.cueLexicon.generic]
  let cue: string | null = null
  let idx = -1
  for (const c of cues) {
    const pos = s.indexOf(c)
    if (pos !== -1 && (idx === -1 || pos < idx)) {
      cue = c
      idx = pos
    }
  }
  if (!cue || idx === -1) return []

  const left = s.slice(0, idx)
  const right = s.slice(idx + cue.length)

  const leftVars = findMentionedVariables(left, variables, cfg)
  const rightVars = findMentionedVariables(right, variables, cfg)
  if (leftVars.length === 0 || rightVars.length === 0) return []

  // choose closest: last on left, first on right
  let fromId = leftVars[leftVars.length - 1]
  let toId = rightVars[0]

  // Special handling: underperformance/performance expected loop direction
  if (cue.includes('reduces') || cue.includes('lowers') || cue.includes('diminish')) {
    // If performance reduces underperformance, direction should be performance -> underperformance with negative polarity already encoded
    if (rightVars.some(v => v.includes('underperformance')) && leftVars.some(v => v.includes('performance'))) {
      fromId = leftVars.find(v => v.includes('performance')) || fromId
      toId = rightVars.find(v => v.includes('underperformance')) || toId
    }
  }

  const confidence = estimateConfidence(sentence, pol, [fromId, toId], cfg)
  const id = `e:${fromId}->${toId}:${pol}`
  return [{ id, fromVariableId: fromId, toVariableId: toId, polarity: pol, confidence, evidence: [sp] }]
}
