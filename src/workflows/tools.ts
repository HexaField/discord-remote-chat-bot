import {
  AgentStreamEvent,
  AgentWorkflowDefinition,
  extractJson,
  runAgentWorkflow,
  validateWorkflowDefinition,
  WorkflowParserJsonOutput,
  type AgentWorkflowResult
} from '@hexafield/agent-workflow'
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
  /** workflow registry key to execute for this tool (optional) */
  workflow?: string
}

export const TOOLS: ToolDef[] = [
  {
    name: 'transcribe',
    title: 'Transcribe Audio/Video',
    callWhen:
      'Call this when the user supplies or references an audio/video file (upload or URL) and asks for a transcript or asks questions that require transcribing audio/video content.',
    description: 'Upload audio or provide a URL to download video and produce a speaker-aligned transcript.',
    workflow: 'transcribe'
  },
  {
    name: 'diagram',
    title: 'Diagram Generation',
    callWhen: 'Call this when the user asks to produce a diagram.',
    description: 'Turn audio, youtube videos or text content into a causal loop diagram.',
    workflow: 'diagram'
  },
  {
    name: 'meeting_summarise',
    title: 'Meeting Summarise',
    callWhen:
      'Call this when the user asks for a meeting summary, insights, action items, decisions or open questions derived from a meeting transcript or recording.',
    description: 'Generate meeting digest: insights, action items, decisions, open questions.',
    workflow: 'meeting_summarise'
  }
]

export const TOOL_NAMES = TOOLS.map((t) => t.name)

const DEFAULT_MODEL = process.env.TOOLS_MODEL || 'github-copilot/gpt-5-mini'
const DEFAULT_SESSION_DIR = path.resolve(appRootPath.path, '.tmp', 'tools-sessions')

const ALLOWED_COMMANDS = new Set(['yt-dlp', 'whisper-cli', 'mmdc'])
const ALLOWED_SHELL_PRIMITIVES = new Set([
  'bash',
  'set',
  'trap',
  'rm',
  'mktemp',
  'cat',
  'printf',
  'base64',
  'tr'
])
const MAX_USER_ARGS = 20
const MAX_ARG_LENGTH = 20000

async function ensureSessionDir(sessionDir = DEFAULT_SESSION_DIR) {
  await fsp.mkdir(sessionDir, { recursive: true })
  return sessionDir
}

export function validateCliArgs(args: unknown, step: { command: string; args?: unknown }): boolean {
  if (!Array.isArray(args)) return false

  // Direct invocation of an allowed CLI
  if (ALLOWED_COMMANDS.has(step.command)) {
    return (
      args.length <= MAX_USER_ARGS &&
      args.every((arg) => typeof arg === 'string' && arg.length > 0 && arg.length <= MAX_ARG_LENGTH)
    )
  }

  // Guarded bash that only touches allowed commands and simple primitives
  if (step.command === 'bash') {
    const [flag, script] = args as unknown[]
    if (flag !== '-lc' || typeof script !== 'string') return false
    const lines = script.split(/\n+/)

    return lines.every((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return true
      const firstToken = trimmed.split(/\s+/)[0]
      return ALLOWED_COMMANDS.has(firstToken) || ALLOWED_SHELL_PRIMITIVES.has(firstToken)
    })
  }

  return false
}

