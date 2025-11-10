import { Code, Containment } from './types'
import { defaultConfig } from './config'

export function aggregateThemesToVariables(themes: Code[], cfg = defaultConfig) {
  const variableMap = new Map<string, Code>()
  const containment: Containment[] = []
  const allowed = new Set<string>([
    // All canonical keys and mapped values are allowed
    ...Object.keys(cfg.variableSynonyms),
    ...Object.values(cfg.themeToVariableMap),
    // Common canonicals
    'performance',
    'underperformance',
    'resource allocation',
    'scrapping',
    'rework',
    'design quality'
  ])

  for (const theme of themes) {
  const canonical = cfg.themeToVariableMap[theme.label] || theme.label
  if (!allowed.has(canonical)) continue
    const varId = `var:${canonical}`
    let variable = variableMap.get(varId)
    if (!variable) {
      variable = {
        id: varId,
        label: canonical,
        type: 'variable',
        group: theme.group,
        evidence: [...(theme.evidence || [])]
      }
      variableMap.set(varId, variable)
    } else {
      // accumulate evidence
      variable.evidence!.push(...(theme.evidence || []))
    }
    containment.push({ parentCodeId: varId, childCodeId: theme.id, relation: 'contains' })
  }

  return { variables: Array.from(variableMap.values()), containment }
}
