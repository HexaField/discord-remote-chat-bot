import { spawn } from 'child_process'
import ollama from 'ollama'
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

async function callOllama(systemPrompt: string, userQuery: string, model: string): Promise<string> {
  const response = await ollama.chat({
    model,
    options: {
      num_ctx: modelSettings[model]?.maxContext || MODEL_MAX_CTX
    },
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userQuery }
    ]
  })

  let fullMessage = ''
  for await (const chunk of response as any) {
    if (chunk.message?.content) {
      fullMessage += chunk.message.content
    }
  }
  return fullMessage
}

async function callOpencodeCLI(systemPrompt: string, userQuery: string, model: string): Promise<string> {
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
  const res = await runCLI('opencode', ['run', combined, '-m', modelToUse, '--format', 'json'], '')
  console.log('Opencode CLI output:', res)

  const finalRes = res
    .split('\n')
    .map(extractOrCreateJSON)
    .reverse()
    .find((obj) => obj && typeof obj === 'object' && obj.type === 'text' && obj.text).text.text
  console.log('finalRes:', finalRes)
  return finalRes
}

async function callGooseCLI(systemPrompt: string, userQuery: string, model: string): Promise<string> {
  const combined = `${systemPrompt}\n${userQuery}`
  // Try to pick a provider/model that exists locally via opencode models if possible.
  let providerArg = undefined

  const args = ['run', '--text', combined, '--no-session']
  if (providerArg) args.push('--provider', providerArg)
  // ignore model and assume it's already configured
  // if (model) args.push('--model', model)
  // Use quiet mode if available to reduce extra output

  const out = await runCLI('goose', args, '')
  console.log('Goose CLI output:', out)
  return out
}

async function callOllamaCLI(systemPrompt: string, userQuery: string, model: string): Promise<string> {
  const combined = `${systemPrompt}\n${userQuery}`
  // Use `ollama run MODEL PROMPT --format json` to get a JSON response when supported.
  // Pass the prompt as a positional argument; do not send via stdin.
  const out = await runCLI('ollama', ['run', model, combined, '--format', 'json'], '')
  return out
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
  retries = 2
): Promise<LLMResponse> {
  const combinedText = `${systemPrompt}\n${userQuery}`
  const tokenCount = combinedText.length / 4 // rough estimate

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
        raw = await callOllama(systemPrompt, userQuery, model)
      } else if (provider === 'opencode') {
        raw = await callOpencodeCLI(systemPrompt, userQuery, String(model))
      } else if (provider === 'goose') {
        raw = await callGooseCLI(systemPrompt, userQuery, String(model))
      } else if (provider === 'ollama-cli') {
        raw = await callOllamaCLI(systemPrompt, userQuery, String(model))
      } else {
        throw new Error(`Unsupported LLM provider: ${provider}`)
      }

      debug('LLM raw response', raw)

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
