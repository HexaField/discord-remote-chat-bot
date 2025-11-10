// Data model per adr.md

export type Group = 'policy' | 'industry' | 'users' | 'local_authority' | 'other'

export interface Document {
  id: string
  title?: string
  metadata?: Record<string, any>
  text: string
  sourceUri?: string
}

export interface Span {
  docId: string
  start: number
  end: number
  textPreview: string
}

export type CodeType = 'theme' | 'variable'

export interface Code {
  id: string
  label: string
  type: CodeType
  group: Group
  notes?: string
  evidence?: Span[]
}

export interface Containment {
  parentCodeId: string
  childCodeId: string
  relation: 'contains'
}

export type Polarity = '+' | '-'

export interface CausalEdge {
  id: string
  fromVariableId: string
  toVariableId: string
  polarity: Polarity
  confidence: number // [0,1]
  evidence: Span[]
  notes?: string
}

export interface Graph {
  variables: Code[] // codes with type = 'variable'
  edges: CausalEdge[]
}

export type LoopType = 'reinforcing' | 'balancing'

export interface Loop {
  id: string
  nodeIds: string[] // code ids
  edgeIds: string[] // edge ids
  type: LoopType
  evidence: string[] // edgeIds duplicated for clarity
}

export interface ExportBundle {
  graphJsonPath: string
  csvNodesPath?: string
  csvEdgesPath?: string
  cldSvgPath?: string
  cldPngPath?: string
  provenanceHtmlPath?: string
}

export interface PipelineArtifacts {
  documents: Document[]
  sentences: Span[]
  themes: Code[]
  variables: Code[]
  containment: Containment[]
  edges: CausalEdge[]
  graph: Graph
  loops: Loop[]
}

export interface CausalConfig {
  cueLexicon: {
    positive: string[]
    negative: string[]
    generic: string[]
  }
  groupRules: Array<{ pattern: RegExp; group: Group }>
  themeStopwords: string[]
  themeMinLength: number
  themeMaxWords: number
  themeToVariableMap: Record<string, string>
  variableSynonyms: Record<string, string[]> // canonical -> synonyms
  pruneThreshold: number
  confidence: {
    base: number
    positiveBonus: number
    negativeBonus: number
    cueWeight: number
    distanceWeight: number
    maxPerSentenceEdges: number
  }
}
