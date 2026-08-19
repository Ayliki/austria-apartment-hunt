/**
 * Every scheduling and threshold decision for notifications, as pure functions over an explicit
 * `now`. This module itself is free of DB and Telegram imports (unlike notify.ts, which wires
 * these policy functions up to telegraf, db, and photo), so the policy is testable without fakes.
 */

const VIENNA = 'Europe/Vienna';

/** Local clock hour (0-23) in Vienna for the given instant, DST included. */
export function viennaHour(now: Date): number {
  const formatted = new Intl.DateTimeFormat('en-GB', { timeZone: VIENNA, hour: '2-digit', hour12: false }).format(now);
  return Number(formatted);
}

const VIENNA_FIELDS = new Intl.DateTimeFormat('en-CA', {
  timeZone: VIENNA, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function viennaFields(instant: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = VIENNA_FIELDS.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour') % 24, // some ICU builds render midnight as hour 24
    minute: get('minute'), second: get('second'),
  };
}

/** Vienna's UTC offset in effect at `instant`, in ms (+1h in CET, +2h in CEST). */
function viennaOffsetMs(instant: Date): number {
  const f = viennaFields(instant);
  const wallAsUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * UTC instant of the most recent Vienna local midnight — the cutoff a per-day cap counts from.
 *
 * Subtracting the local elapsed time from `now` would be wrong on the two DST transition days,
 * because that identity only holds when the UTC offset is the same at midnight as it is at `now`.
 * Instead we take Vienna's calendar date for `now` and solve for the instant whose Vienna wall clock
 * reads 00:00 on that date: guess with the offset at `now`, then correct once with the offset that
 * actually applies at the guess. Only two offsets exist, so one correction always converges.
 */
export function viennaDayStartIso(now: Date): string {
  const { year, month, day } = viennaFields(now);
  const midnightAsUtc = Date.UTC(year, month - 1, day);
  const guess = midnightAsUtc - viennaOffsetMs(now);
  const corrected = midnightAsUtc - viennaOffsetMs(new Date(guess));
  return new Date(corrected).toISOString();
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
  // A percentile outside [0, 1] would index past either end and return undefined, breaking the
  // `number | null` contract for every caller — settings come from user input, so clamp rather than trust.
  const clamped = Math.min(1, Math.max(0, percentile));
  const sorted = [...recentScores].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * (1 - clamped))));
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
