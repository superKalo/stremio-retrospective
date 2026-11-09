import { setTimeout as delay } from 'node:timers/promises';
import { isImdbId, isRecord } from './catalog.ts';
import { maxDiscoveryPages, minimumVoteCount, tmdbLanguage, tmdbPosterSize } from './config.ts';
import { parseCalendarDate } from './dates.ts';

const apiBase = 'https://api.themoviedb.org/3/';
const imageBase = 'https://image.tmdb.org/t/p/';
const maxInFlight = 4;
const startIntervalMs = 125;
const requestTimeoutMs = 8_000;
const ingestionTimeoutMs = 600_000;
const maxRetryAfterMs = 60_000;
const maxRetries = 3;

export type TmdbClock = {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  timeout(ms: number): AbortSignal;
};

const systemClock: TmdbClock = {
  now: () => performance.timeOrigin + performance.now(),
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
  timeout: (ms) => AbortSignal.timeout(ms),
};

export type MovieCandidate = {
  id: number;
  title: string;
  releaseDate: string;
  posterPath: string;
  voteCount: number;
  popularity: number;
};

type SkipReason = 'id' | 'adultOrVideo' | 'releaseDate' | 'votes' | 'popularity' | 'poster' | 'title';
type Discovery = {
  candidates: MovieCandidate[];
  skipped: Partial<Record<SkipReason, number>>;
  pagesFetched: number;
  capped: boolean;
};

function isTmdbId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function normalizeMovie(value: unknown, releaseDate: string): MovieCandidate | SkipReason {
  if (!isRecord(value) || !isTmdbId(value.id)) return 'id';
  if (value.adult !== false || value.video !== false) return 'adultOrVideo';
  if (value.release_date !== releaseDate) return 'releaseDate';
  if (typeof value.vote_count !== 'number' || !Number.isSafeInteger(value.vote_count) ||
      value.vote_count < minimumVoteCount) return 'votes';
  if (typeof value.popularity !== 'number' || !Number.isFinite(value.popularity) ||
      value.popularity < 0) return 'popularity';
  if (typeof value.poster_path !== 'string' ||
      !/^\/[a-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(value.poster_path)) return 'poster';

  const title = (typeof value.title === 'string' && value.title.trim()) ||
    (typeof value.original_title === 'string' && value.original_title.trim());
  if (!title) return 'title';

  return {
    id: value.id, title, releaseDate, posterPath: value.poster_path,
    voteCount: value.vote_count, popularity: value.popularity,
  };
}

function retryAfterMs(header: string | null, now: number): number {
  if (header === null) return 0;
  if (/^[0-9]+$/.test(header)) return Number(header) * 1_000;
  const date = new Date(header);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) && date.toUTCString() === header ? Math.max(0, timestamp - now) : 0;
}

function createRequestQueue(
  clock: TmdbClock,
  signal: AbortSignal,
  abortError: () => Error,
  onTimerError: () => void,
) {
  const pending: Array<{ start: () => void; reject: (error: Error) => void }> = [];
  let inFlight = 0;
  let nextStartAt = 0;
  let pausedUntil = 0;
  let waiting = false;

  function drain(): void {
    if (signal.aborted) {
      for (const task of pending.splice(0)) task.reject(abortError());
      return;
    }
    if (waiting || inFlight >= maxInFlight || pending.length === 0) return;

    const wait = Math.ceil(Math.max(pausedUntil, nextStartAt) - clock.now());
    if (wait > 0) {
      waiting = true;
      void clock.sleep(wait, signal).then(
        () => {
          waiting = false;
          drain();
        },
        () => {
          waiting = false;
          if (!signal.aborted) onTimerError();
          drain();
        },
      );
      return;
    }

    pending.shift()!.start();
    drain();
  }

  signal.addEventListener('abort', drain, { once: true });

  return {
    pauseFor(ms: number): void {
      pausedUntil = Math.max(pausedUntil, clock.now() + ms);
    },
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        pending.push({
          reject,
          start: () => {
            inFlight++;
            nextStartAt = clock.now() + startIntervalMs;
            void task().then(resolve, reject).finally(() => {
              inFlight--;
              drain();
            });
          },
        });
        drain();
      });
    },
  };
}

type ClientOptions = {
  token: string;
  fetch?: typeof fetch;
  clock?: TmdbClock;
  random?: () => number;
  signal?: AbortSignal;
};

type Attempt<T> = { data: T } | { retryIn: number };

