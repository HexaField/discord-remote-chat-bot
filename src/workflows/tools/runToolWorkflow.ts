import { runAgentWorkflow, type AgentWorkflowResult } from '@hexafield/agent-workflow'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chooseToolForMention, TOOLS, validateCliArgs } from '../tools'
import { getToolWorkflowByName } from './index'

export async function runToolWorkflow<TParsed = unknown>(
  toolName: string,
  userInputs: Record<string, any> = {},
  opts: { sessionDir?: string; model?: string; onProgress?: (m: string) => void } = {}
): Promise<{ result: AgentWorkflowResult<any>; parsed?: TParsed; raw?: string; sessionDir: string }> {
  const workflowDef = getToolWorkflowByName(toolName)
  if (!workflowDef) throw new Error(`Unknown tool workflow: ${toolName}`)

  const sessionDir = opts.sessionDir || path.resolve(process.cwd(), '.tmp', 'tools', toolName)
  await fs.mkdir(sessionDir, { recursive: true })

  const onStream = (msg: any) => {
    if (!opts.onProgress) return
    // Map step names to friendly messages where possible
    if (msg && typeof msg === 'object' && 'step' in msg) {
      opts.onProgress(`[${toolName}] ${msg.step}...`)
    } else {
      opts.onProgress(`[${toolName}] progress`)
    }
  }

  const response = await runAgentWorkflow(workflowDef, {
    user: userInputs,
    model: opts.model || workflowDef.model,
    sessionDir,
    workflowId: workflowDef.id,
    workflowSource: 'user',
    workflowLabel: workflowDef.description,
    onStream,
    validateCliArgs
  })

  const result = await response.result
  const lastRound = result.rounds[result.rounds.length - 1]
  const stepKeys = lastRound?.steps ? Object.keys(lastRound.steps) : []
  const lastStep = stepKeys.length ? lastRound.steps[stepKeys[stepKeys.length - 1]] : undefined
  const parsed = lastStep?.parsed as TParsed | undefined

  return { result, parsed, raw: lastStep?.raw, sessionDir }
}

export default runToolWorkflow

export async function runToolWorkflowWithChooser<TParsed = unknown>(chooserOptions: {
  question: string
  referenced?: { attachments?: string[]; content?: string }
  model?: string
  sessionDir?: string
  url?: string
  onProgress?: (m: string) => void
}): Promise<{ tool: string; result?: any; parsed?: TParsed; sessionDir?: string }> {
  const chooser = await chooseToolForMention({
    question: chooserOptions.question,
    referenced: chooserOptions.referenced,
    model: chooserOptions.model,
    sessionDir: chooserOptions.sessionDir,
    onProgress: chooserOptions.onProgress
  })

  const tool = chooser?.tool || 'none'
  if (!tool || tool === 'none') return { tool }

  // Find tool registry entry to determine workflow mapping
  const toolDef = TOOLS.find((t) => t.name === tool)
  const workflowKey = toolDef?.workflow || tool

  // Build generic inputs: prefer transcript if available, else url
  const inputs: Record<string, any> = {}
  if (chooserOptions.referenced?.content) inputs.transcript = chooserOptions.referenced.content
  if (chooserOptions.url) inputs.sourceUrl = chooserOptions.url
  if (chooserOptions.sessionDir) inputs.sessionDir = chooserOptions.sessionDir

  try {
    const res = await runToolWorkflow<TParsed>(workflowKey, inputs, {
      sessionDir: chooserOptions.sessionDir,
      model: chooserOptions.model,
      onProgress: chooserOptions.onProgress
    })
    return { tool, result: res.result, parsed: res.parsed, sessionDir: res.sessionDir }
  } catch (e) {
    return { tool }
  }
}
