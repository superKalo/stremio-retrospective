import { parseArgs } from 'node:util';
import type { Catalog } from './catalog.ts';
import { localBaseUrl } from './config.ts';
import { effectiveUtcDate } from './dates.ts';
import { writeSite } from './site.ts';

export const fixtureCatalog: Catalog = {
  metas: [{
    id: 'tt0000000',
    type: 'movie',
    name: 'Retrospective Fixture Movie',
    poster: 'https://image.tmdb.org/t/p/w342/uVEFQvFMMsg4e6yb03xOfVsDz4o.jpg',
    posterShape: 'poster',
    releaseInfo: '2001',
    description: 'Released on 9 November 2001 (25 years ago).',
  }],
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: { 'base-url': { type: 'string', default: localBaseUrl } },
  });
  const generatedAt = new Date('2026-11-09T00:17:00.000Z');
  const effectiveDate = effectiveUtcDate(generatedAt);

  await writeSite({
    projectDirectory: process.cwd(),
    baseUrl: values['base-url'],
    effectiveDate,
    generatedAt,
    sourceCommit: 'local',
    catalog: fixtureCatalog,
  });
  console.log(`Generated fixture in dist/ for ${effectiveDate} UTC.`);
}