export function createTmdbClient(options: ClientOptions) {
  const token = options.token.trim();
  if (!token) throw new Error('TMDB_READ_ACCESS_TOKEN is required');

  const transport = options.fetch ?? fetch;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const stop = new AbortController();
  const deadline = clock.timeout(ingestionTimeoutMs);
  const signal = AbortSignal.any([stop.signal, deadline, ...(options.signal ? [options.signal] : [])]);
  const stats = { requests: 0, retries: 0 };
  const imdbIds = new Map<number, Promise<string | null>>();
  let configuration: Promise<{ baseUrl: string; size: string }> | undefined;

  function abortError(): Error {
    if (stop.signal.aborted) return stop.signal.reason;
    return new Error(deadline.aborted ? 'TMDB ingestion deadline exceeded' : 'TMDB ingestion cancelled');
  }

  function fail(message: string): never {
    stop.abort(new Error(message));
    throw abortError();
  }

  const queue = createRequestQueue(clock, signal, abortError, () => {
    stop.abort(new Error('TMDB request pacing failed'));
  });

  async function request<T>(
    url: URL,
    family: string,
    decode: (payload: unknown) => T,
    allowMissing = false,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const result = await queue.run(async (): Promise<Attempt<T>> => {
        stats.requests++;
        if (attempt > 0) stats.retries++;

        function retry(detail: string, response?: Response): Attempt<T> {
          if (signal.aborted) throw abortError();
          const requested = retryAfterMs(response?.headers.get('retry-after') ?? null, clock.now());
          if (requested > maxRetryAfterMs) fail(`TMDB ${family} ${detail}: Retry-After exceeds 60 seconds`);
          if (attempt === maxRetries) fail(`TMDB ${family} ${detail} after ${maxRetries + 1} attempts`);
          const backoff = 1_000 * 2 ** attempt + Math.floor(random() * 251);
          const retryIn = Math.max(backoff, requested);
          if (response?.status === 429) queue.pauseFor(retryIn);
          return { retryIn };
        }

        const timeout = clock.timeout(requestTimeoutMs);
        const attemptSignal = AbortSignal.any([signal, timeout]);
        let response: Response;
        try {
          response = await transport(url, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            redirect: 'manual',
            signal: attemptSignal,
          });
        } catch {
          return retry(timeout.aborted ? 'request timed out' : 'network error');
        }

        if (response.status !== 200 || attemptSignal.aborted) {
          void response.body?.cancel().catch(() => {});
          if (attemptSignal.aborted) return retry('request timed out');
          if (allowMissing && response.status === 404) return { data: decode(undefined) };
          if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
            return retry(`HTTP ${response.status}`, response);
          }
          fail(`TMDB ${family} HTTP ${response.status}`);
        }

        let data: unknown;
        try {
          data = await response.json();
        } catch (error) {
          if (signal.aborted) throw abortError();
          if (!timeout.aborted && error instanceof SyntaxError) fail(`TMDB ${family} returned invalid JSON`);
          return retry(timeout.aborted ? 'request timed out' : 'response read failed');
        }
        if (attemptSignal.aborted) return retry('request timed out');
        return { data: decode(data) };
      });

      if ('data' in result) return result.data;
      try {
        await clock.sleep(result.retryIn, signal);
      } catch {
        if (signal.aborted) throw abortError();
        fail('TMDB retry timer failed');
      }
    }
  }

  async function discover(releaseDate: string): Promise<Discovery> {
    parseCalendarDate(releaseDate);
    const url = new URL('discover/movie', apiBase);
    url.search = new URLSearchParams({
      'primary_release_date.gte': releaseDate,
      'primary_release_date.lte': releaseDate,
      include_adult: 'false',
      include_video: 'false',
      language: tmdbLanguage,
      'vote_count.gte': String(minimumVoteCount),
      sort_by: 'popularity.desc',
    }).toString();
    const discovery: Discovery = { candidates: [], skipped: {}, pagesFetched: 0, capped: false };
    let lastPage = 1;

    for (let page = 1; page <= lastPage; page++) {
      url.searchParams.set('page', String(page));
      const { totalPages, rows } = await request(new URL(url), 'discover/movie', (data) => {
        if (!isRecord(data) || data.page !== page || !Array.isArray(data.results) ||
            typeof data.total_pages !== 'number' || !Number.isSafeInteger(data.total_pages) ||
            (data.total_pages < page && !(data.total_pages === 0 && page === 1 && data.results.length === 0))) {
          fail('TMDB discover/movie returned an invalid page');
        }
        return { totalPages: data.total_pages, rows: data.results as unknown[] };
      });
      if (page === 1) {
        lastPage = Math.min(totalPages, maxDiscoveryPages);
        discovery.capped = totalPages > maxDiscoveryPages;
      }
      discovery.pagesFetched++;
      for (const row of rows) {
        const result = normalizeMovie(row, releaseDate);
        if (typeof result === 'string') {
          discovery.skipped[result] = (discovery.skipped[result] ?? 0) + 1;
        } else {
          discovery.candidates.push(result);
        }
      }
    }
    return discovery;
  }

  function fetchImdbId(id: number): Promise<string | null> {
    return request(new URL(`movie/${id}/external_ids`, apiBase), 'movie/external_ids', (data) => {
      if (data === undefined) return null;
      if (!isRecord(data) || data.id !== id || (data.imdb_id !== null && typeof data.imdb_id !== 'string')) {
        fail('TMDB movie/external_ids returned an invalid mapping');
      }
      return isImdbId(data.imdb_id) ? data.imdb_id : null;
    }, true);
  }

  function fetchConfiguration(): Promise<{ baseUrl: string; size: string }> {
    return request(new URL('configuration', apiBase), 'configuration', (data) => {
      if (!isRecord(data) || !isRecord(data.images) || data.images.secure_base_url !== imageBase ||
          !Array.isArray(data.images.poster_sizes) || !data.images.poster_sizes.includes(tmdbPosterSize)) {
        fail('TMDB configuration returned an invalid poster configuration');
      }
      return { baseUrl: imageBase, size: tmdbPosterSize };
    });
  }

  return {
    discover,
    imdbId(id: number): Promise<string | null> {
      if (!isTmdbId(id)) return Promise.reject(new RangeError('Invalid TMDB movie ID'));
      if (signal.aborted) return Promise.reject(abortError());
      const existing = imdbIds.get(id);
      if (existing) return existing;
      const lookup = fetchImdbId(id);
      imdbIds.set(id, lookup);
      return lookup;
    },
    posterConfiguration(): Promise<{ baseUrl: string; size: string }> {
      if (signal.aborted) return Promise.reject(abortError());
      return configuration ??= fetchConfiguration();
    },
    get stats() {
      return { ...stats };
    },
  };
}
