import { describe, it, expect } from 'vitest';
import { createServer } from 'http';
import { callLLM } from '../src/llm';

function startMock(responseBody: any, status = 200) {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c.toString());
    req.on('end', () => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  }).listen(0);
  // @ts-ignore
  const port = (srv.address() as any).port;
  return { srv, url: `http://127.0.0.1:${port}` };
}

describe('callLLM', () => {
  it('returns data on success', async () => {
    const { srv, url } = startMock({ success: true, data: { hello: 'world' } });
    const res = await callLLM(url, undefined, { command: 'test' });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ hello: 'world' });
    srv.close();
  });

  it('returns error on invalid shape', async () => {
    const { srv, url } = startMock({ bad: 'shape' });
    const res = await callLLM(url, undefined, { command: 'test' });
    expect(res.success).toBe(false);
    srv.close();
  });
});
