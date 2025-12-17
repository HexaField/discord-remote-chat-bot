import { workflow } from '@hexafield/agent-workflow'
import appRootPath from 'app-root-path'

const DEFAULT_MODEL = process.env.TOOLS_MODEL || 'github-copilot/gpt-5-mini'

export const diagramWorkflowDocument = workflow('tools.diagram.v1')
  .description(
    'Create diagram PNG from transcript by extracting CLD data (cld.v1), generating Mermaid markup, and rendering PNG via mmdc.'
  )
  .model(DEFAULT_MODEL)
  .session('worker', '{{runId}}-diagram-worker')
  .parser('passthrough', { type: 'unknown' as const })
  .role('worker', { systemPrompt: 'Diagram worker role (unused for CLI-only flow).', parser: 'passthrough' })
  .user('transcript', { type: 'string', default: '' })
  .round((round) =>
    round
      .start('cld')
      .workflow('cld', 'cld.v1', { input: { instructions: '{{user.transcript}}' }, next: 'mermaid' })
      .cli('mermaid', 'npm', {
        argsObject: { payload: '{{steps.cld.parsed.details.rounds.0.steps.consolidator.raw}}' },
        cwd: appRootPath.path,
        capture: 'text',
        next: 'render'
      })
      .cli('render', 'mmdc', {
        argsObject: { input: '-', output: '-' },
        stdinFrom: 'steps.mermaid.raw',
        capture: 'buffer',
        next: 'emit'
      })
      .transform(
        'emit',
        {
          files: {
            'diagram.png': '$.steps.render.parsed.stdoutBuffer'
          },
          response: 'Diagram generated.'
        },
        { exits: [{ condition: 'always', outcome: 'completed', reason: 'diagram complete' }] }
      )
      .maxRounds(1)
      .defaultOutcome('completed', 'diagram workflow executed')
  )
  .build()
