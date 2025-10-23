import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  Interaction,
  ChatInputCommandInteraction,
  ApplicationCommandDataResolvable,
} from "discord.js";
import { callLLM, LLMRequest, LLMResponse } from "./llm";

const DISCORD_TOKEN: string | undefined = process.env.DISCORD_TOKEN;
const LLM_URL: string | undefined = process.env.LLM_URL;
const LLM_API_KEY: string | undefined = process.env.LLM_API_KEY;

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment");
  process.exit(1);
}
if (!LLM_URL) {
  console.error("Missing LLM_URL in environment");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  try {
    // Register a simple guild-scoped command if GUILD_ID provided
    const guildId = process.env.GUILD_ID;
    if (guildId && client.application?.commands) {
      const body: ApplicationCommandDataResolvable = {
        name: "json",
        description: "Send a JSON command to the LLM",
        options: [
          {
            name: "payload",
            description: "JSON payload for LLM",
            type: 3, // STRING
            required: true,
          },
        ],
      };
      await client.application.commands.create(body, guildId as string);
      console.log("Registered /json command in guild", guildId);
    }
  } catch (err) {
    console.warn("Failed to register commands", err);
  }
});

// Simple prefix command: !json <json>
client.on("messageCreate", async (message: Message) => {
  try {
    if (message.author.bot) return;
    const content = message.content.trim();
    if (!content.startsWith("!json")) return;

    const arg = content.slice("!json".length).trim();
    if (!arg)
      return message.reply('Usage: `!json {"command":"name","params":{...}}`');

    let req: LLMRequest;
    try {
      req = JSON.parse(arg) as LLMRequest;
    } catch (e) {
      return message.reply("Invalid JSON. Make sure you pass a JSON object.");
    }

    // Narrow channel to text-based before using sendTyping
    // isTextBased is a runtime type guard; check and call safely
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- sendTyping is available on text-based channels
    if (
      typeof (message.channel as any).isTextBased === "function"
        ? (message.channel as any).isTextBased()
        : false
    ) {
      // call sendTyping
      // @ts-ignore
      await message.channel.sendTyping();
    }
    const resp = await callLLM<any>(LLM_URL!, LLM_API_KEY, req);

    if (!resp.success) {
      return message.reply(`LLM error: ${resp.error}`);
    }

    // Return the JSON response as a single code block message
    return message.reply(
      "```json\n" + JSON.stringify(resp.data, null, 2) + "\n```"
    );
  } catch (err: any) {
    console.error("Handler error", err);
    message.reply("Internal error");
  }
});

// Handle slash commands
client.on("interactionCreate", async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const chat = interaction as ChatInputCommandInteraction;
  if (chat.commandName !== "json") return;

  const payload = chat.options.getString("payload", true);
  let parsed: any;
  try {
    parsed = JSON.parse(payload);
  } catch (e) {
    return chat.reply({ content: "Invalid JSON payload.", ephemeral: true });
  }
  await chat.deferReply();
  const resp = await callLLM<any>(LLM_URL!, LLM_API_KEY, parsed);
  if (!resp.success) return chat.editReply(`LLM error: ${resp.error}`);
  return chat.editReply(
    "```json\n" + JSON.stringify(resp.data, null, 2) + "\n```"
  );
});

client.login(DISCORD_TOKEN).catch((e: unknown) => {
  console.error("Login failed", e);
  if (typeof process !== "undefined" && typeof process.exit === "function")
    process.exit(1);
});
