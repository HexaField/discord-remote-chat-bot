import { validateWorkflowDefinition, workflow, type WorkflowParserJsonOutput } from '@hexafield/agent-workflow'

const DEFAULT_MODEL = process.env.TOOLS_MODEL || 'github-copilot/gpt-5-mini'

const transformParser = {
  type: 'object',
  properties: {
    transform: { type: 'object', properties: {}, additionalProperties: true },
    rationale: { type: 'string' }
  },
  required: ['transform'],
  additionalProperties: true
} as const

export const contextTransformWorkflowDocument = workflow('tools.context-transform.v1')
  .description('Map mention context into the input shape a selected tool expects using jsonpath-object-transform.')
  .model(DEFAULT_MODEL)
  .session('mapper', '{{runId}}-context-transform')
  .parser('transform', transformParser)
  .role('mapper', {
    systemPrompt: `You map a provided mention context into the input object expected by a specific tool.
Use jsonpath-object-transform templates where each leaf is a JSONPath (starting with $.). The JSONPath root is the provided context object.
Rules:
- Prefer referenced content for long-form text (transcripts or notes).
- Prefer URLs from attachments or explicit links in the question when a url field is expected.
- Do not invent values; leave a field as an empty string when the value does not exist.
- Keep the template minimal—only include keys present in the target shape.
Respond with strict JSON: {"transform": { ... }} and nothing else.`,
    parser: 'transform'
  })
  .user('context', { type: 'string', default: '{}' })
  .user('target', { type: 'string', default: '{}' })
  .user('tool', { type: 'string', default: '' })
  .round((round) =>
    round
      .start('mapper')
      .agent(
        'mapper',
        'mapper',
        [
          'Tool: {{user.tool}}',
          'Target input example (keys only): {{user.target}}',
          'Context JSON (root object named context): {{user.context}}',
          'Return only {"transform": { ... }} mapping from the context root to the target keys using jsonpath-object-transform.'
        ],
        { exits: [{ condition: 'always', outcome: 'completed', reason: 'Context transform generated' }] }
      )
      .maxRounds(1)
      .defaultOutcome('completed', 'Context transform workflow executed')
  )
  .build()

export type ContextTransformWorkflowDefinition = typeof contextTransformWorkflowDocument
export type ContextTransformParserOutput = WorkflowParserJsonOutput<typeof transformParser>
export const contextTransformWorkflowDefinition = validateWorkflowDefinition(contextTransformWorkflowDocument)
