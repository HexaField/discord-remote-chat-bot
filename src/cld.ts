import fs from 'fs'
import { callLLM, getEmbedding } from './llm'

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

1. You will identify all the words that have cause and effect between two entities in the text. These entities are variables. \
Name these variables in a concise manner. A variable name should not be more than 2 words. Make sure that you minimize the number of variables used. Variable names should be neutral, i.e., \
it shouldn't have positive or negative meaning in their names.

2. For each variable, represent the causal relationships with other variables. There are two types of causal relationships: positive and negative.\
A positive relationship exists if a decline in variable1 leads to a decline in variable2. Also a positive relationship exists if an increase in variable1 leads to an increase in variable2.\
If there is a positive relationship, use the format: "Variable1" -->(+) "Variable2".\
A negative relationship exists if an increase in variable1 leads to a decline in variable2. Also a negative relationship exists if a decline in variable1 leads to an increase in variable2.\
If there is a negative relationship, use the format: "Variable1" -->(-) "Variable2".

3. Not all variables may have any relationship with any other variables.

4. When three variables are related in a sentence, make sure the relationship between second and third variable is correct.\
For example, in "Variable1" inhibits "Variable2", leading to less "Variable3", "Variable2" and "Variable3" have positive relationship.


5. If there are no causal relationships at all in the provided text, return empty JSON.

Example 1 of a user input:
"when death rate goes up, population decreases"

Corresponding JSON response:
{"1": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "Death rate --> (-) population",  "relevant text": "[the full text/paragraph that highlights this relationship]"}}

Example 2 of a user input:
"increased death rate reduces population"

Corresponding JSON response:
{"1": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "Death rate --> (-) population",  "relevant text": "[the full text/paragraph that highlights this relationship]"}}

Example 3 of a user input:
"lower death rate increases population"

Corresponding JSON response:
{"1": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "Death rate --> (-) population",  "relevant text": "[the full text/paragraph that highlights this relationship]"}}

Example 4 of a user input:
"The engineers compare the work remaining to be done against the time remaining before the deadline. The larger the gap, the more Schedule Pressure they feel. \
When schedule pressure builds up, engineers have several choices. First, they can work overtime. Instead of the normal 50 hours per week, they can come to work early, \
skip lunch, stay late, and work through the weekend. By burning the Midnight Oil, the increase the rate at which they complete their tasks, cut the backlog of work, \
and relieve the schedule pressure. However, if the workweek stays too high too long, fatigue sets in and productivity suffers. As productivity falls, the task completion rate drops, \
which increase schedule pressure and leads to still longer hours. Another way to complete the work faster is to reduce the time spent on each task. \
Spending less time on each task boosts the number of tasks done per hour (productivity) and relieve schedule pressure. \
Lower time per task increases error rate, which leads to rework and lower productivity in the long run."

Corresponding JSON response (truncated):
{
  "1": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "work remaining -->(+) Schedule Pressure", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "2": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "time remaining -->(-) Schedule Pressure", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "3": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "Schedule Pressure --> (+) overtime", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "4": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "overtime --> (+) completion rate", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "5": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "completion rate --> (-) work remaining", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "6": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "overtime --> (+) fatigue", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "7": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "fatigue --> (-) productivity", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "8": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "productivity --> (+) completion rate", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "9": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "Schedule Pressure --> (-) Time per task", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "10": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "Time per task --> (-) error rate", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "11": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "error rate --> (-) productivity", "relevant text": "[the full text/paragraph that highlights this relationship]"}
}

Example 5 of a user input:
"Congestion (i.e., travel time) creates pressure for new roads; after the new capacity is added, travel time falls, relieving the pressure. \
New roads are built to relieve congestion. In the short run, travel time falls and atractiveness of driving goes up—the number of cars in the region hasn’t changed and -\
people’s habits haven’t adjusted to the new, shorter travel times. \
As people notice that they can now get around much faster than before, they will take more Discretionary trips (i.e., more trips per day). They will also travel extra miles, leading to higher trip length. \
Over time, seeing that driving is now much more attractive than other modes of transport such as the public transit system, some people will give up the bus or subway and buy a car. \
The number of cars per person rises as people ask why they should take the bus."

Corresponding JSON response (truncated):
{
  "1": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "travel time --> (+) pressure for new roads", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "2": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "pressure for new roads --> (+) road construction", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "3": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "road construction --> (+) Highway capacity", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "4": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "Highway capacity --> (-) travel time", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "5": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "travel time --> (-) attractiveness of driving", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "6": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "attractiveness of driving --> (+) trips per day", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "7": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "trips per day --> (+) traffic volume", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "8": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "traffic volume --> (+) travel time", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "9": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "attractiveness of driving --> (+) trip length", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "10": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "trip length --> (+) traffic volume", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "11": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "attractiveness of driving --> (-) public transit", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "12": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "public transit --> (-) cars per person", "relevant text": "[the full text/paragraph that highlights this relationship]"},
  "13": {"reasoning": "[your reasoning for this causal relationship]", "causal relationship": "cars per person --> (+) traffic volume", "relevant text": "[the full text/paragraph that highlights this relationship]"}
}

