import appRootPath from 'app-root-path'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { debug, info } from './logger'
import type { Relationship } from './audioToDiagram'

const SUBMODULE_DIR = path.resolve(appRootPath.path, 'external/system-dynamics-bot')

function truthyEnv(name: string) {
  const v = process.env[name]
  if (!v) return false
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function parseRelationshipLine(line: string) {
  // Expect formats like: "1. var1 -->(+) var2" or "var1 --> var2"
  const cleaned = line.replace(/^\s*\d+\.?\s*/, '').trim()
  const parts = cleaned.split('-->')
  if (parts.length < 2) return null
  const subject = parts[0].trim()
  let right = parts[1].trim()
  let symbol = ''
  // capture (+) or (-) if present
  const m = right.match(/\(\+\)|\(-\)/)
  if (m) {
    symbol = m[0]
    right = right.replace(m[0], '').trim()
  }
  const object = right
  const predicate = symbol === '(+)' ? 'increases' : symbol === '(-)' ? 'decreases' : 'influences'
  if (!subject || !object) return null
  return { subject, predicate, object }
}

function parseDot(dot: string): Relationship[] {
  const rels: Relationship[] = []
  const lines = dot.split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/"([^"]+)"\s*->\s*"([^"]+)"(?:\s*\[label=\"([^\"]*)\"\])?/)
    if (!m) continue
    const subject = m[1].trim()
    const object = m[2].trim()
    const lbl = (m[3] || '').trim()
    const predicate = lbl === '(+)' ? 'increases' : lbl === '(-)' ? 'decreases' : 'influences'
    if (subject && object) rels.push({ subject, predicate, object })
  }
  return rels
}

async function runSDBCli(inputPath: string, runDir: string, opts?: { llmModel?: string; embeddingModel?: string }) {
  // Use local ts-node from submodule to execute the CLI with output files in runDir
  const tsNodeBin = path.join(SUBMODULE_DIR, 'node_modules', 'ts-node', 'dist', 'bin.js')
  const cliEntry = path.join(SUBMODULE_DIR, 'src', 'index.ts')

  const args = [tsNodeBin, cliEntry, '-i', inputPath, '-d', '-w']
  if (opts?.llmModel) {
    args.push('--llm-model', opts.llmModel)
  }
  if (opts?.embeddingModel) {
    args.push('--embedding-model', opts.embeddingModel)
  }

  // Ensure runDir exists
  await fsp.mkdir(runDir, { recursive: true })

  const env = { ...process.env }

  // Respect existing env, but warn if neither backend is configured
  if (!truthyEnv('USE_OLLAMA') && !env.OPENAI_API_KEY) {
    info(
      'System-Dynamics-Bot: neither USE_OLLAMA nor OPENAI_API_KEY is set. The run will likely fail unless a default backend is reachable.'
    )
  }

  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, args, { cwd: runDir, env }, (err, stdout, stderr) => {
      if (err) {
        const msg = `SDB CLI failed: ${err.message}\n${stderr}`
        return reject(new Error(msg))
      }
      if (stdout) debug('SDB CLI output:', stdout.slice(0, 500))
      if (stderr) debug('SDB CLI stderr:', stderr.slice(0, 500))
      resolve()
    })
  })
}

export async function generateWithSystemDynamicsTS(transcript: string, baseName?: string, opts?: {
  llmModel?: string
  embeddingModel?: string
}) {
  // Prepare temp run directory and input file
  const runBase = baseName || `sdb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const runDir = path.join(appRootPath.path, '.tmp', 'audio-to-diagram', runBase)
  await fsp.mkdir(runDir, { recursive: true })
  const inputPath = path.join(runDir, 'input.txt')
  await fsp.writeFile(inputPath, transcript, 'utf8')

  // Sanity: submodule presence
  try {
    const stat = await fsp.stat(SUBMODULE_DIR)
    if (!stat.isDirectory()) throw new Error('not a directory')
  } catch (e) {
    throw new Error(
      `System-Dynamics-Bot submodule not found at ${SUBMODULE_DIR}. Make sure to initialize it and run npm install.`
    )
  }

  // Ensure submodule deps are installed and built; if ts-node binary missing, attempt local install
  const tsNodeBin = path.join(SUBMODULE_DIR, 'node_modules', 'ts-node', 'dist', 'bin.js')
  try {
    await fsp.stat(tsNodeBin)
  } catch {
    info('Installing dependencies for System-Dynamics-Bot submodule...')
    await new Promise<void>((resolve, reject) => {
      execFile('npm', ['ci'], { cwd: SUBMODULE_DIR }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`npm ci failed in submodule: ${err.message}\n${stderr}`))
        resolve()
      })
    })
  }

  // Run the CLI to produce relationships.txt and diagram.dot in runDir
  await runSDBCli(inputPath, runDir, opts)

  // Collect outputs
  const relPath = path.join(runDir, 'relationships.txt')
  const dotPath = path.join(runDir, 'diagram.dot')
  let relationships: Relationship[] = []
  let nodes = new Set<string>()
  try {
    const relTxt = await fsp.readFile(relPath, 'utf8')
    const lines = relTxt
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+\./.test(l) || l.includes('-->'))
    for (const l of lines) {
      const parsed = parseRelationshipLine(l)
      if (!parsed) continue
      nodes.add(parsed.subject)
      nodes.add(parsed.object)
      relationships.push(parsed)
    }
  } catch (e) {
    debug('Failed to read relationships.txt from SDB run', e)
  }

  let dot: string | undefined = undefined
  try {
    dot = await fsp.readFile(dotPath, 'utf8')
  } catch {
    // ignore
  }

  // Fallback: if relationships.txt missing or empty, try to parse DOT
  if (relationships.length === 0 && dot) {
    const parsed = parseDot(dot)
    for (const r of parsed) {
      nodes.add(r.subject)
      nodes.add(r.object)
    }
    relationships = parsed
  }

  return { nodes: Array.from(nodes), relationships, dot }
}

export default generateWithSystemDynamicsTS
