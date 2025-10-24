import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Interaction,
  ChatInputCommandInteraction,
  ApplicationCommandDataResolvable,
} from "discord.js";
import * as appRoot from "app-root-path";
import path from "path";
import fs from "fs/promises";
import { callLLM } from "./llm";

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
      // Register /reflect command with a single `query` option
      const reflectBody: ApplicationCommandDataResolvable = {
        name: "reflect",
        description: "Reflect on a question",
        options: [
          {
            name: "query",
            description: "Your question",
            type: 3, // STRING
            required: true,
          },
        ],
      };
      await client.application.commands.set([reflectBody], guildId as string);
      console.log("Registered /reflect command in guild", guildId);
    }
  } catch (err) {
    console.warn("Failed to register commands", err);
  }
});

// We no longer expose a free-text prefix command. Interactions only.

// Handle slash commands
client.on("interactionCreate", async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const chat = interaction as ChatInputCommandInteraction;

  // /reflect handler: single `query` parameter, no CSV support
  if (chat.commandName === "reflect") {
    const reflectChannel = process.env.CHANNEL_ID;
    if (reflectChannel && chat.channelId !== reflectChannel) {
      return chat.reply({
        content: "This command can only be used in a designated channel.",
        ephemeral: true,
      });
    }

    const query = chat.options.getString("query", true);

    await chat.deferReply();

    // Determine CSV source
    const csvPath = process.env.CSV_PATH || "data/data.csv";

    const root = appRoot.path;
    const absPath = path.resolve(root, csvPath);
    const table = await fs.readFile(absPath, "utf-8");

    try {
      const systemPrompt = `
You are an advanced AI assistant, designed to parse CSV data and answer user queries based on that data.

Respond with just the string content requested.

Here is the CSV data you will work with:

${table}`;

      const resp = await callLLM(systemPrompt, query);
      if (!resp.success) return chat.editReply(`LLM error: ${resp.error}`);

      const ans = resp.data;
      const content =
        typeof ans === "string" ? ans : JSON.stringify(ans, null, 2);
      return chat.editReply(String(content));
    } catch (err: any) {
      console.error("reflect handler error", err);
      return chat.editReply({
        content: `Error calling LLM: ${err?.message ?? String(err)}`,
      });
    }
  }
});

client.login(DISCORD_TOKEN).catch((e: unknown) => {
  console.error("Login failed", e);
  if (typeof process !== "undefined" && typeof process.exit === "function")
    process.exit(1);
});
