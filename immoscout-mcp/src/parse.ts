/**
 * ImmoScout24 embeds page data as JavaScript object literals assigned to
 * window.__INITIAL_STATE__ / window.__APOLLO_STATE__. These are *almost* JSON
 * but contain bare `undefined` tokens, which JSON.parse rejects.
 */

/** Replace bare `undefined` tokens (valid JS, invalid JSON) with `null`. */
export function normalizeJsObjectLiteral(raw: string): string {
  return raw.replace(/([:,\[]\s*)undefined\s*(?=[,}\]])/g, '$1null');
}

/**
 * Extract the object literal assigned to `marker` (e.g. "window.__INITIAL_STATE__")
 * from an HTML source string and parse it as JSON after normalization.
 * Brace-matching is string-aware: braces inside "…" strings and escaped quotes
 * do not affect the depth count. Throws a specific Error on any failure —
 * callers must never silently treat a changed page structure as "no results".
 */
export function extractEmbeddedJson(source: string, marker: string): unknown {
  const markerIdx = source.indexOf(marker);
  if (markerIdx < 0) throw new Error(`marker not found in page: ${marker}`);
  const eq = source.indexOf('=', markerIdx + marker.length);
  const start = eq < 0 ? -1 : source.indexOf('{', eq);
  if (start < 0) throw new Error(`no object literal after marker: ${marker}`);

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) throw new Error(`unbalanced object literal after marker: ${marker}`);

  const raw = source.slice(start, end);
  try {
    return JSON.parse(normalizeJsObjectLiteral(raw));
  } catch (err) {
    throw new Error(`failed to parse JSON after marker ${marker}: ${(err as Error).message}`);
  }
}