/* Workflow document for tool selection */
export const toolsWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'tools.v1',
  description: 'Select a tool to handle a user mention or referenced content.',
  model: DEFAULT_MODEL,
  sessions: {
    roles: [{ role: 'chooser' as const, nameTemplate: '{{runId}}-tools-chooser' }]
  },
  parsers: {
    passthrough: { type: 'unknown' as const },
    toolChoice: {
      type: 'object',
      properties: {
        tool: { type: 'string' }
      },
      required: ['tool'],
      additionalProperties: false
    }
  },
  roles: {
    chooser: {
      systemPrompt: `Available tools and when to call them:\n{{user.tools}}\nYou are a tool-selection assistant. Given the transcript and the user's message, choose exactly ONE tool from the available list. Only choose a tool if you are VERY CERTAIN it applies to the user request. If you are not very certain, return {"tool":"none"}. Output must be a single JSON object and nothing else, for example: {"tool":"diagram"}`,
      parser: 'toolChoice'
    }
  },
  state: { initial: {} },
  user: { instructions: { type: 'string', default: '' }, tools: { type: 'string', default: '' } },
  flow: {
    round: {
      start: 'chooser',
      steps: [
        {
          key: 'chooser',
          role: 'chooser' as const,
          prompt: ['{{user.instructions}}'],
          exits: [{ condition: 'always', outcome: 'completed', reason: 'Tool selection complete' }]
        }
      ],
      maxRounds: 1,
      defaultOutcome: { outcome: 'completed', reason: 'Tool selection executed' }
    }
  }
} as const satisfies AgentWorkflowDefinition

export type ToolsWorkflowDefinition = typeof toolsWorkflowDocument
export type ToolsParserOutput = WorkflowParserJsonOutput<(typeof toolsWorkflowDocument)['parsers']['toolChoice']>

export const toolsWorkflowDefinition = validateWorkflowDefinition(toolsWorkflowDocument)
export type ToolsWorkflowResult = AgentWorkflowResult<ToolsWorkflowDefinition>

const extractToolsOutput = (result: ToolsWorkflowResult): ToolsParserOutput | undefined => {
  const lastRound = result.rounds[result.rounds.length - 1]
  return lastRound?.steps?.chooser?.parsed as ToolsParserOutput | undefined
}

export async function chooseToolForMention(options: {
  question: string
  referenced?: { attachments?: string[]; content?: string }
  sessionId?: string
  sessionDir?: string
  model?: string
  onProgress?: (msg: string) => void
}): Promise<{ tool: string }> {
  const model = options.model || DEFAULT_MODEL
  const sessionDir = options.sessionDir || DEFAULT_SESSION_DIR

  await ensureSessionDir(sessionDir)

  const toolLines = TOOLS.map((t, i) => `${i + 1}. ${t.name} — ${t.callWhen}`).join('\n')

  const referencedText = options.referenced
    ? `${options.referenced.attachments ? `Attachments: ${options.referenced.attachments.join(', ')}` : ''}\n${options.referenced.content ? `Referenced message content: ${options.referenced.content}` : ''}`
    : ''

  const userInstructions = ['Context: ' + referencedText, 'Question: ' + options.question].join('\n')

  const onStream = (msg: AgentStreamEvent) => {
    if (!options.onProgress) return
    if (msg.step === 'chooser') options.onProgress('[Tools] Choosing tool...')
  }

  const response = await runAgentWorkflow(toolsWorkflowDefinition, {
    user: { instructions: userInstructions, tools: toolLines },
    model,
    sessionDir,
    workflowId: toolsWorkflowDefinition.id,
    workflowSource: 'user',
    workflowLabel: toolsWorkflowDefinition.description,
    onStream
  })

  const result = await response.result
  const parsed = extractToolsOutput(result)

  if (parsed && parsed.tool) return { tool: parsed.tool }

  // Fallback: try to parse raw text from the workflow step
  const lastRound = result.rounds[result.rounds.length - 1]
  const raw = lastRound?.steps?.chooser?.raw as string | undefined
  if (raw) {
    try {
      const jsonString = extractJson(raw)
      const parsedFallback = JSON.parse(jsonString)
      if (parsedFallback && typeof parsedFallback.tool === 'string') return { tool: parsedFallback.tool }
    } catch {
      // ignore
    }
    // try to extract a JSON-like substring
    const m = raw.match(/\{[\s\S]*?\}/)
    if (m) {
      try {
        const parsedFallback = JSON.parse(m[0])
        if (parsedFallback && typeof parsedFallback.tool === 'string') return { tool: parsedFallback.tool }
      } catch {
        // ignore
      }
    }
  }

  return { tool: 'none' }
}

export default {
  TOOLS,
  TOOL_NAMES,
  chooseToolForMention
}
