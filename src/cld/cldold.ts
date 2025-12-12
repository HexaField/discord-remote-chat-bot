import { callLLM } from '../interfaces/llm'
import { debug } from '../interfaces/logger'

export type RelationshipEntry = {
  subject: string
  object: string
  predicate: string
  reasoning: string
  relevant: string[]
  createdAt: string
}

export type NodeType = 'driver' | 'obstacle' | 'actor' | 'other'
export type Node = { label: string; type: NodeType }

const systemPrompt = `You are a System Dynamics Professional Modeler.
Users will give text, and it is your job to generate causal relationships from that text that can be used to build a causal loop diagram. All variables must be connected into a single graph.
You will conduct a multistep process:

1. Identify all words that imply cause and effect between two entities in the text. These entities are variables.
   - Name variables concisely (maximum 2 words).
   - Minimize the number of distinct variables.
   - Variable names should be neutral (no positive/negative connotation).

2. For each relationship, output a JSON object with explicit fields:
   - subject: the cause variable name (string)
   - predicate: one of "positive" or "negative" (string)
   - object: the effect variable name (string)
   - reasoning: brief explanation (string)
   - relevant: the exact text span(s) that supports the relationship (array of strings, may be multiple)

3. Not all variables must have relationships. Only output relationships that are clearly supported by the text and is relevant to the main topic.

4. If there are no causal relationships in the provided text, return any empty array.

Only return the JSON as an array of the objects described above. Do not include any additional text or explanation.
`

const mediumLLMModel = 'llama3.1:8b'

export async function generateCausalRelationships(
  sentences: string[],
  onProgress: (msg: string) => void,
  verbose = false,
  embeddingModel = 'bge-m3:latest',
  sessionId?: string,
  sessionDir?: string
) {
  // Auto-create a session if none provided to ensure persistence
  if (!sessionId) {
    sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    debug('Generated new sessionId for causal relationship generation:', sessionId)
  }
  onProgress(`Generating Causal Relationships: Summarising ${sentences.length} sentences...`)
  // Generate a short topic summary: ask the LLM to produce a few short sentences about
  // the overall topic of the provided transcript. We join those sentences into a
  // single topic string which will be used to classify sentence relevance below.
  const joined = sentences.join('').split('.').join('.\n')
  let topicSummary = ''
  try {
    const topicSystem = `You are a helpful assistant. Given a transcript, generate 2-4 short sentences that describe the main topic(s) covered. Return only the sentences, each on its own line.`
    const topicResp = await callLLM(topicSystem, joined, 'ollama', mediumLLMModel)
    if (topicResp && topicResp.success && topicResp.data) {
      // convert to string and split into sentences, then join into single-line summary
      const raw = String(topicResp.data)
      const topicLines = raw
        .split(/\r?\n/) // split on newlines
        .map((s) => s.trim())
        .filter(Boolean)
      topicSummary = topicLines.join(' ')
    }
  } catch (e) {
    if (verbose) console.warn('Failed to generate topic summary:', e)
    topicSummary = ''
  }

  // Step 1 (per section)
  // Use session only for opencode provider calls to maintain cross-call context.
  const resp1 = await callLLM(systemPrompt, joined, 'opencode', 'github-copilot/gpt-5-mini', {
    sessionId: sessionId,
    sessionDir: sessionDir
  })
  if (!resp1.success || !resp1.data) {
    throw new Error('Failed to call LLM for causal relationship extraction')
  }
  const response1 = loadJson(resp1.data)
  // If empty, skip this section silently
  if (!response1 || Object.keys(response1).length === 0) {
    throw new Error('Failed to extract any causal relationships from input text')
  }

  const relationships: RelationshipEntry[] = Array.isArray(response1) ? response1 : [response1]

  onProgress(`Generating Causal Relationships: Processing ${Object.keys(relationships).length} relationships...`)

  // Build temporary structured relationship objects (preserve provenance)
  const entries: RelationshipEntry[] = []
  for (const entry of relationships) {
    const subject = entry.subject
    const object = entry.object
    const predicate = entry.predicate
    const reasoning = entry.reasoning
    const relevant = entry.relevant

    if (!subject || !object || !predicate) {
      console.warn('Skipping incomplete entry:', entry)
      continue
    }

    /** @todo split up potentially multiple relevant lines the LLM returns, usually separated by '...' */
    // const relevantTextLine = relevant
    //   ? await getLine(embeddings, embeddingModel, filteredSentences, String(relevant))
    //   : ''
    entries.push({
      subject: subject.toLowerCase(),
      object: object.toLowerCase(),
      predicate: predicate,
      reasoning: reasoning,
      relevant: relevant,
      createdAt: new Date().toISOString()
    })
  }

  const nodes = [] as string[]

  for (const e of entries) {
    if (!nodes.includes(e.subject)) nodes.push(e.subject)
    if (!nodes.includes(e.object)) nodes.push(e.object)
  }

  // Classify each node into one of the provided categories using the LLM, with
  // a small local heuristic fallback. The classification is attached to each
  // relationship as subjectType/objectType so downstream exporters can style
  // nodes without requiring a breaking change to the nodes array shape.
  // Prepare a compact instruction asking for a JSON mapping
  const sys = `You are a System Dynamics Modeler. Given a list of variable names, classify each variable into one of the following categories: 
- driver: external positive influences, generators, attractors, or outcomes/goals
- obstacle: things that steer the system away from its goals (barriers, friction)
- actor: people, agents, or processes that operate in/through the system
- other: none of the above

Return ONLY a single JSON object mapping the variable name to one of the strings: driver, obstacle, actor, other. Example: {"work remaining":"driver","fatigue":"obstacle"}`

  const nodesWithTypes: Node[] = []
  const promptBody = nodes.join('\n') + '\n\nContext:\n' + (joined || '')
  onProgress(`Classifying ${nodes.length} nodes...`)
  const resp = await callLLM(sys, promptBody, 'opencode', 'github-copilot/gpt-5-mini', {
    sessionId: sessionId,
    sessionDir: sessionDir
  })
  debug('Node classification LLM response:', resp?.success)
  if (resp && resp.success && resp.data) {
    const parsed = loadJson(String(resp.data))
    if (parsed && typeof parsed === 'object') {
      for (const k of Object.keys(parsed)) {
        const v = String(parsed[k] || '').toLowerCase()
        if (v === 'driver' || v === 'obstacle' || v === 'actor' || v === 'other') {
          nodesWithTypes.push({ label: k, type: v as NodeType })
        }
      }
    }
  }

  debug('Classified node types:', nodesWithTypes)

  return { nodes: nodesWithTypes, relationships: entries }
}

function loadJson(text: string) {
  if (!text || typeof text !== 'string') return null
  // Try to extract codefence JSON first
  const m = text.match(/```json\n([\s\S]*?)```/i)
  if (m && m[1]) {
    try {
      return JSON.parse(m[1])
    } catch (e) {
      // fall through
    }
  }
  // Try plain JSON parse
  try {
    return JSON.parse(text)
  } catch (e) {
    // Try to find the first { ... } block
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    if (first !== -1 && last !== -1 && last > first) {
      const sub = text.substring(first, last + 1)
      try {
        return JSON.parse(sub)
      } catch (e2) {
        return null
      }
    }
    return null
  }
}
