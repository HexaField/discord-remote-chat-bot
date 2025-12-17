import {
  AgentStreamEvent,
  runAgentWorkflow,
  workflow,
  WorkflowParserJsonOutput,
  type AgentWorkflowResult
} from '@hexafield/agent-workflow'

import os from 'node:os'

const passthroughParser = { type: 'unknown' as const }

const meetingDigestParser = {
  type: 'object',
  properties: {
    insights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' }, default: [] }
        },
        required: ['summary'],
        additionalProperties: false
      },
      default: []
    },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          owner: { type: 'string', default: '' },
          due: { type: 'string', default: '' },
          status: { type: 'string', enum: ['new', 'in-progress', 'blocked', 'done'], default: 'new' },
          source: { type: 'string', default: '' }
        },
        required: ['task'],
        additionalProperties: false
      },
      default: []
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
          rationale: { type: 'string', default: '' },
          source: { type: 'string', default: '' }
        },
        required: ['decision'],
        additionalProperties: false
      },
      default: []
    },
    openQuestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          owner: { type: 'string', default: '' },
          source: { type: 'string', default: '' }
        },
        required: ['question'],
        additionalProperties: false
      },
      default: []
    }
  },
  required: ['insights', 'actionItems', 'decisions', 'openQuestions'],
  additionalProperties: false
} as const

export const meetingDigestWorkflowDocument = workflow('meeting-digest.v1')
  .description('Summarise meetings into insights, action items, decisions, and open questions.')
  .model('github-copilot/gpt-5-mini')
  .session('insight', '{{runId}}-digest-insight')
  .session('actions', '{{runId}}-digest-actions')
  .session('decisions', '{{runId}}-digest-decisions')
  .session('questions', '{{runId}}-digest-questions')
  .session('integrator', '{{runId}}-digest-integrator')
  .parser('passthrough', passthroughParser)
  .parser('meetingDigest', meetingDigestParser)
  .role('insight', {
    systemPrompt: `Extract concise, non-overlapping insights from the meeting transcript.
- Insights are durable findings, observations, or agreements about the situation.
- Stay faithful to the text; avoid speculation or advice.
Return strict JSON: {"insights": [{"summary": "...", "evidence": ["..."]}]}. Use evidence spans from the transcript. Empty array if none.`,
    parser: 'passthrough'
  })
  .role('actions', {
    systemPrompt: `List concrete action items or new tasks from the meeting.
- Each item should include task description, owner if stated, and due date if stated.
- Avoid restating insights or decisions here.
Return strict JSON: {"actionItems": [{"task": "...", "owner": "", "due": "", "status": "new", "source": "..."}]}. Empty array if none.`,
    parser: 'passthrough'
  })
  .role('decisions', {
    systemPrompt: `Capture decisions made in the meeting.
- A decision is a resolved choice with commitment.
- Include brief rationale if present.
Return strict JSON: {"decisions": [{"decision": "...", "rationale": "", "source": "..."}]}. Empty array if none.`,
    parser: 'passthrough'
  })
  .role('questions', {
    systemPrompt: `List open questions that remain unresolved.
- Include who raised or owns the question if known.
- Exclude rhetorical questions or ones already answered.
Return strict JSON: {"openQuestions": [{"question": "...", "owner": "", "source": "..."}]}. Empty array if none.`,
    parser: 'passthrough'
  })
  .role('integrator', {
    systemPrompt: `You are a meeting synthesiser.
Merge prior step outputs into one JSON object with four arrays: insights, actionItems, decisions, openQuestions.
- Keep text concise (max 2 sentences per entry).
- Preserve evidence/source snippets where provided.
- De-duplicate overlapping items; prefer the clearest version.
Output strict JSON only, matching schema:
{"insights": [{"summary": "...", "evidence": ["..."]}],
 "actionItems": [{"task": "...", "owner": "", "due": "", "status": "new|in-progress|blocked|done", "source": "..."}],
 "decisions": [{"decision": "...", "rationale": "", "source": "..."}],
 "openQuestions": [{"question": "...", "owner": "", "source": "..."}]}
Use empty arrays when a category is missing. No markdown or commentary.`,
    parser: 'meetingDigest'
  })
  .user('instructions', { type: 'string', default: '' })
  .round((round) =>
    round
      .start('insight')
      .agent('insight', 'insight', ['Meeting transcript or notes:\n{{user.instructions}}'], { next: 'actions' })
      .agent(
        'actions',
        'actions',
        ['Meeting transcript:\n{{user.instructions}}', 'Reference insights if helpful:\n{{steps.insight.raw}}'],
        { next: 'decisions' }
      )
      .agent(
        'decisions',
        'decisions',
        ['Meeting transcript:\n{{user.instructions}}', 'Action items noted earlier:\n{{steps.actions.raw}}'],
        {
          next: 'questions'
        }
      )
      .agent(
        'questions',
        'questions',
        ['Meeting transcript:\n{{user.instructions}}', 'Decisions noted earlier:\n{{steps.decisions.raw}}'],
        {
          next: 'integrator'
        }
      )
      .agent(
        'integrator',
        'integrator',
        [
          'Meeting transcript:\n{{user.instructions}}',
          'Insights (JSON):\n{{steps.insight.raw}}',
          'Action items (JSON):\n{{steps.actions.raw}}',
          'Decisions (JSON):\n{{steps.decisions.raw}}',
          'Open questions (JSON):\n{{steps.questions.raw}}',
          'Produce the final merged JSON object with four arrays and no extra keys.'
        ],
        {
          exits: [
            {
              condition: 'always',
              outcome: 'completed',
              reason: 'Meeting digest generated'
            }
          ]
        }
      )
      .maxRounds(1)
      .defaultOutcome('completed', 'Meeting digest pipeline executed')
  )
  .build()

