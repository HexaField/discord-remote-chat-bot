import { createSession, extractJson, extractResponseText, getSession, promptSession } from '@hexafield/agent-workflow'
import appRootPath from 'app-root-path'
import fsp from 'node:fs/promises'
import path from 'node:path'

export type ToolDef = {
  /** internal name used when selecting a tool */
  name: string
  /** human friendly title */
  title: string
  /** one-sentence condition describing when the tool should be called */
  callWhen: string
  /** brief description */
  description?: string
}

export const TOOLS: ToolDef[] = [
  {
    name: 'transcribe',
    title: 'Transcribe Audio/Video',
    callWhen:
      'Call this when the user supplies or references an audio/video file (upload or URL) and asks for a transcript or asks questions that require transcribing audio/video content.',
    description: 'Upload audio or provide a URL to download video and produce a speaker-aligned transcript.'
  },
  {
    name: 'diagram',
    title: 'Diagram Generation',
    callWhen: 'Call this when the user asks to produce a diagram.',
    description: 'Turn audio, youtube videos or text content into a causal loop diagram.'
  },
  {
    name: 'meeting_summarise',
    title: 'Meeting Summarise',
    callWhen:
      'Call this when the user asks for a meeting summary, insights, action items, decisions or open questions derived from a meeting transcript or recording.',
    description: 'Generate meeting digest: insights, action items, decisions, open questions.'
  }
]

export const TOOL_NAMES = TOOLS.map((t) => t.name)

const DEFAULT_MODEL = process.env.TOOLS_MODEL || 'github-copilot/gpt-5-mini'
const DEFAULT_SESSION_DIR = path.resolve(appRootPath.path, '.tmp', 'tools-sessions')

async function ensureSession(sessionId?: string, sessionDir = DEFAULT_SESSION_DIR, name?: string) {
  await fsp.mkdir(sessionDir, { recursive: true })
  if (sessionId) {
    const existing = await getSession(sessionDir, sessionId)
    if (existing) return { ...existing, directory: sessionDir }
  }
  const created = await createSession(sessionDir, name ? { name } : {})
  return { ...created, directory: sessionDir }
}

/**
 * Ask the agent to choose a tool when the bot is mentioned. The agent must return
 * a single JSON object like { "tool": "diagram" } and should only choose a tool
 * when it is VERY certain. If uncertain, the agent should return { "tool": "none" }.
 */
export async function chooseToolForMention(options: {
  question: string
  referenced?: { attachments?: string[]; content?: string }
  sessionId?: string
  sessionDir?: string
  model?: string
}): Promise<{ tool: string }> {
  const model = options.model || DEFAULT_MODEL
  const sessionDir = options.sessionDir || DEFAULT_SESSION_DIR
  const session = await ensureSession(options.sessionId, sessionDir, 'tools-chooser')

  const toolLines = TOOLS.map((t, i) => `${i + 1}. ${t.name} — ${t.callWhen}`).join('\n')

  const prompts = [
    `You are a tool-selection assistant. Given the transcript and the user's message, choose exactly ONE tool from the available list. Only choose a tool if you are VERY CERTAIN it applies to the user request. If you are not very certain, return {"tool":"none"}.`,
    'Output must be a single JSON object and nothing else, for example: {"tool":"diagram"}',
    `Available tools:\n${toolLines}`,
    options.referenced?.attachments && Object.keys(options.referenced.attachments).length
      ? `Attachments: ${Object.keys(options.referenced.attachments).join(', ')}`
      : undefined,
    options.referenced?.content ? `Referenced message content: ${options.referenced.content}` : undefined,
    `\n\nUser message: ${options.question}`
  ].filter(Boolean) as string[]

  const response = await promptSession(session, prompts, model)
  const text = extractResponseText(response.parts ?? (response as any))
  const jsonString = extractJson(text)

  // Attempt to parse JSON from the response text
  try {
    const parsed = JSON.parse(jsonString)
    if (parsed && typeof parsed.tool === 'string') return { tool: parsed.tool }
  } catch {
    // try to extract a JSON-looking substring
    const m = text.match(/\{[\s\S]*?\}/)
    if (m) {
      try {
        const parsed = JSON.parse(m[0])
        if (parsed && typeof parsed.tool === 'string') return { tool: parsed.tool }
      } catch {}
    }
  }

  // Fallback: conservative answer
  return { tool: 'none' }
}

export default {
  TOOLS,
  TOOL_NAMES,
  chooseToolForMention
}
