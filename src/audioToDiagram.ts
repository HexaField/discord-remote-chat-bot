import appRootPath from 'app-root-path'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateCausalRelationships } from './cld'
// Causal pipeline (deterministic alternative)
import { runCausalPipeline } from './causal/pipeline'
import type { Code } from './causal/types'
import { exportGraphViz } from './exporters/graphVizExporter'
import exportMermaid from './exporters/mermaidExporter'
import { exportRDF, parseTTL } from './exporters/rdfExporter'
import { convertTo16kMonoWav, ensureFfmpegAvailable } from './ffmpeg'
import { callLLM } from './llm'
import { debug, info } from './logger'
import { ensureWhisperAvailable, transcribeWithWhisper } from './whisper'

const TMP_DIR = path.resolve(appRootPath.path, '.tmp/audio-to-diagram')

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

export function toKumuJSON(nodes: string[], relationships: Relationship[]) {
  const elements = Array.from(new Set(nodes)).map((label) => ({ label }))

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
  // Convert
  const baseName = path.basename(inputPath, path.extname(inputPath))
  const audioPath = path.join(TMP_DIR, `${baseName}.${audioFormat}`)
  const outBase = path.join(TMP_DIR, baseName)

  if (path.extname(inputPath).toLowerCase() !== `.${audioFormat}`) {
    await convertTo16kMonoWav(inputPath, audioPath)
  }

  // Transcribe (WHISPER_MODEL env or default)
  const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), 'models/ggml-base.en.bin')
  await transcribeWithWhisper(WHISPER_MODEL, audioPath, transcriptPath, outBase)

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

export async function downloadYoutubeAudio(youtubeURL: string, destPath: string, audioFormat = 'mp3') {
  // check if it's already downloaded
  try {
    await fsp.stat(destPath)
    return
  } catch (err) {
    // not found, proceed to download
  }
  return new Promise<void>((resolve, reject) => {
    const ytdlp = 'yt-dlp' // Assumes yt-dlp is installed and on PATH

    // use lowest quality audio format to minimize download size
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
      destPath
    ]
    execFile(ytdlp, args, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(`yt-dlp error: ${error.message}\n${stderr}`))
      }
      resolve()
    })
  })
}

