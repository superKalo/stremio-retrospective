import { createHash } from 'node:crypto';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { assertCatalog, isRecord } from './catalog.ts';
import { catalogPath, maxCatalogItems } from './config.ts';
import { parseCalendarDate } from './dates.ts';
import { installUrlForBuild } from './site.ts';
import expectedManifest from '../public/manifest.json' with { type: 'json' };

const stremioOrigin = 'https://web.stremio.com';
const digestPattern = /^[0-9a-f]{64}$/;
const requestTimeoutMs = 8_000;

type Target = {
  baseUrl: string;
  effectiveDate: string;
  sourceCommit: string;
  catalogSha256?: string;
};

type CacheHeaders = {
  cacheControl: string | null;
  age: string | null;
  etag: string | null;
};

type Status = {
  effectiveDate: string;
  sourceCommit: string;
  movieCount: number;
  catalogSha256: string;
};

type Verification = ({ fresh: true } & Status | { fresh: false; reason: string }) & {
  cache: Record<string, CacheHeaders>;
};

function prepare(target: Target) {
  parseCalendarDate(target.effectiveDate);
  if (target.catalogSha256 !== undefined && !digestPattern.test(target.catalogSha256)) {
    throw new Error('Expected a lowercase SHA-256 catalog digest');
  }
  return { ...target, base: new URL('.', installUrlForBuild(target.baseUrl, target.sourceCommit)) };
}

function parseJson(body: Buffer, path: string): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

function parseStatus(body: Buffer): Status {
  const value = parseJson(body, 'status.json');
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.effectiveDate !== 'string' ||
      typeof value.sourceCommit !== 'string' || typeof value.catalogSha256 !== 'string' ||
      !digestPattern.test(value.catalogSha256) || typeof value.movieCount !== 'number' ||
      !Number.isInteger(value.movieCount) || value.movieCount < 0 || value.movieCount > maxCatalogItems ||
      typeof value.generatedAt !== 'string') {
    throw new Error('status.json has invalid fields');
  }
  const generatedAt = new Date(value.generatedAt);
  if (!Number.isFinite(generatedAt.getTime()) || generatedAt.toISOString() !== value.generatedAt) {
    throw new Error('status.json has an invalid UTC timestamp');
  }
  return {
    effectiveDate: value.effectiveDate, sourceCommit: value.sourceCommit,
    catalogSha256: value.catalogSha256, movieCount: value.movieCount,
  };
}

async function inspect(
  target: ReturnType<typeof prepare>,
  includeSite: boolean,
  transport: typeof fetch,
  timeoutMs: number,
): Promise<Verification> {
  const cache: Record<string, CacheHeaders> = {};
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);

  async function get(path: string, mime: string, stremio = false): Promise<Buffer> {
    let response: Response;
    try {
      const url = path === 'index.html' ? target.base : new URL(path, target.base);
      response = await transport(url, {
        redirect: 'manual',
        signal,
        headers: stremio ? { Origin: stremioOrigin } : undefined,
      });
    } catch {
      throw new Error(`${path} could not be reached`);
    }
    cache[path] = {
      cacheControl: response.headers.get('cache-control'),
      age: response.headers.get('age'),
      etag: response.headers.get('etag'),
    };
    if (response.status !== 200) throw new Error(`${path} returned HTTP ${response.status}`);
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== mime) {
      throw new Error(`${path} has an unexpected content type`);
    }
    if (stremio && response.headers.get('access-control-allow-origin') !== '*') {
      throw new Error(`${path} is missing wildcard CORS`);
    }
    try {
      return Buffer.from(await response.arrayBuffer());
    } catch {
      throw new Error(`${path} could not be read`);
    }
  }

  try {
    const [manifest, catalogBody, statusBody, landingPage, logo] = await Promise.all([
      get('manifest.json', 'application/json', true),
      get(catalogPath, 'application/json', true),
      get('status.json', 'application/json'),
      includeSite ? get('index.html', 'text/html') : undefined,
      includeSite ? get('assets/tmdb-logo.svg', 'image/svg+xml') : undefined,
    ]);

    if (!isDeepStrictEqual(parseJson(manifest, 'manifest.json'), expectedManifest)) {
      throw new Error('manifest.json does not match this checkout');
    }
    const status = parseStatus(statusBody);
    if (status.effectiveDate !== target.effectiveDate) throw new Error('Catalog effective date is stale');
    if (status.sourceCommit !== target.sourceCommit) throw new Error('Catalog source commit does not match');
    if (target.catalogSha256 !== undefined && status.catalogSha256 !== target.catalogSha256) {
      throw new Error('Catalog digest does not match the deployed build');
    }
    if (createHash('sha256').update(catalogBody).digest('hex') !== status.catalogSha256) {
      throw new Error('Catalog bytes do not match status.json');
    }
    const catalog = parseJson(catalogBody, catalogPath);
    try {
      assertCatalog(catalog);
    } catch {
      throw new Error('Catalog does not match the movie preview contract');
    }
    if (catalog.metas.length !== status.movieCount) throw new Error('Catalog count does not match status.json');

    if (landingPage && !landingPage.toString('utf8').includes(`datetime="${target.effectiveDate}"`)) {
      throw new Error('Landing page does not display the catalog date');
    }
    if (logo && !/^\s*<svg(?:\s|>)/.test(logo.toString('utf8'))) {
      throw new Error('TMDB logo is not an SVG');
    }

    return { fresh: true, ...status, cache };
  } catch (error) {
    return { fresh: false, reason: error instanceof Error ? error.message : 'Verification failed', cache };
  } finally {
    controller.abort();
  }
}

export function probeLive(target: Target, transport = fetch): Promise<Verification> {
  return inspect(prepare(target), false, transport, requestTimeoutMs);
}

export async function verifyLive(
  target: Target & { catalogSha256: string },
  options: {
    transport?: typeof fetch;
    maxWaitMs?: number;
    retryIntervalMs?: number;
    onAttempt?: (result: Verification) => void;
  } = {},
): Promise<Verification> {
  const prepared = prepare(target);
  const deadline = performance.now() + (options.maxWaitMs ?? 15 * 60_000);
  let result: Verification;
  do {
    const budget = Math.max(1, Math.ceil(deadline - performance.now()));
    result = await inspect(prepared, true, options.transport ?? fetch, Math.min(budget, requestTimeoutMs));
    options.onAttempt?.(result);
    if (result.fresh) return result;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(remaining, options.retryIntervalMs ?? 30_000));
  } while (performance.now() < deadline);
  return result;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        'base-url': { type: 'string' },
        date: { type: 'string' },
        commit: { type: 'string' },
        sha256: { type: 'string' },
        probe: { type: 'boolean', default: false },
      },
    });
    if (!values['base-url'] || !values.date || !values.commit || (!values.probe && !values.sha256)) {
      throw new Error('Provide --base-url, --date, --commit, and either --probe or --sha256');
    }
    const target = {
      baseUrl: values['base-url'], effectiveDate: values.date, sourceCommit: values.commit,
    };
    if (values.probe) {
      console.log(JSON.stringify(await probeLive({ ...target, catalogSha256: values.sha256 })));
    } else {
      const result = await verifyLive({ ...target, catalogSha256: values.sha256! }, {
        onAttempt: (attempt) => console.log(JSON.stringify(attempt)),
      });
      if (!result.fresh) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Verification failed');
    process.exitCode = 1;
  }
}
