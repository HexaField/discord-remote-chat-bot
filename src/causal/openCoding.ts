import { Code, Group, Span } from './types'
import { defaultConfig } from './config'

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function groupForTheme(label: string, cfg = defaultConfig): Group {
  for (const rule of cfg.groupRules) {
    if (rule.pattern.test(label)) return rule.group
  }
  return 'other'
}

export function extractThemes(spans: Span[], cfg = defaultConfig): Code[] {
  const themeMap = new Map<string, Code>()
  const cueTerms = new Set<string>([
    ...cfg.cueLexicon.positive,
    ...cfg.cueLexicon.negative,
    ...cfg.cueLexicon.generic
  ].map((s) => s.toLowerCase()))

  for (const sp of spans) {
    const tokens = tokenize(sp.textPreview)
    // sliding window up to cfg.themeMaxWords
    for (let w = cfg.themeMaxWords; w >= 1; w--) {
      for (let i = 0; i + w <= tokens.length; i++) {
        const phrase = tokens.slice(i, i + w).join(' ').trim()
        if (phrase.length < cfg.themeMinLength) continue
        const words = phrase.split(' ')
        if (words.some((t) => cfg.themeStopwords.includes(t))) continue
        // skip phrases that include causal cue terms; they are not variables
        if (Array.from(cueTerms).some((c) => phrase.includes(c))) continue
        // avoid pure numbers
        if (/^\d+$/.test(phrase)) continue

  // canonical via mapping if available (e.g., allocation -> resource allocation)
  const mapped = cfg.themeToVariableMap[phrase]
  const label = mapped || phrase
        const id = `theme:${label}`
        const group = groupForTheme(label, cfg)
        const existing = themeMap.get(id)
        if (existing) {
          existing.evidence!.push(sp)
        } else {
          themeMap.set(id, {
            id,
            label,
            type: 'theme',
            group,
            evidence: [sp]
          })
        }
      }
    }
  }

  return Array.from(themeMap.values())
}
