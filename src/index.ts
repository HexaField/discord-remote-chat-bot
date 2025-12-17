import appRootPath from 'app-root-path'
import dotenv from 'dotenv-flow'

dotenv.config({ path: path.resolve(appRootPath.path) })

console.log(process.env.NODE_ENV, process.env.GUILD_ID)

import {
  ApplicationCommandDataResolvable,
  ApplicationCommandOptionType,
  AttachmentBuilder,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
  Message,
  Partials,
  TextBasedChannel
} from 'discord.js'
import fs from 'fs/promises'
import path from 'path'
import {
  answerQuestion,
  ASKQUESTION_CONSTANTS,
  cloneAskQuestionContext,
  getAskQuestionContext,
  rememberAskQuestionContext
} from './askQuestion'
import { audioToTranscript, transcriptToDiagrams } from './audioToDiagram'
import { getActiveRecording, startRecording, stopRecording } from './recording/discord'
import { startTranscriptionServer } from './recording/server'
import { runToolWorkflow } from './tools'
import { generateMeetingDigest } from './workflows/meetingDigest.workflow'

const DISCORD_TOKEN: string | undefined = process.env.DISCORD_TOKEN

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment')
  process.exit(1)
}

const RECORDINGS_ROOT = path.resolve(process.cwd(), '.tmp', 'recordings')

const TEXT_ATTACHMENT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'log', 'yaml', 'yml', 'xml'])

const isTextAttachment = (name?: string | null, contentType?: string | null) => {
  const lowerName = name?.toLowerCase() ?? ''
  const ext = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.') + 1) : ''
  return Boolean(contentType?.startsWith('text/')) || (ext ? TEXT_ATTACHMENT_EXTENSIONS.has(ext) : false)
}

const findRecordingById = async (recordingId?: string) => {
  if (!recordingId) return undefined
  const vttPath = path.join(RECORDINGS_ROOT, recordingId, 'audio.vtt')
  try {
    await fs.stat(vttPath)
    return { recordingId, vttPath }
  } catch {
    return undefined
  }
}

const findLatestRecordingForChannel = async (channelId: string) => {
  try {
    const entries = await fs.readdir(RECORDINGS_ROOT, { withFileTypes: true })
    const candidates = await Promise.all(
      entries
        .filter((d) => d.isDirectory() && d.name.startsWith(`${channelId}-`))
        .map(async (d) => {
          const vttPath = path.join(RECORDINGS_ROOT, d.name, 'audio.vtt')
          try {
            const stat = await fs.stat(vttPath)
            return { recordingId: d.name, vttPath, mtimeMs: stat.mtimeMs }
          } catch {
            return null
          }
        })
    )
    const valid = candidates.filter(Boolean) as { recordingId: string; vttPath: string; mtimeMs: number }[]
    if (!valid.length) return undefined
    valid.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return { recordingId: valid[0].recordingId, vttPath: valid[0].vttPath }
  } catch {
    return undefined
  }
}

const resolveRecordingReference = async (channelId: string, opts: { meetingId?: string }) => {
  const direct = await findRecordingById(opts.meetingId)
  if (direct) return direct
  return findLatestRecordingForChannel(channelId)
}

const vttToTranscriptLines = (vtt: string) => {
  const lines = vtt.split(/\r?\n/)
  const cleaned: string[] = []
  for (const line of lines) {
    if (!line || line.startsWith('WEBVTT')) continue
    if (line.includes('-->')) continue
    if (/^\d+$/.test(line.trim())) continue
    const stripped = line
      .replace(/<v\s+[^>]+>/gi, '')
      .replace(/<\/v>/gi, '')
      .trim()
    if (stripped) cleaned.push(stripped)
  }
  return cleaned
}

