import appRootPath from 'app-root-path'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateCausalRelationships } from './cld'
import exportMermaid from './exporters/mermaidExporter'
import { exportGraphJSON, loadGraphJSON } from './exporters/rdfExporter'
import { ensureFfmpegAvailable } from './ffmpeg'
import { callLLM } from './llm'
import { debug, info } from './logger'
import { ensureWhisperAvailable, transcribeWithWhisper } from './whisper'

const TMP_DIR = path.resolve(appRootPath.path, '.tmp/audio-to-diagram')

async function existsNonEmpty(p: string) {
  try {
    const stat = await fsp.stat(p)
    console.log(`File ${p} exists:`, stat.isFile() && stat.size > 0)
    return stat.isFile() && stat.size > 0
  } catch (e) {
    return false
  }
}

function normalizeCSL(txt: string) {
  return txt
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractNodes(raw: string) {
  const set = new Set(
    normalizeCSL(raw)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  )
  return Array.from(set)
}

export function extractRelationships(raw: string) {
  return normalizeCSL(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export type Relationship = { subject: string; predicate: string; object: string }

export function toKumuJSON(nodes: Array<string | { label?: string; type?: string }>, relationships: Relationship[]) {
  // Normalize nodes to element objects preserving optional type metadata
  const labels: string[] = Array.from(
    new Set((nodes || []).map((n) => (typeof n === 'string' ? n : n.label || String(n))))
  )
  const elements = labels.map((label) => {
    const src = (nodes || []).find((n) => (typeof n === 'string' ? n === label : (n.label || '') === label))
    return typeof src === 'object' ? { label, type: (src as any).type } : { label }
  })

  const connections: Array<{ from: string; to: string; label?: string }> = []
  for (const rel of relationships) {
    const from = rel.subject
    const to = rel.object
    const label = rel.predicate
    if (from && to) connections.push({ from, to, label })
  }

  const elementLabels = new Set(elements.map((e) => e.label))
  for (const c of connections) {
    if (!elementLabels.has(c.from)) (elements.push({ label: c.from }), elementLabels.add(c.from))
    if (!elementLabels.has(c.to)) (elements.push({ label: c.to }), elementLabels.add(c.to))
  }

  return { elements, connections }
}

function relationshipsToStatements(relationships: Relationship[]) {
  const out: string[] = []
  for (const rel of relationships) {
    const symbol = rel.predicate.includes('increases') ? '(+)' : rel.predicate.includes('decreases') ? '(-)' : ''
    out.push(`${rel.subject} --> ${rel.object} ${symbol}`.trim())
  }
  return out
}

async function downloadToFile(url: string, dest: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await fsp.writeFile(dest, buf)
}

/**
 * Main exported function used by the discord command handler.
 * Accepts an audio file URL, returns the path to the generated Kumu JSON file.
 */
export async function transcribeAudioFile(inputPath: string, transcriptPath: string, audioFormat = 'mp3') {
  // Use the input file directly (whisper supports mp3); no WAV conversion required
  const dir = path.dirname(transcriptPath)
  const outBase = path.join(dir, 'transcript')

  // Transcribe (WHISPER_MODEL env or default)
  const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), 'models/ggml-base.en.bin')
  await transcribeWithWhisper(WHISPER_MODEL, inputPath, transcriptPath, outBase)

  // Read raw transcript
  let transcript = await fsp.readFile(transcriptPath, 'utf8')

  // Single-call LLM scrub: remove advertising, promos, irrelevant tangents and noise
  // try {
  //   const scrubSystem = `The following is an audio recording transcription. Remove anything not directly about the recording's main topic. Include minor fixes for obvious split words or misspellings. Remove advertising, sponsor/donation/referral mentions, and calls-to-action (subscribe, follow, visit). Return only the cleaned transcript text (no notes, explanation, or JSON).`

  //   const resp = await callLLM(scrubSystem, transcript, 'llama3.1:8b')
  //   if (resp && resp.success && typeof resp.data === 'string' && resp.data.trim().length > 0) {
  //     transcript = resp.data.trim()
  //     // Persist cleaned transcript to the transcriptPath
  //     try {
  //       await fsp.writeFile(transcriptPath, transcript, 'utf8')
  //       debug('Wrote cleaned transcript to', transcriptPath)
  //     } catch (e) {
  //       debug('Failed to write cleaned transcript:', e)
  //     }
  //   } else {
  //     debug('LLM scrub returned empty or failed; using original transcript')
  //   }
  // } catch (e: any) {
  //   console.warn('LLM scrub failed, using raw transcript:', e?.message ?? e)
  // }

  return transcript
}

// Chunking parameters (can be tuned via env)
const CHUNK_MAX = Number(process.env.LLM_CHUNK_MAX || '3000')
const CHUNK_MIN = Number(process.env.LLM_CHUNK_MIN || '200')

function chunkByNewline(text: string, maxChars: number, minLast: number) {
  const lines = text.split(/\r?\n/)
  const chunks: string[] = []
  let curLines: string[] = []
  let curLen = 0
  const overlapChars = Math.max(1, Math.floor(maxChars * 0.1))

  for (const line of lines) {
    const addLen = (curLines.length > 0 ? 1 : 0) + line.length
    const candidateLen = curLen + addLen
    if (candidateLen > maxChars) {
      if (curLines.length > 0) {
        const chunk = curLines.join('\n')
        chunks.push(chunk)

        // compute overlap as last lines whose cumulative length >= overlapChars
        let acc = 0
        let overlapStart = curLines.length
        for (let j = curLines.length - 1; j >= 0; j--) {
          acc += curLines[j].length + 1 // include newline
          overlapStart = j
          if (acc >= overlapChars) break
        }
        const overlapLines = curLines.slice(overlapStart)

        // start new curLines with the overlap then add the current line
        curLines = overlapLines.slice()
        curLen = curLines.length > 0 ? curLines.join('\n').length : 0
        if (curLines.length > 0) {
          curLen += 1 + line.length
          curLines.push(line)
        } else {
          curLines = [line]
          curLen = line.length
        }
      } else {
        // single line longer than maxChars: force split the line
        chunks.push(line.slice(0, maxChars))
        const leftover = line.slice(maxChars)
        curLines = leftover ? [leftover] : []
        curLen = leftover.length
      }
    } else {
      if (curLines.length > 0) curLen += 1 + line.length
      else curLen = line.length
      curLines.push(line)
    }
  }

  if (curLines.length > 0) chunks.push(curLines.join('\n'))

  if (chunks.length > 1 && chunks[chunks.length - 1].length < minLast) {
    const last = chunks.pop() as string
    chunks[chunks.length - 1] = chunks[chunks.length - 1] + '\n' + last
  }
  return chunks
}

export async function generateNodes(transcript: string) {
  const prompt = `You are an assistant that extracts a new-line separated list of concepts from a document. These must only be a concept, idea, person or place and never a whole sentence. Do not use underscores, hyphens, or any other punctuation in the concepts unless it is part of the name. Respond with a single new-line separated string.`

  const chunks = chunkByNewline(transcript, CHUNK_MAX, CHUNK_MIN)
  const nodeSet = new Set<string>()
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const resp = await callLLM(prompt, chunk, 'opencode', 'github-copilot/gpt-5-mini')
    if (!resp.success) throw new Error(resp.error || 'LLM failed extracting nodes')
    const raw = String(resp.data || '')
    for (const n of extractNodes(raw)) nodeSet.add(n)
  }
  return Array.from(nodeSet)
}

