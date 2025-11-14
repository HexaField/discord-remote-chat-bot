import { CategorisedSentence, classifySentence, extractSentences } from './classifySentences'

export const analyzeMeetingTranscript = async (
  transcript: string,
  ontology: Array<{ label: string; explanation: string; examples: string[] }>
): Promise<CategorisedSentence[]> => {
  const sentences = extractSentences(transcript)
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]
    try {
      const res = await classifySentence(s.sentence, sentences.slice(0, i), ontology)
      s.type = res.label
      if (res.relatedTo && res.relatedTo.length) s.relatedTo = res.relatedTo
      else delete s.relatedTo
    } catch (e) {
      s.type = ''
      delete s.relatedTo
    }
  }
  return sentences
}

export const meetingOntology = [
  {
    label: 'Status Update',
    explanation: 'Sharing progress, current state, or factual reporting about ongoing work.',
    examples: [
      'I finished that earlier.',
      "It's done now.",
      'I completed it yesterday.',
      'Everything is ready on my side.',
      "I've wrapped that up.",
      'The task is complete.',
      'I have finished the work.',
      'It is ready for review.',
      'I took care of that.',
      'This is now resolved.'
    ]
  },
  {
    label: 'Issue / Risk / Blocker',
    explanation: 'Identifying problems, delays, risks, or dependencies that impede progress.',
    examples: [
      "I'm having trouble with this.",
      'This is not working as expected.',
      "I can't access the file.",
      'There appears to be an error.',
      'I am stuck on this step.',
      'Something is blocking progress for me.',
      'I ran into an unexpected problem.',
      'This seems broken right now.',
      'I need help to move forward.',
      'There is a failure when I try that.'
    ]
  },
  {
    label: 'Proposal / Suggestion',
    explanation: 'Offering an idea, approach, or recommended course of action.',
    examples: [
      'Maybe try a different approach.',
      'How about we change this?',
      'Perhaps we simplify it a bit.',
      'What if we try an alternative?',
      'I suggest we consider another option.',
      'Maybe test a smaller idea first.',
      'We could attempt a different method.',
      'I propose we adjust the plan.',
      "Why don't we explore another route?",
      "Let's experiment with a simple change."
    ]
  },
  {
    label: 'Question (Information Seeking)',
    explanation: 'Any inquiry aimed at gathering information or clarification.',
    examples: [
      'When will that be ready?',
      'Who is responsible for this?',
      'Do you have an update?',
      'Can you tell me more about it?',
      'What does this mean?',
      'How does that work?',
      'Is this confirmed?',
      'Where can I find it?',
      'Have you seen this before?',
      'Can you explain that?'
    ]
  },
  {
    label: 'Answer / Explanation',
    explanation: 'Providing information, clarification, or context, often in response to a question.',
    examples: [
      'It should be ready soon.',
      'Here is some more information.',
      'That is because of a configuration issue.',
      'It works by applying a simple rule.',
      'The reason is explained here.',
      'You can find it at that location.',
      'I observed the same behavior earlier.',
      'This is included in the current version.',
      'It was delayed due to an error.',
      'The details are available in the note.'
    ]
  },
  {
    label: 'Decision / Agreement',
    explanation: 'Formalizing a choice, expressing alignment, or concluding a discussion.',
    examples: [
      "Let's do that.",
      'I agree.',
      'That sounds good.',
      'We will move forward with that.',
      "Yes, let's proceed.",
      'I approve.',
      'That is decided.',
      'Let’s move ahead.',
      'We are in agreement.',
      'Agreed.'
    ]
  },
  {
    label: 'Task Assignment / Commitment',
    explanation: 'Delegating tasks, volunteering, or confirming responsibility.',
    examples: [
      "I'll take care of it.",
      "I'll handle that.",
      "I'll do it.",
      "I'll send the details.",
      "I'll follow up.",
      "I'll look into it.",
      "I'll update you.",
      "I'll take ownership.",
      "I'll complete it.",
      "I'll reach out."
    ]
  },
  {
    label: 'Insight / Analysis / Interpretation',
    explanation: 'An understanding, interpretation, or analysis that sheds light on a situation.',
    examples: [
      'I think there is a pattern here.',
      'I had not seen that before.',
      'This suggests a different cause.',
      'I notice a consistent behavior.',
      'This points to a likely explanation.',
      'It seems related to a specific factor.',
      'This observation could change the view.',
      'I realize this reveals more context.',
      'This explains the earlier behavior.',
      'We might be missing an important detail.'
    ]
  },
  {
    label: 'Filler / Backchannel / Minimal Response',
    explanation: 'Interpersonal moves that maintain rapport or smooth interaction.',
    examples: [
      'Right.',
      'Sure.',
      'Uh-huh.',
      'Thanks.',
      'Appreciate it.',
      'Sorry for the delay.',
      'Nice.',
      'No worries.',
      'Hello.',
      'Hope you are well.'
    ]
  }
] as Array<{
  label: string
  explanation: string
  examples: string[]
}>
