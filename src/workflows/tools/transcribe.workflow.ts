import { AgentWorkflowDefinition } from '@hexafield/agent-workflow'
import path from 'node:path'

const DEFAULT_MODEL = process.env.TOOLS_MODEL || 'github-copilot/gpt-5-mini'

export const transcribeWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'tools.transcribe.v1',
  description: 'Download audio via yt-dlp and transcribe using Whisper (CLI steps).',
  model: DEFAULT_MODEL,
  sessions: { roles: [{ role: 'worker' as const, nameTemplate: '{{runId}}-transcribe' }] },
  parsers: {
    transcribeResult: {
      type: 'object',
      properties: {
        vttPath: { type: 'string' },
        transcript: { type: 'string' }
      },
      required: ['vttPath', 'transcript'],
      additionalProperties: false
    }
  },
  roles: {
    worker: {
      systemPrompt: 'Transcribe audio files. Use the CLI steps to download and transcribe audio. Return parsed { vttPath, transcript }.',
      parser: 'transcribeResult',
      tools: { webfetch: true, bash: true, read: true, write: true }
    }
  },
  user: {
    url: { type: 'string', default: '' },
    sessionDir: { type: 'string', default: path.resolve(process.cwd(), '.tmp', 'transcribe') }
  },
  flow: {
    round: {
      start: 'download',
      steps: [
        {
          key: 'download',
          type: 'cli',
          command: 'yt-dlp',
          args: ['-x', '--audio-format', 'wav', '-o', '{{user.sessionDir}}/{{run.id}}.%(ext)s', '{{user.url}}'],
          next: 'whisper'
        },
        {
          key: 'whisper',
          type: 'cli',
          command: 'whisper',
          // whisper CLI: whisper <input> --model small --output_format vtt --output_dir <dir>
          args: ['{{steps.download.args.0||""}}', '--model', 'small', '--output_format', 'vtt', '--output_dir', '{{user.sessionDir}}'],
          next: 'emit'
        },
        {
          key: 'emit',
          role: 'worker' as const,
          prompt: [
            'Finalize transcription result. The whisper CLI wrote a .vtt file into {{user.sessionDir}} with a filename starting with {{run.id}}. Read that file and return { vttPath, transcript }.'
          ],
          exits: [{ condition: 'always', outcome: 'completed', reason: 'transcription complete' }]
        }
      ],
      maxRounds: 1,
      defaultOutcome: { outcome: 'completed', reason: 'transcription executed' }
    }
  }
} as const satisfies AgentWorkflowDefinition
