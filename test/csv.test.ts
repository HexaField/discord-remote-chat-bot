import { describe, it, expect } from 'vitest';
import { createServer } from 'http';
import { loadCsvFromUrl, loadCsvFromText } from '../src/csv';

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
"Charlie, Jr",300,2023
`;

describe('CSV loader', () => {
  it('parses CSV text', async () => {
    const tbl = await loadCsvFromText(sample, 10);
    expect(tbl.totalRows).toBe(3);
    expect(tbl.columns).toEqual(['name', 'amount', 'year']);
    expect(tbl.rows[0].name).toBe('Alice');
  });

  it('loads from url', async () => {
    const { srv, url } = startCsvMock(sample);
    const tbl = await loadCsvFromUrl(url, 5);
    expect(tbl.totalRows).toBe(3);
    srv.close();
  });
});
