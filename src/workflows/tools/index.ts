import { validateWorkflowDefinition } from '@hexafield/agent-workflow'
import { cldWorkflowDocument } from '../cld.workflow'
import { diagramWorkflowDocument } from './diagram.workflow'
import { transcribeWorkflowDocument } from './transcribe.workflow'

const registry: Record<string, any> = {}

export function registerToolWorkflow(name: string, doc: any) {
  const def = validateWorkflowDefinition(doc)
  registry[name] = def
  return def
}

// register built-in tools
registerToolWorkflow('transcribe', transcribeWorkflowDocument)
registerToolWorkflow('diagram', diagramWorkflowDocument)
// cld.v1 is referenced by diagram workflow; register under its own id too
registerToolWorkflow('cld', cldWorkflowDocument)

export function getToolWorkflowByName(name: string) {
  return registry[name]
}

export function listToolWorkflows() {
  return Object.keys(registry)
}

export default { registerToolWorkflow, getToolWorkflowByName, listToolWorkflows }
