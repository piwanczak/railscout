# Third-party notices

The MIT license in `LICENSE` covers RailScout's original source code and
project-specific visual assets. It does not relicense upstream data, trademarks,
fonts, or dependencies.

## Timetable and station snapshot

The following bundled files are processed extracts of the `polish_trains.zip`
GTFS feed:

- `app/data/ic-timetable.json`
- `public/stations.json`

Exact source: PKP Polskie Linie Kolejowe S.A. timetable data distributed in the
[Polish Trains GTFS feed](https://mkuran.pl/gtfs/polish_trains.zip) prepared by
Mikołaj Kuranowski.

- Source generation time reported by the feed: `2026-09-20 02:45:38`
- Acquisition time: `2026-09-20T08:37:58.320Z`
- Processing time: `2026-09-23T08:37:33.968Z`
- Processing performed by RailScout: PKP Intercity trips and their service
  dates, stops, platforms, and tracks were selected and converted into compact
  JSON; no claim is made that PKP PLK or the GTFS maintainer approved the
  resulting application.

Reuse remains subject to the
[PKP PLK public-sector information reuse terms](https://bip.plk-sa.pl/ponowne-wykorzystywanie).
Those terms require the exact source, creation/acquisition time, and the fact of
processing to be stated. The feed is supplied without warranty; PKP PLK and the
feed maintainer are not responsible for RailScout's processing, availability,
correctness, timeliness, completeness, or quality.

## e-IC station identifiers

`app/data/eic-stations.json` is a compact, processed mapping of numeric station
identifiers exposed by the PKP Intercity e-IC station catalogue and acquired on
`2026-07-26`. It contains numeric identifiers only. It is not relicensed under
MIT, and no rights in PKP Intercity names, services, databases, or trademarks
are granted by this repository.

Live composition and wagon-map responses are requested at runtime, cached for
at most 90 seconds, and are not committed to or redistributed with the source
repository.

## Fonts

The application bundles Bitter and Oswald through `next/font/local`. Both
families are distributed under the SIL Open Font License 1.1 and are self-hosted
in the compiled application; the site makes no runtime request to Google Fonts.

- Bitter: Copyright 2011 The Bitter Project Authors. See the
  [bundled license text](app/fonts/Bitter-OFL.txt) and the
  [official Google Fonts source](https://github.com/google/fonts/tree/main/ofl/bitter).
- Oswald: Copyright 2016 The Oswald Project Authors. See the
  [bundled license text](app/fonts/Oswald-OFL.txt) and the
  [official Google Fonts source](https://github.com/google/fonts/tree/main/ofl/oswald).

## JavaScript dependencies

Installed packages retain their own licenses. Exact versions and declared SPDX
license expressions are recorded in `package-lock.json`; `npm run
licenses:check` fails when a dependency lacks license metadata or uses a
non-standard/restricted expression requiring manual review.
