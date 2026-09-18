/**
 * Web application firewall: one filter in front of the whole stack.
 *
 * This is deliberately NOT per-endpoint rate limiting. It runs before routing,
 * before authentication, before any handler, and it judges the SHAPE of a
 * request rather than its volume: a single request carrying `../../etc/passwd`
 * or `' UNION SELECT` is hostile on its own, and waiting for a hundred of them
 * before reacting is waiting too long.
 *
 * ── The constraint that shapes every rule here ──
 *
 * CloudNivo is a backend-as-a-service. Customers legitimately send SQL through
 * the SQL editor, arbitrary JSON through the data API, JavaScript source
 * through function deploys, and binary through storage. A generic WAF that
 * pattern-matches "SELECT" or "<script" against every byte of every request
 * would break the product on day one — and a WAF that is turned off because it
 * has too many false positives protects nothing.
 *
 * So inspection is SCOPED, and the scope is the whole design:
 *
 *   - Path, query string and headers are inspected on EVERY request. Nothing
 *     the product does requires a traversal sequence or a null byte in a URL.
 *   - Bodies are inspected ONLY on routes whose payload shape the platform
 *     itself defines — sign-in, sign-up, organization and project management.
 *     On tenant data planes (sql, data, functions, storage, ai, realtime) the
 *     body is the customer's own content and is never pattern-matched.
 *
 * Every rule below states what it catches and, where it matters, what it must
 * NOT catch. A rule that cannot express that distinction does not belong here.
 */

export type WafCategory =
  | 'traversal'
  | 'sql_injection'
  | 'xss'
  | 'command_injection'
  | 'scanner'
  | 'protocol'
  | 'tool';

export interface WafRule {
  id: string;
  category: WafCategory;
  /** What this catches, in one line — surfaced to operators, never to the caller. */
  describes: string;
  test: RegExp;
}

export interface WafVerdict {
  blocked: boolean;
  ruleId?: string;
  category?: WafCategory;
  /** Where the match was found: path, query, header name, or 'body'. */
  where?: string;
}

/**
 * Routes whose request body is customer content. The WAF never pattern-matches
 * these bodies — a customer running `SELECT * FROM users` in their own
 * database is the product working, not an attack.
 *
 * Matching is on the URL path, so this cannot be spoofed by a header.
 */
const BODY_OPAQUE = [
  /\/api\/v1\/projects\/[^/]+\/(sql|query|data|tables|functions|storage|ai|realtime|branches)/i,
  /\/api\/v1\/data\//i,
  /\/api\/v1\/storage\//i,
  /\/api\/v1\/functions\//i,
  /\/api\/v1\/ai\//i,
  /\/api\/v1\/projects\/[^/]+\/automation/i,
  // Customer-facing auth for a tenant's own end users: the body carries their
  // users' credentials and profile JSON, not platform-defined fields.
  /\/api\/v1\/projects\/[^/]+\/auth\//i,
  // Inbound webhooks are third-party payloads of arbitrary shape.
  /\/webhooks?\//i,
];

/** True when the body on this path is customer content rather than platform input. */
export function bodyIsOpaque(pathname: string): boolean {
  return BODY_OPAQUE.some(re => re.test(pathname));
}

/**
 * Rules applied to path and query string on every request.
 *
 * These are anchored on injection SYNTAX rather than on keywords. "select" or
 * "union" as bare words appear in ordinary identifiers — a project named
 * "union-bank" is not an attack — so every SQL rule requires the punctuation
 * that turns a value into a statement.
 */
