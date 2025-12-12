import { createSession, extractResponseText, getSession, promptSession } from '@hexafield/agent-workflow/opencode'
import appRootPath from 'app-root-path'
import fsp from 'node:fs/promises'
import path from 'node:path'

export type AskQuestionContext = {
  sessionId: string
  sessionDir: string
  transcript: string
  sourceId: string
}

const DEFAULT_MODEL = process.env.ASKQUESTION_MODEL || process.env.ASKVIDEO_MODEL || 'github-copilot/gpt-5-mini'
const DEFAULT_UNIVERSE = 'discord'
const DEFAULT_SESSION_DIR = path.resolve(appRootPath.path, '.tmp', `${DEFAULT_UNIVERSE}-sessions`)
const CONTEXT_DIR = path.join(DEFAULT_SESSION_DIR, 'context')

const transcriptPathFor = (universe: string, id: string) =>
  path.resolve(appRootPath.path, '.tmp', universe, id, 'audio.vtt')

const contextPathFor = (key: string) => path.join(CONTEXT_DIR, `${key}.json`)

export async function loadTranscriptText(universe: string, id: string): Promise<string> {
  const vttPath = transcriptPathFor(universe, id)
  const vttContent = await fsp.readFile(vttPath, 'utf8')
  const cueRegex =
    /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\s*\n([\s\S]*?)(?=\n\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*-->|$)/gm
  const chunks: string[] = []
  let match: RegExpExecArray | null
  while ((match = cueRegex.exec(vttContent)) !== null) {
    const cueText = match[3].replace(/\n+/g, ' ').trim()
    if (cueText) chunks.push(cueText)
  }
  return chunks.join('\n')
}

async function ensureSession(sessionId?: string, sessionDir = DEFAULT_SESSION_DIR, name?: string) {
  await fsp.mkdir(sessionDir, { recursive: true })
  if (sessionId) {
    const existing = await getSession(sessionDir, sessionId)
    if (existing) return { ...existing, directory: sessionDir }
  }
  const created = await createSession(sessionDir, name ? { name } : {})
  return { ...created, directory: sessionDir }
}

async function readContext(key: string): Promise<AskQuestionContext | undefined> {
  try {
    const raw = await fsp.readFile(contextPathFor(key), 'utf8')
    return JSON.parse(raw) as AskQuestionContext
  } catch (e: any) {
    if (e?.code === 'ENOENT') return undefined
    throw e
  }
}

async function writeContext(key: string, context: AskQuestionContext) {
  await fsp.mkdir(CONTEXT_DIR, { recursive: true })
  await fsp.writeFile(contextPathFor(key), JSON.stringify(context, null, 2), 'utf8')
}

export async function answerQuestion(options: {
  transcript: string
  question: string
  sessionId?: string
  sessionDir?: string
  model?: string
  sourceId?: string
}) {
  const model = options.model || DEFAULT_MODEL
  const sessionDir = options.sessionDir || DEFAULT_SESSION_DIR
  const session = await ensureSession(options.sessionId, sessionDir, options.sourceId)
  const prompts = [
    'You answer questions using only the provided transcript. Respond concisely and avoid speculation.',
    `Transcript:\n${options.transcript}`,
    `User question: ${options.question}`
  ]
  const response = await promptSession(session, prompts, model)
  const answer = extractResponseText(response.parts ?? (response as any))
  return {
    question: options.question,
    answer,
    sessionId: (session as any).id as string,
    sessionDir,
    parts: response.parts ?? [],
    transcript: options.transcript,
    sourceId: options.sourceId || (session as any).title || 'text'
  }
}

export async function rememberAskQuestionContext(key: string, context: AskQuestionContext) {
  await writeContext(key, context)
}

export async function getAskQuestionContext(key?: string) {
  if (!key) return undefined
  return readContext(key)
}

export async function cloneAskQuestionContext(fromKey: string | undefined, toKey: string | undefined) {
  if (!fromKey || !toKey) return
  const ctx = await readContext(fromKey)
  if (ctx) await writeContext(toKey, ctx)
}

export const ASKQUESTION_CONSTANTS = {
  MODEL: DEFAULT_MODEL,
  UNIVERSE: DEFAULT_UNIVERSE,
  SESSION_DIR: DEFAULT_SESSION_DIR
}
