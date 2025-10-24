import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { convertTo16kMonoWav, ensureFfmpegAvailable } from './ffmpeg'
import { callLLM } from './llm'
import { ensureWhisperAvailable, transcribeWithWhisper } from './whisper'

const TMP_DIR = path.resolve('.tmp_ailoop')

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
  await fsp.mkdir(TMP_DIR, { recursive: true })

  // Convert
  const baseName = path.basename(inputPath, path.extname(inputPath))
  const wavPath = path.join(TMP_DIR, `${baseName}.wav`)
  const outBase = path.join(TMP_DIR, baseName)

  await convertTo16kMonoWav(inputPath, wavPath)

  // Transcribe (WHISPER_MODEL env or default)
  const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), 'models/ggml-base.en.bin')
  await transcribeWithWhisper(WHISPER_MODEL, wavPath, transcriptPath, outBase)

  const transcript = await fsp.readFile(transcriptPath, 'utf8')
  return transcript
}

export default async function audioToDiagram(attachmentUrl: string) {
  await fsp.mkdir(TMP_DIR, { recursive: true })

  // Ensure tools
  await ensureFfmpegAvailable()
  await ensureWhisperAvailable()

  const urlPath = new URL(attachmentUrl).pathname
  const originalName = path.basename(urlPath) || `audio-${Date.now()}`
  const baseName = path.basename(originalName, path.extname(originalName))

  const audioPath = path.join(TMP_DIR, originalName)
  const wavPath = path.join(TMP_DIR, `${baseName}.wav`)
  const transcriptPath = path.join(TMP_DIR, `${baseName}.txt`)
  const outBase = path.join(TMP_DIR, baseName)

  // Download
  await downloadToFile(attachmentUrl, audioPath)

  // Transcribe
  const transcript = await transcribeAudioFile(audioPath, transcriptPath)

  // LLM calls: use callLLM from ./llm
  const nodesSystem = `You are an assistant that extracts a comma separated list of concepts from a document. Respond with a single comma-separated string.`
  const rawNodesResp = await callLLM(nodesSystem, transcript)
  if (!rawNodesResp.success) throw new Error(rawNodesResp.error || 'LLM failed extracting nodes')
  const rawNodesText = String(rawNodesResp.data || '')
  const nodes = extractNodes(rawNodesText)

  const relsSystem = `You are an assistant that extracts relationships between the following concepts: ${nodes.join(
    ', '
  )}. Respond with a comma separated list. Each relationship must be in the form 'from node-relationship label-to node'. Only include relationships supported by the provided document.`
  const rawRelsResp = await callLLM(relsSystem, transcript)
  if (!rawRelsResp.success) throw new Error(rawRelsResp.error || 'LLM failed extracting relationships')
  const rawRelsText = String(rawRelsResp.data || '')
  const relationships = extractRelationships(rawRelsText)

  const kumu = toKumuJSON(nodes, relationships)

  const outJsonPath = path.join(TMP_DIR, `${baseName}.kumu.json`)
  await fsp.writeFile(outJsonPath, JSON.stringify(kumu, null, 2), 'utf8')

  return outJsonPath
}
