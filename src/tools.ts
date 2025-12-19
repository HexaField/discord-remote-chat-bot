import {
  AgentStreamEvent,
  AgentWorkflowDefinition,
  extractJson,
  runAgentWorkflow,
  validateWorkflowDefinition,
  WorkflowParserJsonOutput,
  type AgentWorkflowResult,
  type CliRuntimeInvocation,
  type CliRuntimeResult
} from '@hexafield/agent-workflow'
import { renderAsync } from '@resvg/resvg-js'
import appRootPath from 'app-root-path'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { vttToTranscript } from './utils/vtt'
import { cldWorkflowDefinition, cldWorkflowDocument } from './workflows/cld.workflow'
import { diagramWorkflowDocument } from './workflows/diagram.workflow'
import { meetingDigestWorkflowDocument } from './workflows/meetingDigest.workflow'
import { transcribeWorkflowDocument } from './workflows/transcribe.workflow'

const registry: Record<string, any> = {}

export function registerToolWorkflow(name: string, doc: any) {
  const def = validateWorkflowDefinition(doc)
  registry[name] = def
  return def
}

// register built-in tools
registerToolWorkflow('transcribe', transcribeWorkflowDocument)
registerToolWorkflow('diagram', diagramWorkflowDocument)
// cld.v1 is referenced by diagram workflow; register under its own id too
registerToolWorkflow('cld', cldWorkflowDocument)
registerToolWorkflow('meeting_summarise', meetingDigestWorkflowDocument)

export function getToolWorkflowByName(name: string) {
  return registry[name]
}

export function listToolWorkflows() {
  return Object.keys(registry)
}

export type ToolDef = {
  /** internal name used when selecting a tool */
  name: string
  /** human friendly title */
  title: string
  /** one-sentence condition describing when the tool should be called */
  callWhen: string
  /** brief description */
  description: string
  /** workflow registry key to execute for this tool */
  workflow: string
  /** map prompt/context into tool-specific inputs */
  mapInputs: (question: string, referenced?: string[]) => Record<string, unknown>
}

const mergeReferencedText = (referenced?: string[]) =>
  Array.isArray(referenced) ? referenced.filter(Boolean).join('\n\n') : ''

export const TOOLS: ToolDef[] = [
  {
    name: 'transcribe',
    title: 'Transcribe Audio/Video',
    callWhen:
      'Call this when the user supplies or references an audio/video file (upload or URL) and asks for a transcript or asks questions that require transcribing audio/video content.',
    description: 'Upload audio or provide a URL to download video and produce a speaker-aligned transcript.',
    workflow: 'transcribe',
    mapInputs: (question, referenced) => ({ url: extractFirstUrl([mergeReferencedText(referenced), question]) })
  },
  {
    name: 'diagram',
    title: 'Diagram Generation',
    callWhen: 'Call this when the user asks to produce a diagram.',
    description: 'Turn audio, youtube videos or text content into a causal loop diagram.',
    workflow: 'diagram',
    mapInputs: (question, referenced) => {
      const referencedText = mergeReferencedText(referenced)
      return { transcript: referencedText || question }
    }
  },
  {
    name: 'meeting_summarise',
    title: 'Meeting Summarise',
    callWhen:
      'Call this when the user asks for a meeting summary, insights, action items, decisions or open questions derived from a meeting transcript or recording.',
    description: 'Generate meeting digest: insights, action items, decisions, open questions.',
    workflow: 'meeting_summarise',
    mapInputs: (question, referenced) => {
      const referencedText = mergeReferencedText(referenced)
      return { instructions: referencedText || question }
    }
  }
]

export const TOOL_NAMES = TOOLS.map((t) => t.name)

const formatToolGuide = () => TOOLS.map((t) => `- ${t.name}: ${t.callWhen} Description: ${t.description}`).join('\n')

const DEFAULT_MODEL = process.env.TOOLS_MODEL || 'github-copilot/gpt-5-mini'
const DEFAULT_SESSION_DIR = path.resolve(appRootPath.path, '.tmp', 'tools-sessions')
const MAX_ARG_LENGTH = 20000
const MAX_CAPTURE_BYTES = 25 * 1024 * 1024

const isPngBuffer = (buf?: Buffer) =>
  !!buf && buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47