Example 6 of a user input:
"[Text with no causal relationships]"

Corresponding JSON response:
{}

Please ensure that you only provide the appropriate JSON response format and nothing more. Ensure that you follow the example JSON response formats provided in the examples.
`

export async function generateCausalRelationships(
  question: string,
  threshold = 0.85,
  verbose = false,
  llmModel = 'github-copilot/gpt-5-mini',
  embeddingModel = 'bge-m3:latest'
) {
  const sentences = simpleSentenceSplit(question)
  const embeddings = await initEmbeddings(sentences, embeddingModel)
  // Mirror the original Python multi-step flow:
  // 1) initial generation (JSON numbered dict with 'causal relationship', 'reasoning', 'relevant text')
  // 2) follow-up to close implied loops
  // 3) normalize and merge the two responses
  // 4) map to tuples and return a numbered list of corrected relationships after variable checking

  // Step 1: initial generation
  const resp1 = await callLLM(systemPrompt, question, 'opencode', llmModel)
  if (!resp1.success || !resp1.data) throw new Error('LLM failed to produce an initial response')
  const response1 = loadJson(resp1.data)
  if (!response1 || Object.keys(response1).length === 0) {
    throw new Error('Input text did not have any causal relationships!')
  }

  // Step 2: ask the model to find closed loops and add extra relationships if needed
  const loopQuery = `Find out if there are any possibilities of forming closed loops that are implied in the text. If yes, then close the loops by adding the extra relationships and provide them in a JSON format please.`
  const resp2 = await callLLM(systemPrompt, loopQuery, 'opencode', llmModel)
  const response2 = resp2.success && resp2.data ? loadJson(resp2.data) : null

  // Only merge if response2 has actual content
  const merged: any = response2 && Object.keys(response2).length > 0 ? { ...response1, ...response2 } : response1

  // Normalize merged into an object mapping like Python expected
  const responseDict: { [k: string]: any } = merged

  const lines: Array<[string, string, string]> = []
  for (const k of Object.keys(responseDict)) {
    const entry = responseDict[k]
    const rel =
      entry['causal relationship'] ||
      entry['relationship'] ||
      entry['causal_relationship'] ||
      entry['causal relationship']
    const reasoning = entry['reasoning'] || ''
    const relevant = entry['relevant text'] || entry['relevant_text'] || entry['relevant text'] || ''
    // Only call getLine if relevant text is non-empty
    const relevantTextLine = relevant ? await getLine(embeddings, embeddingModel, sentences, String(relevant)) : ''
    lines.push([String(rel || '').toLowerCase(), String(reasoning || ''), String(relevantTextLine || '')])
  }

  // Step 3: check and merge similar variables via LLM-driven logic
  const checked = await checkVariables(embeddings, embeddingModel, sentences, threshold, llmModel, question, lines)
  console.log('Checked', checked.length, 'relationships')

  // Step 4: verify each relationship and produce final corrected lines (1-based numbering)
  const corrected: string[] = []
  for (let i = 0; i < checked.length; i++) {
    const vals = checked[i]
    const relevantTxt = vals[2]
    const verified = await checkCausalRelationships(vals[0], vals[1], relevantTxt)
    corrected.push(`${i + 1}. ${verified}`)
  }

  // dedupe and normalize lines
  const correctedLines = corrected.map((l) => l.replace(/^[0-9]+\.\s*/, '').trim()).filter(Boolean)
  const uniq = Array.from(new Set(correctedLines))

  function normalizeLine(line: string): string | null {
    let s = line.trim()
    if (!s.includes('-->')) return null
    const parts = s.split('-->')
    let left = parts[0].trim()
    let right = parts.slice(1).join('-->').trim()

    // detect existing symbol
    const symbolMatch = right.match(/\(\+\)|\(\-\)/)
    let symbol = symbolMatch ? symbolMatch[0] : ''
    // remove any existing symbol from right
    right = right.replace(/\(\+\)|\(\-\)/g, '').trim()

    left = left
      .replace(/["'()\.,]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    right = right
      .replace(/["'()\.,]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!left || !right) return null
    return `${left} -->${symbol} ${right}`
  }

  const normalized: string[] = []
  for (const l of uniq) {
    const n = normalizeLine(l)
    if (n) normalized.push(n)
  }
  // Deduplicate normalized relationships
  const uniqNormalized = Array.from(new Set(normalized))

  const nodes = [] as string[]
  const relationships = [] as { subject: string; predicate: string; object: string }[]

  for (const rel of uniqNormalized) {
    const arrowStart = rel.indexOf('-->')
    const positive = rel.includes('-->(+)')
    const subject = rel.slice(0, arrowStart).trim()
    const object = rel
      .slice(arrowStart + 3)
      .replace(/\(\+\)|\(\-\)/, '')
      .trim()
    const predicate = positive ? 'positive' : 'negative'
    relationships.push({ subject, predicate, object })
    if (!nodes.includes(subject)) nodes.push(subject)
    if (!nodes.includes(object)) nodes.push(object)
  }

  return { statements: uniqNormalized, nodes, relationships }
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

async function checkCausalRelationships(
  relationship: string,
  reasoning: string,
  relevant_txt: string,
  llmModel?: string
) {
  const [var1, var2] = extractVariables(relationship)
  const prompt = `Relationship: ${relationship}\nRelevant Text: ${relevant_txt}\nReasoning: ${reasoning}\n\nGiven the above text, select which of the following options are correct (there may be more than one):\n1. increasing ${var1} increases ${var2}\n2. decreasing ${var1} decreases ${var2}\n3. increasing ${var1} decreases ${var2}\n4. decreasing ${var1} increases ${var2}\n\nRespond in JSON with keys 'answers' (a list of numbers) and 'reasoning'.`

  const resp = await callLLM(prompt, '', 'ollama', 'llama3.1:8b')
  if (!resp.success || !resp.data) {
    throw new Error('LLM failed while checking causal relationship')
  }
  const parsed = loadJson(resp.data)
  let steps: string[] = []
  if (parsed && parsed.answers) {
    try {
      // answers could be a string like "[1,2]" or an array
      if (Array.isArray(parsed.answers)) {
        steps = parsed.answers.map(String)
      } else if (typeof parsed.answers === 'string') {
        steps = (parsed.answers.match(/\d+/g) || []).map(String)
      }
    } catch (e) {
      steps = []
    }
  }
  // fallback: try to extract digits from raw data
  if (steps.length === 0) {
    const nums = (resp.data || '').match(/\d+/g) || []
    steps = nums
  }

  if (steps.includes('1') || steps.includes('2')) {
    return `${var1} -->(+) ${var2}`
  } else if (steps.includes('3') || steps.includes('4')) {
    return `${var1} -->(-) ${var2}`
  } else {
    throw new Error('Unexpected answer while verifying causal relationship' + JSON.stringify(parsed))
  }
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
  lines: Array<[string, string, string]>
) {
  const result_list = lines.map((l) => l[0])
  const reasoning_list = lines.map((l) => l[1])
  const rel_txt_list = lines.map((l) => l[2])
  // collect variables
  const variable_set = new Set<string>()
  for (const line of result_list) {
    const [v1, v2] = extractVariables(line)
    if (v1) variable_set.add(v1)
    if (v2) variable_set.add(v2)
  }
  const variable_list = Array.from(variable_set)
  const variable_to_index: { [k: string]: number } = {}
  const index_to_variable: { [k: number]: string } = {}
  for (let i = 0; i < variable_list.length; i++) {
    variable_to_index[variable_list[i]] = i
    index_to_variable[i] = variable_list[i]
  }

  const similar_variables = await computeSimilarities(embeddingModel, threshold, variable_to_index, index_to_variable)
  if (!similar_variables) return lines

  // Prepare merge prompt (mirror Python system prompt)
  const mergeSystem = `You are a Professional System Dynamics Modeler.\nYou will be provided with: Text, Relationships, and Similar Variables. Merge similar variable names choosing the shorter name, update relationships, and return JSON as in the examples.`
  const prompt = `Text:\n${text}\nRelationships:\n${JSON.stringify(lines)}\nSimilar Variables:\n${JSON.stringify(similar_variables)}`
  const resp = await callLLM(mergeSystem, prompt, 'opencode', llmModel)
  if (!resp.success || !resp.data) throw new Error('LLM failed while merging similar variables')
  const parsed = loadJson(resp.data)
  if (!parsed) throw new Error('Got no corrected response from the assistant')

  let relationships: any[] = []
  if (parsed['Step 2'] && parsed['Step 2']['Final Relationships']) {
    relationships = parsed['Step 2']['Final Relationships']
  } else {
    // try to flatten numbered dict like Python
    try {
      const keys = Object.keys(parsed).sort((a, b) => {
        const na = a.match(/\d+/)?.[0]
        const nb = b.match(/\d+/)?.[0]
        return Number(na || a) - Number(nb || b)
      })
      for (const k of keys) {
        const entry = parsed[k]
        const rel =
          entry['causal relationship'] ||
          entry['relationship'] ||
          entry['causal_relationship'] ||
          entry['causal relationship']
        const reasoning = entry['reasoning'] || ''
        const relevant = entry['relevant text'] || entry['relevant_text'] || ''
        relationships.push({ relationship: rel, reasoning, 'relevant text': relevant })
      }
    } catch (e) {
      throw new Error('Could not normalize merged response')
    }
  }

  const new_lines: Array<[string, string, string]> = []
  for (const r of relationships) {
    const relevantTxt = await getLine(embeddings, embeddingModel, sentences, String(r['relevant text'] || ''))
    new_lines.push([
      String((r['relationship'] || r['causal relationship'] || '').toLowerCase()),
      String(r['reasoning'] || ''),
      relevantTxt
    ])
  }
  return new_lines
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
