import { describe, it, expect } from 'vitest';
import { createServer } from 'http';
import { loadCsvFromUrl } from '../src/csv';
import { askWithCsv } from '../src/askService';

function startMockLLM(responseBody: any, status = 200) {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c.toString()));
    req.on('end', () => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  }).listen(0);
  // @ts-ignore
  const port = (srv.address() as any).port;
  return { srv, url: `http://127.0.0.1:${port}` };
}

function startCsvMock(csvText: string) {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/csv' });
    res.end(csvText);
  }).listen(0);
  // @ts-ignore
  const port = (srv.address() as any).port;
  return { srv, url: `http://127.0.0.1:${port}` };
}

const sample = `name,amount,year
Alice,100,2024
Bob,200,2024
`;

describe('askWithCsv', () => {
  it('sends structured payload to LLM and returns answer', async () => {
    const { srv: csvSrv, url: csvUrl } = startCsvMock(sample);
    const { srv: llmSrv, url: llmUrl } = startMockLLM({ success: true, data: { answer: 'Top: Bob' } });

    const table = await loadCsvFromUrl(csvUrl, 10);
    const res = await askWithCsv('Who has the top amount?', table, llmUrl);

    expect(res.success).toBe(true);
    // the askService normalizes strings to { answer }
    // LLM mock returns { success: true, data: { answer: 'Top: Bob' } }
    expect((res.data as any).answer).toBe('Top: Bob');

    csvSrv.close();
    llmSrv.close();
  });
});