type CleanupFn = () => Promise<void>

const combineCleanups =
  (...cleanups: Array<CleanupFn | undefined>): CleanupFn =>
  async () => {
    for (const fn of cleanups) {
      if (fn) await fn()
    }
  }

const createTmpDir = async (prefix: string) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const cleanup: CleanupFn = async () => {
    await fs.rm(dir, { recursive: true, force: true })
  }
  return { dir, cleanup }
}

const writeTmpFile = async (prefix: string, ext: string, content: string | Buffer | Uint8Array) => {
  const { dir, cleanup } = await createTmpDir(prefix)
  const filePath = path.join(dir, `tmp${ext}`)
  await fs.writeFile(filePath, content)
  return { filePath, cleanup }
}

const pruneEmpty = (value: unknown): any => {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : undefined
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => pruneEmpty(item)).filter((item) => item !== undefined)
    return items.length ? items : undefined
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, pruneEmpty(v)] as const)
      .filter(([, v]) => v !== undefined)
    if (!entries.length) return undefined
    return Object.fromEntries(entries)
  }
  return value
}

const stripTrailingPunctuation = (value: string) => value.replace(/[)\].,]+$/g, '')

const extractFirstUrl = (sources: Array<string | string[] | undefined | null>): string | undefined => {
  const flatten: string[] = []
  for (const source of sources) {
    if (Array.isArray(source)) {
      flatten.push(...source)
    } else if (typeof source === 'string') {
      flatten.push(source)
    }
  }

  const urlRegex = /(https?:\/\/[^\s'"<>]+)/i
  for (const candidate of flatten) {
    const match = candidate.match(urlRegex)
    if (match?.[0]) return stripTrailingPunctuation(match[0])
  }
  return undefined
}

const expectString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.length || value.length > MAX_ARG_LENGTH) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'false') return false
    if (value.toLowerCase() === 'true') return true
  }
  return defaultValue
}

type BuildResult = {
  argv: string[]
  /** whether to pipe provided stdinValue into the spawned process */
  allowStdin?: boolean
  postProcess?: (context: { cwd: string; args: Record<string, unknown>; result: CliRuntimeResult }) => Promise<void>
}

type CommandBuilder = (
  args: Record<string, any>,
  cwd: string,
  stdinValue?: string | Buffer | Uint8Array
) => Promise<BuildResult> | BuildResult

