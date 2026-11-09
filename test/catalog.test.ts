import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCatalog, buildCatalog } from '../src/catalog.ts';
import { maxCatalogItems, maxImdbLookups, tmdbImageBaseUrl, tmdbPosterSize } from '../src/config.ts';
import type { MovieCandidate } from '../src/tmdb.ts';
import fixtures from './fixtures/tmdb.json' with { type: 'json' };

const fixtureCatalog = fixtures.expectedCatalog;
const date = '2026-11-09';
const posterConfiguration = async () => ({ baseUrl: tmdbImageBaseUrl, size: tmdbPosterSize });

function candidate(id: number, overrides: Partial<MovieCandidate> = {}): MovieCandidate {
  return {
    id, title: `Movie ${id}`, releaseDate: '2001-11-09', posterPath: '/poster.jpg',
    popularity: 10, voteCount: 25, ...overrides,
  };
}

function imdbId(id: number): string {
  return 'tt' + String(id).padStart(7, '0');
}

test('accepts a native movie catalog and an empty response', () => {
  assert.doesNotThrow(() => assertCatalog(fixtureCatalog));
  assert.doesNotThrow(() => assertCatalog({ metas: [] }));
});

test('rejects duplicate IMDb IDs', () => {
  const [movie] = fixtureCatalog.metas;
  assert.throws(() => assertCatalog({ metas: [movie, movie] }), /Duplicate IMDb ID/);
});

test('rejects non-native IDs, unsafe posters, and incorrect preview fields', () => {
  const [movie] = fixtureCatalog.metas;
  for (const overrides of [
    { id: 'tmdb:123' },
    { type: 'series' },
    { name: ' ' },
    { poster: 'http://example.com/poster.jpg' },
    { poster: 'https://someone@example.com/poster.jpg' },
    { poster: 'https://example.com/poster.jpg' },
    { poster: fixtureCatalog.metas[0].poster + '?token=example' },
    { poster: tmdbImageBaseUrl + tmdbPosterSize + '/../poster.jpg' },
    { posterShape: 'landscape' },
    { releaseInfo: 2001 },
    { releaseInfo: '2001-11-09' },
    { description: '' },
    { imdbRating: '8.2' },
  ]) {
    assert.throws(() => assertCatalog({ metas: [{ ...movie, ...overrides }] }));
  }
});

test('uses deterministic rank and lexical ties, excluding TMDB IDs with conflicting dates', async () => {
  const candidates = [
    candidate(3),
    candidate(2, { voteCount: 50 }),
    candidate(1, { popularity: 20, title: 'Zulu' }),
    candidate(1, { popularity: 20, title: 'Alpha', posterPath: '/z.jpg' }),
    candidate(1, { popularity: 20, title: 'Alpha', posterPath: '/a.jpg' }),
    candidate(8, { popularity: 40 }),
    candidate(8, { popularity: 100, releaseDate: '2002-11-09' }),
    candidate(4, { releaseDate: '2025-11-09' }),
  ];
  const lookedUp: number[] = [];
  const client = { posterConfiguration, imdbId: async (id: number) => {
    lookedUp.push(id);
    return imdbId(id);
  } };
  const result = await buildCatalog(date, candidates, client);
  assert.deepEqual(lookedUp, [1, 2, 3, 4]);
  assert.equal(result.duplicateTmdbRows, 3);
  assert.equal(result.conflictingTmdbIds, 1);
  assert.equal(result.catalog.metas[0].name, 'Alpha');
  assert.equal(result.catalog.metas[0].poster, tmdbImageBaseUrl + tmdbPosterSize + '/a.jpg');
  assert.equal(result.catalog.metas[3].description, 'Released on 9 November 2025 (1 year ago).');

  const reversed = await buildCatalog(date, [...candidates].reverse(), client);
  assert.equal(JSON.stringify(reversed.catalog), JSON.stringify(result.catalog));
});

test('deduplicates IMDb IDs in ranked order even when lookups finish out of order', async () => {
  const pending = new Map<number, (value: string | null) => void>();
  const work = buildCatalog(date, [3, 2, 1, 4].map((id) => candidate(id)), {
    posterConfiguration,
    imdbId: (id) => new Promise((resolve) => pending.set(id, resolve)),
  });
  pending.get(4)!(imdbId(4));
  pending.get(3)!(imdbId(1));
  pending.get(2)!(null);
  pending.get(1)!(imdbId(1));
  const result = await work;
  assert.deepEqual(result.catalog.metas.map((movie) => movie.name), ['Movie 1', 'Movie 4']);
  assert.equal(result.duplicateImdbIds, 1);
  assert.equal(result.missingImdbIds, 1);
});

test('fills the output after missing mappings and bounds both results and total lookups', async () => {
  const candidates = Array.from({ length: 180 }, (_, index) => candidate(index + 1));
  const filled = await buildCatalog(date, candidates, {
    posterConfiguration,
    imdbId: async (id) => id <= 4 ? null : imdbId(id),
  });
  assert.equal(filled.imdbLookups, 44);
  assert.equal(filled.catalog.metas.length, maxCatalogItems);
  assert.equal(filled.catalog.metas.at(-1)?.id, imdbId(44));

  const lookedUp: number[] = [];
  const empty = await buildCatalog(date, candidates, {
    posterConfiguration: async () => assert.fail('Empty catalogs need no poster settings'),
    imdbId: async (id) => { lookedUp.push(id); return null; },
  });
  assert.equal(empty.imdbLookups, maxImdbLookups);
  assert.equal(lookedUp.at(-1), maxImdbLookups);
  assert.deepEqual(empty.catalog, { metas: [] });
});

test('fails the whole selection if a required lookup fails in the last batch', async () => {
  const candidates = Array.from({ length: 44 }, (_, index) => candidate(index + 1));
  await assert.rejects(buildCatalog(date, candidates, {
    posterConfiguration,
    imdbId: async (id) => {
      if (id === 44) throw new Error('Last batch failed');
      return id === 40 ? null : imdbId(id);
    },
  }), /Last batch failed/);
});

test('keeps the catalog to one capped page and rejects other top-level keys', () => {
  const metas = Array.from({ length: maxCatalogItems + 1 }, (_, index) => ({
    ...fixtureCatalog.metas[0],
    id: 'tt' + String(index).padStart(7, '0'),
  }));
  assert.doesNotThrow(() => assertCatalog({ metas: metas.slice(1) }));
  assert.throws(() => assertCatalog({ metas }), /single-page limit/);
  assert.throws(() => assertCatalog({ metas: [], cacheMaxAge: 0 }), /Unexpected catalog fields/);
});
