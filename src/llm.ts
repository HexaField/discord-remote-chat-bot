import { z } from "zod";
import { debug, info } from "./logger";
import ollama from "ollama";

export const LLMRequestSchema = z.object({
  command: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const LLMResponseSchema = <T extends z.ZodTypeAny>(dataSchema?: T) =>
  z.object({
    success: z.boolean(),
    data: dataSchema ? dataSchema.optional() : z.any().optional(),
    error: z.string().optional(),
  });

export type LLMRequest = z.infer<typeof LLMRequestSchema>;
export type LLMResponse<T = unknown> = {
  success: boolean;
  data?: T;
  error?: string;
};

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function callLLM<T = unknown>(
  url: string,
  apiKey: string | undefined,
  payload: LLMRequest,
  timeoutMs = 20000,
  maxRetries = 2
): Promise<LLMResponse<T>> {
  const parsed = LLMRequestSchema.safeParse(payload);
  if (!parsed.success)
    return { success: false, error: "Invalid LLM request payload" };

  let attempt = 0;
  let lastError: string | undefined;

  while (attempt <= maxRetries) {
    try {
      // Log outgoing request in dev mode, but avoid printing the API key

      const systemPrompt = `
You are an advanced AI assistant, designed to parse CSV data and answer user queries based on that data.

Respond with just the string content requested.

Here is the CSV data you will work with:

${parsed.data.params!.table}

`;

      debug("LLM payload", systemPrompt);

      const response = await ollama.chat({
        model: "llama3.2",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: parsed.data.params!.query as string },
        ],
      });

      debug("LLM response status", response);

      // Try parsing JSON; if parsing fails, capture the text for debug
      let json: unknown;
      try {
        json = JSON.parse(response.message.content);
      } catch (e) {
        json = response.message.content;
      }

      debug("LLM returned JSON:", json);

      return {
        success: true,
        data: json as T,
      };
    } catch (err: any) {
      lastError = err?.message ?? String(err);
      // Retry on network errors / timeouts
      attempt += 1;
      if (attempt > maxRetries) break;
      await wait(200 * attempt); // backoff
    }
  }

  return { success: false, error: lastError ?? "Unknown error" };
}
