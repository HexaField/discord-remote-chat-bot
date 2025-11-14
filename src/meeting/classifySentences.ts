import { callLLM } from '../interfaces/llm'

export type CategorisedSentence = {
  /**
   * The original sentence from the transcript.
   */
  sentence: string
  /**
   * The category label assigned to the sentence.
   */
  type: string
  /**
   * The agent or speaker who made the statement.
   */
  agent: string
  /**
   * Optional field to link this sentence to related sentences.
   */
  relatedTo?: string | string[]
}

/**
 * Extract raw spoken sentences from a VTT transcript and clean them.
 */
export const extractSentences = (transcript: string): CategorisedSentence[] => {
  if (!transcript) return []

  const lines = transcript.split(/\r?\n/)
  const seen = new Set<string>()
  const out: CategorisedSentence[] = []

  // Regexes
  const speakerTag = /^<v\s+([^>]+)>\s*/i
  const bracketAnnotation = /\[[^\]]+\]/g

  for (let raw of lines) {
    const line = raw.trim()
    if (!line) continue
    // skip header
    if (/^WEBVTT$/i.test(line)) continue
    // skip timestamp lines
    if (line.includes('-->')) continue

    // remove any HTML tags besides the speaker tag (we handle speaker tag separately)
    let agent = ''
    let text = line
    const m = text.match(speakerTag)
    if (m) {
      agent = m[1].trim()
      text = text.replace(speakerTag, '')
    }

    // strip any remaining HTML tags
    text = text.replace(/<[^>]+>/g, '')
    // remove bracketed annotations like [LAUGHTER], [inaudible], [BLANK_AUDIO]
    text = text.replace(bracketAnnotation, '')
    // normalize whitespace
    text = text.replace(/\s+/g, ' ').trim()

    if (!text) continue

    // dedupe preserving first occurrence
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    out.push({
      sentence: text,
      type: '',
      agent: agent || 'unknown'
    })
  }

  return out
}

function parseFencedJSON(fenced: string) {
  if (!fenced) return null
  // Enforce JSON code fence: only accept JSON inside ```json ... ```
  const m = fenced.match(/```(?:json\n)?([\s\S]*?)```/i)
  if (!m) return null
  const payload = m[1]
  try {
    return JSON.parse(payload)
  } catch (e) {
    return null
  }
}

export async function classifySentence(
  sentence: string,
  previous: CategorisedSentence[] = [],
  ontology: Array<{ label: string; explanation: string; examples: string[] }>
) {
  const labels = ontology.map((m) => m.label)

  const ontologyText = ontology.map((m) => `- ${m.label}: ${m.explanation}\n`).join('\n\n')

  const systemPrompt = `You are a meeting-note classifier. The possible categories are listed below with explanations. MUST STRICTLY RESPOND with a JSON code fence only (triple backticks) containing a single JSON object with two keys: \"label\" (a string set to one of the provided labels or empty string) and \"relatedTo\" (an array of integers referring to the indices of the provided previous sentences that are related to this sentence). Use the previous sentences list provided in the user query for indices (0 is the most recent previous sentence). Do NOT output any other text outside the code fence. If there are no related sentences, return an empty array for \"relatedTo\". Only include related sentences that are clear and obviously related, and with explicit reason (such as answer to a question) and not just vaguely related or usual part of a conversation.\n\n${ontologyText}`

  const prevList = previous.slice(-10).reverse()
  const prevText = prevList.map((p, i) => `${i}: ${p.sentence}`).join('\n')
  const userQuery = `Sentence:\n${sentence}\n\nPrevious sentences (most recent first, index starts at 0):\n${prevText}`

  try {
    const res = await callLLM(systemPrompt, userQuery, 'ollama', 'llama3.1:8b')
    if (!res.success || !res.data) throw new Error('LLM call failed or returned no data')
    const parsed = parseFencedJSON(res.data)
    if (!parsed || typeof parsed !== 'object' || (parsed as any).label === undefined) {
      throw new Error('LLM did not return a valid JSON object inside a ```json ... ``` fence')
    }

    const lbl = String((parsed as any).label)
    const related = Array.isArray((parsed as any).relatedTo) ? (parsed as any).relatedTo : []

    const resultLabel = (() => {
      if (lbl === '') return ''
      if (labels.includes(lbl)) return lbl
      const normalize = (s: string) => s.replace(/[^a-z0-9]+/gi, '').toLowerCase()
      const n = normalize(lbl)
      const found = labels.find((L) => normalize(L) === n || normalize(L).includes(n) || n.includes(normalize(L)))
      if (!found) throw new Error('LLM returned an unknown label')
      return found
    })()

    const prevListLocal = previous.slice(-10).reverse()
    const relatedToStrings: string[] = []
    for (const r of related) {
      if (typeof r === 'number') {
        const ps = prevListLocal[r]
        if (ps && ps.sentence) relatedToStrings.push(ps.sentence)
      } else if (typeof r === 'string') {
        const found = prevListLocal.find((p) => p.sentence === r)
        if (found) relatedToStrings.push(found.sentence)
        else relatedToStrings.push(r)
      }
    }

    return { label: resultLabel, relatedTo: relatedToStrings }
  } catch (e) {
    throw e
  }
}