export async function generateRelationships(transcript: string, nodes: string[]) {
  // Request JSON array of relationship objects from the LLM.
  const prompt = `You are an assistant that extracts relationships from a document given a list of nodes. Respond with a JSON array where each item is an object with keys { "subject": string, "predicate": string, "object": string }. Only include relationships supported by the provided document. Objects and subjects must be of the defined nodes, and predicates only a very simple relationship type, not whole sentences. The nodes are: ${nodes.join(', ')}.`

  const chunks = chunkByNewline(transcript, CHUNK_MAX, CHUNK_MIN)
  const relMap = new Map<string, Relationship>()
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const resp = await callLLM(prompt, chunk, 'opencode', 'github-copilot/gpt-5-mini')
    if (!resp.success) throw new Error(resp.error || 'LLM failed extracting relationships')
    const raw = String(resp.data || '')

    // Try to pull a JSON array from the response
    let parsed: any = null
    try {
      // try extract ```json ... ``` block
      const jsonBlockMatch = raw.match(/```json([\s\S]*?)```/)
      if (jsonBlockMatch) {
        try {
          parsed = JSON.parse(jsonBlockMatch[1].trim())
        } catch (e) {
          // still failed, will skip
          console.debug('Failed to parse JSON from extracted block:', e)
        }
      }
    } catch (e) {
      try {
        const first = raw.indexOf('[')
        const last = raw.lastIndexOf(']')
        if (first >= 0 && last > first) {
          parsed = JSON.parse(raw.slice(first, last + 1))
        } else {
          parsed = JSON.parse(raw)
        }
      } catch (e) {
        console.debug('Failed to parse JSON from raw response:', e)
      }
      // Could not parse JSON from this chunk, skip it
      console.debug('Failed to parse JSON relationships from LLM response chunk ' + i)
      continue
    }

    if (!Array.isArray(parsed)) continue
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const subject = String(item.subject || '').trim()
      const predicate = String(item.predicate || '').trim()
      const object = String(item.object || '').trim()
      if (!subject || !predicate || !object) continue
      const key = `${subject}|||${predicate}|||${object}`
      relMap.set(key, { subject, predicate, object })
    }
  }

  return Array.from(relMap.values())
}

