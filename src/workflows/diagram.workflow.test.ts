import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { runAgentWorkflow, workflow } from '@hexafield/agent-workflow'
import { buildMermaid } from '../exporters/mermaidExporter'
import { diagramWorkflowDocument } from './diagram.workflow'

const SAMPLE_NODES = [
  { label: 'schedule pressure', type: 'driver' },
  { label: 'overtime', type: 'actor' },
  { label: 'completion rate', type: 'other' }
]

const SAMPLE_RELATIONSHIPS = [
  { subject: 'schedule pressure', predicate: 'positive', object: 'overtime' },
  { subject: 'overtime', predicate: 'positive', object: 'completion rate' }
]

test('diagram workflow renders mermaid and emits png buffer', async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diagram-workflow-'))

  const cldStub = workflow('cld.v1')
    .description('Stub CLD workflow for diagram tests')
    .session('noop', '{{runId}}-noop')
    .parser('passthrough', { type: 'unknown' as const })
    .role('noop', { systemPrompt: 'noop', parser: 'passthrough' })
    .user('instructions', { type: 'string', default: '' })
    .round((round) =>
      round
        .start('consolidator')
        .transform(
          'consolidator',
          { nodes: '$.input.nodes', relationships: '$.input.relationships' },
          {
            input: { nodes: SAMPLE_NODES, relationships: SAMPLE_RELATIONSHIPS },
            exits: [{ condition: 'always', outcome: 'completed', reason: 'cld ready' }]
          }
        )
        .maxRounds(1)
        .defaultOutcome('completed', 'stub cld complete')
    )
    .build()

  const fakeRunCliArgs = async ({ step, args, stdinValue }: any) => {
    if (step.command === 'npm') {
      const payloadValue = (args as any).payload
      const parsed = typeof payloadValue === 'string' ? JSON.parse(payloadValue) : payloadValue
      const mermaid = buildMermaid(parsed.nodes ?? [], parsed.relationships ?? [])
      return { stdout: mermaid, exitCode: 0 }
    }

    if (step.command === 'mmdc') {
      const mermaid = typeof stdinValue === 'string' ? stdinValue : ''
      const png = Buffer.from(`png:${mermaid}`)
      return { stdoutBuffer: png, exitCode: 0 }
    }

    throw new Error(`Unexpected command ${step.command}`)
  }

  const response = await runAgentWorkflow(diagramWorkflowDocument, {
    user: { transcript: 'example transcript' },
    model: 'test-model',
    sessionDir,
    workflowId: diagramWorkflowDocument.id,
    workflowSource: 'user',
    workflowLabel: 'diagram workflow test',
    workflows: { [cldStub.id]: cldStub },
    runCliArgs: fakeRunCliArgs
  })

  const result = await response.result
  const lastRound = result.rounds[result.rounds.length - 1]
  const emitStep = lastRound?.steps?.emit as any
  const diagram = emitStep?.parsed?.files?.['diagram.png']

  expect(Buffer.isBuffer(diagram)).toBe(true)
  expect(diagram?.toString('utf8')).toContain('graph TD')
})
