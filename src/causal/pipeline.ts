import { ingestDocuments } from './ingest'
import { extractThemes } from './openCoding'
import { aggregateThemesToVariables } from './axialCoding'
import { extractCausalEdges } from './causality'
import { consolidateEdges, buildGraph } from './graph'
import { findSimpleCycles } from './loops'
import { exportAll } from './export'
import { CausalConfig, PipelineArtifacts } from './types'
import defaultConfig from './config'

export interface PipelineOptions {
  config?: Partial<CausalConfig>
  exportDir?: string
  baseName?: string
}

function mergeConfig(partial?: Partial<CausalConfig>): CausalConfig {
  if (!partial) return defaultConfig
  return {
    ...defaultConfig,
    ...partial,
    cueLexicon: partial.cueLexicon ? { ...defaultConfig.cueLexicon, ...partial.cueLexicon } : defaultConfig.cueLexicon,
    confidence: partial.confidence ? { ...defaultConfig.confidence, ...partial.confidence } : defaultConfig.confidence,
    themeToVariableMap: partial.themeToVariableMap
      ? { ...defaultConfig.themeToVariableMap, ...partial.themeToVariableMap }
      : defaultConfig.themeToVariableMap,
    variableSynonyms: partial.variableSynonyms
      ? { ...defaultConfig.variableSynonyms, ...partial.variableSynonyms }
      : defaultConfig.variableSynonyms,
    groupRules: partial.groupRules || defaultConfig.groupRules,
    themeStopwords: partial.themeStopwords || defaultConfig.themeStopwords,
    themeMinLength: partial.themeMinLength ?? defaultConfig.themeMinLength,
    themeMaxWords: partial.themeMaxWords ?? defaultConfig.themeMaxWords,
    pruneThreshold: partial.pruneThreshold ?? defaultConfig.pruneThreshold
  }
}

export async function runCausalPipeline(
  docs: Array<{ id: string; text: string; title?: string; sourceUri?: string }>,
  opts: PipelineOptions = {}
): Promise<PipelineArtifacts & { exports?: import('./types').ExportBundle }> {
  const cfg = mergeConfig(opts.config)
  // 1. Ingest
  const { documents, sentenceSpans } = ingestDocuments(docs)
  // 2. Open coding
  const themes = extractThemes(sentenceSpans, cfg)
  // 3. Axial coding
  const { variables, containment } = aggregateThemesToVariables(themes, cfg)
  // 4. Causality extraction
  const rawEdges = extractCausalEdges(sentenceSpans, variables, cfg)
  // 5. Consolidation
  const edges = consolidateEdges(rawEdges, cfg)
  const graph = buildGraph(variables, edges)
  // 6. Loop discovery
  const loops = findSimpleCycles(graph)
  // 7. Export
  let exports
  if (opts.exportDir) {
    exports = await exportAll(opts.exportDir, opts.baseName || 'causal', graph, loops)
  }

  return {
    documents,
    sentences: sentenceSpans,
    themes,
    variables,
    containment,
    edges,
    graph,
    loops,
    exports
  }
}
