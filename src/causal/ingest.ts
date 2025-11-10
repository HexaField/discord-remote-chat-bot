import { Document, Span } from './types'

export function normalizeText(text: string) {
  return text.replace(/\r\n?/g, '\n')
}

export function sentenceSplit(text: string): { spans: Span[]; sentences: string[] } {
  const normalized = normalizeText(text)
  const spans: Span[] = []
  const sentences: string[] = []

  // Simple rule-based splitter that preserves offsets
  const regex = /[^.!?\n]+[.!?]?/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(normalized))) {
    const s = match[0].trim()
    if (!s) continue
    const start = match.index
    const end = match.index + match[0].length
    sentences.push(s)
    spans.push({ docId: '', start, end, textPreview: s.slice(0, 160) })
  }
  return { spans, sentences }
}

export function ingestDocuments(texts: Array<{ id: string; title?: string; text: string; sourceUri?: string }>) {
  const documents: Document[] = texts.map((t) => ({ id: t.id, title: t.title, text: normalizeText(t.text), sourceUri: t.sourceUri }))
  const allSentenceSpans: Span[] = []

  for (const d of documents) {
    const { spans } = sentenceSplit(d.text)
    // stamp docId on each span
    for (const sp of spans) {
      sp.docId = d.id
      allSentenceSpans.push(sp)
    }
  }
  return { documents, sentenceSpans: allSentenceSpans }
}
