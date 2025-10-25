import appRootPath from 'app-root-path'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { convertTo16kMonoWav, ensureFfmpegAvailable } from './ffmpeg'
import { callLLM } from './llm'
import { ensureWhisperAvailable, transcribeWithWhisper } from './whisper'

const TMP_DIR = appRootPath.resolve('.tmp/audio-to-diagram')

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
export async function transcribeAudioFile(inputPath: string, transcriptPath: string) {
  // Convert
  const baseName = path.basename(inputPath, path.extname(inputPath))
  const wavPath = path.join(TMP_DIR, `${baseName}.wav`)
  const outBase = path.join(TMP_DIR, baseName)

  if (path.extname(inputPath).toLowerCase() !== '.wav') {
    await convertTo16kMonoWav(inputPath, wavPath)
  }

  // Transcribe (WHISPER_MODEL env or default)
  const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), 'models/ggml-base.en.bin')
  await transcribeWithWhisper(WHISPER_MODEL, wavPath, transcriptPath, outBase)

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

// Build a simple Mermaid graph (graph TD) with labelled edges
export function toMermaid(nodes: string[], relationships: string[]) {
  // Escape Mermaid special chars lightly for ids/labels
  const id = (s: string) => s.replace(/[^\w\u00C0-\u017F]+/g, '_').replace(/^_+|_+$/g, '') || 'N'
  const uniqueNodes = Array.from(new Set(nodes))

  // Build nodes as labeled boxes
  const nodeLines = uniqueNodes.map((n) => {
    const nid = id(n)
    // Use quotes for label to preserve spaces
    return `${nid}["${n}"]`
  })

  // Parse relationships like "from-node-relationship-to-node"
  const edgeLines = [] as string[]
  for (const rel of relationships) {
    // Try to split as: from - label - to
    // Accept separators: '-', '->', '—', '–' (users sometimes paste variants)
    // We look for exactly three chunks: from, label, to.
    let parts = rel
      .split(/-+>|—|–/g)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length === 3) {
      const [from, label, to] = parts
      const fid = id(from)
      const tid = id(to)
      edgeLines.push(`${fid} -- "${label}" --> ${tid}`)
    } else {
      // fallback: try simple hyphen split into three segments
      const p2 = rel
        .split('-')
        .map((s) => s.trim())
        .filter(Boolean)
      if (p2.length >= 3) {
        const from = p2.shift()!
        const to = p2.pop()!
        const label = p2.join('-')
        const fid = id(from)
        const tid = id(to)
        edgeLines.push(`${fid} -- "${label}" --> ${tid}`)
      }
    }
  }

  return ['```mermaid', 'graph TD', ...nodeLines, ...edgeLines, '```'].join('\n')
}

export async function downloadYoutubeAudio(youtubeURL: string, destPath: string) {
  // check if it's already downloaded
  try {
    await fsp.stat(destPath)
    return
  } catch (err) {
    // not found, proceed to download
  }
  return new Promise<void>((resolve, reject) => {
    const ytdlp = 'yt-dlp' // Assumes yt-dlp is installed and on PATH
    const args = ['-x', '--audio-format', 'wav', '-o', destPath, youtubeURL]
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

  const urlPath =
    audioURL.includes('youtube.com') || audioURL.includes('youtu.be')
      ? audioURL.split('?v=').pop() || ''
      : new URL(audioURL).pathname
  const originalName = path.basename(urlPath) || `audio-${Date.now()}`
  const baseName = path.basename(originalName, path.extname(originalName))

  const audioPath = path.join(TMP_DIR, originalName).endsWith('.wav') ? originalName : `${baseName}.wav`
  const transcriptPath = path.join(TMP_DIR, `${baseName}.txt`)

  // Download
  if (audioURL.includes('youtube.com') || audioURL.includes('youtu.be')) {
    await downloadYoutubeAudio(audioURL, audioPath)
  } else {
    await downloadToFile(audioURL, audioPath)
  }

  // Transcribe
  const transcript = await transcribeAudioFile(audioPath, transcriptPath)

  // Generate nodes and relationships
  const nodes = await generateNodes(transcript)
  const relationships = await generateRelationships(transcript, nodes)

  const kumu = toKumuJSON(nodes, relationships)

  const outJsonPath = path.join(TMP_DIR, `${baseName}.kumu.json`)
  await fsp.writeFile(outJsonPath, JSON.stringify(kumu, null, 2), 'utf8')

  return outJsonPath
}
