/**
 * Generated-code safety scanner. Treats ALL model-produced code as untrusted:
 * deny-listed capabilities fail the scan before build, deploy, or execution.
 * The scanner is one layer — the Functions sandbox remains the enforcement
 * boundary. SQL text is checked structurally (identifiers + single statement).
 */

export interface ScanFinding {
  rule: string;
  severity: 'block' | 'warn';
  detail: string;
}

export interface ScanResult {
  safe: boolean;
  findings: ScanFinding[];
}

const BLOCK_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: 'no-child-process', re: /\b(child_process|spawn|spawnSync|exec(Sync|File)?)\b/ },
  { rule: 'no-eval', re: /\beval\s*\(|new\s+Function\s*\(/ },
  { rule: 'no-fs-access', re: /\b(fs|node:fs|readFileSync|writeFileSync|createReadStream)\b/ },
  {
    rule: 'no-process-manipulation',
    re: /\bprocess\.(env|exit|kill|dlopen|binding|_linkedBinding)\b/,
  },
  {
    rule: 'no-network',
    re: /\b(net|node:net|dgram|node:dgram|tls|node:tls|WebSocket|fetch\s*\()\b/,
  },
  { rule: 'no-worker-threads', re: /\bworker_threads\b/ },
  {
    rule: 'no-vm-escape',
    re: /\bconstructor\s*\[\s*['"]constructor['"]\s*\]|__proto__|prototype\s*\.\s*constructor\b/,
  },
  {
    rule: 'no-hardcoded-secret',
    re: /(api[_-]?key|password|secret|bearer)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  },
  { rule: 'no-privilege', re: /\b(setuid|setgid|chown|chmod\s*\(\s*['"]?0?777)\b/ },
  { rule: 'no-dynamic-import-url', re: /\bimport\s*\(\s*[`'"]https?:/ },
];

const WARN_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: 'broad-catch', re: /catch\s*\(\s*[a-zA-Z_$][\w$]*\s*\)\s*\{\s*\}/ },
  { rule: 'todo-provider-call', re: /TODO/i },
];

/** Scan generated handler source. Blocking findings make the plan unappliable. */
export function scanGeneratedCode(source: string): ScanResult {
  const findings: ScanFinding[] = [];
  const text = source.slice(0, 100_000);
  for (const { rule, re } of BLOCK_PATTERNS) {
    const m = re.exec(text);
    if (m) findings.push({ rule, severity: 'block', detail: `matched: ${m[0].slice(0, 80)}` });
  }
  for (const { rule, re } of WARN_PATTERNS) {
    if (re.test(text)) findings.push({ rule, severity: 'warn', detail: rule });
  }
  return { safe: !findings.some(f => f.severity === 'block'), findings };
}

const SQL_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/** Validate generated SQL text structurally (migration runner re-checks). */
export function scanGeneratedSql(sqlText: string): ScanResult {
  const findings: ScanFinding[] = [];
  const statements = sqlText
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
  if (statements.length > 1) {
    findings.push({
      rule: 'stacked-statements',
      severity: 'block',
      detail: 'one statement per execution',
    });
  }
  const upper = sqlText.toUpperCase();
  for (const kw of ['DROP DATABASE', 'TRUNCATE', 'GRANT ALL', 'COPY ', 'LOAD ', '\\COPY']) {
    if (upper.includes(kw))
      findings.push({ rule: 'dangerous-sql', severity: 'block', detail: kw.trim() });
  }
  const quoted = sqlText.match(/"([^"]+)"/g) ?? [];
  for (const q of quoted.slice(0, 200)) {
    if (!SQL_IDENT.test(q.slice(1, -1))) {
      findings.push({ rule: 'unsafe-identifier', severity: 'block', detail: q.slice(0, 60) });
      break;
    }
  }
  return { safe: !findings.some(f => f.severity === 'block'), findings };
}
