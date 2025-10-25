import * as appRoot from 'app-root-path'
import {
  ApplicationCommandDataResolvable,
  ApplicationCommandOptionType,
  AttachmentBuilder,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
  Partials
} from 'discord.js'
import 'dotenv/config'
import fs from 'fs/promises'
import path from 'path'
import audioToDiagram from './audioToDiagram'
import { callLLM } from './llm'

const DISCORD_TOKEN: string | undefined = process.env.DISCORD_TOKEN
const LLM_URL: string | undefined = process.env.LLM_URL

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment')
  process.exit(1)
}
if (!LLM_URL) {
  console.error('Missing LLM_URL in environment')
  process.exit(1)
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
    // MessageContent is a privileged intent. If you haven't enabled it in
    // the Developer Portal for this bot, omit it to avoid a "Used disallowed intents" error.
    // GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel]
})

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`)

  try {
    // Register a simple guild-scoped command if GUILD_ID provided
    const guildId = process.env.GUILD_ID
    if (guildId && client.application?.commands) {
      // Register /reflect command with a single `query` option
      const commands: ApplicationCommandDataResolvable[] = [
        {
          name: 'reflect',
          description: 'Reflect on a question',
          options: [
            {
              name: 'query',
              description: 'Your question',
              type: ApplicationCommandOptionType.String, // STRING
              required: true
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
            }
          ]
        }
      ]
      await client.application.commands.set(commands, guildId as string)
      console.log('Registered /reflect command in guild', guildId)
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

  // /reflect handler: single `query` parameter, no CSV support
  if (chat.commandName === 'reflect') {
    const reflectChannel = process.env.CHANNEL_ID
    if (reflectChannel && chat.channelId !== reflectChannel) {
      return chat.reply({
        content: 'This command can only be used in a designated channel.',
        ephemeral: true
      })
    }

    const query = chat.options.getString('query', true)

    await chat.deferReply()

    // Determine CSV source
    const csvPath = process.env.CSV_PATH || 'data/data.csv'

    const root = appRoot.path
    const absPath = path.resolve(root, csvPath)
    const table = await fs.readFile(absPath, 'utf-8')

    try {
      const systemPrompt = `
You are an advanced AI assistant, designed to parse CSV data and answer user queries based on that data.

Respond with just the string content requested.

Here is the CSV data you will work with:

${table}`

      const resp = await callLLM(systemPrompt, query)
      if (!resp.success) return chat.editReply(`LLM error: ${resp.error}`)

      const ans = resp.data
      const MAX_LEN = 2000
      const full = `***${query}***\n\n${ans}`

      const splitIntoChunks = (text: string, maxLen: number): string[] => {
        const chunks: string[] = []
        let remaining = text
        while (remaining.length > maxLen) {
          // try to break at a newline first, then a space, otherwise hard cut
          let idx = remaining.lastIndexOf('\n', maxLen)
          if (idx <= 0) idx = remaining.lastIndexOf(' ', maxLen)
          if (idx <= 0) idx = maxLen
          chunks.push(remaining.slice(0, idx))
          remaining = remaining.slice(idx).trimStart()
        }
        if (remaining.length > 0) chunks.push(remaining)
        return chunks
      }

      const chunks = splitIntoChunks(full, MAX_LEN)

      // send first chunk as the deferred reply, follow up for the rest
      await chat.editReply(chunks[0])
      for (let i = 1; i < chunks.length; i++) {
        await chat.followUp({ content: chunks[i] })
      }
      return
    } catch (err: any) {
      console.error('reflect handler error', err)
      return chat.editReply({
        content: `Error calling LLM: ${err?.message ?? String(err)}`
      })
    }
  }

  if (chat.commandName === 'diagram') {
    const attachment = chat.options.getAttachment('audio', false)

    await chat.deferReply()

    // get the URL of the attachment, falling back to pulling a link from the message text
    const url = attachment?.url ?? chat.toString().match(/https?:\/\/\S+/)?.[0]

    if (!url) {
      return chat.editReply('Please provide an audio file attachment or a URL link to an audio file.')
    }

    try {
      const diagramFilePath = await audioToDiagram(url)
      const diagramData = await fs.readFile(diagramFilePath, 'utf-8')
      return chat.editReply({
        content: 'Here is your diagram for ' + url,
        files: [new AttachmentBuilder(Buffer.from(diagramData), { name: 'diagram.json' })]
      })
    } catch (err: any) {
      console.error('diagram handler error', err)
      return chat.editReply({
        content: `Error calling audioToDiagram: ${err?.message ?? String(err)}`
      })
    }
  }
})

client.login(DISCORD_TOKEN).catch((e: unknown) => {
  console.error('Login failed', e)
  if (typeof process !== 'undefined' && typeof process.exit === 'function') process.exit(1)
})
