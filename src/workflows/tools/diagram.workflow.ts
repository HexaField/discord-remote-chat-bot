import { AgentWorkflowDefinition } from '@hexafield/agent-workflow'

const DEFAULT_MODEL = process.env.TOOLS_MODEL || 'github-copilot/gpt-5-mini'

export const diagramWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'tools.diagram.v1',
  description:
    'Create diagram PNG from transcript by extracting CLD data (cld.v1), generating Mermaid markup, and rendering PNG via mmdc.',
  model: DEFAULT_MODEL,
  sessions: { roles: [{ role: 'orchestrator' as const, nameTemplate: '{{runId}}-diagram' }] },
  parsers: {
    passthrough: { type: 'unknown' as const },
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
    mermaid: {
      systemPrompt:
        'Given CLD JSON, produce Mermaid flowchart (graph LR) showing nodes and signed edges. Use lowercase node ids derived from labels; include edge labels "+" or "-" for predicate. No code fences or commentary. Output Mermaid only.',
      parser: 'passthrough'
    },
    orchestrator: {
      systemPrompt:
        'Orchestrate diagram creation: call CLD workflow if a transcript is provided, convert CLD JSON to Mermaid, and render PNG via mmdc. Return { files, response } with diagram.png content and a short status.',
      parser: 'toolResult',
      tools: { read: true, write: true }
    }
  },
  user: {
    transcript: { type: 'string', default: '' }
  },
  flow: {
    round: {
      start: 'cld',
      steps: [
        {
          key: 'cld',
          type: 'workflow',
          workflowId: 'cld.v1',
          input: { instructions: '{{user.transcript}}' },
          next: 'mermaid'
        },
        {
          key: 'mermaid',
          role: 'mermaid' as const,
          prompt: ['{{steps.cld.raw}}'],
          next: 'render'
        },
        {
          key: 'render',
          type: 'cli',
          command: 'mmdc',
          argsObject: { input: '-', output: '-' },
          stdinFrom: '{{steps.mermaid.raw||""}}',
          capture: 'buffer',
          next: 'emit'
        },
        {
          key: 'emit',
          type: 'transform',
          template: {
            files: {
              'diagram.png': '$.steps.render.parsed.files["diagram.png"]'
            },
            response: 'Diagram generated.'
          },
          exits: [{ condition: 'always', outcome: 'completed', reason: 'diagram complete' }]
        }
      ],
      maxRounds: 1,
      defaultOutcome: { outcome: 'completed', reason: 'diagram workflow executed' }
    }
  }
} as const satisfies AgentWorkflowDefinition
