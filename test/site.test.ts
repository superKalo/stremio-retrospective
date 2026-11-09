import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { catalogPath, localBaseUrl, localHost, siteContentTypes } from '../src/config.ts';
import { assertCatalog } from '../src/catalog.ts';
import { generateSite } from '../src/generate.ts';
import { createSiteServer } from '../src/serve.ts';
import { writeSite } from '../src/site.ts';
import { createTmdbClient } from '../src/tmdb.ts';
import fixtures from './fixtures/tmdb.json' with { type: 'json' };

const fixtureCatalog = fixtures.expectedCatalog;

async function fixtureOptions(t: TestContext) {
  const projectDirectory = await mkdtemp(join(tmpdir(), 'retrospective-test-'));
  t.after(() => rm(projectDirectory, { recursive: true, force: true }));
  const catalog: unknown = fixtureCatalog;
  assertCatalog(catalog);
  return {
    projectDirectory,
    baseUrl: localBaseUrl,
    effectiveDate: '2026-11-09',
    generatedAt: new Date('2026-11-09T00:17:00.000Z'),
    sourceCommit: 'local',
    catalog,
  };
}

test('writes the exact artifact with a date, digest, install link, and credits', async (t) => {
  const options = await fixtureOptions(t);
  await writeSite({ ...options, baseUrl: 'https://example.com/stremio-retrospective' });
  const dist = join(options.projectDirectory, 'dist');
  const entries = await readdir(dist, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile())
    .map((entry) => relative(dist, join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
  assert.deepEqual(files.sort(), Object.keys(siteContentTypes).sort());

  const catalog = await readFile(join(dist, catalogPath), 'utf8');
  assert.deepEqual(JSON.parse(catalog), fixtureCatalog);
  assert.deepEqual(JSON.parse(await readFile(join(dist, 'status.json'), 'utf8')), {
    schemaVersion: 1,
    effectiveDate: options.effectiveDate,
    generatedAt: options.generatedAt.toISOString(),
    sourceCommit: 'local',
    movieCount: 1,
    catalogSha256: createHash('sha256').update(catalog).digest('hex'),
  });
  const index = await readFile(join(dist, 'index.html'), 'utf8');
  assert.match(index, /href="https:\/\/example\.com\/stremio-retrospective\/manifest\.json"/);
  assert.match(index, /<time datetime="2026-11-09">2026-11-09<\/time>/);
  assert.match(index, /src="assets\/tmdb-logo\.svg"/);
  assert.match(index, /This product uses the TMDB API but is not endorsed or certified by TMDB\./);
});

test('publishes a valid empty response and keeps it if the next build is invalid', async (t) => {
  const options = await fixtureOptions(t);
  await writeSite(options);
  await writeSite({ ...options, catalog: { metas: [] } });
  const output = join(options.projectDirectory, 'dist', catalogPath);
  const empty = await readFile(output, 'utf8');
  assert.deepEqual(JSON.parse(empty), { metas: [] });

  const [movie] = options.catalog.metas;
  await assert.rejects(writeSite({ ...options, catalog: { metas: [movie, movie] } }), /Duplicate IMDb ID/);
  assert.equal(await readFile(output, 'utf8'), empty);
  assert.deepEqual(await readdir(options.projectDirectory), ['dist']);
});

test('escapes the install URL and rejects a credential or oversized artifact before replacement', async (t) => {
  const options = await fixtureOptions(t);
  await writeSite({ ...options, baseUrl: 'https://example.com/cinema&archive/' });
  const dist = join(options.projectDirectory, 'dist');
  const index = await readFile(join(dist, 'index.html'), 'utf8');
  assert(index.includes('href="https://example.com/cinema&amp;archive/manifest.json"'));
  const previous = await readFile(join(dist, catalogPath), 'utf8');
  const [movie] = options.catalog.metas;

  await assert.rejects(writeSite({
    ...options,
    tokenToExclude: 'fixture-secret',
    catalog: { metas: [{ ...movie, name: 'Name with fixture-secret' }] },
  }), /Credential found in site artifact/);
  await assert.rejects(writeSite({
    ...options,
    catalog: { metas: [{ ...movie, name: 'x'.repeat(256 * 1024) }] },
  }), /smaller than 256 KiB/);
  assert.equal(await readFile(join(dist, catalogPath), 'utf8'), previous);
  assert.deepEqual(await readdir(options.projectDirectory), ['dist']);
});

test('generates from both discovery pages and resolves a repeated TMDB ID only once', async (t) => {
  const options = await fixtureOptions(t);
  const [sample] = fixtures.discover['2001-11-09'][1].results;
  const client = createTmdbClient({
    token: 'fixture-token',
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/3/discover/movie') {
        assert.equal(url.searchParams.get('primary_release_date.gte'), '1950-11-09');
        const page = Number(url.searchParams.get('page'));
        return Response.json({
          page, total_pages: 2,
          results: [{ ...sample, title: `Page ${page}`, popularity: page, release_date: '1950-11-09' }],
        });
      }
      if (url.pathname === '/3/movie/101/external_ids') return Response.json(fixtures.externalIds[101]);
      assert.equal(url.pathname, '/3/configuration');
      return Response.json(fixtures.configuration);
    },
  });
  const summary = await generateSite({ ...options, effectiveDate: '1951-11-09' }, client);
  assert.equal(summary.pagesFetched, 2);
  assert.equal(summary.imdbLookups, 1);
  assert.equal(summary.duplicateTmdbRows, 1);
  assert.equal(summary.movieCount, 1);
  const catalog = JSON.parse(await readFile(join(options.projectDirectory, 'dist', catalogPath), 'utf8'));
  assert.equal(catalog.metas[0].name, 'Page 2');
  assert.equal(catalog.metas[0].description, 'Released on 9 November 1950 (1 year ago).');
});

