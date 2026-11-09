import assert from 'node:assert/strict';
import { maxCatalogItems } from './config.ts';

export type MoviePreview = {
  id: string;
  type: 'movie';
  name: string;
  poster: string;
  posterShape: 'poster';
  releaseInfo: string;
  description: string;
};

export type Catalog = { metas: MoviePreview[] };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isImdbId(value: unknown): value is string {
  return typeof value === 'string' && /^tt[0-9]{7,}$/.test(value);
}

export function assertCatalog(value: unknown): asserts value is Catalog {
  assert(isRecord(value) && Array.isArray(value.metas), 'Expected a catalog with a metas array');
  assert.deepEqual(Object.keys(value), ['metas'], 'Unexpected catalog fields');
  assert(value.metas.length <= maxCatalogItems, 'Catalog exceeds the single-page limit');

  const seen = new Set<string>();
  for (const movie of value.metas as unknown[]) {
    assert(isRecord(movie), 'Expected a movie preview object');
    assert.deepEqual(Object.keys(movie).sort(), [
      'description', 'id', 'name', 'poster', 'posterShape', 'releaseInfo', 'type',
    ], 'Unexpected movie preview fields');
    assert(isImdbId(movie.id), 'Invalid IMDb title ID');
    assert(!seen.has(movie.id), `Duplicate IMDb ID: ${movie.id}`);
    seen.add(movie.id);
    assert.equal(movie.type, 'movie', 'Expected a movie preview');
    assert(typeof movie.name === 'string' && movie.name.trim(), 'Missing movie title');
    assert(typeof movie.poster === 'string', 'Missing poster URL');
    const poster = new URL(movie.poster);
    assert(poster.protocol === 'https:' && !poster.username && !poster.password, 'Expected an HTTPS poster URL');
    assert.equal(movie.posterShape, 'poster', 'Invalid poster shape');
    assert(typeof movie.releaseInfo === 'string' && /^[0-9]{4}$/.test(movie.releaseInfo), 'Expected a release year');
    assert(typeof movie.description === 'string' && movie.description.trim(), 'Missing preview description');
  }
}
