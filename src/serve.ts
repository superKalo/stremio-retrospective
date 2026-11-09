import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isRecord } from './catalog.ts';
import { localHost, localPort, siteContentTypes } from './config.ts';

export function createSiteServer(directory: string, basePath = '/') {
  if (!/^\/(?:[a-zA-Z0-9-]+\/)*$/.test(basePath)) {
    throw new Error('Base path must start and end with /, such as /stremio-retrospective/');
  }

  return createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    const pathname = (request.url ?? '').split('?', 1)[0];
    const relative = pathname.slice(basePath.length) || 'index.html';
    if (!pathname.startsWith(basePath) || !Object.hasOwn(siteContentTypes, relative)) {
      response.writeHead(404).end();
      return;
    }

    try {
      const body = await readFile(join(directory, relative));
      response.writeHead(200, {
        'Content-Type': siteContentTypes[relative as keyof typeof siteContentTypes],
        'Content-Length': body.byteLength,
      }).end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const status = isRecord(error) && error.code === 'ENOENT' ? 404 : 500;
      response.writeHead(status).end();
    }
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { 'base-path': { type: 'string', default: '/' } },
  });
  const basePath = values['base-path'];
  const server = createSiteServer(resolve('dist'), basePath);
  server.listen(localPort, localHost, () => {
    console.log(`Retrospective fixture: http://${localHost}:${localPort}${basePath}manifest.json`);
  });
}