const formatMeetingDigest = (digest: any) => {
  const lines: string[] = []

  const pushSection = (title: string, entries: any[] | undefined, render: (e: any, idx: number) => string) => {
    lines.push(`**${title}**`)
    if (!entries || !entries.length) {
      lines.push('- none')
      lines.push('')
      return
    }
    entries.forEach((entry, idx) => {
      const rendered = render(entry, idx)
      if (rendered) lines.push(rendered)
    })
    lines.push('')
  }

  pushSection('Insights', digest?.insights, (e) => {
    const evidence = Array.isArray(e?.evidence) && e.evidence.length ? ` — evidence: ${e.evidence.join('; ')}` : ''
    return `- ${e?.summary ?? ''}${evidence}`.trim()
  })

  pushSection('Action items', digest?.actionItems, (e) => {
    const bits = [e?.owner && `owner: ${e.owner}`, e?.due && `due: ${e.due}`, e?.status && `status: ${e.status}`]
    const meta = bits.filter(Boolean).join('; ')
    const suffix = meta ? ` (${meta})` : ''
    return `- ${e?.task ?? ''}${suffix}`.trim()
  })

  pushSection('Decisions', digest?.decisions, (e) => {
    const rationale = e?.rationale ? ` — rationale: ${e.rationale}` : ''
    return `- ${e?.decision ?? ''}${rationale}`.trim()
  })

  pushSection('Open questions', digest?.openQuestions, (e) => {
    const owner = e?.owner ? ` (owner: ${e.owner})` : ''
    return `- ${e?.question ?? ''}${owner}`.trim()
  })

  // trim trailing blank lines
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}

async function buildReferencedMessageContext(message: Message) {
  let referenced: Message | null | undefined

  if (message.reference?.messageId) {
    try {
      referenced = await message.fetchReference()
    } catch (e) {
      console.warn('Failed to fetch referenced message', e)
    }
  }

  if (!referenced && message.channel?.isThread?.()) {
    try {
      referenced = await message.channel.fetchStarterMessage()
    } catch (e) {
      console.warn('Failed to fetch thread starter message', e)
    }
  }

  if (!referenced) return

  const attachmentTexts = {} as Record<string, string>
  for (const attachment of referenced.attachments.values()) {
    if (!isTextAttachment(attachment.name, attachment.contentType)) continue
    try {
      const res = await fetch(attachment.url)
      if (!res.ok) throw new Error(`Failed to fetch attachment (${res.status})`)
      const text = await res.text()
      attachmentTexts[attachment.name || attachment.url] = text
    } catch (e) {
      console.warn('Failed to download referenced attachment', e)
    }
  }

  return {
    content: referenced.content,
    attachments: attachmentTexts
  }
}

