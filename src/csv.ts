import fs from "fs/promises";
import { parse } from "csv-parse/sync";
import { debug } from "./logger";
import appRoot from "app-root-path";
import path from "path";

export type CsvTable = {
  columns: string[];
  rows: Record<string, string>[];
  totalRows: number;
  truncated: boolean;
};

export async function loadCsvFromText(
  text: string,
  maxRows = 50
): Promise<CsvTable> {
  const records: Record<string, string>[] = parse(text, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];

  const totalRows = records.length;
  const truncated = totalRows > maxRows;
  const rows = records.slice(0, maxRows);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return { columns, rows, totalRows, truncated };
}

export async function loadCsvFromUrl(
  url: string,
  maxRows = 50
): Promise<CsvTable> {
  // Log fetch attempts in dev mode
  debug("Fetching CSV URL", url);
  const res = await fetch(url);
  debug("CSV fetch status", res.status);
  if (!res.ok) throw new Error(`Failed to fetch CSV: ${res.status}`);
  const text = await res.text();
  debug("CSV fetched length", text.length);
  return loadCsvFromText(text, maxRows);
}

const root = appRoot.path;

export async function loadCsvFromFile(
  filePath: string,
  maxRows = 50
): Promise<CsvTable> {
  const absPath = path.resolve(root, filePath);
  const text = await fs.readFile(absPath, "utf-8");
  return loadCsvFromText(text, maxRows);
}
