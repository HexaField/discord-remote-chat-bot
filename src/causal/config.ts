import { CausalConfig, Group } from './types'

const DEFAULT_STOPWORDS = [
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'by',
  'from',
  'that',
  'this',
  'is',
  'are',
  'was',
  'were',
  'be',
  'as',
  'it',
  'at',
  'we',
  'they',
  'you',
  'i',
  'he',
  'she',
  'them',
  'our'
]

export const defaultConfig: CausalConfig = {
  cueLexicon: {
    positive: [
      'leads to',
      'results in',
      'increases',
      'raises',
      'boosts',
      'amplifies',
      'reinforces',
      'grows',
      'more',
      'higher'
    ],
    negative: [
      'reduces',
      'decreases',
      'lowers',
      'diminishes',
      'mitigates',
      'limits',
      'inhibits',
      'constraints',
      'less',
      'lower'
    ],
    generic: ['causes', 'because', 'due to', 'therefore', 'so that', 'so']
  },
  groupRules: [
    { pattern: /policy|regulation|minister|department/i, group: 'policy' as Group },
    { pattern: /industry|firm|company|engineer|contractor|builder/i, group: 'industry' as Group },
    { pattern: /user|resident|people|public|customer|household/i, group: 'users' as Group },
    { pattern: /local\s*authorit|council|city|municipal/i, group: 'local_authority' as Group }
  ],
  themeStopwords: DEFAULT_STOPWORDS,
  themeMinLength: 3,
  themeMaxWords: 4,
  // Default mappings for fixtures referenced in the ADR acceptance text
  themeToVariableMap: {
    // Keep underperformance distinct from performance to allow balancing loops
    underperformance: 'underperformance',
    'low performance': 'underperformance',
    resource: 'resource allocation',
    resources: 'resource allocation',
    allocation: 'resource allocation',
    scrapping: 'scrapping',
    rework: 'rework',
    design: 'design quality',
    'better design': 'design quality'
  },
  variableSynonyms: {
    performance: ['building performance'],
    underperformance: ['low performance', 'poor performance'],
    'resource allocation': ['resources', 'resource', 'allocation'],
    'design quality': ['design', 'better design'],
    rework: ['rework', 're-work'],
    competence: ['capability', 'capabilities']
  },
  pruneThreshold: 0.35,
  confidence: {
    base: 0.4,
    positiveBonus: 0.15,
    negativeBonus: 0.15,
    cueWeight: 0.35,
    distanceWeight: 0.10,
    maxPerSentenceEdges: 3
  }
}

export default defaultConfig
