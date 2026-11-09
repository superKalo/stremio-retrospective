export const localHost = '127.0.0.1';
export const localPort = 7000;
export const localBaseUrl = `http://${localHost}:${localPort}/`;
export const catalogPath = 'catalog/movie/today.json';
export const maxCatalogItems = 40;
export const minimumReleaseYear = 1950;
export const minimumVoteCount = 25;
export const maxDiscoveryPages = 3;
export const maxImdbLookups = 160;
export const imdbLookupBatchSize = 4;
export const tmdbLanguage = 'en-US';
export const tmdbImageBaseUrl = 'https://image.tmdb.org/t/p/';
export const tmdbPosterSize = 'w342';
export const maxSiteBytes = 256 * 1024;
export const generationTimeoutMs = 600_000;

export const siteContentTypes = {
  'index.html': 'text/html; charset=utf-8',
  'manifest.json': 'application/json; charset=utf-8',
  [catalogPath]: 'application/json; charset=utf-8',
  'status.json': 'application/json; charset=utf-8',
  'assets/tmdb-logo.svg': 'image/svg+xml',
} as const;