const serializeAttachments = (attachments: Record<string, string>): string =>
  Object.entries(attachments)
    .map((name, content) => `\`\`\`${name}\n${content}\n\`\`\``)
    .join('\n\n')

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
})

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`)

  try {
    await startTranscriptionServer()
  } catch (e) {
    console.warn('Transcription server failed to start', e)
  }

  try {
    const guildId = process.env.GUILD_ID
    if (guildId && client.application?.commands) {
      const commands: ApplicationCommandDataResolvable[] = [
        {
          name: 'record',
          description: 'Record the current voice channel',
          options: [
            {
              name: 'start',
              description: 'Start recording the current voice channel',
              type: ApplicationCommandOptionType.Subcommand,
              options: [
                {
                  name: 'include_audio',
                  description: 'Persist speaker .wav files (default: off)',
                  type: ApplicationCommandOptionType.Boolean,
                  required: false
                }
              ]
            },
            {
              name: 'stop',
              description: 'Stop the active recording',
              type: ApplicationCommandOptionType.Subcommand
            },
            {
              name: 'review',
              description: 'Summarise a recording (insights, actions, decisions, questions)',
              type: ApplicationCommandOptionType.Subcommand,
              options: [
                {
                  name: 'meeting_id',
                  description: 'Recording ID (defaults to latest in this channel)',
                  type: ApplicationCommandOptionType.String,
                  required: false
                },
                {
                  name: 'prompt',
                  description: 'Extra guidance for the meeting digest',
                  type: ApplicationCommandOptionType.String,
                  required: false
                }
              ]
            }
          ]
        },
        {
          name: 'diagram',
          description: 'Turn an audio file into a diagram',
          options: [
            {
              name: 'audio',
              description: 'The audio file to analyze',
              type: ApplicationCommandOptionType.Attachment, // ATTACHMENT
              required: false
            },
            {
              name: 'url',
              description: 'A URL to an audio file to analyze',
              type: ApplicationCommandOptionType.String, // STRING
              required: false
            },
            {
              name: 'prompt',
              description: 'An additional user prompt to guide diagram generation',
              type: ApplicationCommandOptionType.String, // STRING
              required: false
            },
            {
              name: 'regenerate',
              description: 'Force re-generation of diagrams',
              type: ApplicationCommandOptionType.Boolean, // BOOLEAN
              required: false
            }
          ]
        }
      ]
      await client.guilds.resolve(guildId as string)?.commands.set(commands)
      console.log('Registered slash commands in guild', guildId)
    }
  } catch (err) {
    console.warn('Failed to register commands', err)
  }
})

// We no longer expose a free-text prefix command. Interactions only.

// Handle slash commands
client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return
  const chat = interaction as ChatInputCommandInteraction

  if (chat.commandName === 'diagram') {
    const attachment = chat.options.getAttachment('audio', false)

    await chat.deferReply()

    // get the URL of the attachment, falling back to pulling a link from the message text
    const url = attachment?.url ?? chat.toString().match(/https?:\/\/\S+/)?.[0]

    if (!url) {
      return chat.editReply('Please provide an audio file attachment or a URL link to an audio file.')
    }

    const regenerate = chat.options.getBoolean('regenerate', false) ?? false
    const userPrompt = chat.options.getString('prompt', false) ?? undefined

    try {
      const onProgress = async (message: string) => {
        try {
          await chat.editReply({ content: `🔄 ${message}` })
        } catch (e) {
          console.warn('onProgress editReply failed', e)
        }
      }

      const id = await audioToTranscript('discord', url, onProgress)
      const { kumuPath, pngPath } = await transcriptToDiagrams(
        'discord',
        id,
        undefined,
        userPrompt,
        onProgress,
        regenerate
      )
      const diagramData = await fs.readFile(kumuPath, 'utf-8')
      const pngData = await fs.readFile(pngPath)
      return chat.editReply({
        content: 'Here is your diagram for ' + url,
        files: [
          new AttachmentBuilder(Buffer.from(diagramData), { name: 'kumu.json' }),
          new AttachmentBuilder(pngData, { name: 'diagram.png' })
        ]
      })
    } catch (err: any) {
      console.error('diagram handler error', err)
      return chat.editReply({
        content: `Error calling audioToDiagram: ${err?.message ?? String(err)}`
      })
    }
  }

  if (chat.commandName === 'record') {
    const sub = chat.options.getSubcommand(true)
    const guild = chat.guild
    if (!guild) return chat.reply({ content: 'This command is only available in servers.', ephemeral: true })

    if (sub === 'review') {
      const meetingId = chat.options.getString('meeting_id', false) ?? undefined
      const prompt = chat.options.getString('prompt', false) ?? undefined

      await chat.deferReply()

      const resolved = await resolveRecordingReference(chat.channelId, { meetingId })
      if (!resolved) {
        return chat.editReply(
          'No recordings found for this channel yet. Run /record start to capture one, then try again.'
        )
      }

      let vtt: string
      try {
        vtt = await fs.readFile(resolved.vttPath, 'utf-8')
      } catch (e: any) {
        return chat.editReply({
          content: `Could not read transcript for recording ${resolved.recordingId}: ${e?.message ?? e}`
        })
      }

      const transcriptLines = vttToTranscriptLines(vtt)
      if (!transcriptLines.length) {
        return chat.editReply('Transcript is empty or could not be parsed.')
      }

      try {
        const digest = await generateMeetingDigest(
          transcriptLines.join('\n'),
          prompt,
          async (m) => {
            try {
              await chat.editReply({ content: `🔄 ${m}` })
            } catch {}
          },
          undefined,
          resolved.recordingId,
          path.join(RECORDINGS_ROOT, 'sessions')
        )

        const formatted = formatMeetingDigest(digest)

        if (formatted.length < 2000) {
          return chat.editReply({ content: formatted })
        }

        const attachment = new AttachmentBuilder(Buffer.from(formatted, 'utf-8'), {
          name: `meeting-digest-${resolved.recordingId}.txt`
        })

        return chat.editReply({
          content: `Here is your meeting digest:`,
          files: [attachment]
        })
      } catch (e: any) {
        return chat.editReply({ content: `Failed to generate meeting digest: ${e?.message ?? e}` })
      }
    }

    // Must be a text channel and member must be in a voice channel
    const member: any = chat.member
    const voiceCh = member?.voice?.channel
    if (!voiceCh) return chat.reply({ content: 'Join a voice channel first.', ephemeral: true })

    if (sub === 'start') {
      if (getActiveRecording(guild.id)) {
        return chat.reply({ content: 'A recording is already active in this server.', ephemeral: true })
      }
      try {
        await chat.deferReply()
        const includeAudio = chat.options.getBoolean('include_audio', false) ?? false
        const sess = await startRecording(guild.id, voiceCh, includeAudio, chat.channelId)
        return chat.editReply(`🎙️ Recording started. ID: ${sess.recordingId}`)
      } catch (e: any) {
        try {
          await chat.editReply({ content: `Failed to start recording: ${e?.message ?? e}` })
        } catch {
          try {
            await chat.followUp({ content: `Failed to start recording: ${e?.message ?? e}`, ephemeral: true })
          } catch {}
        }
        return
      }
    }

    if (sub === 'stop') {
      try {
        await chat.deferReply()
        const active = getActiveRecording(guild.id)
        const recordingId = active?.recordingId
        type SendableTextChannel = Extract<TextBasedChannel, { send: unknown }>

        const fetchTextChannel = async (channelId?: string | null): Promise<TextBasedChannel | null> => {
          if (!channelId) return null
          try {
            const channel = await client.channels.fetch(channelId)
            if (channel && channel.isTextBased()) return channel
          } catch (e) {
            console.warn('Failed to fetch transcript channel', e)
          }
          return null
        }

        const ensureSendableChannel = (channel: TextBasedChannel | null): channel is SendableTextChannel => {
          if (!channel) return false
          return 'send' in channel && typeof (channel as SendableTextChannel).send === 'function'
        }
        // Send immediate feedback that we are still transcribing remaining chunks
        await chat.editReply(
          recordingId
            ? `⏹️ Recording stopped (ID: ${recordingId}). Transcribing remaining audio…`
            : '⏹️ Recording stopped. Transcribing remaining audio…'
        )

        const sess = await stopRecording(guild.id)

        const transcriptChannel =
          (await fetchTextChannel(process.env.RECORDING_TRANSCRIPT_CHANNEL_ID)) ||
          (await fetchTextChannel(sess.textChannelId ?? active?.textChannelId)) ||
          chat.channel

        if (!ensureSendableChannel(transcriptChannel)) {
          await chat.editReply({ content: 'Failed to find a text channel to post the transcript.' })
          return
        }

        const vtt = await fs.readFile(sess.vttPath)
        const transcriptPayload = {
          content: `✅ Transcript ready (ID: ${sess.recordingId}).`,
          files: [new AttachmentBuilder(Buffer.from(vtt), { name: 'audio.vtt' })]
        }

        if (transcriptChannel.id === chat.channelId) {
          await chat.editReply(transcriptPayload)
        } else {
          await chat.editReply({
            content: `✅ Transcript ready (ID: ${sess.recordingId}). Posted to <#${transcriptChannel.id}>.`
          })
          try {
            await transcriptChannel.send(transcriptPayload)
          } catch (e: any) {
            await chat.editReply({
              content: `❌ Failed to post transcript to <#${transcriptChannel.id}>: ${e?.message ?? e}`
            })
            return
          }
        }

        const followUpTranscription = async () => {
          try {
            const followUp = await transcriptChannel.send({ content: 'Generating diagrams from the transcript…' })
            const out = await transcriptToDiagrams('recordings', sess.recordingId, undefined, '', async (m) => {
              try {
                await followUp.edit({ content: `🔄 ${m}` })
              } catch (e) {
                console.warn('onProgress followUp failed', e)
              }
            })
            const diagramData = await fs.readFile(out.kumuPath, 'utf-8')
            const pngData = await fs.readFile(out.pngPath)
            await followUp.edit({
              content: 'Here is the transcript and diagram generated from the recording:',
              files: [
                new AttachmentBuilder(Buffer.from(diagramData), { name: 'kumu.json' }),
                new AttachmentBuilder(pngData, { name: 'diagram.png' })
              ]
            })
          } catch (e: any) {
            try {
              await transcriptChannel.send({ content: `❌ Failed to stop/transcribe: ${e?.message ?? e}` })
            } catch {}
            if (transcriptChannel.id !== chat.channelId) {
              try {
                await chat.editReply({ content: `❌ Failed to stop/transcribe: ${e?.message ?? e}` })
              } catch {}
            }
          }
        }
        // followUpTranscription()
      } catch (e: any) {
        await chat.editReply({ content: `Failed to stop recording: ${e?.message ?? e}` })
      }
    }
  }
})

