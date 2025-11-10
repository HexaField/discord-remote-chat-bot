import fs from 'fs'
import { callLLM, getEmbedding } from './llm'
import { debug, warn } from './logger'

export type RelationshipEntry = {
  subject: string
  object: string
  predicateRaw: string
  reasoning: string
  relevant: string
  createdAt: string
  sourceSentenceIndex?: number
}

export type VerifiedRelationship = {
  subject: string
  object: string
  predicate: string // 'positive' | 'negative'
  reasoning: string
  relevant: string
  createdAt: string
  verifiedAt: string
  provenance?: any
}

export type NodeType = 'driver' | 'obstacle' | 'actor' | 'other'
export type Node = { label: string; type?: NodeType; provenance?: any }

function simpleSentenceSplit(text: string): string[] {
  // very simple sentence splitter
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const systemPrompt = `You are a System Dynamics Professional Modeler.
Users will give text, and it is your job to generate causal relationships from that text.
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
   - relevant text: the exact text span that supports the relationship (string)

   Definitions:
   - positive: increasing subject increases object AND decreasing subject decreases object
   - negative: increasing subject decreases object AND decreasing subject increases object

3. Not all variables must have relationships.

4. If there are no causal relationships in the provided text, return empty JSON {}.

Only return the JSON as shown—no prose, no markdown.
`

export async function generateCausalRelationships(
  sentences: string[],
  onProgress: (msg: string) => void,
  threshold = 0.85,
  verbose = false,
  llmModel = 'llama3.1:8b',
  embeddingModel = 'bge-m3:latest'
) {
  // Generate a short topic summary: ask the LLM to produce a few short sentences about
  // the overall topic of the provided transcript. We join those sentences into a
  // single topic string which will be used to classify sentence relevance below.
  let topicSummary = ''
  try {
    const topicSystem = `You are a helpful assistant. Given a transcript, generate 2-4 short sentences that describe the main topic(s) covered. Return only the sentences, each on its own line.`
    const joined = sentences.join('\n')
    const topicResp = await callLLM(topicSystem, joined, 'ollama', 'llama3.1:8b')
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

  const embeddings = await initEmbeddings(sentences, embeddingModel)

  let globalIndex = 1
  const aggregated: { [k: string]: any } = {}
  let anyFound = false

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i]
    const sec = sentence.trim()
    if (!sec) continue
    // If we have a topic summary, classify this sentence as relevant or irrelevant
    // to the topic. The classifier is constrained to answer only 'yes' or 'no'.
    if (topicSummary) {
      try {
        const clsSystem = `You are a classification assistant. Here is a short topic summary:\n${topicSummary}\n\nFor the given sentence, answer ONLY 'yes' or 'no' (lowercase) indicating whether the sentence is relevant to the topic summary.`
        const clsResp = await callLLM(clsSystem, sec, 'ollama', 'llama3.1:8b')
        if (clsResp && clsResp.success && clsResp.data) {
          const ans = String(clsResp.data).trim().toLowerCase()
          // Accept responses that start with yes/no
          const first = (ans.match(/^(yes|no)/) || [])[0]
          if (first === 'no') {
            // skip irrelevant sentence
            debug(`Skipping sentence ${i + 1} as irrelevant to topic`)
            continue
          }
          // If it's 'yes' we proceed. If uncertain, we proceed as a conservative default.
        }
      } catch (e) {
        debug('Classification failed, proceeding with sentence:', e)
      }
    }
    // Step 1 (per section)
    const resp1 = await callLLM(systemPrompt, sec, 'ollama', 'llama3.1:8b')
    if (!resp1.success || !resp1.data) {
      warn('LLM failed to produce initial response for a section')
      continue
    }
    const response1 = loadJson(resp1.data)
    // If empty, skip this section silently
    if (!response1 || Object.keys(response1).length === 0) {
      debug('No causal relationships in section')
      continue
    }
    anyFound = true

    // Step 2 (per section) - loop closure specific to this section.
    // const loopQuery = `Find out if there are any possibilities of forming closed loops that are implied in the text. If yes, then close the loops by adding the extra relationships and provide them in a JSON format please.`
    // const resp2 = await callLLM(systemPrompt, loopQuery, 'ollama', 'llama3.1:8b')
    // const response2 = resp2.success && resp2.data ? loadJson(resp2.data) : null

    const response2 = response1

    const mergedSection: any =
      response2 && Object.keys(response2).length > 0 ? { ...response1, ...response2 } : response1

    // Reindex merged section entries into aggregated dict.
    const keys = Object.keys(mergedSection)
    for (const k of keys) {
      const entry = mergedSection[k]
      aggregated[String(globalIndex++)] = entry
    }

    onProgress(`Generating Causal Relationships: Processed ${i + 1} of ${sentences.length} sections`)
  }

  if (!anyFound) throw new Error('Input text did not have any causal relationships across all sections!')

  const responseDict: {
    [k: string]: {
      subject: string
      predicate: string
      object: string
      reasoning: string
      relevant: string
    }
  } = aggregated

  // Build temporary structured relationship objects (preserve provenance)
  const entries: RelationshipEntry[] = []
  for (const k of Object.keys(responseDict)) {
    const entry = responseDict[k]
    const subject = entry.subject
    const object = entry.object
    const predicateRaw = entry.predicate
    const reasoning = entry.reasoning
    const relevant = entry.relevant

    if (!subject || !object || !predicateRaw) {
      console.warn('Skipping incomplete entry:', entry)
      continue
    }

    const relevantTextLine = relevant ? await getLine(embeddings, embeddingModel, sentences, String(relevant)) : ''
    entries.push({
      subject: String(subject).toLowerCase(),
      object: String(object).toLowerCase(),
      predicateRaw: String(predicateRaw),
      reasoning: String(reasoning || ''),
      relevant: String(relevantTextLine || ''),
      createdAt: new Date().toISOString()
    })
  }

  onProgress(`Generating Causal Relationships: Checking ${entries.length} relationships...`)

  // Step 3: check and merge similar variables via LLM-driven logic (reuses existing helper)
  const checked = await checkVariables(
    embeddings,
    embeddingModel,
    sentences,
    threshold,
    llmModel,
    sentences.join('\n'),
    entries
  )

  console.log('Checked from', entries.length, 'to', checked.length, 'relationships')

  // Step 4: verify each relationship and produce final corrected structured entries
  const verifiedEntries: Array<{
    subject: string
    object: string
    predicate: string
    reasoning: string
    relevant: string
    createdAt: string
    verifiedAt: string
    provenance?: any
  }> = []

  for (let i = 0; i < checked.length; i++) {
    const vals = checked[i]
    const verified = await checkCausalRelationships(vals)
    verifiedEntries.push(verified)
  }

  console.log('Verified from', checked.length, 'to', verifiedEntries.length, 'relationships')

  onProgress(`Generating Causal Relationships: Formatting ${verifiedEntries.length} relationships...`)

  // Deduplicate normalized relationships by subject|predicate|object
  const uniqMap = new Map<string, (typeof verifiedEntries)[0]>()
  for (const e of verifiedEntries) {
    const key = `${e.subject}||${e.predicate}||${e.object}`
    if (!uniqMap.has(key)) {
      e.provenance = e.provenance || []
      uniqMap.set(key, e)
    } else {
      // merge provenance/reasoning: keep earliest createdAt and concatenate reasoning
      const existing = uniqMap.get(key)!
      if (e.createdAt < existing.createdAt) existing.createdAt = e.createdAt
      existing.reasoning = `${existing.reasoning}${existing.reasoning && e.reasoning ? ' | ' : ''}${e.reasoning}`
      existing.provenance = existing.provenance || []
      existing.provenance.push(e.provenance || { verifiedAt: e.verifiedAt })
    }
  }

  const nodes = [] as string[]
  const relationships = [] as Array<{
    subject: string
    predicate: string
    object: string
    reasoning: string
    relevant: string
    createdAt: string
    verifiedAt: string
    provenance?: any
    subjectType?: NodeType
    objectType?: NodeType
  }>

  for (const e of uniqMap.values()) {
    if (!nodes.includes(e.subject)) nodes.push(e.subject)
    if (!nodes.includes(e.object)) nodes.push(e.object)
    relationships.push(e)
  }

  // Classify each node into one of the provided categories using the LLM, with
  // a small local heuristic fallback. The classification is attached to each
  // relationship as subjectType/objectType so downstream exporters can style
  // nodes without requiring a breaking change to the nodes array shape.
  async function classifyNodes(nodeList: string[], textContext: string, llmModelLocal = llmModel) {
    const out: { [k: string]: NodeType } = {}
    if (!nodeList || nodeList.length === 0) return out

    // Prepare a compact instruction asking for a JSON mapping
    const sys = `You are a System Dynamics Modeler. Given a list of variable names, classify each variable into one of the following categories: 
- driver: external positive influences, generators, attractors, or outcomes/goals
- obstacle: things that steer the system away from its goals (barriers, friction)
- actor: people, agents, or processes that operate in/through the system
- other: none of the above

Return ONLY a single JSON object mapping the variable name to one of the strings: driver, obstacle, actor, other. Example: {"work remaining":"other","fatigue":"obstacle"}`

    const promptBody = nodeList.join('\n') + '\n\nContext:\n' + (textContext || '')
    try {
      onProgress(`Classifying ${nodeList.length} nodes...`)
      const resp = await callLLM(sys, promptBody, 'ollama', llmModelLocal)
      if (resp && resp.success && resp.data) {
        const parsed = loadJson(String(resp.data))
        if (parsed && typeof parsed === 'object') {
          for (const k of Object.keys(parsed)) {
            const v = String(parsed[k] || '').toLowerCase()
            if (v === 'driver' || v === 'obstacle' || v === 'actor' || v === 'other') out[k] = v as NodeType
          }
        }
      }
    } catch (e) {
      debug('Node classification LLM failed, falling back to heuristics', e)
    }

    // Fallback heuristics for any nodes not classified by LLM
    for (const n of nodeList) {
      if (out[n]) continue
      const s = n.toLowerCase()
      if (/(people|person|user|agent|engineer|team|staff|worker|customer|audience)/.test(s)) out[n] = 'actor'
      else if (/(goal|target|outcome|result|throughput|completion|increase|growth|gain)/.test(s)) out[n] = 'driver'
      else if (/(barrier|obstacle|friction|cost|delay|fatigue|error|loss|drop|resist)/.test(s)) out[n] = 'obstacle'
      else out[n] = 'other'
    }

    return out
  }

  const nodeTypes = await classifyNodes(nodes, sentences.join('\n'))

  // Convert nodes to objects with types
  const nodesWithTypes: Node[] = nodes.map((n) => ({ label: n, type: nodeTypes[n] || 'other' }))

  // Also attach types to relationships for backward compatibility
  for (const r of relationships) {
    r.subjectType = nodeTypes[String(r.subject)] || (nodeTypes[String(r.subject).toLowerCase()] as NodeType) || 'other'
    r.objectType = nodeTypes[String(r.object)] || (nodeTypes[String(r.object).toLowerCase()] as NodeType) || 'other'
  }

  return { nodes: nodesWithTypes, relationships }
}