const COMMAND_BUILDERS: Record<string, CommandBuilder> = {
  'yt-dlp': async (args) => {
    const url = expectString(args.url || args.arg0, 'url')
    const output = expectString(args.output || 'audio.%(ext)s', 'output')
    const audioFormat = expectString(args.audioFormat || 'wav', 'audioFormat')
    const extractAudio = parseBoolean(args.extractAudio, true)

    let workingOutput = output
    let captureFromFile = false
    let cleanup: CleanupFn | undefined

    if (output === '-') {
      const { dir, cleanup: dirCleanup } = await createTmpDir('yt-dlp-out-')
      workingOutput = path.join(dir, 'audio.%(ext)s')
      captureFromFile = true
      cleanup = dirCleanup
    }

    const argv: string[] = []
    if (extractAudio) argv.push('-x')
    argv.push('--audio-format', audioFormat, '-o', workingOutput, url)

    const postProcess = async ({ result }: { cwd: string; args: any; result: CliRuntimeResult }) => {
      if (captureFromFile) {
        const dir = path.dirname(workingOutput)
        const files = await fs.readdir(dir)
        const audioFile = files.find((f) => f.startsWith('audio.'))
        if (!audioFile) throw new Error('yt-dlp did not produce audio output')
        const resolvedPath = path.join(dir, audioFile)
        const data = await fs.readFile(resolvedPath)
        result.stdoutBuffer = data
      }

      if (cleanup) await cleanup()
    }

    return { argv, postProcess }
  },
  'whisper-cli': async (args, _cwd, stdinValue) => {
    const input = expectString(args.input || args.arg0 || '-', 'input')
    const outputDir = expectString(args.outputDir || '-', 'outputDir')

    const modelPath = process.env.WHISPER_MODEL || path.join(os.homedir(), 'models/ggml-base.en.bin')
    const argv: string[] = []
    let workingInputPath = input
    let workingOutputDir = outputDir === '-' ? '' : outputDir
    let cleanup: CleanupFn | undefined

    if (input === '-') {
      if (
        !stdinValue ||
        !(typeof stdinValue === 'string' || Buffer.isBuffer(stdinValue) || stdinValue instanceof Uint8Array)
      ) {
        throw new Error('stdin audio required when input is "-"')
      }
      const { filePath, cleanup: inputCleanup } = await writeTmpFile(
        'whisper-in-',
        '.wav',
        Buffer.isBuffer(stdinValue) || stdinValue instanceof Uint8Array
          ? Buffer.from(stdinValue)
          : Buffer.from(stdinValue)
      )
      workingInputPath = filePath
      cleanup = inputCleanup
    }

    if (!workingOutputDir) {
      const { dir, cleanup: outCleanup } = await createTmpDir('whisper-out-')
      workingOutputDir = dir
      cleanup = combineCleanups(outCleanup, cleanup)
    }

    const expectedBase = path.basename(workingInputPath, path.extname(workingInputPath))
    const outputBase = path.join(workingOutputDir || path.dirname(workingInputPath), expectedBase)

    argv.push(workingInputPath, '-m', modelPath, '-ovtt', '-of', outputBase)

    const postProcess = async ({ result }: { cwd: string; args: any; result: CliRuntimeResult }) => {
      const searchDir = path.dirname(outputBase)
      const files = await fs.readdir(searchDir)
      const vttFile =
        files.find((f) => f.startsWith(expectedBase) && f.endsWith('.vtt')) || files.find((f) => f.endsWith('.vtt'))
      if (!vttFile) throw new Error('whisper output missing VTT file')

      const vttPath = path.join(searchDir, vttFile)
      const vtt = await fs.readFile(vttPath)
      const transcript = vttToTranscript(vtt.toString('utf8'))

      // Surface normalized outputs for downstream workflows directly from step output
      result.stdout = transcript
      result.stdoutBuffer = vtt

      if (cleanup) await cleanup()
    }

    return { argv, postProcess, allowStdin: false }
  },
  npm: (args) => {
    const payloadValue = args.payload ?? args.arg0
    if (payloadValue === undefined || payloadValue === null) {
      throw new Error('Mermaid payload required')
    }

    const payloadString = typeof payloadValue === 'string' ? payloadValue : JSON.stringify(payloadValue)
    const payload = expectString(payloadString ?? '', 'payload')

    const argv: string[] = ['run', '--silent', 'build-mermaid', '--', payload]
    return { argv, allowStdin: false }
  },
  mmdc: async (args, _cwd, stdinValue) => {
    const input = expectString(args.input || args.arg0, 'input')
    const output = expectString(args.output || args.arg1 || '-', 'output')
    const outputIsStdout = output === '-'
    const { dir: mmdcDir, cleanup: mmdcDirCleanup } = outputIsStdout
      ? await createTmpDir('mmdc-out-')
      : { dir: path.dirname(output), cleanup: undefined as CleanupFn | undefined }
    const tmpOutput = outputIsStdout ? path.join(mmdcDir, `mmdc-${Date.now()}.png`) : output

    let workingInput = input
    let cleanup: CleanupFn | undefined

    if (input === '-') {
      if (!stdinValue || !(typeof stdinValue === 'string' || Buffer.isBuffer(stdinValue))) {
        throw new Error('mmdc requires mermaid stdin when input is "-"')
      }
      const { filePath, cleanup: inputCleanup } = await writeTmpFile('mmdc-in-', '.mmd', stdinValue)
      workingInput = filePath
      cleanup = inputCleanup
    }

    const argv: string[] = ['--input', workingInput, '--output', tmpOutput, '--outputFormat', 'png']

    const postProcess = async ({ result }: { cwd: string; args: any; result: CliRuntimeResult }) => {
      // Prefer captured stdout buffer when provided
      let pngBuffer = result.stdoutBuffer

      // If stdout was redirected to a temp file, prefer the file output regardless of stdout chatter
      if (outputIsStdout) {
        try {
          const fileBuf = await fs.readFile(tmpOutput)
          pngBuffer = fileBuf
        } catch (err) {
          pngBuffer = pngBuffer ?? undefined
        } finally {
          if (outputIsStdout) {
            await fs.rm(tmpOutput, { force: true }).catch(() => {})
          }
        }
      }

      if (pngBuffer) {
        if (!isPngBuffer(pngBuffer)) {
          const svgText = pngBuffer.toString('utf8')
          if (svgText.trim().startsWith('<svg')) {
            const rendered = await renderAsync(svgText)
            pngBuffer = Buffer.from(rendered.asPng())
          }
        }
        if (!isPngBuffer(pngBuffer)) {
          const preview = pngBuffer.subarray(0, 64).toString('hex')
          throw new Error(`mmdc did not produce a valid PNG (exit=${result.exitCode ?? 'unknown'}, head=${preview})`)
        }
        result.stdout = pngBuffer.toString('base64')
        result.stdoutBuffer = pngBuffer
        ;(result as any).files = { 'diagram.png': pngBuffer }
      }

      await combineCleanups(cleanup, mmdcDirCleanup)()
    }

    return { argv, postProcess, allowStdin: false }
  }
}

