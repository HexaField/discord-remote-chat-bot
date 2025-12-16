import { workflow } from '@hexafield/agent-workflow'

const DEFAULT_MODEL = process.env.TOOLS_MODEL || 'github-copilot/gpt-5-mini'

const passthroughParser = { type: 'unknown' as const }

const toolResultParser = {
  type: 'object',
  properties: {
    files: { type: 'object', properties: {}, additionalProperties: true },
    response: { type: 'string' }
  },
  required: ['files'],
  additionalProperties: true
} as const

export const diagramWorkflowDocument = workflow('tools.diagram.v1')
  .description(
    'Create diagram PNG from transcript by extracting CLD data (cld.v1), generating Mermaid markup, and rendering PNG via mmdc.'
  )
  .model(DEFAULT_MODEL)
  .session('mermaid', '{{runId}}-json-to-mermaid-diagram')
  .parser('passthrough', passthroughParser)
  .parser('toolResult', toolResultParser)
  .role('mermaid', {
    systemPrompt:
      'Given CLD JSON, produce Mermaid flowchart (graph LR) showing nodes and signed edges. Use lowercase node ids derived from labels; include edge labels "+" or "-" for predicate. No code fences or commentary. Output Mermaid only.',
    parser: 'passthrough'
  })
  .user('transcript', { type: 'string', default: '' })
  .round((round) =>
    round
      .start('cld')
      .workflow('cld', 'cld.v1', { input: { instructions: '{{user.transcript}}' }, next: 'mermaid' })
      .agent('mermaid', 'mermaid', ['{{steps.cld.raw}}'], { next: 'render' })
      .cli('render', 'mmdc', {
        argsObject: { input: '-', output: '-' },
        stdinFrom: '{{steps.mermaid.raw}}',
        capture: 'buffer',
        next: 'emit'
      })
      .transform(
        'emit',
        {
          files: {
            'diagram.png': '$.steps.render.parsed.files["diagram.png"]'
          },
          response: 'Diagram generated.'
        },
        { exits: [{ condition: 'always', outcome: 'completed', reason: 'diagram complete' }] }
      )
      .maxRounds(1)
      .defaultOutcome('completed', 'diagram workflow executed')
  )
  .build()
