import axios from 'axios'
import { spawn } from 'child_process'
import fs from 'fs'
import ollama from 'ollama'
import path from 'path'
import { debug } from './logger'

const modelSettings = {
  'llama3.2': {
    maxContext: 128000
  },
  'gpt-oss:20b': {
    maxContext: 32000
  },
  'llama3.1:8b': {
    maxContext: 64000
  }
} as {
  [model: string]: {
    maxContext: number
  }
}

const MODEL_MAX_CTX = 128000

export type LLMResponse = {
  success: boolean
  data?: string
  error?: string
}

export type Provider = 'ollama' | 'opencode' | 'goose' | 'ollama-cli'

// Simple in-memory session stores. For ollama we keep a rolling chat history per session.
// For CLI-based providers we prefer passing a --session flag, but also retain the
// last assistant text for optional future heuristics if desired.
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
const ollamaSessions = new Map<string, ChatMessage[]>()
const cliLastResponses = new Map<string, string>()

// Persistent session storage now lives inside a caller-provided directory (e.g. a sourceDir).
// We support legacy global path for backward compatibility if no directory supplied.
function metaFile(sessionId: string, baseDir?: string) {
  const dir = baseDir ? path.join(baseDir) : path.join(process.cwd(), '.sessions', sessionId)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'meta.json')
}
type SessionMeta = {
  id: string
  providerData?: {
    ollama?: { messages: ChatMessage[] }
    cli?: { last: string[] }
  }
  createdAt: string
  updatedAt: string
}
function loadSessionMeta(sessionId: string, baseDir?: string): SessionMeta {
  const file = metaFile(sessionId, baseDir)
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      return JSON.parse(raw)
    } catch (e) {
      debug('Failed to parse session meta.json; recreating', e)
    }
  }
  const blank: SessionMeta = {
    id: sessionId,
    providerData: { ollama: { messages: [] }, cli: { last: [] } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  saveSessionMeta(blank, baseDir)
  return blank
}
function saveSessionMeta(meta: SessionMeta, baseDir?: string) {
  const file = metaFile(meta.id, baseDir)
  meta.updatedAt = new Date().toISOString()
  fs.writeFileSync(file, JSON.stringify(meta, null, 2))
}

export async function runCLI(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''

    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (err += String(chunk)))

    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`CLI exited ${code}: ${err}`))
      }
      resolve(out)
    })

    if (input) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })
}

function wrapAsJSONCodeFence(obj: any): string {
  const pretty = JSON.stringify(obj, null, 2)
  // Avoid template literal containing backticks to prevent parser confusion; build with concatenation.
  return '\n\n```json\n' + pretty + '\n```\n'
}

function extractOrCreateJSON(fullMessage: string): any {
  // Try to parse directly
  try {
    return JSON.parse(fullMessage)
  } catch (e) {
    // Try to extract JSON objects from the text and pick one that looks like structured output.
    const allMatches = Array.from(fullMessage.matchAll(/(\{[\s\S]*?\})/g)).map((r) => r[1])
    for (const jsonText of allMatches) {
      try {
        const parsed = JSON.parse(jsonText)
        // Prefer objects that match the typical { answer, status } shape or any non-empty object.
        if (parsed && typeof parsed === 'object') {
          // If this object directly matches the expected shape, return it.
          if ('answer' in parsed && 'status' in parsed) return parsed

          // Some CLIs wrap the JSON as a string under a `text`/`message` field.
          for (const key of ['text', 'message', 'content']) {
            if (typeof (parsed as any)[key] === 'string') {
              const inner = (parsed as any)[key]
              try {
                const innerParsed = JSON.parse(inner)
                if (
                  innerParsed &&
                  typeof innerParsed === 'object' &&
                  'answer' in innerParsed &&
                  'status' in innerParsed
                ) {
                  return innerParsed
                }
              } catch (e) {
                // not JSON, continue
              }
            }
          }

          // Otherwise, accept any non-empty object as a fallback.
          if (Object.keys(parsed).length > 0) return parsed
        }
      } catch (e2) {
        // ignore
      }
    }
    // Fallback: embed raw text under `text`
    return { text: fullMessage }
  }
}

