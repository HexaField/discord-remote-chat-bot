import appRootPath from 'app-root-path'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { exportMermaid } from './exporters/mermaidExporter'
import { exportRDF } from './exporters/rdfExporter'
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
      .split(',')
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

export function toKumuJSON(nodes: string[], relationships: string[]) {
  const elements = Array.from(new Set(nodes)).map((label) => ({ label }))

  const connections: Array<{ from: string; to: string; label?: string }> = []
  for (const rel of relationships) {
    let parts = rel
      .split(/-+>|—|–/g)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length !== 3) {
      const p2 = rel
        .split('-')
        .map((s) => s.trim())
        .filter(Boolean)
      if (p2.length >= 3) {
        parts = [p2.shift() as string, p2.slice(0, -1).join('-'), p2.pop() as string]
      }
    }
    if (parts.length === 3) {
      const [from, label, to] = parts
      if (from && to) connections.push({ from, to, label })
    }
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

  const transcript = await fsp.readFile(transcriptPath, 'utf8')
  return transcript
}

export async function generateNodes(transcript: string) {
  const nodesSystem = `You are an assistant that extracts a comma separated list of concepts from a document. Respond with a single comma-separated string.`
  const rawNodesResp = await callLLM(nodesSystem, transcript, 'gpt-oss:20b')
  if (!rawNodesResp.success) throw new Error(rawNodesResp.error || 'LLM failed extracting nodes')
  const rawNodesText = String(rawNodesResp.data || '')
  const nodes = extractNodes(rawNodesText)
  return nodes
}

export async function generateRelationships(transcript: string, nodes: string[]) {
  const relsSystem = `You are an assistant that extracts relationships from a list of nodes given a transcript. Respond with a comma separated list. Each relationship must be in the form 'from node-relationship label-to node'. Only include relationships supported by the provided document. The nodes are: ${nodes.join(
    ', '
  )}.`
  const rawRelsResp = await callLLM(relsSystem, transcript, 'gpt-oss:20b')
  if (!rawRelsResp.success) throw new Error(rawRelsResp.error || 'LLM failed extracting relationships')
  const rawRelsText = String(rawRelsResp.data || '')
  const relationships = extractRelationships(rawRelsText)
  return relationships
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
    const args = ['-x', '--audio-quality', 'lowest', '--audio-format', audioFormat, '-o', destPath, youtubeURL]
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
  const nodesPath = path.join(TMP_DIR, `${baseName}.nodes.json`)
  const relsPath = path.join(TMP_DIR, `${baseName}.relationships.json`)

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

  // Generate nodes and relationships
  // Load or generate nodes
  let nodes: string[]
  try {
    if (await existsNonEmpty(nodesPath)) {
      debug('Loading existing nodes from', nodesPath)
      const raw = await fsp.readFile(nodesPath, 'utf8')
      nodes = JSON.parse(raw) as string[]
    } else {
      nodes = await generateNodes(transcript)
      // atomic write nodes
      const tmpNodes = path.join(TMP_DIR, `.${baseName}.nodes.json.partial`)
      await fsp.writeFile(tmpNodes, JSON.stringify(nodes, null, 2), 'utf8')
      await fsp.rename(tmpNodes, nodesPath)
    }
  } catch (e) {
    debug('Failed reading nodes file, regenerating', e)
    nodes = await generateNodes(transcript)
  }

  // Load or generate relationships
  let relationships: string[]
  try {
    if (await existsNonEmpty(relsPath)) {
      debug('Loading existing relationships from', relsPath)
      const raw = await fsp.readFile(relsPath, 'utf8')
      relationships = JSON.parse(raw) as string[]
    } else {
      relationships = await generateRelationships(transcript, nodes)
      const tmpRels = path.join(TMP_DIR, `.${baseName}.relationships.json.partial`)
      await fsp.writeFile(tmpRels, JSON.stringify(relationships, null, 2), 'utf8')
      await fsp.rename(tmpRels, relsPath)
    }
  } catch (e) {
    debug('Failed reading relationships file, regenerating', e)
    relationships = await generateRelationships(transcript, nodes)
  }

  const kumu = toKumuJSON(nodes, relationships)

  const kumuPath = path.join(TMP_DIR, `${baseName}.kumu.json`)
  await fsp.writeFile(kumuPath, JSON.stringify(kumu, null, 2), 'utf8')

  // Prepare minimal per-base markers and output paths
  const processingMarker = path.join(TMP_DIR, `${baseName}.processing`)
  const ttlPath = path.join(TMP_DIR, `${baseName}.triples.ttl`)
  const jsonldPath = path.join(TMP_DIR, `${baseName}.triples.jsonld`)
  const mddPath = path.join(TMP_DIR, `${baseName}.mdd`)
  const svgPath = path.join(TMP_DIR, `${baseName}.svg`)

  // Create processing marker (write timestamp)
  try {
    await fsp.writeFile(processingMarker, String(Date.now()), 'utf8')
  } catch (e) {
    debug('Could not write processing marker', e)
  }

  // Export RDF (Turtle + JSON-LD) if missing or empty
  try {
    const needTTL = !(await existsNonEmpty(ttlPath))
    const needJSONLD = !(await existsNonEmpty(jsonldPath))
    if (needTTL || needJSONLD) {
      info('Writing RDF outputs for', baseName)
      await exportRDF(TMP_DIR, baseName, nodes, relationships)
    } else {
      debug('RDF outputs already exist for', baseName)
    }
  } catch (e: any) {
    console.warn('Failed to export RDF for', baseName, e?.message ?? e)
  }

  // Export Mermaid if missing
  try {
    const needMDD = !(await existsNonEmpty(mddPath))
    const needSVG = !(await existsNonEmpty(svgPath))
    if (needMDD || needSVG) {
      info('Writing mermaid .mdd for', baseName)
      await exportMermaid(TMP_DIR, baseName, nodes, relationships)
    } else {
      debug('.mdd already exists for', baseName)
    }
  } catch (e: any) {
    console.warn('Failed to export mermaid for', baseName, e?.message ?? e)
  }

  // Remove processing marker
  try {
    await fsp.unlink(processingMarker).catch(() => {})
  } catch (e) {
    debug('Could not finalize markers for', baseName, e)
  }

  return { kumuPath, svgPath }
}