export default async function audioToDiagram(audioURL: string) {
  await fsp.mkdir(TMP_DIR, { recursive: true })

  // Ensure tools
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

  const audioPath = path.join(
    TMP_DIR,
    originalName.endsWith(`.${audioFormat}`) ? originalName : `${baseName}.${audioFormat}`
  )
  const transcriptPath = path.join(TMP_DIR, `${baseName}.txt`)
  const ttlPath = path.join(TMP_DIR, `${baseName}.triples.ttl`)

  // Download
  if (audioURL.includes('youtube.com') || audioURL.includes('youtu.be')) {
    await downloadYoutubeAudio(audioURL, audioPath, audioFormat)
  } else {
    await downloadToFile(audioURL, audioPath)
  }

  // Transcribe (reuse existing transcript if present)
  async function existsNonEmpty(p: string) {
    try {
      const stat = await fsp.stat(p)
      console.log(`File ${p} exists:`, stat.isFile() && stat.size > 0)
      return stat.isFile() && stat.size > 0
    } catch (e) {
      return false
    }
  }

  let transcript: string
  if (await existsNonEmpty(transcriptPath)) {
    debug('Using existing transcript at', transcriptPath)
    transcript = await fsp.readFile(transcriptPath, 'utf8')
  } else {
    transcript = await transcribeAudioFile(audioPath, transcriptPath)
  }

  // Generate nodes and relationships. If a TTL exists, parse it and use that as the source of truth.

  let nodes: string[] = []
  let relationships: Relationship[] = []
  let statements: string[] = []
  console.log(process.env.USE_CAUSAL_PIPELINE)
  const useCausalPipeline = process.env.USE_CAUSAL_PIPELINE === 'true'
  let loadedFromTTL = false
  if (await existsNonEmpty(ttlPath)) {
    try {
      const ttl = await fsp.readFile(ttlPath, 'utf8')
      const parsed = await parseTTL(ttl)
      nodes = parsed.nodes
      relationships = parsed.relationships
      statements = parsed.statements
      loadedFromTTL = true
      debug('Loaded nodes and relationships from TTL', ttlPath)
    } catch (e) {
      console.warn('Failed to parse existing TTL, regenerating nodes and relationships:', e)
    }
  }
  if (!loadedFromTTL) {
    // const useSDB = true //Boolean(process.env.USE_SYSTEM_DYNAMICS_TS)
    // if (useSDB) {
    //   try {
    if (useCausalPipeline) {
      const artifacts = await runCausalPipeline(
        [{ id: baseName, text: transcript, title: baseName, sourceUri: audioURL }],
        { exportDir: TMP_DIR, baseName: `${baseName}.causal` }
      )
      if (!artifacts.edges.length) throw new Error('Causal pipeline produced no edges')
      const variableById = new Map<string, Code>(artifacts.graph.variables.map((v) => [v.id, v]))
      nodes = artifacts.graph.variables.map((v) => v.label)
      relationships = artifacts.edges.map((edge) => {
        const from = variableById.get(edge.fromVariableId)?.label || edge.fromVariableId
        const to = variableById.get(edge.toVariableId)?.label || edge.toVariableId
        return {
          subject: from,
          predicate: edge.polarity === '+' ? 'reinforces' : 'reduces',
          object: to
        }
      })
      statements = artifacts.edges.map((e) => {
        const from = variableById.get(e.fromVariableId)?.label || e.fromVariableId
        const to = variableById.get(e.toVariableId)?.label || e.toVariableId
        return `${from} -> ${to} ${e.polarity}`
      })
    } else {
      const cld = await generateCausalRelationships(
        transcript,
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
      statements = cld.statements
    }
    //   } catch (err) {
    //     console.warn('System-Dynamics-Bot failed; falling back to LLM-based extraction:', (err as any)?.message || err)
    //     nodes = await generateNodes(transcript)
    //     relationships = await generateRelationships(transcript, nodes)
    //   }
    // } else {
    //   nodes = await generateNodes(transcript)
    //   relationships = await generateRelationships(transcript, nodes)
    // }
  }

  // Filter out any nodes that don't appear in relationships (no subject/object links)
  try {
    const relNodeSet = new Set<string>()
    for (const r of relationships) {
      if (r.subject) relNodeSet.add(r.subject)
      if (r.object) relNodeSet.add(r.object)
    }
    const before = nodes.length
    nodes = nodes.filter((n) => relNodeSet.has(n))
    const after = nodes.length
    if (before !== after) debug(`Filtered ${before - after} disconnected node(s)`)
  } catch (e) {
    // If anything goes wrong, keep the original nodes list to avoid breaking downstream
    debug('Failed to filter nodes by relationships, keeping original nodes', e)
  }

  const kumu = toKumuJSON(nodes, relationships)

  const kumuPath = path.join(TMP_DIR, `${baseName}.kumu.json`)
  await fsp.writeFile(kumuPath, JSON.stringify(kumu, null, 2), 'utf8')

  // Prepare minimal per-base markers and output paths
  const processingMarker = path.join(TMP_DIR, `${baseName}.processing`)
  const mddPath = path.join(TMP_DIR, `${baseName}.mdd`)
  const svgPath = path.join(TMP_DIR, `${baseName}.svg`)
  const pngPath = path.join(TMP_DIR, `${baseName}.png`)
  const dotPath = path.join(TMP_DIR, `${baseName}.dot`)

  // Create processing marker (write timestamp)
  try {
    await fsp.writeFile(processingMarker, String(Date.now()), 'utf8')
  } catch (e) {
    debug('Could not write processing marker', e)
  }

  // Export RDF (Turtle) if missing or empty
  try {
    const needTTL = !(await existsNonEmpty(ttlPath))
    if (needTTL) {
      info('Writing RDF outputs for', baseName)
      await exportRDF(TMP_DIR, baseName, nodes, relationships)
    } else {
      debug('RDF outputs already exist for', baseName)
    }
  } catch (e: any) {
    console.warn('Failed to export RDF for', baseName, e?.message ?? e)
  }

  const graphType = process.env.DIAGRAM_EXPORTER || 'mermaid' // options: 'mermaid' or 'graphviz'
  console.log(graphType)

  if (graphType === 'mermaid') {
    // Export Mermaid if missing
    try {
      const needMDD = !(await existsNonEmpty(mddPath))
      const needSVG = !(await existsNonEmpty(svgPath))
      const needPNG = !(await existsNonEmpty(pngPath))
      if (needMDD || needSVG || needPNG) {
        info('Writing mermaid .mdd, .svg and .png for', baseName)
        await exportMermaid(TMP_DIR, baseName, nodes, relationships)
      } else {
        debug('.mdd already exists for', baseName)
      }
    } catch (e: any) {
      console.warn('Failed to export mermaid for', baseName, e?.message ?? e)
    }
  } else if (graphType === 'graphviz') {
    try {
      const needDOT = !(await existsNonEmpty(dotPath))
      const needSVG = !(await existsNonEmpty(svgPath))
      const needPNG = !(await existsNonEmpty(pngPath))
      if (needDOT || needSVG || needPNG) {
        info('Writing graphviz .svg for', baseName)
        await exportGraphViz(TMP_DIR, baseName, statements)
      } else {
        debug('.svg already exists for', baseName)
      }
    } catch (e: any) {
      console.warn('Failed to export graphviz for', baseName, e?.message ?? e)
    }
  }

  // Remove processing marker
  try {
    await fsp.unlink(processingMarker).catch(() => {})
  } catch (e) {
    debug('Could not finalize markers for', baseName, e)
  }

  return { kumuPath, svgPath, pngPath }
}
