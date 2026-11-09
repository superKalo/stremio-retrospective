import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createTmdbClient } from '../src/tmdb.ts';
import type { TmdbClock } from '../src/tmdb.ts';
import fixtures from './fixtures/tmdb.json' with { type: 'json' };

const date = '2001-11-09';
const sample = fixtures.discover[date][1];
const [movie] = sample.results;
const token = 'fixture-read-token';
const start = Date.parse('2026-11-09T00:17:00Z');

type Timer = { at: number; fire: () => void };

class FakeClock implements TmdbClock {
  time = start;
  timers = new Set<Timer>();

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const abort = () => {
        this.timers.delete(timer);
        reject(signal.reason);
      };
      const timer = {
        at: this.time + ms,
        fire: () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      this.timers.add(timer);
    });
  }

  timeout(ms: number): AbortSignal {
    const controller = new AbortController();
    this.timers.add({ at: this.time + ms, fire: () => controller.abort(new Error('Simulated timeout')) });
    return controller.signal;
  }

  async run<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    const finish = () => { settled = true; };
    void work.then(finish, finish);
    for (let count = 0; count < 200 && !settled; count++) {
      await tick();
      if (settled) break;
      const timer = [...this.timers].sort((a, b) => a.at - b.at)[0];
      assert(timer, 'Work stalled with no timers');
      this.timers.delete(timer);
      this.time = Math.max(this.time, timer.at);
      timer.fire();
    }
    assert(settled, 'Work did not finish within the timer budget');
    return work;
  }
}

type Call = { url: URL; init: RequestInit; at: number };

function harness(respond: (call: Call, index: number, clock: FakeClock) => Response | Promise<Response>) {
  const clock = new FakeClock();
  const calls: Call[] = [];
  const client = createTmdbClient({
    token, clock, random: () => 0,
    fetch: async (input, init = {}) => {
      const call = { url: new URL(String(input)), init, at: clock.now() - start };
      calls.push(call);
      return respond(call, calls.length - 1, clock);
    },
  });
  return { client, clock, calls };
}

function status(code: number, retryAfter?: string): Response {
  return new Response(null, { status: code, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });
}

test('sends the exact primary-date filters and stops at the third page', async () => {
  const { client, clock, calls } = harness((_, index) => Response.json({
    ...sample, page: index + 1, total_pages: 8, results: index === 0 ? sample.results : [],
  }));
  const discovery = await clock.run(client.discover(date));
  assert.deepEqual(discovery, {
    candidates: [{
      id: 101, title: 'Retrospective Fixture Movie', releaseDate: date,
      posterPath: '/fixture.jpg', voteCount: 25, popularity: 9.5,
    }],
    pagesFetched: 3, capped: true, skipped: {},
  });
  for (const [index, { url, init }] of calls.entries()) {
    assert.equal(url.origin, 'https://api.themoviedb.org');
    assert.equal(url.pathname, '/3/discover/movie');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      'primary_release_date.gte': date, 'primary_release_date.lte': date,
      include_adult: 'false', include_video: 'false', language: 'en-US',
      'vote_count.gte': '25', sort_by: 'popularity.desc', page: String(index + 1),
    });
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(init.redirect, 'manual');
    assert(!url.href.includes(token));
  }
});

test('skips incomplete and mismatched movies and falls back to the original title', async () => {
  const { client, clock } = harness(() => Response.json({
    ...sample,
    results: [
      {}, { ...movie, video: undefined }, { ...movie, adult: true },
      { ...movie, release_date: '2001-11-10' }, { ...movie, release_date: '' },
      { ...movie, vote_count: 24 }, { ...movie, popularity: -1 },
      { ...movie, poster_path: '/../../invalid.jpg' }, { ...movie, poster_path: null },
      { ...movie, title: ' ', original_title: null }, { ...movie, title: ' ' },
    ],
  }));
  const discovery = await clock.run(client.discover(date));
  assert.deepEqual(discovery.skipped, { id: 1, adultOrVideo: 2, releaseDate: 2, votes: 1, popularity: 1, poster: 2, title: 1 });
  assert.equal(discovery.candidates.length, 1);
  assert.equal(discovery.candidates[0].title, movie.original_title);
});