async function initEmbeddings(sentences: string[], embeddingModel: string) {
  // Ollama has 512 max pending requests, so parallelize in batches
  const maxBatchSize = 512 / 2
  const embeddings: number[][] = []
  for (let i = 0; i < sentences.length; i += maxBatchSize) {
    const batch = sentences.slice(i, i + maxBatchSize)
    const batchEmbeddings = await Promise.all(batch.map((s) => getEmbedding(s, embeddingModel)))
    embeddings.push(...batchEmbeddings)
  }
  return embeddings
}

async function getLine(embeddings: number[][], embeddingModel: string, sentences: string[], query: string) {
  if (embeddings.length === 0) await initEmbeddings(sentences, embeddingModel)
  const qEmb = await getEmbedding(query, embeddingModel)
  let best = 0
  let idx = 0
  for (let i = 0; i < embeddings.length; i++) {
    const sim = cosineSimilarity(qEmb as number[], embeddings[i])
    if (sim > best) {
      best = sim
      idx = i
    }
  }
  return sentences[idx]
}

async function checkCausalRelationships(entry: RelationshipEntry, llmModel = 'llama3.1:8b') {
  const var1 = entry.subject
  const var2 = entry.object
  const prompt = `Relationship: ${var1} -> ${var2}\nRelevant Text: ${entry.relevant}\nReasoning: ${entry.reasoning}\n\nGiven the above text, select which of the following options are correct (there may be more than one):\n1. increasing ${var1} increases ${var2}\n2. decreasing ${var1} decreases ${var2}\n3. increasing ${var1} decreases ${var2}\n4. decreasing ${var1} increases ${var2}\n\nRespond in JSON with keys 'answers' (a list of numbers) and 'reasoning'.`

  const resp = await callLLM(prompt, '', 'ollama', llmModel)
  if (!resp.success || !resp.data) {
    throw new Error('LLM failed while checking causal relationship')
  }
  const parsed = loadJson(resp.data)
  let steps: string[] = []
  if (parsed && parsed.answers) {
    try {
      if (Array.isArray(parsed.answers)) {
        steps = parsed.answers.map(String)
      } else if (typeof parsed.answers === 'string') {
        steps = (parsed.answers.match(/\d+/g) || []).map(String)
      }
    } catch (e) {
      steps = []
    }
  }
  if (steps.length === 0) {
    const nums = (String(resp.data) || '').match(/\d+/g) || []
    steps = nums
  }

  let predicate = ''
  if (steps.includes('1') || steps.includes('2')) {
    predicate = 'positive'
  } else if (steps.includes('3') || steps.includes('4')) {
    predicate = 'negative'
  } else {
    throw new Error(
      'Unexpected answer while verifying causal relationship' + JSON.stringify(parsed) + JSON.stringify(steps)
    )
  }

  const verificationReasoning = parsed && parsed.reasoning ? String(parsed.reasoning) : ''

  const out: VerifiedRelationship = {
    subject: var1,
    object: var2,
    predicate,
    reasoning: `${entry.reasoning}${entry.reasoning && verificationReasoning ? ' | ' : ''}${verificationReasoning}`,
    relevant: entry.relevant,
    createdAt: entry.createdAt,
    verifiedAt: new Date().toISOString(),
    provenance: { llmRaw: resp.data }
  }
  return out
}

