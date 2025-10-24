import { callLLM, LLMRequest } from './llm';
import type { CsvTable } from './csv';
import { debug } from './logger';

export async function askWithCsv(
  query: string,
  table: string,
  llmUrl: string,
  apiKey?: string
) {
  const payload: LLMRequest = {
    command: 'query_table',
    params: {
      query,
      table
    },
  };

  const resp = await callLLM<any>(llmUrl, apiKey, payload);
  if (!resp.success) return resp;

  // Normalize LLM responses: prefer structured { answer } but accept plain strings
  const data = resp.data;
  if (typeof data === 'string') return { success: true, data: { answer: data } };
  return { success: true, data };
}
