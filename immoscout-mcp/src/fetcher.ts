export interface FetcherOptions {
  /** Minimum ms between requests (politeness). Default 700. */
  minIntervalMs?: number;
  /** Retries for transient 401/429/5xx. Default 3. */
  maxRetries?: number;
  userAgent?: string;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; personal apartment search tool)';

/**
 * Minimal HTTP fetcher for immobilienscout24.at with:
 * - a cookie jar (the site occasionally answers 401 without a persisted
 *   session cookie; reusing the jar across a run resolves this),
 * - one-request-at-a-time rate limiting (~700ms by default),
 * - bounded retry with linear backoff on transient 401/429/5xx.
 * Never swallows non-200 responses: throws a specific error instead.
 */
export class Fetcher {
  private readonly cookies = new Map<string, string>();
  private lastRequestAt = 0;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: FetcherOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 700;
    this.maxRetries = opts.maxRetries ?? 3;
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async fetchText(url: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await fetch(url, {
        headers: {
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml',
          ...(this.cookieHeader() ? { cookie: this.cookieHeader()! } : {}),
        },
        redirect: 'follow',
      });
      this.storeCookies(res.headers.getSetCookie?.() ?? []);
      if (res.ok) return res.text();

      const transient = res.status === 401 || res.status === 429 || res.status >= 500;
      if (!transient || attempt >= this.maxRetries) {
        throw new Error(`GET ${url} failed with HTTP ${res.status}`);
      }
      await this.sleep(500 * (attempt + 1));
    }
  }

  private async throttle(): Promise<void> {
    const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private cookieHeader(): string | null {
    if (this.cookies.size === 0) return null;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private storeCookies(setCookies: string[]): void {
    for (const sc of setCookies) {
      const pair = sc.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}