async function computeSimilarities(
  embeddingModel: string,
  threshold: number,
  variable_to_index: { [k: string]: number },
  index_to_variable: { [k: number]: string }
) {
  const names = Object.keys(variable_to_index)
  // Use real embeddings from Ollama - no fallbacks
  const jobs = names.map((n) => getEmbedding(n, embeddingModel))
  const embeddingList = (await Promise.all(jobs)) as number[][]

  // normalize
  const norms = embeddingList.map((v) => {
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    return v.map((x) => x / (mag || 1))
  })
  const h = norms.length
  const similar: Array<[string, string]> = []
  for (let i = 0; i < h; i++) {
    for (let j = i + 1; j < h; j++) {
      const a = norms[i]
      const b = norms[j]
      let dot = 0
      for (let k = 0; k < a.length; k++) dot += a[k] * (b[k] || 0)
      if (dot >= threshold) {
        similar.push([index_to_variable[i], index_to_variable[j]])
      }
    }
  }
  if (similar.length === 0) return null
  // convert to unique sorted tuples like Python
  const groups = similar.map((g) => g.sort().join('||'))
  const uniq = Array.from(new Set(groups)).map((s) => s.split('||'))
  return uniq as string[][]
}

async function checkVariables(
  embeddings: number[][],
  embeddingModel: string,
  sentences: string[],
  threshold: number,
  llmModel: string,
  text: string,
  entries: RelationshipEntry[]
) {
  // collect variables from structured entries
  const variable_set = new Set<string>()
  for (const e of entries) {
    if (e.subject) variable_set.add(e.subject)
    if (e.object) variable_set.add(e.object)
  }
  const variable_list = Array.from(variable_set)
  const variable_to_index: { [k: string]: number } = {}
  const index_to_variable: { [k: number]: string } = {}
  for (let i = 0; i < variable_list.length; i++) {
    variable_to_index[variable_list[i]] = i
    index_to_variable[i] = variable_list[i]
  }

  const similar_variables = await computeSimilarities(embeddingModel, threshold, variable_to_index, index_to_variable)
  if (!similar_variables) return entries

  // Prepare merge prompt to produce structured triples
  const mergeSystem = `You are a Professional System Dynamics Modeler.\nYou will be provided with: Text, Relationships, and Similar Variables.\n- Merge similar variable names by choosing the shorter neutral name.\n- Update every relationship accordingly.\n- Return JSON where each entry has: subject (string), predicate ("positive"|"negative"), object (string), reasoning (string), and relevant text (string).`
  const prompt = `You will receive a list of relationship objects and groups of similar variables to merge.\nRelationships:\n${JSON.stringify(
    entries
  )}\nSimilar Variables (pairs/groups to merge):\n${JSON.stringify(similar_variables)}\nPlease return a single JSON object mapping ordinal keys (\"1\", \"2\", ...) to entries with subject/predicate/object/reasoning/relevant text.`
  const resp = await callLLM(mergeSystem, prompt, 'ollama', 'llama3.1:8b')
  if (!resp.success || !resp.data) throw new Error('LLM failed while merging similar variables')
  const parsed = loadJson(resp.data)
  if (!parsed) throw new Error('Got no corrected response from the assistant')

  let relationships: any[] = []
  // Normalize either a keyed dict or an explicit array
  if (Array.isArray(parsed)) {
    relationships = parsed
  } else if (parsed && typeof parsed === 'object') {
    const keys = Object.keys(parsed).sort((a, b) => {
      const na = a.match(/\d+/)?.[0]
      const nb = b.match(/\d+/)?.[0]
      return Number(na || a) - Number(nb || b)
    })
    for (const k of keys) relationships.push(parsed[k])
  }

  // If the merge produced fewer relationships than we started with, prefer the
  // original entries to avoid accidental over-merging (preserve provenance).
  try {
    if (relationships.length < entries.length) {
      return entries
    }
  } catch (e) {
    // ignore
  }

  const new_entries: RelationshipEntry[] = []
  for (const r of relationships) {
    const subj = r['subject'] || r['from'] || r['variable1']
    const obj = r['object'] || r['to'] || r['variable2']
    const pred = r['predicate'] || r['polarity'] || r['sign']
    const reasoning = r['reasoning'] || ''
    const relevant = r['relevant text'] || r['relevant_text'] || r['relevant'] || ''
    if (!subj || !obj || !pred) continue
    const relevantTxt = await getLine(embeddings, embeddingModel, sentences, String(relevant || ''))
    new_entries.push({
      subject: String(subj).toLowerCase(),
      object: String(obj).toLowerCase(),
      predicateRaw: String(pred),
      reasoning: String(reasoning),
      relevant: String(relevantTxt || ''),
      createdAt: new Date().toISOString()
    })
  }
  return new_entries
}

