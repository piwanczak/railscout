# Contributing

RailScout welcomes focused fixes and well-tested improvements.

## Development

1. Use Node.js 22.13 or newer and npm 10.
2. Run `npm ci`.
3. Use `npm run dev` while editing, or `npm run preview` for the complete
   production-style local path.
4. Run `npm run check` before submitting a change.

Tests must not depend on live carrier services. Extend the local GRM mock for
new seat-map behavior, and keep at least one manual live check for release
verification.

## Data changes

Do not commit timetable or station data without a reproducible source and an
updated `app/data/provenance.json` plus `THIRD_PARTY_NOTICES.md`. Preserve every
upstream attribution and reuse condition. Never commit an API key, cookie,
credential, or captured customer data.

## Pull requests

Keep changes small, explain the user-visible effect and root cause, and add a
regression test for every bug fix. Treat `unknown` inventory as unknown: an
upstream parsing or network failure must never be presented as sold out.