test('preserves the previous deployment when discovery fails', async (t) => {
  const options = await fixtureOptions(t);
  await writeSite(options);
  const client = createTmdbClient({
    token: 'fixture-token',
    fetch: async () => new Response(null, { status: 403 }),
  });
  const output = join(options.projectDirectory, 'dist', catalogPath);
  const previous = await readFile(output, 'utf8');
  await assert.rejects(generateSite(options, client), /HTTP 403/);
  assert.equal(await readFile(output, 'utf8'), previous);
  assert.deepEqual(await readdir(options.projectDirectory), ['dist']);
});

for (const basePath of ['/', '/stremio-retrospective/']) {
  test(`serves the Stremio contract at ${basePath}`, async (t) => {
    const options = await fixtureOptions(t);
    await writeSite(options);
    const server = createSiteServer(join(options.projectDirectory, 'dist'), basePath);
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    server.listen(0, localHost);
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    const base = `http://${localHost}:${address.port}${basePath}`;
    const headers = { Origin: 'https://web.stremio.com' };

    const manifestResponse = await fetch(base + 'manifest.json', { headers });
    assert.equal(manifestResponse.status, 200);
    assert.equal(manifestResponse.headers.get('content-type'), siteContentTypes['manifest.json']);
    assert.equal(manifestResponse.headers.get('access-control-allow-origin'), '*');
    assert.equal(manifestResponse.headers.get('cache-control'), 'no-store');
    const manifest = await manifestResponse.json();
    assert.equal(manifest.id, 'io.github.superkalo.retrospective');
    assert.equal(manifest.name, 'Retrospective');
    assert.deepEqual(manifest.resources, ['catalog']);
    assert.deepEqual(manifest.types, ['movie']);
    assert.deepEqual(manifest.catalogs, [{ type: 'movie', id: 'today', name: 'Released on This Day' }]);
    for (const unsupported of ['extra', 'idPrefixes', 'behaviorHints']) {
      assert(!Object.hasOwn(manifest, unsupported));
    }

    const catalogResponse = await fetch(base + catalogPath, { headers });
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalogResponse.headers.get('content-type'), siteContentTypes[catalogPath]);
    assert.equal(catalogResponse.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await catalogResponse.json(), fixtureCatalog);

    for (const path of ['catalog/movie/today/skip=100.json', 'meta/movie/tt900000001.json', 'plan.md']) {
      assert.equal((await fetch(base + path)).status, 404);
    }
  });
}