async function callOllama(
  systemPrompt: string,
  userQuery: string,
  model: string,
  sessionId?: string,
  sessionDir?: string
): Promise<string> {
  // Maintain a per-session message history when a sessionId is provided
  let messages: ChatMessage[]
  if (sessionId) {
    const meta = loadSessionMeta(sessionId, sessionDir)
    messages = (meta.providerData?.ollama?.messages as ChatMessage[]) || []
    if (messages.length === 0) messages.push({ role: 'system', content: systemPrompt })
    messages.push({ role: 'user', content: userQuery })
    ollamaSessions.set(sessionId, messages)
  } else {
    messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userQuery }
    ]
  }

  const response = await ollama.chat({
    model,
    options: {
      num_ctx: modelSettings[model]?.maxContext || MODEL_MAX_CTX
    },
    stream: true,
    messages
  })

  let fullMessage = ''
  for await (const chunk of response as any) {
    if (chunk.message?.content) {
      fullMessage += chunk.message.content
    }
  }
  // Store assistant turn for session continuity
  if (sessionId) {
    const hist = ollamaSessions.get(sessionId) || messages
    hist.push({ role: 'assistant', content: fullMessage })
    ollamaSessions.set(sessionId, hist)
    // Persist to disk
    const meta = loadSessionMeta(sessionId, sessionDir)
    meta.providerData = meta.providerData || {}
    meta.providerData.ollama = { messages: hist }
    saveSessionMeta(meta, sessionDir)
  }
  return fullMessage
}

async function callOpencodeCLI(
  systemPrompt: string,
  userQuery: string,
  model: string,
  sessionId?: string,
  sessionDir?: string
): Promise<string> {
  // We assume `opencode` CLI is installed. We'll pass the combined prompt as a positional argument.
  const combined = `${systemPrompt}\n${userQuery}`
  // If the model doesn't include a provider (provider/model), try to pick a default available model.
  let modelToUse = model
  if (!model.includes('/')) {
    try {
      const modelsRaw = await runCLI('opencode', ['models'], '')
      const lines = modelsRaw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      // prefer local opencode models first, then github-copilot provider models
      const preferredLocal = lines.find((l) => /^opencode\//i.test(l))
      const preferredProvider = lines.find((l) => /github-?copilot|gpt|o3|claude|gemini/i.test(l))
      modelToUse = (preferredLocal as string) || (preferredProvider as string) || lines[0] || model
    } catch (e) {
      // if listing models fails, fall back to the given model
      modelToUse = model
    }
  }

  // Use the `run` subcommand with the prompt as a positional argument and request JSON output.
  const args = ['run', combined, '-m', modelToUse, '--format', 'json']
  // opencode run manages its own sessions; do not force a session flag here.
  const res = await runCLI('opencode', args, '')
  debug('Opencode CLI output:', res.split('\n').map(extractOrCreateJSON))

  const finalRes = res
    .split('\n')
    .map(extractOrCreateJSON)
    .reverse() // get last
    .find((obj) => (obj && typeof obj === 'object' && obj.type === 'text' && obj.part) || obj.text)

  let text = finalRes?.part?.text ?? finalRes?.text?.text ?? ''
  if (!text) {
    // Fallback: if output is a bare JSON object or array, surface it directly
    try {
      const maybe = extractOrCreateJSON(res)
      if (maybe && typeof maybe === 'object') {
        text = JSON.stringify(maybe)
      }
    } catch (e) {
      // ignore, keep empty text
    }
  }
  if (sessionId) {
    cliLastResponses.set(sessionId, text)
    const meta = loadSessionMeta(sessionId, sessionDir)
    meta.providerData = meta.providerData || {}
    const prev = meta.providerData.cli?.last || []
    meta.providerData.cli = { last: [...prev, text] }
    saveSessionMeta(meta, sessionDir)
  }
  debug('finalRes:', text)
  return text
}

async function callGooseCLI(
  systemPrompt: string,
  userQuery: string,
  model: string,
  sessionId?: string,
  sessionDir?: string
): Promise<string> {
  const combined = `${systemPrompt}\n${userQuery}`
  // Try to pick a provider/model that exists locally via opencode models if possible.
  let providerArg = undefined

  const args = ['run', '--text', combined, '--no-session']
  if (providerArg) args.push('--provider', providerArg)
  if (sessionId) args.push('--session-id', sessionId)
  // ignore model and assume it's already configured
  // if (model) args.push('--model', model)
  // Use quiet mode if available to reduce extra output

  const out = await runCLI('goose', args, '')
  debug('Goose CLI output:', out)
  if (sessionId) {
    cliLastResponses.set(sessionId, out)
    const meta = loadSessionMeta(sessionId, sessionDir)
    meta.providerData = meta.providerData || {}
    const prev = meta.providerData.cli?.last || []
    meta.providerData.cli = { last: [...prev, out] }
    saveSessionMeta(meta, sessionDir)
  }
  return outClean(out)
}

async function callOllamaCLI(
  systemPrompt: string,
  userQuery: string,
  model: string,
  sessionId?: string,
  sessionDir?: string
): Promise<string> {
  const combined = `${systemPrompt}\n${userQuery}`
  // Use `ollama run MODEL PROMPT --format json` to get a JSON response when supported.
  // Pass the prompt as a positional argument; do not send via stdin.
  const args = ['run', model, combined, '--format', 'json']
  const out = await runCLI('ollama', args, '')
  if (sessionId) {
    cliLastResponses.set(sessionId, out)
    const meta = loadSessionMeta(sessionId, sessionDir)
    meta.providerData = meta.providerData || {}
    const prev = meta.providerData.cli?.last || []
    meta.providerData.cli = { last: [...prev, out] }
    saveSessionMeta(meta, sessionDir)
  }
  return outClean(out)
}

function outClean(s: string): string {
  // Small normalization to reduce spurious whitespace differences
  return typeof s === 'string' ? s.trim() : s
}

/**
 * callLLM - unified LLM caller with simple provider adapters and retries.
 * - provider: 'ollama' | 'opencode' | 'goose'
 * - ensures the returned `data` contains a JSON code-fence so callers can reliably parse it.
 */
export async function callLLM(
  systemPrompt: string,
  userQuery: string,
  provider = 'ollama',
  model = 'llama3.2',
  optionsOrRetries?: number | { retries?: number; sessionId?: string; sessionDir?: string }
): Promise<LLMResponse> {
  let retries = 2
  let sessionId: string | undefined = undefined
  let sessionDir: string | undefined = undefined
  if (typeof optionsOrRetries === 'number') {
    retries = optionsOrRetries
  } else if (typeof optionsOrRetries === 'object' && optionsOrRetries) {
    if (typeof optionsOrRetries.retries === 'number') retries = optionsOrRetries.retries
    if (typeof optionsOrRetries.sessionId === 'string') sessionId = optionsOrRetries.sessionId
    if (typeof (optionsOrRetries as any).sessionDir === 'string') sessionDir = (optionsOrRetries as any).sessionDir
  }
  // Ensure session meta exists when sessionId provided
  if (sessionId) {
    loadSessionMeta(sessionId, sessionDir)
  }
  const tokenCount = (systemPrompt.length + userQuery.length) / 4 // rough estimate

  debug('LLM token count', tokenCount)
  if (tokenCount > 0 && tokenCount > MODEL_MAX_CTX) {
    console.warn(
      `LLM prompt token count (${tokenCount}) exceeds model max context (${MODEL_MAX_CTX}). Prompt may be truncated or rejected.`
    )
  }

  let lastErr: any = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      let raw = ''
      if (provider === 'ollama') {
        raw = await callOllama(systemPrompt, userQuery, model, sessionId, sessionDir)
      } else if (provider === 'opencode') {
        raw = await callOpencodeCLI(systemPrompt, userQuery, String(model), sessionId, sessionDir)
      } else if (provider === 'goose') {
        raw = await callGooseCLI(systemPrompt, userQuery, String(model), sessionId, sessionDir)
      } else if (provider === 'ollama-cli') {
        raw = await callOllamaCLI(systemPrompt, userQuery, String(model), sessionId, sessionDir)
      } else {
        throw new Error(`Unsupported LLM provider: ${provider}`)
      }

      debug('LLM', provider, model, 'raw response', raw)

      const parsed = extractOrCreateJSON(raw)
      const fenced = wrapAsJSONCodeFence(parsed)

      return { success: true, data: fenced }
    } catch (err) {
      lastErr = err
      debug(`LLM attempt ${attempt} failed`, err)
      if (attempt < retries) {
        // small backoff
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
        continue
      }
    }
  }

  return { success: false, error: String(lastErr) }
}

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'

