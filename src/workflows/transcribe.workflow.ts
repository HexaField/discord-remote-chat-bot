import { AgentWorkflowDefinition } from '@hexafield/agent-workflow'

const DEFAULT_MODEL = process.env.TOOLS_MODEL || 'github-copilot/gpt-5-mini'

export const transcribeWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'tools.transcribe.v1',
  description: 'Download audio via yt-dlp and transcribe using whisper-cli. No shell, only allowed CLIs.',
  model: DEFAULT_MODEL,
  sessions: { roles: [{ role: 'worker' as const, nameTemplate: '{{runId}}-transcribe' }] },
  parsers: {
    toolResult: {
      type: 'object',
      properties: {
        files: { type: 'object', properties: {}, additionalProperties: true },
        response: { type: 'string' }
      },
      required: ['files'],
      additionalProperties: true
    }
  },
  roles: {
    worker: {
      systemPrompt:
        'Transcribe audio files without using any shell. Use yt-dlp to download audio and whisper-cli to produce VTT. Return { files, response } where files include audio.vtt and transcript.txt.',
      parser: 'toolResult',
      tools: { webfetch: true, read: true, write: true }
    }
  },
  user: {
    sourceUrl: { type: 'string', default: '' }
  },
  flow: {
    round: {
      start: 'download',
      steps: [
        {
          key: 'download',
          type: 'cli',
          command: 'yt-dlp',
          argsObject: {
            url: '{{user.sourceUrl}}',
            output: '-',
            audioFormat: 'wav',
            extractAudio: 'true'
          },
          capture: 'buffer',
          next: 'transcribe'
        },
        {
          key: 'transcribe',
          type: 'cli',
          command: 'whisper-cli',
          argsObject: { input: '-', outputDir: '-' },
          stdinFrom: 'steps.download.parsed.stdoutBuffer',
          capture: 'buffer',
          next: 'emit'
        },
        {
          key: 'emit',
          type: 'transform',
          template: {
            files: {
              'audio.vtt': '$.steps.transcribe.parsed.stdoutBuffer',
              'transcript.txt': '$.steps.transcribe.parsed.stdout'
            },
            response: '$.steps.transcribe.parsed.stdout'
          },
          exits: [{ condition: 'always', outcome: 'completed', reason: 'transcription complete' }]
        }
      ],
      maxRounds: 1,
      defaultOutcome: { outcome: 'completed', reason: 'transcription executed' }
    }
  }
} as const satisfies AgentWorkflowDefinition
