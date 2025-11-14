import { describe, expect, it } from 'vitest'
import { analyzeMeetingTranscript, meetingOntology } from './meetingExtraction'

const sampleVtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
<v SpeakerA> Hello team, welcome to the meeting.

00:00:02.000 --> 00:00:05.000
<v SpeakerB> Thanks. Quick status: the API is deployed.

00:00:05.000 --> 00:00:07.000
<v SpeakerA> Great. Let's run tests.

00:00:07.000 --> 00:00:09.000
<v SpeakerC> [LAUGHTER]

00:00:09.000 --> 00:00:11.000
<v SpeakerB> I don't know.

00:00:11.000 --> 00:00:13.000
<v SpeakerB> I don't know.

00:00:13.000 --> 00:00:15.000
<v SpeakerA> Please assign the task to Alex.

00:00:15.000 --> 00:00:17.000
<v SpeakerA> Please assign the task to Alex.

00:00:17.000 --> 00:00:19.000
<v SpeakerD> [inaudible]

00:00:19.000 --> 00:00:21.000
<v SpeakerD> Noted.
`

describe('analyzeMeetingTranscript', () => {
  it('parses VTT and returns cleaned sentences with agents (generic sample)', async () => {
    const results = await analyzeMeetingTranscript(
      sampleVtt,
      meetingOntology
      //   .map((o) => ({
      //     label: o.label,
      //     explanation: o.explanation,
      //     examples: o.examples
      //   }))
    )

    console.log('results', results)

    const expectedMinimal = [
      { sentence: 'Hello team, welcome to the meeting.', agent: 'SpeakerA', type: 'Meeting Management' },
      { sentence: 'Thanks. Quick status: the API is deployed.', agent: 'SpeakerB', type: 'Status Update' },
      { sentence: "Great. Let's run tests.", agent: 'SpeakerA', type: 'Planning / Next Steps' },
      { sentence: "I don't know.", agent: 'SpeakerB', type: 'Filler / Backchannel / Minimal Response' },
      { sentence: 'Please assign the task to Alex.', agent: 'SpeakerA', type: 'Task Assignment / Commitment' },
      { sentence: 'Noted.', agent: 'SpeakerD', type: 'Filler / Backchannel / Minimal Response' }
    ]

    expect(results).toEqual(expectedMinimal)
  }, 60_000)
})