export type MeetingDigestWorkflowDefinition = typeof meetingDigestWorkflowDocument
export type MeetingDigestParserOutput = WorkflowParserJsonOutput<typeof meetingDigestParser>

export const meetingDigestWorkflowDefinition = meetingDigestWorkflowDocument
export type MeetingDigestWorkflowResult = AgentWorkflowResult<MeetingDigestWorkflowDefinition>

const extractMeetingDigest = (result: MeetingDigestWorkflowResult): MeetingDigestParserOutput | undefined => {
  const lastRound = result.rounds[result.rounds.length - 1]
  return lastRound?.steps?.integrator?.parsed as MeetingDigestParserOutput | undefined
}

export async function generateMeetingDigest(
  transcript: string,
  userPrompt: string | undefined,
  onProgress?: (msg: string) => void,
  model = 'github-copilot/gpt-5-mini',
  sessionId?: string,
  sessionDir?: string
): Promise<MeetingDigestParserOutput> {
  const baseSessionDir = sessionDir ?? `${os.tmpdir()}/meeting-digest-sessions`
  const workspacePath = sessionId ? `${baseSessionDir}/${sessionId}` : baseSessionDir

  const onStream = (msg: AgentStreamEvent) => {
    switch (msg.step) {
      case 'insight':
        onProgress?.('[Digest] Gathering insights...')
        break
      case 'actions':
        onProgress?.('[Digest] Capturing action items...')
        break
      case 'decisions':
        onProgress?.('[Digest] Recording decisions...')
        break
      case 'questions':
        onProgress?.('[Digest] Listing open questions...')
        break
      case 'integrator':
        onProgress?.('[Digest] Consolidating meeting digest...')
        break
    }
  }

  let userInstructions = transcript

  if (userPrompt) {
    userInstructions = `User prompt: ${userPrompt}\n\nSource text:\n${userInstructions}`
  }

  const response = await runAgentWorkflow(meetingDigestWorkflowDefinition, {
    user: { instructions: userInstructions },
    model,
    sessionDir: workspacePath,
    workflowId: meetingDigestWorkflowDefinition.id,
    workflowSource: 'user',
    workflowLabel: meetingDigestWorkflowDefinition.description,
    onStream
  })

  const result = await response.result
  const output = extractMeetingDigest(result)

  if (!output) {
    throw new Error('Meeting digest workflow did not return parsed output')
  }

  return output
}