async function ensureSessionDir(sessionDir = DEFAULT_SESSION_DIR) {
  await fs.mkdir(sessionDir, { recursive: true })
  return sessionDir
}

export async function runCliArgs(
  input: CliRuntimeInvocation,
  opts: { defaultCwd?: string } = {}
): Promise<CliRuntimeResult> {
  const spec = COMMAND_BUILDERS[input.step.command]
  if (!spec) throw new Error(`CLI command not allowed: ${input.step.command}`)

  const argsObject = input.args || {}
  const cwd = input.cwd || opts.defaultCwd || process.cwd()
  const stdinValue = input.stdinValue
  if (
    stdinValue !== undefined &&
    !(typeof stdinValue === 'string' || Buffer.isBuffer(stdinValue) || stdinValue instanceof Uint8Array)
  ) {
    throw new Error('stdinValue must be string or Buffer')
  }

  const {
    argv,
    postProcess,
    allowStdin = true
  } = await spec(argsObject, cwd, stdinValue as string | Buffer | Uint8Array | undefined)

  const capture = input.capture || 'text'
  const wantStdoutBuffer = capture === 'buffer' || capture === 'both'
  const wantStderrBuffer = capture === 'buffer' || capture === 'both'
  const wantStdoutText = capture === 'text' || capture === 'both'
  const wantStderrText = capture === 'text' || capture === 'both'

  const shouldPipeStdin = allowStdin && stdinValue !== undefined

  const child = spawn(input.step.command, argv, {
    cwd,
    shell: false,
    stdio: [
      shouldPipeStdin ? 'pipe' : 'ignore',
      wantStdoutBuffer || wantStdoutText ? 'pipe' : 'inherit',
      wantStderrBuffer || wantStderrText ? 'pipe' : 'inherit'
    ]
  })

  if (shouldPipeStdin && child.stdin) {
    child.stdin.end(
      Buffer.isBuffer(stdinValue) || stdinValue instanceof Uint8Array ? Buffer.from(stdinValue) : stdinValue
    )
  }

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let stdoutSize = 0
  let stderrSize = 0

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutSize + chunk.length <= MAX_CAPTURE_BYTES) {
        stdoutSize += chunk.length
        stdoutChunks.push(chunk)
      }
    })
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrSize + chunk.length <= MAX_CAPTURE_BYTES) {
        stderrSize += chunk.length
        stderrChunks.push(chunk)
      }
    })
  }

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? -1))
  })

  const result: CliRuntimeResult = { exitCode }

  if (wantStdoutBuffer && stdoutChunks.length) result.stdoutBuffer = Buffer.concat(stdoutChunks)
  if (wantStderrBuffer && stderrChunks.length) result.stderrBuffer = Buffer.concat(stderrChunks)
  if (wantStdoutText && stdoutChunks.length) result.stdout = Buffer.concat(stdoutChunks).toString('utf8')
  if (wantStderrText && stderrChunks.length) result.stderr = Buffer.concat(stderrChunks).toString('utf8')

  if (exitCode !== 0) {
    throw new Error(
      `CLI command failed: ${input.step.command} ${argv.join(' ')} exited with code ${exitCode}${
        result.stderr ? `: ${result.stderr}` : ''
      }`
    )
  }

  if (postProcess) await postProcess({ cwd, args: argsObject, result })

  return result
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
      systemPrompt: `You are a tool-selection assistant. Given the transcript and the user's message, choose exactly ONE tool from the available list. Only choose a tool if you are VERY CERTAIN it applies to the user request. If the user simply asks with the tool name, it's safe to assume this is what they are asking, but only if there is necessary provided context appropriate for the tool. If you are not very certain, return {"tool":"none"}. Output must be a single JSON object and nothing else, for example: {"tool":"diagram"}`,
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
          prompt: ['{{user.instructions}}', 'Available tools and when to use them: {{user.tools}}'],
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
  prompt: string
  context?: string[]
  sessionId?: string
  sessionDir?: string
  model?: string
  onProgress?: (msg: string) => void
}): Promise<{ tool: string }> {
  const model = options.model || DEFAULT_MODEL
  const sessionDir = options.sessionDir || DEFAULT_SESSION_DIR

  await ensureSessionDir(sessionDir)

  const contextText = (options.context || []).filter(Boolean).join('\n\n')
  const userInstructions = [
    contextText ? `Context:\n${contextText}` : 'Context: (none)',
    `Prompt:\n${options.prompt}`
  ].join('\n\n')

  const onStream = (msg: AgentStreamEvent) => {
    if (!options.onProgress) return
    if (msg.step === 'chooser') options.onProgress('[Tools] Choosing tool...')
  }

  const response = await runAgentWorkflow(toolsWorkflowDefinition, {
    user: { instructions: userInstructions, tools: formatToolGuide() },
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

export async function runToolWorkflow<TParsed = unknown>(options: {
  prompt: string
  context?: string[]
  model?: string
  sessionDir?: string
  onProgress?: (m: string) => void
}): Promise<{ tool: string; result?: any; parsed?: TParsed; sessionDir?: string }> {
  const chooser = await chooseToolForMention({
    prompt: options.prompt,
    context: options.context,
    model: options.model,
    sessionDir: options.sessionDir,
    onProgress: options.onProgress
  })

  const tool = chooser?.tool || 'none'
  if (!tool || tool === 'none') return { tool }

  options.onProgress?.(`[Tools] Selected tool: ${tool}`)

  // Find tool registry entry to determine workflow mapping
  const toolDef = TOOLS.find((t) => t.name === tool)
  if (!toolDef) throw new Error(`Unknown tool: ${tool}`)

  const workflowKey = toolDef.workflow

  const mapped = toolDef.mapInputs(options.prompt, options.context)

  const inputs = pruneEmpty(mapped) as Record<string, unknown>

  try {
    const workflowDef = getToolWorkflowByName(workflowKey)
    if (!workflowDef) throw new Error(`Unknown tool workflow: ${workflowKey}`)

    const baseSessionDir = options.sessionDir || path.resolve(process.cwd(), '.tmp', 'tools', workflowKey)
    const sessionDir = path.join(baseSessionDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)

    await fs.mkdir(sessionDir, { recursive: true })

    const onStream = (msg: any) => {
      if (!options.onProgress) return
      // Map step names to friendly messages where possible
      if (msg && typeof msg === 'object' && 'step' in msg) {
        options.onProgress(`[${workflowKey}] ${msg.step}...`)
      } else {
        options.onProgress(`[${workflowKey}] progress`)
      }
    }

    const response = await runAgentWorkflow(workflowDef, {
      user: inputs,
      model: options.model || workflowDef.model,
      sessionDir,
      workflows: { [cldWorkflowDefinition.id]: cldWorkflowDefinition },
      workflowId: workflowDef.id,
      workflowSource: 'user',
      workflowLabel: workflowDef.description,
      onStream,
      runCliArgs: (input) => runCliArgs(input, { defaultCwd: sessionDir })
    })

    const result = await response.result
    const lastRound = result.rounds[result.rounds.length - 1]
    const stepKeys = lastRound?.steps ? Object.keys(lastRound.steps) : []
    const lastStep = stepKeys.length ? lastRound.steps[stepKeys[stepKeys.length - 1]] : undefined
    const parsed = lastStep?.parsed as TParsed | undefined

    return { tool, result, parsed, sessionDir }
  } catch (err) {
    console.error(`Tool workflow ${workflowKey} failed to execute`, err)
    return { tool }
  }
}