export async function downloadYoutubeSingleWithInfo(youtubeURL: string, sourceDir: string, audioFormat = 'mp3') {
  const ytdlp = 'yt-dlp'
  // ensure dir exists
  await fsp.mkdir(sourceDir, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const args = [
      youtubeURL,
      '--sponsorblock-remove',
      'all',
      '-x',
      '--audio-quality',
      'lowest',
      '--audio-format',
      audioFormat,
      '-o',
      path.join(sourceDir, `audio.${audioFormat}`)
    ]
    execFile(ytdlp, args, { cwd: sourceDir }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`yt-dlp (single) error: ${error.message}\n${stderr}`))
      resolve()
    })
  })
  const files = await fsp.readdir(sourceDir)
  const audioFiles = files.filter((f) => f.endsWith(`.${audioFormat}`))
  if (audioFiles.length === 0) throw new Error('No audio file produced by yt-dlp')
  // choose the first audio file
  const audioFile = audioFiles[0]
  return path.join(sourceDir, audioFile)
}

function normalizeTranscript(text: string) {
  return text.replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}

export default async function audioToDiagram(audioURL: string, onProgress?: (message: string) => void | Promise<void>) {
  await fsp.mkdir(TMP_DIR, { recursive: true })

  // Ensure tools
  const notify = async (msg: string) => {
    if (!onProgress) return
    try {
      await Promise.resolve(onProgress(msg))
    } catch (e) {
      debug('onProgress callback failed', e)
    }
  }

  await notify('Preparing dependencies (ffmpeg, whisper)…')
  await ensureFfmpegAvailable()
  await ensureWhisperAvailable()

  const urlPath = audioURL.includes('youtube.com')
    ? new URL(audioURL).searchParams.get('v')!
    : audioURL.includes('youtu.be')
      ? new URL(audioURL).pathname.slice(1)
      : new URL(audioURL).pathname
  if (!urlPath) throw new Error('Invalid audio URL')

  const audioFormat = 'mp3'

  const originalName = path.basename(urlPath) || `audio-${Date.now()}`
  const baseName = path.basename(originalName, path.extname(originalName))

  const sourceDir = path.join(TMP_DIR, baseName)
  await fsp.mkdir(sourceDir, { recursive: true })

  const audioPath = path.join(sourceDir, `audio.${audioFormat}`)
  const transcriptPath = path.join(sourceDir, `audio.vtt`)
  const graphJSONPath = path.join(sourceDir, `graph.json`)

  if (!(await existsNonEmpty(audioPath))) {
    // Download strictly using chapter splitting for YouTube; for direct audio URLs, download as-is
    await notify('Downloading audio (chapters if available)…')
    if (audioURL.includes('youtube.com') || audioURL.includes('youtu.be')) {
      // Download a single file + info.json, then transcribe once and split by chapters
      await downloadYoutubeSingleWithInfo(audioURL, sourceDir, audioFormat)
    } else {
      await downloadToFile(audioURL, audioPath)
    }
  }

  // Transcribe whole file to VTT (timestamps) so we can split per chapter
  const outBase = path.join(sourceDir, 'audio')
  const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), 'models/ggml-base.en.bin')
  if (!(await existsNonEmpty(transcriptPath))) {
    await transcribeWithWhisper(WHISPER_MODEL, audioPath, transcriptPath, outBase)
  }

  const transcripts = [] as string[]
  // Read VTT content and try to extract either NOTE Chapter ranges (yt-dlp style)
  // or individual cue blocks. We want each timestamped section as its own transcript.
  const vttContent = await fsp.readFile(path.join(sourceDir, `audio.vtt`), 'utf8')

  // First, try to detect NOTE Chapter entries (some yt-dlp outputs include these)
  const chapterNoteRegex = /NOTE Chapter: (.+?)\s+(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/g
  let m: RegExpExecArray | null
  const chapters: Array<{ title: string; start: string; end: string }> = []
  while ((m = chapterNoteRegex.exec(vttContent)) !== null) {
    chapters.push({ title: m[1].trim(), start: m[2], end: m[3] })
  }

  // Regex to capture VTT cues: start --> end then the cue text (non-greedy)
  const cueRegex =
    /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\s*\n([\s\S]*?)(?=\n\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*-->|$)/gm

  if (chapters.length === 0) {
    // No chapters: split by each cue and use the cue text as a transcript chunk
    let cueMatch: RegExpExecArray | null
    while ((cueMatch = cueRegex.exec(vttContent)) !== null) {
      const cueText = cueMatch[3].replace(/\n+/g, ' ').trim()
      if (cueText.length > 0) transcripts.push(normalizeTranscript(cueText))
    }

    // Fallback: if no cues found (malformed VTT), use the whole transcript file
    if (transcripts.length === 0) {
      const fullTranscript = await fsp.readFile(transcriptPath, 'utf8')
      transcripts.push(normalizeTranscript(fullTranscript))
    }
  } else {
    // We have chapter ranges: for each chapter, collect cue texts that fall within the range
    for (const chapter of chapters) {
      let chapterText = ''
      let cueMatch: RegExpExecArray | null
      cueRegex.lastIndex = 0
      while ((cueMatch = cueRegex.exec(vttContent)) !== null) {
        const startTime = cueMatch[1]
        const endTime = cueMatch[2]
        // lexical compare works for HH:MM:SS.mmm format
        if (startTime >= chapter.start && endTime <= chapter.end) {
          chapterText += cueMatch[3].replace(/\n+/g, ' ').trim() + ' '
        }
      }
      if (chapterText.trim().length > 0) transcripts.push(normalizeTranscript(chapterText))
    }
  }

  console.log(`Generated ${transcripts.length} transcript chunk(s) from ${chapters.length} chapter(s)`)
  console.log(transcripts)

  // Generate nodes and relationships. If a graph JSON exists, load it and use that as the source of truth.

  let nodes: Array<string | { label?: string; type?: string }> = []
  let relationships: Relationship[] = []
  let statements: string[] = []
  let loadedFromGraph = false
  if (await existsNonEmpty(graphJSONPath)) {
    try {
      await notify('Loading existing graph data…')
      const parsed = await loadGraphJSON(sourceDir)
      nodes = parsed.nodes
      relationships = parsed.relationships
      statements = parsed.statements
      loadedFromGraph = true
      debug('Loaded nodes and relationships from graph JSON', graphJSONPath)
    } catch (e) {
      debug('Failed to load graph JSON, regenerating nodes/relationships', e)
    }
  }
  if (!loadedFromGraph) {
    // const useSDB = Boolean(process.env.USE_SYSTEM_DYNAMICS_BOT)
    // let generatedFromSDB = false
    // if (useSDB) {
    //   try {
    await notify('Extracting causal relationships (System Dynamics Bot)…')
    const cld = await generateCausalRelationships(
      transcripts,
      notify,
      0.85,
      true,
      process.env.SDB_LLM_MODEL,
      process.env.SDB_EMBEDDING_MODEL
    )
    if (cld.nodes.length === 0 || cld.relationships.length === 0) {
      throw new Error('Failed to extract any nodes or relationships')
    }
    nodes = cld.nodes
    relationships = cld.relationships
    // generatedFromSDB = true
    // } catch (err) {
    //   console.warn('System-Dynamics-Bot failed; falling back to LLM-based extraction:', (err as any)?.message || err)
    // }
    // }
    // if (!generatedFromSDB) {
    //   await notify('Extracting concepts (nodes)…')
    //   nodes = await generateNodes(transcript)
    //   await notify('Extracting relationships between concepts…')
    //   relationships = await generateRelationships(transcript, nodes)
    // }
  }

  // Filter out any nodes that don't appear in relationships (no subject/object links)
  try {
    await notify('Filtering disconnected concepts…')
    const relNodeSet = new Set<string>()
    for (const r of relationships) {
      if (r.subject) relNodeSet.add(r.subject)
      if (r.object) relNodeSet.add(r.object)
    }
    const before = nodes.length
    nodes = nodes.filter((n: any) => {
      const label = typeof n === 'string' ? n : n.label || ''
      return relNodeSet.has(label)
    })
    const after = nodes.length
    if (before !== after) debug(`Filtered ${before - after} disconnected node(s)`)
  } catch (e) {
    // If anything goes wrong, keep the original nodes list to avoid breaking downstream
    debug('Failed to filter nodes by relationships, keeping original nodes', e)
  }

  // Ensure statements are available for graphviz exporter and persisted JSON
  if (statements.length === 0 && relationships.length > 0) {
    statements = relationshipsToStatements(relationships)
  }

  const kumu = toKumuJSON(nodes, relationships)

  const kumuPath = path.join(sourceDir, `kumu.json`)
  await fsp.writeFile(kumuPath, JSON.stringify(kumu, null, 2), 'utf8')

  // Prepare minimal per-base markers and output paths
  const processingMarker = path.join(sourceDir, `processing`)
  const mermaidMDD = path.join(sourceDir, `mermaid.mdd`)
  const mermaidSVG = path.join(sourceDir, `mermaid.svg`)
  const mermaidPNG = path.join(sourceDir, `mermaid.png`)
  const graphvizDOT = path.join(sourceDir, `graphviz.dot`)
  const graphvizSVG = path.join(sourceDir, `graphviz.svg`)
  const graphvizPNG = path.join(sourceDir, `graphviz.png`)

  // Create processing marker (write timestamp)
  try {
    await fsp.writeFile(processingMarker, String(Date.now()), 'utf8')
  } catch (e) {
    debug('Could not write processing marker', e)
  }

  // Export graph JSON if missing or empty
  try {
    const needGraph = !(await existsNonEmpty(graphJSONPath))
    if (needGraph) {
      info('Writing graph JSON for', baseName)
      await notify('Writing graph data…')
      // Build metadata: include a simple name derived from the file/base name
      const metadata: any = {
        name: originalName || baseName,
        source: audioURL,
        created: Date.now()
      }
      // For YouTube URLs include a thumbnail link (use video id stored in urlPath)
      if (audioURL.includes('youtube.com') || audioURL.includes('youtu.be')) {
        try {
          const videoId = urlPath
          if (videoId) metadata.thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        } catch (e) {
          // ignore
        }
      }

      await exportGraphJSON(sourceDir, nodes, relationships, metadata)
    } else {
      debug('Graph JSON already exists for', baseName)
    }
  } catch (e: any) {
    console.warn('Failed to export graph JSON for', baseName, e?.message ?? e)
  }

  const graphType = process.env.DIAGRAM_EXPORTER || 'mermaid' // options: 'mermaid' or 'graphviz'
  console.log(graphType)

  if (graphType === 'mermaid') {
    // Export Mermaid if missing
    try {
      const needMDD = !(await existsNonEmpty(mermaidMDD))
      const needSVG = !(await existsNonEmpty(mermaidSVG))
      const needPNG = !(await existsNonEmpty(mermaidPNG))
      if (needMDD || needSVG || needPNG) {
        info('Writing mermaid artifacts for', baseName)
        await notify('Rendering diagram (Mermaid)…')
        await exportMermaid(sourceDir, 'mermaid', nodes, relationships)
      } else {
        debug('Mermaid artifacts already exist for', baseName)
      }
    } catch (e: any) {
      console.warn('Failed to export mermaid for', baseName, e?.message ?? e)
    }
  }

  // Remove processing marker
  try {
    await fsp.unlink(processingMarker).catch(() => {})
  } catch (e) {
    debug('Could not finalize markers for', baseName, e)
  }

  const activePNG = graphType === 'graphviz' ? graphvizPNG : mermaidPNG
  const activeSVG = graphType === 'graphviz' ? graphvizSVG : mermaidSVG

  await notify('Finalizing…')

  return {
    dir: sourceDir,
    audioPath,
    transcriptPath,
    graphJSONPath,
    kumuPath,
    pngPath: activePNG,
    svgPath: activeSVG,
    mermaid: { mdd: mermaidMDD, svg: mermaidSVG, png: mermaidPNG },
    graphviz: { dot: graphvizDOT, svg: graphvizSVG, png: graphvizPNG }
  }
}