test('accepts an empty first page and rejects bad JSON, invalid pagination, and unexpected 404', async () => {
  const valid = harness(() => Response.json({ page: 1, total_pages: 0, results: [] }));
  assert.deepEqual(await valid.clock.run(valid.client.discover(date)), {
    candidates: [], skipped: {}, pagesFetched: 1, capped: false,
  });
  assert.equal(valid.calls.length, 1);

  for (const response of [
    new Response('untrusted response body'),
    Response.json({ page: 1, total_pages: 0, results: [movie] }),
    Response.json({ page: 2, total_pages: 2, results: [] }),
    Response.json({ page: 1, total_pages: 1 }),
    status(404),
  ]) {
    const invalid = harness(() => response);
    await assert.rejects(invalid.clock.run(invalid.client.discover(date)), /invalid (JSON|page)|HTTP 404/);
    assert.equal(invalid.calls.length, 1);
  }

  const badSecondPage = harness((_, index) => Response.json({
    ...sample, page: index + 1, total_pages: index === 0 ? 2 : 1,
  }));
  await assert.rejects(badSecondPage.clock.run(badSecondPage.client.discover(date)), /invalid page/);
  assert.equal(badSecondPage.calls.length, 2);
});

test('deduplicates IMDb lookups and treats missing or invalid values and movie 404s as no mapping', async () => {
  const { client, clock, calls } = harness(({ url }) => {
    const id = Number(url.pathname.split('/')[3]);
    if (id === 101 || id === 102) return Response.json(fixtures.externalIds[id]);
    if (id === 103) return status(404);
    return Response.json({ id, imdb_id: id === 104 ? '' : 'tmdb:99' });
  });
  const ids = [101, 101, 102, 103, 103, 104, 105];
  assert.deepEqual(await clock.run(Promise.all(ids.map(client.imdbId))), [
    'tt900000001', 'tt900000001', null, null, null, null, null,
  ]);
  assert.deepEqual(calls.map(({ url }) => url.pathname), [
    '/3/movie/101/external_ids', '/3/movie/102/external_ids', '/3/movie/103/external_ids',
    '/3/movie/104/external_ids', '/3/movie/105/external_ids',
  ]);

  for (const mapping of [{ id: 999, imdb_id: 'tt900000001' }, { id: 101 }, { id: 101, imdb_id: 123 }]) {
    const invalid = harness(() => Response.json(mapping));
    await assert.rejects(invalid.clock.run(invalid.client.imdbId(101)), /invalid mapping/);
  }
});

test('requires the official secure poster base and w342, and fetches configuration once', async () => {
  const { client, clock, calls } = harness(() => Response.json(fixtures.configuration));
  const expected = { baseUrl: 'https://image.tmdb.org/t/p/', size: 'w342' };
  assert.deepEqual(await clock.run(Promise.all([client.posterConfiguration(), client.posterConfiguration()])), [
    expected, expected,
  ]);
  assert.deepEqual(calls.map(({ url }) => url.pathname), ['/3/configuration']);

  for (const images of [
    { secure_base_url: 'https://example.com/', poster_sizes: ['w342'] },
    { secure_base_url: expected.baseUrl, poster_sizes: ['original'] },
  ]) {
    const invalid = harness(() => Response.json({ images }));
    await assert.rejects(invalid.clock.run(invalid.client.posterConfiguration()), /invalid poster configuration/);
  }
});

test('fails on missing credentials and aborts queued work on 401, 403, or redirect', async () => {
  assert.throws(() => createTmdbClient({ token: ' ' }), /TMDB_READ_ACCESS_TOKEN/);
  for (const code of [401, 403, 302]) {
    const { client, clock, calls } = harness(() => status(code));
    const results = await clock.run(Promise.allSettled([client.discover(date), client.imdbId(101)]));
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.match(String(result.reason), new RegExp(`HTTP ${code}`));
    }
    assert.equal(calls.length, 1);
  }
});

