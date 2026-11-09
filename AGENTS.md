# Retrospective project guide

## Product and compatibility

- Retrospective is a free, noncommercial, open-source Stremio add-on in `superkalo/stremio-retrospective`. The add-on name is deliberately broad so later releases can add other film-history catalogs. Its first catalog is **Released on This Day**.
- Keep the manifest ID `io.github.superkalo.retrospective`, catalog ID `today`, and public [manifest URL](https://superkalo.github.io/stremio-retrospective/manifest.json) stable. Stremio resolves `catalog/movie/today.json` relative to the manifest's GitHub Pages project subpath.
- The current add-on serves one native `movie` catalog, with a single `{ "metas": [...] }` response. Use IMDb title IDs (`tt…`) so Stremio can hand off movie details to Cinemeta and streams to installed providers such as Torrentio. Keep resources catalog-only and leave search, filters, and pagination out of the manifest unless the project explicitly adds those routes.
- Serve the manifest and catalog as direct HTTPS JSON responses with wildcard CORS in production. Keep GitHub Pages and the static JSON architecture unless a requested feature requires changing it.

## Catalog rules

- The effective day is UTC. Match the month and day of TMDB's **primary release date** from 1950 through the previous year. February 29 matches historical leap years only. Leave `region` and `with_release_type` unset.
- Require at least 25 TMDB votes, a usable TMDB poster, and a valid IMDb title ID. Exclude adult and video entries. Sort by TMDB popularity descending, vote count descending, then TMDB ID ascending. Deduplicate TMDB and IMDb IDs and discard TMDB IDs with conflicting release dates.
- Keep the current bounds in `src/config.ts`. Discover reads at most three pages per year, enrichment checks at most 160 TMDB candidates for IMDb IDs in batches of four, and the catalog has at most 40 movies. Reuse the shared TMDB client's rate limits, deadlines, and retry handling. An empty catalog is valid after a successful run.

## Code and verification

- Use Node.js 24, npm, and strict TypeScript ESM with explicit `.ts` imports. Node runs the source directly. Keep the checked-in lockfile and prefer built-in Node APIs.
- `src/generate.ts` orchestrates the build. `src/dates.ts`, `src/tmdb.ts`, and `src/catalog.ts` handle dates, TMDB requests, and selection. `src/site.ts` validates and promotes the artifact. `src/serve.ts` is the loopback preview server, and `src/verify-live.ts` checks deployed snapshots.
- The public artifact consists of `index.html`, `manifest.json`, `catalog/movie/today.json`, `status.json`, and `assets/tmdb-logo.svg`. Stage and validate before replacing `dist/`. Preserve the previous valid catalog if generation fails. Keep generated output and raw TMDB responses out of Git.
- For changes, run the checks below. The tests and fixture build use synthetic TMDB responses and need no credentials. Use a scratch checkout for the fixture build if the local server is already serving a real catalog, because both generation commands replace `dist/`.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run generate:fixture
```

- Use `npm run generate` for a real local build and `npm run serve` to preview it on port 7000. Local generation can take `--date YYYY-MM-DD` for a past UTC day. See [README.md](README.md) for the project-subpath preview and live verifier commands.

## Deployment and credentials

- Read `TMDB_READ_ACCESS_TOKEN` from the ignored local `.env` or the process environment. In GitHub, the secret lives in the `catalog-generation` environment and is passed only to the generation step. Keep token values out of chats, logs, committed files, and the artifact.
- [CI](.github/workflows/ci.yml) runs without secrets. [Publish Retrospective](.github/workflows/publish.yml) runs from `main` at **00:17 UTC**, with a catch-up check at **04:43 UTC**. The catch-up skips generation only when the public snapshot matches the UTC date and source commit and its catalog count and digest agree. Keep official actions pinned to full SHAs. Restrict `catalog-generation` and `github-pages` to `main`.
- Before deploying, the workflow rechecks the UTC day and current head of `main`. After deployment it checks the canonical URLs and exact catalog digest. Use the [public status file](https://superkalo.github.io/stremio-retrospective/status.json) and Actions runs to diagnose stale data. Once the underlying problem is fixed, dispatch **Publish Retrospective** from `main`. Allow for GitHub scheduling delays, Pages caching, and Stremio session caching.
- Keep the approved TMDB logo and attribution on the landing page and preserve the credits in the README. The MIT license covers project code and original assets.