export const URL_RULES: WafRule[] = [
  {
    id: 'traversal.dotdot',
    category: 'traversal',
    describes: 'Path traversal (../ or ..\\), raw, encoded, or double-encoded',
    test: /(\.\.[/\\])|(%2e%2e[/\\%])|(%252e%252e)|(\.\.%2f)|(%2e%2e\/)/i,
  },
  {
    id: 'traversal.absolute',
    category: 'traversal',
    describes: 'Absolute path to a system file',
    test: /(\/etc\/(passwd|shadow|hosts))|(\/proc\/self\/)|(c:\\+windows\\+)/i,
  },
  {
    id: 'protocol.nullbyte',
    category: 'protocol',
    describes: 'Null byte, used to truncate a path or a parser',
    test: /(%00)|\0/,
  },
  {
    id: 'protocol.crlf',
    category: 'protocol',
    describes: 'CRLF in the URL — response splitting or header injection',
    test: /(%0d%0a)|(%0a%0d)|[\r\n]/i,
  },
  {
    id: 'sqli.tautology',
    category: 'sql_injection',
    describes: "Boolean tautology with a quote break, e.g. ' OR 1=1",
    test: /['")]\s*(or|and)\s+['"\d][\w'"]*\s*=\s*['"\d]/i,
  },
  {
    id: 'sqli.union',
    category: 'sql_injection',
    describes: 'UNION SELECT — classic column-harvesting injection',
    test: /\bunion\b[\s/*]+(all[\s/*]+)?\bselect\b/i,
  },
  {
    id: 'sqli.comment',
    category: 'sql_injection',
    describes: 'Statement terminator followed by a SQL comment (;-- or ;#)',
    test: /;\s*(--|#)|\/\*!?\d*\s*(union|select|drop|insert)/i,
  },
  {
    id: 'sqli.timing',
    category: 'sql_injection',
    describes: 'Time-based blind injection (sleep, pg_sleep, waitfor delay)',
    test: /\b(pg_sleep|sleep|benchmark|waitfor\s+delay)\s*\(/i,
  },
  {
    id: 'sqli.schema',
    category: 'sql_injection',
    describes: 'Schema enumeration through the URL',
    test: /\b(information_schema\.|pg_catalog\.|pg_shadow|sysobjects)\b/i,
  },
  {
    id: 'xss.tag',
    category: 'xss',
    describes: 'Script or object tag in the URL',
    test: /<\s*(script|iframe|object|embed|svg\b[^>]*onload)/i,
  },
  {
    id: 'xss.handler',
    category: 'xss',
    describes: 'Inline event handler or javascript: URI',
    test: /(javascript|vbscript|data)\s*:\s*[^\s]*(alert|eval|script)|\bon(error|load|click|mouseover)\s*=/i,
  },
  {
    id: 'cmdi.shell',
    category: 'command_injection',
    describes: 'Shell metacharacters wrapping a command',
    test: /(\$\(|`|\|\s*(sh|bash|nc|curl|wget|python)\b|;\s*(cat|ls|id|whoami|rm)\s)/i,
  },
  {
    id: 'cmdi.template',
    category: 'command_injection',
    describes: 'Server-side template / expression injection',
    test: /(\{\{.*?\}\}|\$\{.*?\}|<%.*?%>)\s*$|__proto__|constructor\s*\[\s*['"]prototype/i,
  },
  {
    id: 'scanner.cms',
    category: 'scanner',
    describes: 'Probing for software this platform does not run',
    test: /\/(wp-admin|wp-login|wp-content|xmlrpc\.php|phpmyadmin|pma|administrator\/index\.php|cgi-bin|vendor\/phpunit|solr\/admin|struts|jenkins\/script|actuator\/env|console\/login)\b/i,
  },
  {
    id: 'scanner.secrets',
    category: 'scanner',
    describes: 'Probing for credential and config files',
    test: /\/(\.env(\.|$)|\.git\/|\.svn\/|\.aws\/credentials|\.ssh\/id_|id_rsa|\.DS_Store|web\.config|composer\.lock|dump\.sql|backup\.(sql|zip|tar\.gz))/i,
  },
  {
    id: 'scanner.interpreter',
    category: 'scanner',
    describes: 'Request for an interpreter this stack does not serve',
    test: /\.(php\d?|asp|aspx|jsp|cgi|pl|sh|exe|dll)(\?|$)/i,
  },
];

/**
 * Rules applied only to bodies on platform routes (see BODY_OPAQUE).
 *
 * Narrower than the URL set on purpose: a support message or an operator email
 * may legitimately contain the word "select" or a code sample, so only
 * unambiguous injection syntax blocks here.
 */
export const BODY_RULES: WafRule[] = [
  URL_RULES.find(r => r.id === 'sqli.union')!,
  URL_RULES.find(r => r.id === 'sqli.tautology')!,
  URL_RULES.find(r => r.id === 'sqli.timing')!,
  URL_RULES.find(r => r.id === 'traversal.dotdot')!,
  URL_RULES.find(r => r.id === 'protocol.nullbyte')!,
  {
    id: 'cmdi.proto',
    category: 'command_injection',
    describes: 'Prototype-pollution key in a platform payload',
    test: /"__proto__"\s*:|"constructor"\s*:\s*\{\s*"prototype"/,
  },
];

/**
 * User agents that exist only to find holes. Blocking these is not security by
 * itself — the string is trivially changed — but it removes the loudest,
 * cheapest traffic before it costs a database round trip, and a request that
 * volunteers `sqlmap` has told the truth about its intent.
 */
export const TOOL_AGENTS: WafRule = {
  id: 'tool.scanner',
  category: 'tool',
  describes: 'Self-identified attack tool in the User-Agent',
  test: /\b(sqlmap|nikto|nmap|masscan|zgrab|havij|acunetix|nessus|openvas|wpscan|dirbuster|gobuster|feroxbuster|xsser|commix|joomscan)\b/i,
};

/** Methods this API never serves. TRACE/TRACK enable cross-site tracing. */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Absolute ceilings that no legitimate client approaches. */
export const LIMITS = {
  /** Longest URL the platform ever generates, with generous headroom. */
  urlBytes: 4096,
  /** One header value. Node caps total header size; this catches a single abusive one. */
  headerValueBytes: 8192,
  /** Bytes of body scanned on platform routes. Beyond this the size cap rejects anyway. */
  bodyScanBytes: 64 * 1024,
} as const;

export interface WafInput {
  method: string;
  /** Raw request target, query string included and still percent-encoded. */
  rawUrl: string;
  pathname: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Inspect everything available before the body is read.
 *
 * Returns a verdict rather than throwing so the caller decides the response —
 * and so the threat tracker can score a block even when the request is then
 * allowed through in report-only mode.
 */
export function inspectRequest(input: WafInput): WafVerdict {
  const method = input.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return { blocked: true, ruleId: 'protocol.method', category: 'protocol', where: 'method' };
  }

  if (Buffer.byteLength(input.rawUrl) > LIMITS.urlBytes) {
    return { blocked: true, ruleId: 'protocol.url_length', category: 'protocol', where: 'path' };
  }

  // The raw target is checked first, then the decoded form: an attacker who
  // encodes `../` as `%2e%2e%2f` must fail both, and one who double-encodes
  // must fail the raw check, which matches `%252e`.
  const decoded = safeDecode(input.rawUrl);
  for (const candidate of [input.rawUrl, decoded]) {
    for (const rule of URL_RULES) {
      if (rule.test.test(candidate)) {
        return {
          blocked: true,
          ruleId: rule.id,
          category: rule.category,
          where: candidate.includes('?') ? 'query' : 'path',
        };
      }
    }
  }

  for (const [name, value] of Object.entries(input.headers)) {
    const flat = Array.isArray(value) ? value.join(',') : (value ?? '');
    if (!flat) continue;
    if (Buffer.byteLength(flat) > LIMITS.headerValueBytes) {
      return { blocked: true, ruleId: 'protocol.header_size', category: 'protocol', where: name };
    }
    if (name === 'user-agent' && TOOL_AGENTS.test.test(flat)) {
      return {
        blocked: true,
        ruleId: TOOL_AGENTS.id,
        category: TOOL_AGENTS.category,
        where: 'user-agent',
      };
    }
    // Header values carrying a traversal or a null byte are never legitimate,
    // whatever the header. Scanned decoded, because proxies decode.
    const headerValue = safeDecode(flat);
    if (/(\.\.[/\\])|\0|[\r\n]/.test(headerValue)) {
      return { blocked: true, ruleId: 'protocol.header_inject', category: 'protocol', where: name };
    }
  }

  return { blocked: false };
}

/**
 * Inspect a platform-route body. The caller must have checked `bodyIsOpaque`
 * first — this function does not know the path.
 */
export function inspectBody(raw: string): WafVerdict {
  const slice = raw.length > LIMITS.bodyScanBytes ? raw.slice(0, LIMITS.bodyScanBytes) : raw;
  for (const rule of BODY_RULES) {
    if (rule.test.test(slice)) {
      return { blocked: true, ruleId: rule.id, category: rule.category, where: 'body' };
    }
  }
  return { blocked: false };
}

/** Percent-decoding that never throws on a malformed sequence. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed sequence is itself suspicious, but decoding is not the place
    // to decide that: return the raw value so the rules still see it.
    return value;
  }
}

/** Every rule, for the operator console. Patterns are shown as source, not secrets. */
export function ruleCatalog(): { id: string; category: WafCategory; describes: string }[] {
  return [...URL_RULES, TOOL_AGENTS, ...BODY_RULES.filter(r => r.id === 'cmdi.proto')].map(r => ({
    id: r.id,
    category: r.category,
    describes: r.describes,
  }));
}
