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
import { loadCsvFromUrl, loadCsvFromFile } from "./csv";
import { askWithCsv } from "./askService";
import appRoot from "app-root-path";
import path from "path";
import fs from "fs/promises";

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
    // MessageContent is a privileged intent. If you haven't enabled it in
    // the Developer Portal for this bot, omit it to avoid a "Used disallowed intents" error.
    // GatewayIntentBits.MessageContent,
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
      // Register /ask in the same guild
      const askBody: ApplicationCommandDataResolvable = {
        name: "ask",
        description: "Ask a question about a CSV dataset",
        options: [
          {
            name: "query",
            description: "Your question",
            type: 3,
            required: true,
          },
          // {
          //   name: "csv_url",
          //   description: "Optional CSV URL",
          //   type: 3,
          //   required: false,
          // },
        ],
      };
      await client.application.commands.create(askBody, guildId as string);
      console.log("Registered /ask command in guild", guildId);
    }
  } catch (err) {
    console.warn("Failed to register commands", err);
  }
});

// Simple prefix command: !json <json>
client.on("messageCreate", async (message: Message) => {
  try {
    if (message.author.bot) return;
    // message.content can be empty/undefined if MessageContent intent is not enabled.
    const content = (message.content ?? "").trim();
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

  // /json existing handler
  if (chat.commandName === "json") {
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
  }

  // /ask handler
  if (chat.commandName === "ask") {
    const askChannel = process.env.ASK_CHANNEL_ID;
    if (askChannel && chat.channelId !== askChannel) {
      return chat.reply({
        content: "This command can only be used in a designated channel.",
        ephemeral: true,
      });
    }

    const query = chat.options.getString("query", true);
    // const csvUrl = chat.options.getString("csv_url", false);

    // Determine CSV source
    const csvPath = process.env.CSV_PATH;
    const maxRows = Number(process.env.MAX_CSV_ROWS ?? "50");

    await chat.deferReply();

    try {
      let table;
      // if (csvUrl) {
      //   table = await loadCsvFromUrl(csvUrl, maxRows);
      // } else
      if (csvPath) {
        const root = appRoot.path;
        const absPath = path.resolve(root, csvPath);
        table = await fs.readFile(absPath, "utf-8");
        // table = await loadCsvFromFile(csvPath, maxRows);
      } else {
        return chat.editReply({
          content:
            "No CSV provided. Please pass a `csv_url` or configure CSV_PATH in the environment.",
        });
      }

      const resp = await askWithCsv(query, table, LLM_URL!, LLM_API_KEY);
      if (!resp.success) return chat.editReply(`LLM error: ${resp.error}`);

      // Prefer structured answer if present
      const ans = (resp.data && (resp.data.answer ?? resp.data)) || resp.data;
      const content =
        typeof ans === "string" ? ans : JSON.stringify(ans, null, 2);
      return chat.editReply("" + content);
    } catch (err: any) {
      console.error("ask handler error", err);
      return chat.editReply({
        content: `Error processing CSV or LLM: ${err?.message ?? String(err)}`,
      });
    }
  }
});

client.login(DISCORD_TOKEN).catch((e: unknown) => {
  console.error("Login failed", e);
  if (typeof process !== "undefined" && typeof process.exit === "function")
    process.exit(1);
});
