# RailScout

RailScout is an independent PKP Intercity timetable and exact
seat-availability explorer. One search checks every visible direct train. If a
seat is not free for the full journey, RailScout evaluates every contiguous
station-pair combination and chooses a complete route with the fewest ticket
splits.

The project is an experimental private beta. It is not affiliated with,
endorsed by, or operated by PKP Intercity or PKP Polskie Linie Kolejowe.

## What it does

- searches a documented PKP PLK timetable API or a bundled attributed snapshot;
- reads current e-IC composition and wagon maps without reserving inventory;
- reports exact wagon and seat numbers instead of a guessed availability flag;
- distinguishes upstream failure (`unknown`) from a confirmed lack of seats;
- checks split-ticket options by intersecting the same seat across adjacent
  route legs; and
- opens e-IC with the route, date, and time of the selected connection.

Seat availability is informational and can change immediately. e-IC remains
the source of truth during purchase.

## Requirements

- Node.js 22.13 or newer
- npm 10

## Local development

```bash
npm ci
npm run dev
```

For a production-style local run, including the same-origin browser assets and
server-side carrier requests:

```bash
npm run preview
```

The preview listens on `http://127.0.0.1:3001` by default. To use a different
port, build first and then run `npm run start -- --port 3100`.

## Configuration

Copy `.env.example` to `.env.local` and set only the values you need:

- `PLK_API_KEY` enables the official live timetable API. Obtain a key directly
  from PKP PLK and keep it server-side.
- `EIC_GRM_API_URL` overrides the e-IC seat-map root for tests or compatible
  development services. Production defaults to the current Intercity gateway.
- `EIC_APP_VERSION` overrides the tested e-IC request-contract version when the
  official portal rolls forward before a RailScout release.

Without `PLK_API_KEY`, the app uses the bundled snapshot only for the validity
window recorded in that file. Download and import the current feed with:

```bash
npm run data:refresh
```

The refresh command keeps a content-addressed archive under `.cache/gtfs`, sends
conditional `ETag`/`Last-Modified` requests, and leaves generated files untouched
when the upstream feed has not changed. It retries transient failures and keeps
the last verified local archive available when working offline. Use
`npm run data:refresh -- --require-fresh` when an unavailable upstream must fail
the run instead of falling back to the cache.

An already extracted feed can still be imported directly:

```bash
npm run data:import -- /path/to/extracted/polish_trains
```

The source feed is `polish_trains.zip` from
[mkuran.pl/gtfs](https://mkuran.pl/gtfs/).

The `Refresh GTFS snapshot` GitHub Actions workflow runs daily, restores the
conditional-download cache, validates the complete project, and commits only
changed generated data and provenance. `npm run data:check` also rejects a
snapshot with less than seven days of validity remaining; set
`GTFS_MIN_VALIDITY_DAYS` only when intentionally changing that release gate.
Hosted Sites releases are immutable, so a newly committed snapshot becomes live
there with the next private Sites deployment. Supplying `PLK_API_KEY` avoids that
deployment cadence by using the official live timetable API at runtime.

## Verification

```bash
npm run check
npm run security:audit
```

`npm run check` runs linting, TypeScript validation, a production build,
unit/integration tests, data-provenance checks, and dependency-license checks.
Tests use a local carrier mock and do not consume live inventory.

Before a release, also perform one manual search against current Intercity data
through the built application. A carrier response-format change must produce
`unknown`, never a false sold-out result.

## Operational notes

The e-IC composition and wagon-map interface is public and read-only but not a
documented, versioned developer API. It can change or become unavailable without
notice. RailScout therefore uses short bounded caches, deduplicates identical
requests, limits outbound concurrency, and treats malformed responses as
unknown. Deployments should remain behind access control or an external rate
limit until their traffic profile has been agreed with the provider.

## Data, dependencies, and licensing

RailScout's original code and visual assets are released under the
[MIT License](LICENSE). Bundled timetable data, station identifiers, fonts, and
dependencies keep their upstream terms; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the in-app data-and-license
page for exact provenance.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.
