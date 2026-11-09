import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { assertCatalog } from '../src/catalog.ts';
import { catalogPath, localHost } from '../src/config.ts';
import { createSiteServer } from '../src/serve.ts';
import { writeSite } from '../src/site.ts';
import { probeLive, verifyLive } from '../src/verify-live.ts';
import fixtures from './fixtures/tmdb.json' with { type: 'json' };

const basePath = '/stremio-retrospective/';

async function serveFixture(t: TestContext) {
  const projectDirectory = await mkdtemp(join(tmpdir(), 'retrospective-smoke-'));
  t.after(() => rm(projectDirectory, { recursive: true, force: true }));
  const catalog: unknown = fixtures.expectedCatalog;
  assertCatalog(catalog);
  const dist = join(projectDirectory, 'dist');
  const server = createSiteServer(dist, basePath);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.listen(0, localHost);
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://${localHost}:${address.port}${basePath}`;
  const status = await writeSite({
    projectDirectory, baseUrl, catalog,
    effectiveDate: '2026-11-09',
    generatedAt: new Date('2026-11-09T00:17:00.000Z'),
    sourceCommit: 'local',
  });
  return {
    dist, status,
    target: { baseUrl, effectiveDate: status.effectiveDate, sourceCommit: status.sourceCommit },
  };
}

test('recognizes a healthy project-subpath deployment and sends the Stremio origin', async (t) => {
  const { target } = await serveFixture(t);
  const calls: Array<{ pathname: string; origin: string | null }> = [];
  const result = await probeLive(target, (input, init) => {
    assert.equal(init?.redirect, 'manual');
    calls.push({ pathname: new URL(String(input)).pathname, origin: new Headers(init?.headers).get('origin') });
    return fetch(input, init);
  });
  assert(result.fresh);
  assert.equal(result.movieCount, 1);
  assert.equal(result.cache[catalogPath].cacheControl, 'no-store');
  assert.deepEqual(calls, [
    { pathname: basePath + 'manifest.json', origin: 'https://web.stremio.com' },
    { pathname: basePath + catalogPath, origin: 'https://web.stremio.com' },
    { pathname: basePath + 'status.json', origin: null },
  ]);
});

test('rejects a stale date or commit even if the catalog still matches its digest', async (t) => {
  const { dist, status, target } = await serveFixture(t);
  const old = await probeLive({ ...target, effectiveDate: '2026-11-10' });
  assert(!old.fresh);
  assert.match(old.reason, /date is stale/);

  await writeFile(join(dist, 'status.json'), JSON.stringify({ ...status, sourceCommit: 'a'.repeat(40) }));
  const otherCommit = await probeLive(target);
  assert(!otherCommit.fresh);
  assert.match(otherCommit.reason, /source commit/);
});

test('rejects a mismatched count, catalog digest, or manifest', async (t) => {
  const { dist, status, target } = await serveFixture(t);
  await writeFile(join(dist, 'status.json'), JSON.stringify({ ...status, movieCount: 0 }));
  const wrongCount = await probeLive(target);
  assert(!wrongCount.fresh);
  assert.match(wrongCount.reason, /count does not match/);

  await writeFile(join(dist, 'status.json'), JSON.stringify(status));
  const body = await readFile(join(dist, catalogPath), 'utf8');
  await writeFile(join(dist, catalogPath), body + '\n');
  const wrongHash = await probeLive(target);
  assert(!wrongHash.fresh);
  assert.match(wrongHash.reason, /bytes do not match/);

  await writeFile(join(dist, catalogPath), body);
  await writeFile(join(dist, 'manifest.json'), '{}');
  const wrongManifest = await probeLive(target);
  assert(!wrongManifest.fresh);
  assert.match(wrongManifest.reason, /manifest.json does not match/);
});

test('treats a missing deployment, redirects, and broken CORS or MIME as stale', async (t) => {
  const { dist, target } = await serveFixture(t);
  for (const [status, headers, reason] of [
    [302, { location: '/manifest.json' }, /HTTP 302/],
    [200, { 'content-type': 'text/html' }, /content type/],
    [200, { 'content-type': 'application/json' }, /wildcard CORS/],
  ] as const) {
    const result = await probeLive(target, (input, init) => {
      if (String(input).endsWith('/manifest.json')) return Promise.resolve(new Response(null, { status, headers }));
      return fetch(input, init);
    });
    assert(!result.fresh);
    assert.match(result.reason, reason);
  }

  await rm(join(dist, 'status.json'));
  const missing = await probeLive(target);
  assert(!missing.fresh);
  assert.match(missing.reason, /status.json returned HTTP 404/);

  const unreachable = await probeLive(target, () => Promise.reject(new Error('Simulated connection error')));
  assert(!unreachable.fresh);
  assert.match(unreachable.reason, /could not be reached/);
});

test('verifies the exact build and retries until its logo is available', async (t) => {
  const { status, target } = await serveFixture(t);
  let logoAttempts = 0;
  const attempts: boolean[] = [];
  const result = await verifyLive({ ...target, catalogSha256: status.catalogSha256 }, {
    maxWaitMs: 2_000,
    retryIntervalMs: 1,
    onAttempt: (attempt) => attempts.push(attempt.fresh),
    transport: (input, init) => {
      if (String(input).endsWith('/assets/tmdb-logo.svg') && ++logoAttempts === 1) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return fetch(input, init);
    },
  });
  assert(result.fresh);
  assert.deepEqual(attempts, [false, true]);
  assert.equal(result.catalogSha256, status.catalogSha256);
  assert.equal(result.cache['index.html'].cacheControl, 'no-store');

  const mismatched = await probeLive({ ...target, catalogSha256: '0'.repeat(64) });
  assert(!mismatched.fresh);
  assert.match(mismatched.reason, /digest does not match the deployed build/);
});

test('reports failure when the verification window expires', async () => {
  const target = {
    baseUrl: 'https://example.com/stremio-retrospective/',
    effectiveDate: '2026-11-09',
    sourceCommit: 'a'.repeat(40),
    catalogSha256: '0'.repeat(64),
  };
  const result = await verifyLive(target, {
    maxWaitMs: 30,
    retryIntervalMs: 1,
    transport: () => Promise.resolve(new Response(null, { status: 503 })),
  });
  assert(!result.fresh);
  assert.match(result.reason, /HTTP 503/);
});
