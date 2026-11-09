import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCatalog } from '../src/catalog.ts';
import { maxCatalogItems } from '../src/config.ts';
import { fixtureCatalog } from '../src/generate.ts';

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
    { posterShape: 'landscape' },
    { releaseInfo: 2001 },
    { releaseInfo: '2001-11-09' },
    { description: '' },
    { imdbRating: '8.2' },
  ]) {
    assert.throws(() => assertCatalog({ metas: [{ ...movie, ...overrides }] }));
  }
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
