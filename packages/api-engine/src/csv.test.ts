import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv, serializeCsv } from './csv.js';

describe('csv', () => {
  it('round-trips quotes, commas, and newlines', () => {
    const text = 'a,b\r\n"x, y","say ""hi"""\r\n"line1\nline2",ok\r\n';
    const parsed = parseCsv(text);
    expect(parsed.headers).toEqual(['a', 'b']);
    expect(parsed.rows).toEqual([
      { a: 'x, y', b: 'say "hi"' },
      { a: 'line1\nline2', b: 'ok' },
    ]);
    expect(parseCsv(serializeCsv(parsed.headers, parsed.rows))).toEqual(parsed);
  });

  it('rejects ragged rows, duplicates, empties, and oversize files', () => {
    expect(() => parseCsv('')).toThrow(CsvError);
    expect(() => parseCsv('a,a\r\n1,2\r\n')).toThrow(CsvError);
    expect(() => parseCsv('a,b\r\n1\r\n')).toThrow(CsvError);
    expect(() => parseCsv('a\r\n"oops\r\n')).toThrow(CsvError);
    const big = `a\r\n${'1\r\n'.repeat(1025)}`;
    expect(() => parseCsv(big)).toThrow(CsvError);
  });
});
