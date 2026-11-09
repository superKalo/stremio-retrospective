import assert from 'node:assert/strict';
import {
  imdbLookupBatchSize, maxCatalogItems, maxImdbLookups, tmdbImageBaseUrl, tmdbPosterSize,
} from './config.ts';
import type { createTmdbClient, MovieCandidate } from './tmdb.ts';

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

export function isPosterPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/[a-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(value);
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
    const posterBase = tmdbImageBaseUrl + tmdbPosterSize;
    assert(typeof movie.poster === 'string' && movie.poster.startsWith(posterBase) &&
      isPosterPath(movie.poster.slice(posterBase.length)), 'Expected a canonical TMDB poster URL');
    assert.equal(movie.posterShape, 'poster', 'Invalid poster shape');
    assert(typeof movie.releaseInfo === 'string' && /^[0-9]{4}$/.test(movie.releaseInfo), 'Expected a release year');
    assert(typeof movie.description === 'string' && movie.description.trim(), 'Missing preview description');
  }
}

function compareText(first: string, second: string): number {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}

function compareCandidates(first: MovieCandidate, second: MovieCandidate): number {
  return second.popularity - first.popularity || second.voteCount - first.voteCount ||
    first.id - second.id || compareText(first.title, second.title) ||
    compareText(first.posterPath, second.posterPath);
}

type EnrichmentClient = Pick<ReturnType<typeof createTmdbClient>, 'imdbId' | 'posterConfiguration'>;

const releaseDateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric',
});

export async function buildCatalog(
  effectiveDate: string,
  candidates: readonly MovieCandidate[],
  client: EnrichmentClient,
) {
  const bestById = new Map<number, MovieCandidate>();
  const conflictingIds = new Set<number>();
  let duplicateTmdbRows = 0;
  for (const movie of candidates) {
    const previous = bestById.get(movie.id);
    if (previous) {
      duplicateTmdbRows++;
      if (previous.releaseDate !== movie.releaseDate) conflictingIds.add(movie.id);
    }
    if (!previous || compareCandidates(movie, previous) < 0) bestById.set(movie.id, movie);
  }
  const ranked = [...bestById.values()]
    .filter((movie) => !conflictingIds.has(movie.id))
    .sort(compareCandidates)
    .slice(0, maxImdbLookups);

  const selected = new Map<string, MovieCandidate>();
  let imdbLookups = 0;
  let missingImdbIds = 0;
  let duplicateImdbIds = 0;
  for (let index = 0; index < ranked.length && selected.size < maxCatalogItems; index += imdbLookupBatchSize) {
    const batch = ranked.slice(index, index + imdbLookupBatchSize);
    const ids = await Promise.all(batch.map((movie) => client.imdbId(movie.id)));
    imdbLookups += batch.length;
    for (const [position, id] of ids.entries()) {
      if (!id) missingImdbIds++;
      else if (selected.has(id)) duplicateImdbIds++;
      else if (selected.size < maxCatalogItems) selected.set(id, batch[position]);
    }
  }

  const catalog: Catalog = { metas: [] };
  if (selected.size > 0) {
    const { baseUrl, size } = await client.posterConfiguration();
    const currentYear = Number(effectiveDate.slice(0, 4));
    for (const [id, movie] of selected) {
      const year = movie.releaseDate.slice(0, 4);
      const years = currentYear - Number(year);
      const formattedDate = releaseDateFormat.format(new Date(movie.releaseDate + 'T00:00:00Z'));
      catalog.metas.push({
        id,
        type: 'movie',
        name: movie.title,
        poster: baseUrl + size + movie.posterPath,
        posterShape: 'poster',
        releaseInfo: year,
        description: `Released on ${formattedDate} (${years} ${years === 1 ? 'year' : 'years'} ago).`,
      });
    }
  }

  return {
    catalog, imdbLookups, missingImdbIds, duplicateImdbIds, duplicateTmdbRows,
    conflictingTmdbIds: conflictingIds.size,
  };
}
