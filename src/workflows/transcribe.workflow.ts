import { workflow } from '@hexafield/agent-workflow'

const DEFAULT_MODEL = process.env.TOOLS_MODEL || 'github-copilot/gpt-5-mini'

const toolResultParser = {
  type: 'object',
  properties: {
    files: { type: 'object', properties: {}, additionalProperties: true },
    response: { type: 'string' }
  },
  required: ['files'],
  additionalProperties: true
} as const

export const transcribeWorkflowDocument = workflow('tools.transcribe.v1')
  .description('Download audio via yt-dlp and transcribe using whisper-cli. No shell, only allowed CLIs.')
  .model(DEFAULT_MODEL)
  .session('worker', '{{runId}}-transcribe')
  .parser('toolResult', toolResultParser)
  .role('worker', {
    systemPrompt:
      'Transcribe audio files without using any shell. Use yt-dlp to download audio and whisper-cli to produce VTT. Return { files, response } where files include audio.vtt and transcript.txt.',
    parser: 'toolResult',
    tools: { webfetch: true, read: true, write: true }
  })
  .user('url', { type: 'string', default: '' })
  .round((round) =>
    round
      .start('download')
      .cli('download', 'yt-dlp', {
        argsObject: {
          url: '{{user.url}}',
          output: '-',
          audioFormat: 'wav',
          extractAudio: 'true'
        },
        capture: 'buffer',
        next: 'transcribe'
      })
      .cli('transcribe', 'whisper-cli', {
        argsObject: { input: '-', outputDir: '-' },
        stdinFrom: 'steps.download.parsed.stdoutBuffer',
        capture: 'buffer',
        next: 'emit'
      })
      .transform(
        'emit',
        {
          files: {
            'audio.vtt': '$.steps.transcribe.parsed.stdoutBuffer',
            'transcript.txt': '$.steps.transcribe.parsed.stdout'
          },
          response: '$.steps.transcribe.parsed.stdout'
        },
        { exits: [{ condition: 'always', outcome: 'completed', reason: 'transcription complete' }] }
      )
      .maxRounds(1)
      .defaultOutcome('completed', 'transcription executed')
  )
  .build()
