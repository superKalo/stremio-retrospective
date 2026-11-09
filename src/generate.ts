import { parseArgs } from 'node:util';
import { buildCatalog } from './catalog.ts';
import { generationTimeoutMs, localBaseUrl } from './config.ts';
import { effectiveUtcDate, historicalDates } from './dates.ts';
import { installUrlForBuild, writeSite } from './site.ts';
import type { SiteOptions } from './site.ts';
import { createTmdbClient } from './tmdb.ts';

type TmdbClient = ReturnType<typeof createTmdbClient>;

export async function generateSite(options: Omit<SiteOptions, 'catalog'>, client: TmdbClient) {
  const started = performance.now();
  options.signal?.throwIfAborted();
  installUrlForBuild(options.baseUrl, options.sourceCommit);
  const dates = historicalDates(options.effectiveDate);
  const discoveries = await Promise.all(dates.map((date) => client.discover(date)));
  const candidates = discoveries.flatMap((discovery) => discovery.candidates);
  const skipped: Record<string, number> = {};
  const cappedDates: string[] = [];
  let pagesFetched = 0;
  for (const [index, discovery] of discoveries.entries()) {
    pagesFetched += discovery.pagesFetched;
    if (discovery.capped) cappedDates.push(dates[index]);
    for (const [reason, count] of Object.entries(discovery.skipped)) {
      skipped[reason] = (skipped[reason] ?? 0) + count;
    }
  }

  const { catalog, ...selection } = await buildCatalog(options.effectiveDate, candidates, client);
  const status = await writeSite({ ...options, catalog });
  return {
    ...status,
    yearsAttempted: dates.length,
    pagesFetched,
    cappedDates,
    candidates: candidates.length,
    skipped,
    ...selection,
    ...client.stats,
    elapsedMs: Math.round(performance.now() - started),
  };
}

async function fixtureFetch(effectiveDate: string): Promise<typeof fetch> {
  const { default: fixtures } = await import('../test/fixtures/tmdb.json', { with: { type: 'json' } });
  const pages: Record<string, Record<string, unknown>> = fixtures.discover;
  const ids: Record<string, unknown> = fixtures.externalIds;
  const expectedDates = new Set(historicalDates(effectiveDate));

  return async (input) => {
    const url = new URL(String(input));
    if (url.origin === 'https://api.themoviedb.org') {
      if (url.pathname === '/3/discover/movie') {
        const date = url.searchParams.get('primary_release_date.gte');
        const page = url.searchParams.get('page');
        if (date && expectedDates.has(date) && date === url.searchParams.get('primary_release_date.lte') && page) {
          if (Object.hasOwn(pages, date) && Object.hasOwn(pages[date], page)) {
            return Response.json(pages[date][page]);
          }
          if (!Object.hasOwn(pages, date) && page === '1') {
            return Response.json({ page: 1, total_pages: 0, results: [] });
          }
        }
      }
      if (url.pathname === '/3/configuration') return Response.json(fixtures.configuration);
      const externalId = /^\/3\/movie\/([0-9]+)\/external_ids$/.exec(url.pathname)?.[1];
      if (externalId && Object.hasOwn(ids, externalId)) return Response.json(ids[externalId]);
    }
    throw new Error('Unexpected TMDB fixture request');
  };
}

async function main(): Promise<void> {
  const now = new Date();
  const signal = AbortSignal.timeout(generationTimeoutMs);
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string', default: localBaseUrl },
      commit: { type: 'string' },
      date: { type: 'string' },
      fixture: { type: 'boolean', default: false },
    },
  });
  if (values.fixture && (values.date !== undefined || values.commit !== undefined)) {
    throw new Error('Fixture mode uses a fixed date and local build identity');
  }
  if (values.commit !== undefined && values.date !== undefined) {
    throw new Error('A release build must use the current UTC day');
  }

  const generatedAt = values.fixture ? new Date('2026-11-09T00:17:00.000Z') : now;
  const effectiveDate = effectiveUtcDate(generatedAt, values.date);
  const token = values.fixture ? 'fixture-token' : (process.env.TMDB_READ_ACCESS_TOKEN ?? '').trim();
  const client = createTmdbClient({
    token,
    fetch: values.fixture ? await fixtureFetch(effectiveDate) : undefined,
    signal,
  });
  const summary = await generateSite({
    projectDirectory: process.cwd(),
    baseUrl: values['base-url'],
    effectiveDate,
    generatedAt,
    sourceCommit: values.commit ?? 'local',
    tokenToExclude: token,
    signal,
  }, client);
  console.log(JSON.stringify(summary));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Catalog generation failed');
    process.exitCode = 1;
  }
}
