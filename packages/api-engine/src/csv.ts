/**
 * RFC 4180 CSV parsing/serialization for table import/export.
 * Pure functions with hard caps: oversized input is rejected, never
 * truncated (callers surface row counts honestly).
 */

export class CsvError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'CsvError';
    this.code = code;
    this.status = status;
  }
}

export const CSV_MAX_BYTES = 1_000_000;
export const CSV_MAX_ROWS = 1024;
export const CSV_MAX_COLUMNS = 100;
export const CSV_MAX_CELL_CHARS = 100_000;

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    records.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ',') {
      pushField();
      i += 1;
    } else if (ch === '\r' && text[i + 1] === '\n') {
      pushRow();
      i += 2;
    } else if (ch === '\n') {
      pushRow();
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (inQuotes) throw new CsvError('MALFORMED_CSV', 'Unterminated quoted field', 400);
  if (field !== '' || row.length > 0) pushRow();
  return records.filter(r => !(r.length === 1 && r[0] === ''));
}

export function parseCsv(text: string): ParsedCsv {
  if (text.length > CSV_MAX_BYTES) {
    throw new CsvError('PAYLOAD_TOO_LARGE', `CSV exceeds ${CSV_MAX_BYTES} bytes`, 413);
  }
  // Strip a single UTF-8 BOM so spreadsheet exports import cleanly.
  const clean = text.startsWith('﻿') ? text.slice(1) : text;
  const records = parseRecords(clean);
  if (records.length === 0) throw new CsvError('VALIDATION_ERROR', 'CSV is empty', 400);
  const headers = (records[0] ?? []).map(h => h.trim());
  if (headers.length === 0 || headers.some(h => h.length === 0)) {
    throw new CsvError('VALIDATION_ERROR', 'CSV header row must name every column', 400);
  }
  if (headers.length > CSV_MAX_COLUMNS) {
    throw new CsvError('VALIDATION_ERROR', `CSV exceeds ${CSV_MAX_COLUMNS} columns`, 400);
  }
  const seen = new Set<string>();
  for (const h of headers) {
    if (seen.has(h)) throw new CsvError('VALIDATION_ERROR', `Duplicate CSV column: ${h}`, 400);
    seen.add(h);
  }
  const body = records.slice(1);
  if (body.length > CSV_MAX_ROWS) {
    throw new CsvError('VALIDATION_ERROR', `CSV exceeds ${CSV_MAX_ROWS} data rows per import`, 400);
  }
  const rows = body.map((record, idx) => {
    if (record.length !== headers.length) {
      throw new CsvError(
        'VALIDATION_ERROR',
        `Row ${idx + 2} has ${record.length} fields, expected ${headers.length}`,
        400,
      );
    }
    const out: Record<string, string> = {};
    record.forEach((cell, col) => {
      if (cell.length > CSV_MAX_CELL_CHARS) {
        throw new CsvError('VALIDATION_ERROR', `Row ${idx + 2} cell exceeds size limit`, 400);
      }
      out[headers[col] as string] = cell;
    });
    return out;
  });
  return { headers, rows };
}

function escapeCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function serializeCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(headers.map(h => escapeCell(row[h])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