// getEmbedding now uses Ollama exclusively - no fallbacks
export async function getEmbedding(text: string, model?: string) {
  const clean = text.replace(/\n/g, ' ')
  const embedModel = model || process.env.OLLAMA_EMBEDDING_MODEL || 'bge-m3:latest'
  const payload = { model: embedModel, input: clean }

  try {
    const resp = await axios.post(`${OLLAMA_URL}/api/embed`, payload, { timeout: 120_000 })
    const data = resp.data

    // Ollama /api/embed response format: { "embeddings": [[...]] }
    if (data && Array.isArray(data.embeddings)) {
      if (data.embeddings[0] && Array.isArray(data.embeddings[0])) {
        return data.embeddings[0]
      } else {
        throw new Error(`No embeddings were returned for text ${text}.`)
      }
    }

    // No fallbacks - fail immediately if embeddings not available
    throw new Error(
      `Embeddings API returned unexpected format for model ${embedModel}. Response: ${JSON.stringify(data)}. Ensure Ollama is running at ${OLLAMA_URL} and the model supports embeddings.`
    )
  } catch (error: any) {
    if (error.response) {
      throw new Error(
        `Ollama embeddings API error (${error.response.status}): ${JSON.stringify(error.response.data)}. Ensure model ${embedModel} is installed (run: ollama pull ${embedModel}) and Ollama is running at ${OLLAMA_URL}.`
      )
    }
    throw error
  }
}
