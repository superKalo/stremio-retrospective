import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { assertCatalog, isRecord } from './catalog.ts';
import type { Catalog } from './catalog.ts';
import { catalogPath, localHost, maxSiteBytes, siteContentTypes } from './config.ts';
import { parseCalendarDate } from './dates.ts';

const publicDirectory = new URL('../public/', import.meta.url);

export type SiteOptions = {
  projectDirectory: string;
  baseUrl: string;
  effectiveDate: string;
  generatedAt: Date;
  sourceCommit: string;
  catalog: Catalog;
  tokenToExclude?: string;
  signal?: AbortSignal;
};

function assertManifest(value: unknown): void {
  assert(isRecord(value), 'Expected a manifest object');
  assert.deepEqual(Object.keys(value).sort(), [
    'catalogs', 'description', 'id', 'name', 'resources', 'types', 'version',
  ], 'Unexpected manifest fields');
  for (const field of ['description', 'id', 'name', 'version']) {
    const text = value[field];
    assert(typeof text === 'string' && text.trim(), `Missing manifest ${field}`);
  }
  assert.deepEqual(value.resources, ['catalog']);
  assert.deepEqual(value.types, ['movie']);
  assert(Array.isArray(value.catalogs) && value.catalogs.length === 1, 'Expected one catalog');
  const catalog: unknown = value.catalogs[0];
  assert(isRecord(catalog), 'Expected a catalog declaration');
  assert.deepEqual(Object.keys(catalog).sort(), ['id', 'name', 'type'], 'Unexpected catalog declaration fields');
  assert.equal(catalog.type, 'movie');
  assert.equal(catalog.id, 'today');
  assert(typeof catalog.name === 'string' && catalog.name.trim(), 'Missing catalog name');
}

export function installUrlForBuild(baseUrl: string, sourceCommit: string): URL {
  assert(sourceCommit === 'local' || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit),
    'Expected a full commit SHA or local');
  const base = new URL(baseUrl);
  assert(
    base.protocol === 'https:' ||
      (sourceCommit === 'local' && base.protocol === 'http:' && base.hostname === localHost),
    'Use an HTTPS site base or the local loopback URL',
  );
  assert(!base.username && !base.password && !base.search && !base.hash, 'Invalid site base URL');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL('manifest.json', base);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function renderLandingPage(installUrl: URL, effectiveDate: string): string {
  const url = escapeHtml(installUrl.href);
  const date = escapeHtml(effectiveDate);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Retrospective</title>
  <style>
    body { max-width: 42rem; margin: 3rem auto; padding: 0 1rem; font: 1rem/1.6 system-ui, sans-serif; }
    h1, h2 { line-height: 1.2; }
    code { overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <h1>Retrospective</h1>
    <p>A Stremio add-on for exploring film history.</p>
    <h2>Released on This Day</h2>
    <p>Discover films whose TMDB primary release date shares the same month and day in a past year.</p>
    <p>Catalog date (UTC) <time datetime="${date}">${date}</time></p>
    <h2>Install in Stremio</h2>
    <p>Paste this manifest URL into the Stremio add-on search field.</p>
    <p><a href="${url}"><code>${url}</code></a></p>
    <p><a href="https://github.com/superkalo/stremio-retrospective">Source code</a></p>
    <h2>About and credits</h2>
    <p><a href="https://www.themoviedb.org/"><img src="assets/tmdb-logo.svg" width="96" alt="The Movie Database"></a></p>
    <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
  </main>
</body>
</html>
`;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readStagedArtifact(directory: string, tokenToExclude?: string) {
  const allowed = Object.keys(siteContentTypes);
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    const fullPath = join(entry.parentPath, entry.name);
    const path = relative(directory, fullPath).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      assert(allowed.some((file) => file.startsWith(path + '/')), 'Unexpected artifact directory');
      continue;
    }
    assert(entry.isFile() && allowed.includes(path), 'Unexpected artifact file');
    const info = await lstat(fullPath);
    assert(info.isFile() && info.nlink === 1, 'Expected a regular artifact file');
    totalBytes += info.size;
    assert(totalBytes < maxSiteBytes, 'Site artifact must be smaller than 256 KiB');
    const bytes = await readFile(fullPath);
    assert(!tokenToExclude || !bytes.includes(tokenToExclude), 'Credential found in site artifact');
    files.set(path, bytes);
  }
  assert(files.size === allowed.length, 'Site artifact is missing required files');
  return files;
}

export async function writeSite(options: SiteOptions) {
  options.signal?.throwIfAborted();
  assertCatalog(options.catalog);
  parseCalendarDate(options.effectiveDate);
  const installUrl = installUrlForBuild(options.baseUrl, options.sourceCommit);
  const manifest = await readFile(new URL('manifest.json', publicDirectory), 'utf8');
  assertManifest(JSON.parse(manifest));
  const catalog = JSON.stringify(options.catalog, null, 2) + '\n';
  const status = {
    schemaVersion: 1,
    effectiveDate: options.effectiveDate,
    generatedAt: options.generatedAt.toISOString(),
    sourceCommit: options.sourceCommit,
    movieCount: options.catalog.metas.length,
    catalogSha256: sha256(catalog),
  };
  const statusJson = JSON.stringify(status, null, 2) + '\n';
  const landingPage = renderLandingPage(installUrl, options.effectiveDate);
  const destination = join(options.projectDirectory, 'dist');
  const lock = join(options.projectDirectory, '.dist-lock');

  await mkdir(lock);
  let stage: string | undefined;
  let keepBackup = false;
  try {
    stage = await mkdtemp(join(options.projectDirectory, '.dist-'));
    const site = join(stage, 'site');
    const backup = join(stage, 'previous');
    await mkdir(join(site, 'catalog/movie'), { recursive: true });
    await mkdir(join(site, 'assets'));
    await writeFile(join(site, 'manifest.json'), manifest);
    await writeFile(join(site, catalogPath), catalog);
    await writeFile(join(site, 'status.json'), statusJson);
    await writeFile(join(site, 'index.html'), landingPage);
    await copyFile(new URL('assets/tmdb-logo.svg', publicDirectory), join(site, 'assets/tmdb-logo.svg'));
    const files = await readStagedArtifact(site, options.tokenToExclude);
    assert(files.get('manifest.json')?.toString('utf8') === manifest, 'Staged manifest mismatch');
    assert(files.get('status.json')?.toString('utf8') === statusJson, 'Staged status mismatch');
    assert(files.get('index.html')?.toString('utf8') === landingPage, 'Staged landing page mismatch');
    assert(sha256(files.get(catalogPath)!) === status.catalogSha256, 'Staged catalog digest mismatch');
    options.signal?.throwIfAborted();

    let backedUp = false;
    try {
      await rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    }

    try {
      await rename(site, destination);
    } catch (error) {
      if (backedUp) {
        try {
          await rename(backup, destination);
        } catch (restoreError) {
          keepBackup = true;
          throw new AggregateError([error, restoreError], `Previous output is recoverable at ${backup}`);
        }
      }
      throw error;
    }
  } finally {
    try {
      if (stage && !keepBackup) await rm(stage, { recursive: true, force: true });
    } finally {
      await rmdir(lock);
    }
  }
  return status;
}
