# Retrospective

A Stremio add-on for exploring film history, starting with release anniversaries.
Its first catalog, **Released on This Day**, is designed around TMDB primary release dates and a shared UTC calendar day.

## Local fixture

Use Node.js 24 and npm. The fixture build uses a fixed UTC date and a synthetic movie and IMDb ID. It exercises the Stremio catalog contract without a TMDB token.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run generate:fixture
npm run serve
```

The local manifest is at `http://127.0.0.1:7000/manifest.json` and the catalog is at `http://127.0.0.1:7000/catalog/movie/today.json`. The server binds to loopback.

To simulate a GitHub Pages project subpath:

```sh
npm run generate:fixture -- --base-url http://127.0.0.1:7000/stremio-retrospective/
npm run serve -- --base-path /stremio-retrospective/
```

Open `http://127.0.0.1:7000/stremio-retrospective/` for the install link and credits. See [the implementation plan](plan.md) for the live data pipeline and deployment phases.

## Generate with TMDB data

Set `TMDB_READ_ACCESS_TOKEN` in the local `.env` or process environment. `.env.example` lists the variable, and Git ignores local credentials. [TMDB authentication](https://developer.themoviedb.org/docs/authentication-application)

```sh
npm run generate
npm run serve
```

Generation uses the current UTC day by default. To test a past UTC day, run `npm run generate -- --date 2026-11-09`. The build reports counts and the catalog digest, validates the artifact, and then replaces `dist/`.

## Publish to GitHub Pages

1. Push `main` to the public repository `superkalo/stremio-retrospective`.
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. In **Settings → Environments**, create `catalog-generation` and add the environment secret `TMDB_READ_ACCESS_TOKEN`. Create `github-pages` there if needed. Restrict both environments to the `main` branch and leave required reviewers disabled for unattended runs.
4. In **Actions → Publish Retrospective**, select **Run workflow** on `main`. The run summary records the build date, counts, and catalog digest.

After the first successful publish, paste the [manifest URL](https://superkalo.github.io/stremio-retrospective/manifest.json) into the Stremio add-on search field. The install address and catalog path stay fixed through daily refreshes. [GitHub Pages workflow setup](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) · [GitHub environments and branch restrictions](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

## Refresh and recovery

The primary run is scheduled for 00:17 UTC. A catch-up run scheduled for 04:43 UTC checks the public manifest, catalog, and status against the current UTC day and the checked-out commit. A healthy snapshot skips generation. The post-deploy job checks the exact catalog digest and allows up to 15 minutes for the canonical URLs to catch up. GitHub Pages controls HTTP caching, and Stremio can keep a result within an existing session. Use a fresh session to check an updated catalog.

The [public status file](https://superkalo.github.io/stremio-retrospective/status.json) and landing page show the effective UTC date. A failed build leaves the last successful snapshot available. If catch-up misses a day, inspect the Actions run and dispatch **Publish Retrospective** from `main`. Revert a faulty release commit before dispatching again. Re-enable scheduled workflows if GitHub disabled them after repository inactivity. Enable Actions failure notifications and investigate if the public date is more than one UTC day behind. [GitHub Actions schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

Run the same freshness check from a checkout of the expected `main` commit.

```sh
npm run verify:live -- --probe \
  --base-url https://superkalo.github.io/stremio-retrospective/ \
  --date "$(date -u +%F)" --commit "$(git rev-parse HEAD)"
```

A probe reports `fresh: false` with a reason for a missing or stale deployment. For an exact post-deploy check, replace `--probe` with `--sha256 <digest>` from the build summary and use its date and commit. The exact check retries and exits unsuccessfully if the site never matches that build.

## Credits

This product uses the TMDB API but is not endorsed or certified by TMDB. [The Movie Database](https://www.themoviedb.org/) supplies movie data and poster artwork in the live add-on. The TMDB logo and third-party movie data and artwork remain subject to their respective terms. The project code and original assets are [MIT-licensed](LICENSE).