test('rejects a malformed response before starting queued work in the freed slot', async () => {
  const { client, clock, calls } = harness(async ({ init }, index, timer) => {
    await timer.sleep(index === 0 ? 500 : 2_000, init.signal!);
    return Response.json({ id: 999 });
  });
  const lookups = [101, 102, 103, 104, 105, 106].map(client.imdbId);
  const results = await clock.run(Promise.allSettled(lookups));
  assert.equal(calls.length, 4);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.match(String(result.reason), /invalid mapping/);
  }
});

test('429 Retry-After seconds or HTTP dates pause the entire queue', async () => {
  for (const header of ['3', new Date(start + 3_000).toUTCString()]) {
    const { client, clock, calls } = harness(({ url }, index) => {
      if (index === 0) return status(429, header);
      return url.pathname.includes('external_ids') ? status(404) : Response.json(sample);
    });
    await clock.run(Promise.all([client.discover(date), client.imdbId(101), client.imdbId(102)]));
    assert.equal(calls.length, 4);
    assert(calls.slice(1).every(({ at }) => at >= 3_000));
    assert.deepEqual(client.stats, { requests: 4, retries: 1 });
  }
});

test('invalid Retry-After uses backoff and delays over 60 seconds fail closed', async () => {
  const fallback = harness((_, index) => index === 0 ? status(429, 'Invalid Date') : Response.json(sample));
  await fallback.clock.run(fallback.client.discover(date));
  assert.deepEqual(fallback.calls.map(({ at }) => at), [0, 1_000]);

  const excessive = harness(() => status(429, '61'));
  await assert.rejects(excessive.clock.run(excessive.client.discover(date)), /Retry-After exceeds 60 seconds/);
  assert.equal(excessive.calls.length, 1);
});

test('retries network failures and 5xx with backoff and stops after four attempts', async () => {
  const recovering = harness((_, index) => {
    if (index === 0) throw new Error('untrusted socket details');
    return index === 1 ? status(503) : Response.json(sample);
  });
  await recovering.clock.run(recovering.client.discover(date));
  assert.deepEqual(recovering.calls.map(({ at }) => at), [0, 1_000, 3_000]);

  const broken = harness(() => status(502));
  await assert.rejects(broken.clock.run(broken.client.discover(date)), /HTTP 502 after 4 attempts/);
  assert.deepEqual(broken.calls.map(({ at }) => at), [0, 1_000, 3_000, 7_000]);
});

test('aborts an attempt after eight seconds and the full ingestion after ten minutes', async () => {
  const retry = harness(async ({ init }, index, clock) => {
    if (index === 0) await clock.sleep(60_000, init.signal!);
    return Response.json(sample);
  });
  await retry.clock.run(retry.client.discover(date));
  assert.deepEqual(retry.calls.map(({ at }) => at), [0, 9_000]);

  const deadline = harness(async ({ init }, _, clock) => {
    await clock.sleep(60_000, init.signal!);
    return Response.json(sample);
  });
  deadline.clock.time += 595_000;
  await assert.rejects(deadline.clock.run(deadline.client.discover(date)), /ingestion deadline exceeded/);
  assert.equal(deadline.clock.now() - start, 600_000);
  assert.equal(deadline.calls.length, 1);
});

test('spaces starts by at least 125 ms and holds at most four requests in flight', async () => {
  const fast = harness(() => status(404));
  const ids = Array.from({ length: 12 }, (_, index) => index + 1);
  await fast.clock.run(Promise.all(ids.map(fast.client.imdbId)));
  assert.deepEqual(fast.calls.map(({ at }) => at), ids.map((id) => (id - 1) * 125));

  let active = 0;
  let peak = 0;
  const slow = harness(async ({ init }, _, clock) => {
    active++;
    peak = Math.max(active, peak);
    await clock.sleep(900, init.signal!);
    active--;
    return status(404);
  });
  await slow.clock.run(Promise.all(ids.map(slow.client.imdbId)));
  assert.equal(peak, 4);
  assert(slow.calls[4].at >= 900);
});
