import { AutomationError } from './types.js';

/**
 * Minimal five-field cron matcher (minute hour day-of-month month
 * day-of-week, UTC). Supports `*`, lists, ranges, and steps (`\/15`).
 * Deliberately small and pure: parsing failures are validation errors,
 * `nextRun` scans forward minute-by-minute with a one-year horizon.
 */

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

const RANGES: Record<keyof CronFields, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
};

function parseField(raw: string, min: number, max: number, field: string): Set<number> {
  const out = new Set<number>();
  const add = (n: number): void => {
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new AutomationError('VALIDATION_ERROR', `Cron field ${field}: value ${raw} out of range`, 400);
    }
    out.add(n);
  };
  for (const part of raw.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) {
      throw new AutomationError('VALIDATION_ERROR', `Cron field ${field}: bad step in ${raw}`, 400);
    }
    if (range === '*') {
      for (let n = min; n <= max; n += step) out.add(n);
      continue;
    }
    const dash = range?.split('-');
    const lo = Number(dash?.[0]);
    if (dash?.length === 1 && Number.isInteger(lo)) {
      if ((lo - min) % step === 0) add(lo);
      continue;
    }
    if (dash?.length === 2) {
      const hi = Number(dash[1]);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) {
        throw new AutomationError('VALIDATION_ERROR', `Cron field ${field}: bad range in ${raw}`, 400);
      }
      for (let n = lo; n <= hi; n += step) add(n);
      continue;
    }
    throw new AutomationError('VALIDATION_ERROR', `Cron field ${field}: cannot parse ${raw}`, 400);
  }
  if (out.size === 0) {
    throw new AutomationError('VALIDATION_ERROR', `Cron field ${field}: empty set in ${raw}`, 400);
  }
  return out;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new AutomationError(
      'VALIDATION_ERROR',
      'Cron must have five fields: minute hour day-of-month month day-of-week (UTC)',
      400,
    );
  }
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  return {
    minute: parseField(minute, ...RANGES.minute, 'minute'),
    hour: parseField(hour, ...RANGES.hour, 'hour'),
    dom: parseField(dom, ...RANGES.dom, 'day-of-month'),
    month: parseField(month, ...RANGES.month, 'month'),
    dow: parseField(dow, ...RANGES.dow, 'day-of-week'),
  };
}

/** Next minute-boundary strictly after `from` matching `fields`, or null past the horizon. */
export function nextRun(fields: CronFields, from: Date): Date | null {
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let i = 0; i < 525_600; i++) {
    if (
      fields.minute.has(cursor.getUTCMinutes()) &&
      fields.hour.has(cursor.getUTCHours()) &&
      fields.dom.has(cursor.getUTCDate()) &&
      fields.month.has(cursor.getUTCMonth() + 1) &&
      fields.dow.has(cursor.getUTCDay())
    ) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

/** Validate + compute the first run strictly after `from` (defaults to now). */
export function nextRunFor(expr: string, from: Date = new Date()): string {
  const next = nextRun(parseCron(expr), from);
  if (!next) throw new AutomationError('VALIDATION_ERROR', 'Cron expression never matches within a year', 400);
  return next.toISOString();
}