client.on('messageCreate', async (message) => {
  if (message.author.bot || message.system) return

  const botId = client.user?.id
  const isMention = botId ? message.mentions.has(botId) : false
  const contextKey = message.channel?.isThread?.() ? message.channelId : message.reference?.messageId
  const existingContext = await getAskQuestionContext(contextKey)

  if (!isMention && !existingContext) return

  await message.channel.sendTyping()

  const reply = await message.reply('Optimizing tool selection...')

  const raw = message.content || ''
  const cleaned = botId ? raw.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim() : raw.trim()
  const question = cleaned || raw.trim()
  if (!question) return

  try {
    const referencedContext = await buildReferencedMessageContext(message)

    const onProgress = async (m: string) => {
      try {
        await reply.edit(m)
      } catch {}
    }

    const contextParts = [] as string[]
    if (referencedContext?.content) contextParts.push(`Referenced Message:${referencedContext.content}`)
    if (referencedContext?.attachments) {
      contextParts.push(serializeAttachments(referencedContext.attachments))
    }
    if (!contextParts.length) contextParts.push(question)
    const fullContext = contextParts.join('\n\n')
    // Use the centralized chooser+executor to reduce bespoke glue per-tool
    const referencedForChooser = referencedContext
      ? { attachments: Object.keys(referencedContext.attachments || {}), content: referencedContext.content }
      : undefined

    const toolOutput = await runToolWorkflow({
      question,
      referenced: referencedForChooser,
      model: ASKQUESTION_CONSTANTS.MODEL,
      sessionDir: undefined,
      url: message.attachments.first()?.url ?? message.content.match(/https?:\/\/\S+/)?.[0],
      onProgress
    })

    if (toolOutput.tool !== 'none') {
      try {
        const parsed = toolOutput.parsed || {}
        const filesFromWorkflow = parsed && typeof parsed === 'object' ? (parsed as any).files : undefined
        const attachments: AttachmentBuilder[] = []

        if (filesFromWorkflow && typeof filesFromWorkflow === 'object') {
          for (const [name, value] of Object.entries(filesFromWorkflow)) {
            if (value === undefined || value === null) continue
            const buf = Buffer.isBuffer(value)
              ? value
              : value instanceof Uint8Array
                ? Buffer.from(value)
                : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf-8')
            attachments.push(new AttachmentBuilder(buf, { name }))
          }
        }

        let responseText = typeof (parsed as any).response === 'string' ? (parsed as any).response : undefined

        if (responseText && responseText.length > 1900) {
          attachments.push(new AttachmentBuilder(Buffer.from(responseText, 'utf-8'), { name: 'response.txt' }))
          responseText = 'Response attached.'
        }

        if (attachments.length || responseText) {
          await reply.edit({
            content: responseText || 'Here is the result:',
            files: attachments.length ? attachments : undefined
          })
          return
        } else {
          await reply.edit({ content: 'Tool executed but produced no attachable artifacts.' })
          return
        }
      } catch (e: any) {
        await reply.edit({ content: `Failed to run tool: ${e?.message ?? e}` })
      }
    }

    await reply.edit('Thinking...')

    const answer = await answerQuestion({
      context: fullContext,
      question,
      sessionId: existingContext?.sessionId,
      sessionDir: existingContext?.sessionDir,
      model: ASKQUESTION_CONSTANTS.MODEL,
      sourceId: existingContext?.sourceId ?? 'text'
    })

    if (answer.answer.length > 2000) {
      const att = new AttachmentBuilder(Buffer.from(answer.answer, 'utf-8'), {
        name: `answer-${answer.sessionId}.txt`
      })
      await reply.edit({ content: '', files: [att] })
    } else {
      await reply.edit({ content: answer.answer })
    }

    const targetKey = message.channel?.isThread?.() && message.channelId
    if (targetKey) {
      await rememberAskQuestionContext(targetKey, {
        sessionId: answer.sessionId,
        sessionDir: answer.sessionDir,
        sourceId: existingContext?.sourceId ?? 'text'
      })
    }
  } catch (e) {
    try {
      await reply.edit(`Error processing your question: ${e instanceof Error ? e.message : String(e)}`)
    } catch {
      await message.channel.send(`Error processing your question: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
})

client.on('threadCreate', async (thread) => {
  try {
    const starter = await thread.fetchStarterMessage()
    if (!starter) return
    await cloneAskQuestionContext(starter.id, thread.id)
  } catch (e) {
    console.warn('threadCreate handler failed', e)
  }
})

client.login(DISCORD_TOKEN).catch((e: unknown) => {
  console.error('Login failed', e)
  if (typeof process !== 'undefined' && typeof process.exit === 'function') process.exit(1)
})
