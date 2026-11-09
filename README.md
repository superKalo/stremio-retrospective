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

## Credits

This product uses the TMDB API but is not endorsed or certified by TMDB. [The Movie Database](https://www.themoviedb.org/) supplies movie data and poster artwork in the live add-on. The TMDB logo and third-party movie data and artwork remain subject to their respective terms. The project code and original assets are [MIT-licensed](LICENSE).