export function extractVariables(relationship: string) {
  const parts = relationship.split('-->')
  if (parts.length < 2) return ['', '', '']
  let var1 = parts[0].trim().toLowerCase()
  let right = parts[1]
  let symbol = ''
  let var2 = right
    .replace(/\(\+\)|\(-\)/g, (s) => {
      symbol = s
      return ''
    })
    .trim()
    .toLowerCase()
  var1 = var1.replace(/[!.,;:]/g, '')
  var2 = var2.replace(/[!.,;:]/g, '')
  return [var1, var2, symbol]
}

export const RED = '\u001b[31m'
export const RESET = '\u001b[0m'

export function cosineSimilarity(a: number[], b: number[]) {
  const dot = a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0)
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0))
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0))
  if (magA === 0 || magB === 0) throw new Error('Zero magnitude vector')
  return dot / (magA * magB)
}

export function extractNumbers(input: string) {
  const m = input.match(/\d+/g)
  return m || []
}

function generateXmile(resultList: string[]) {
  let variablesDict: Record<string, string[]> = {}
  let connectors = ''
  for (const line of resultList) {
    const [v1, v2, symbol] = extractVariables(line)
    if (!v1 || !v2 || v1 === v2) continue
    if (!variablesDict[v2]) variablesDict[v2] = []
    variablesDict[v2].push(v1)
    connectors += `\t\t\t\t<connector polarity=\"${cleanSymbol(symbol)}\">\n`
    connectors += `\t\t\t\t\t<from>${xmileName(v1)}</from>\n`
    connectors += `\t\t\t\t\t<to>${xmileName(v2)}</to>\n`
    connectors += `\t\t\t\t</connector>\n`
  }

  let xmileVariables = ''
  for (const [variable, causers] of Object.entries(variablesDict)) {
    xmileVariables += `\t\t\t<aux name=\"${variable}\">\n`
    xmileVariables += `\t\t\t\t<eqn>NAN(${causers.map((c) => xmileName(c)).join(',')})</eqn>\n`
    xmileVariables += `\t\t\t\t<isee:delay_aux/>\n`
    xmileVariables += `\t\t\t</aux>\n`
  }

  const xmile = `<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<xmile version=\"1.0\">\n\t<model>\n\t\t<variables>\n${xmileVariables}\t\t</variables>\n\t\t<views>\n\t\t\t${connectors}\t\t</views>\n\t</model>\n</xmile>`
  return xmile
}

export function xmileName(displayName: string) {
  return displayName.split(/\s+/).join('_')
}

export function cleanSymbol(symbol: string) {
  return symbol.replace(/[()]/g, '')
}

export function loadJson(text: string) {
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

export function cleanUp(text: string) {
  // Extract numbered list items
  const pattern = /\d+\.[^\n]*(?:\n(?!\d+\.).*)*/g
  const items = text.match(pattern) || []
  return items.map((i) => i.replace(/\n\s*/g, ' ').trim()).join('\n')
}

export function saveFile(path: string, content: string) {
  fs.writeFileSync(path, content, { encoding: 'utf8' })
}
