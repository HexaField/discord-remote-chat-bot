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
    diagramResult: {
      type: 'object',
      properties: {
        pngBase64: { type: 'string' }
      },
      required: ['pngBase64'],
      additionalProperties: false
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
        'Orchestrate diagram creation: call CLD workflow if a transcript is provided, pipe graph JSON into mermaid CLI and mmdc to render a PNG without intermediate files. Return { pngBase64 } (base64 of the PNG).',
      parser: 'diagramResult',
      tools: { read: true, write: true, bash: true }
    }
  },
  user: {
    transcript: { type: 'string', default: '' }
  },
  flow: {
    round: {
      start: 'maybeClf',
      steps: [
        {
          key: 'maybeClf',
          type: 'workflow',
          workflowId: 'cld.v1',
          input: { instructions: '{{user.transcript}}' },
          next: 'mermaid'
        },
        {
          key: 'mermaid',
          role: 'mermaid' as const,
          prompt: ['{{steps.maybeClf.raw}}'],
          next: 'render'
        },
        {
          key: 'render',
          type: 'cli',
          command: 'bash',
          args: [`mmdc --input {{steps.mermaid.raw}} --output - | base64 | tr -d`],
          next: 'emit'
        },
        {
          key: 'emit',
          role: 'orchestrator' as const,
          prompt: ['Return { "pngBase64": "{{steps.render.raw}}" }'],
          exits: [{ condition: 'always', outcome: 'completed', reason: 'diagram complete' }]
        }
      ],
      maxRounds: 1,
      defaultOutcome: { outcome: 'completed', reason: 'diagram workflow executed' }
    }
  }
} as const satisfies AgentWorkflowDefinition
