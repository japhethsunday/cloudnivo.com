/**
 * Platform-assigned listen port.
 *
 * Hosted platforms (Railway, Render, Fly) assign a dynamic `PORT` per service
 * and route edge traffic to it — a hardcoded service port answers nothing.
 * Precedence: explicit code arg (tests/callers) → `PORT` env → configured
 * service port (`API_PORT` / `WORKER_PORT` / `REALTIME_PORT`). Malformed
 * values fall through to the configured port instead of crashing boot.
 */
export function resolveListenPort(explicit: number | undefined, configured: number): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env['PORT'] ?? '';
  if (raw !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
  }
  return configured;
}
