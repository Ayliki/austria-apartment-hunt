/**
 * Every scheduling and threshold decision for notifications, as pure functions over an explicit
 * `now`. Kept free of DB and Telegram imports so the whole policy is testable without fakes, in the
 * same spirit as notify.ts's injectable DelayFn.
 */

const VIENNA = 'Europe/Vienna';

/** Local clock hour (0-23) in Vienna for the given instant, DST included. */
export function viennaHour(now: Date): number {
  const formatted = new Intl.DateTimeFormat('en-GB', { timeZone: VIENNA, hour: '2-digit', hour12: false }).format(now);
  return Number(formatted);
}

/** UTC instant of the most recent Vienna local midnight — the cutoff a per-day cap counts from. */
export function viennaDayStartIso(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VIENNA, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const elapsedMs = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000;
  return new Date(now.getTime() - elapsedMs - now.getMilliseconds()).toISOString();
}

/**
 * Inclusive of `quietStart`, exclusive of `quietEnd`, and correct for a window that wraps past
 * midnight (the default 22->8 does). A zero-length window means quiet hours are off.
 */
export function isQuietHour(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
  return hour >= quietStart || hour < quietEnd;
}

/**
 * Below this many recent scored matches, a percentile is noise rather than a signal, so instant
 * notification falls back to the caller's valueFlag check alone.
 */
export const MIN_THRESHOLD_SAMPLE = 20;

/**
 * Score a listing must meet or exceed to sit in the top `percentile` of `recentScores`. Returns
 * null when there is too little history to say. Callers compare with `>=`, so a run of identical
 * scores yields that score rather than an unreachable bound.
 */
export function instantThreshold(recentScores: number[], percentile: number): number | null {
  if (recentScores.length < MIN_THRESHOLD_SAMPLE) return null;
  const sorted = [...recentScores].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - percentile)));
  return sorted[index];
}

/**
 * True when `now` has reached a configured digest hour that `lastDigestAt` has not already covered.
 * Comparing Vienna calendar-day + hour (rather than elapsed time) keeps one digest per configured
 * hour per day even though the caller ticks every few minutes.
 */
export function isDigestDue(now: Date, digestHours: number[], lastDigestAt: string | null): boolean {
  if (digestHours.length === 0) return false;
  const hour = viennaHour(now);
  const dueHours = digestHours.filter((h) => h <= hour);
  if (dueHours.length === 0) return false;

  if (lastDigestAt == null) return true;
  const last = new Date(lastDigestAt);
  const dayStart = viennaDayStartIso(now);
  if (last.toISOString() < dayStart) return true; // last digest was on an earlier Vienna day

  return viennaHour(last) < Math.max(...dueHours);
}
