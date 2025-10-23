import { z } from 'zod';

export const LLMRequestSchema = z.object({
  command: z.string(),
  params: z.record(z.string(), z.unknown()).optional()
});

export const LLMResponseSchema = <T extends z.ZodTypeAny>(dataSchema?: T) => z.object({
  success: z.boolean(),
  data: dataSchema ? dataSchema.optional() : z.any().optional(),
  error: z.string().optional()
});

export type LLMRequest = z.infer<typeof LLMRequestSchema>;
export type LLMResponse<T = unknown> = { success: boolean; data?: T; error?: string };

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
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

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export async function callLLM<T = unknown>(url: string, apiKey: string | undefined, payload: LLMRequest, timeoutMs = 20000, maxRetries = 2): Promise<LLMResponse<T>> {
  const parsed = LLMRequestSchema.safeParse(payload);
  if (!parsed.success) return { success: false, error: 'Invalid LLM request payload' };

  let attempt = 0;
  let lastError: string | undefined;

  while (attempt <= maxRetries) {
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        body: JSON.stringify(parsed.data),
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        }
      }, timeoutMs);

      if (!res.ok) {
        const text = await res.text();
        lastError = `LLM HTTP ${res.status}: ${text}`;
        throw new Error(lastError);
      }

      const json = await res.json();

      // Validate response shape
      const shape = LLMResponseSchema().safeParse(json);
      if (!shape.success) {
        return { success: false, error: 'LLM returned invalid JSON shape' };
      }

      return shape.data as LLMResponse<T>;
    } catch (err: any) {
      lastError = err?.message ?? String(err);
      // Retry on network errors / timeouts
      attempt += 1;
      if (attempt > maxRetries) break;
      await wait(200 * attempt); // backoff
    }
  }

  return { success: false, error: lastError ?? 'Unknown error' };
}
