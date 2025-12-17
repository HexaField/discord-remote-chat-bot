import { runAgentWorkflow } from '@hexafield/agent-workflow'
import appRootPath from 'app-root-path'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { runCliArgs } from '../tools'
import { cldWorkflowDocument } from './cld.workflow'
import { diagramWorkflowDocument } from './diagram.workflow'

test('diagram workflow runs real CLI and emits a valid PNG', async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diagram-workflow-'))

  // Ensure mermaid CLI is discoverable even when tests set cwd
  const binPath = path.join(appRootPath.path, 'node_modules', '.bin')
  const originalPath = process.env.PATH || ''
  process.env.PATH = `${binPath}${path.delimiter}${originalPath}`

  const response = await runAgentWorkflow(diagramWorkflowDocument, {
    user: {
      transcript:
        'Engineers feel schedule pressure when work remaining exceeds time remaining. Schedule pressure increases overtime. Overtime improves completion rate but also increases fatigue, reducing productivity.'
    },
    model: 'github-copilot/gpt-5-mini',
    sessionDir,
    workflowId: diagramWorkflowDocument.id,
    workflowSource: 'user',
    workflowLabel: 'diagram workflow integration test',
    workflows: { [cldWorkflowDocument.id]: cldWorkflowDocument },
    runCliArgs: (input) => runCliArgs(input, { defaultCwd: appRootPath.path })
  })

  const result = await response.result
  const lastRound = result.rounds[result.rounds.length - 1]
  const emitStep = lastRound?.steps?.emit as any
  const cldDetails = (lastRound?.steps?.cld as any)?.parsed?.details
  const cldRound = cldDetails?.rounds?.[0]?.steps?.consolidator
  const cldRaw = cldRound?.raw as string | undefined
  const cldParsed = cldRound?.parsed as { nodes?: unknown; relationships?: unknown }
  const diagram = emitStep?.parsed?.files?.['diagram.png']

  expect(cldRaw).toBeDefined()
  expect(cldParsed?.nodes).toBeDefined()
  expect(cldParsed?.relationships).toBeDefined()

  expect(Buffer.isBuffer(diagram)).toBe(true)
  expect(diagram?.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true)
  // basic sanity: PNG contains rendered mermaid text somewhere
  const mermaidText = lastRound?.steps?.mermaid?.raw as string | undefined
  expect(mermaidText).toBeDefined()
  expect(mermaidText).toContain('graph TD')

  // cleanup PATH for other tests
  process.env.PATH = originalPath
}, 120_000)
