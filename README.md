# RailScout

RailScout is a private-first PKP Intercity seat-availability search. One query
checks every visible direct train against the carrier's live wagon maps. When a
through seat is unavailable, it evaluates every contiguous station-pair
combination and selects the complete route with the fewest ticket splits.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

The repository includes an attributed timetable snapshot for the dates covered
by the feed. Add `PLK_API_KEY` to `.env.local` to use current timetable data from
the PKP PLK Open Railway Data API.

## Seat availability

RailScout uses the read-only GRM composition and wagon-map endpoints exposed by
the current e-IC sales interface. For each train it:

1. Reads the train composition and the selected class's wagon maps.
2. Extracts the exact wagon and seat numbers currently marked free by e-IC.
3. If the through journey is full, reads every adjacent leg with bounded
   concurrency and intersects the same seat IDs across legs. This derives every
   possible contiguous split while avoiding a quadratic request sweep.
4. Builds the complete route with the fewest ticket splits, preferring plans
   with more spare seats.

Responses are cached briefly to avoid repeating identical checks. Seat numbers
are informational and are not held; e-IC confirms the final assignment during
purchase. `EIC_GRM_API_URL` can point tests or local development at a compatible
mock service and defaults to the official Intercity gateway.

The e-IC station-code mapping in `app/data/eic-stations.json` is generated from
the carrier's station catalogue. Purchase buttons open a route-and-time search
that places the selected connection first instead of sending visitors to the
portal home page.

## Timetable data

Timetables use the documented PKP PLK Open Railway Data API when `PLK_API_KEY`
is configured. Results are cached briefly. The fallback is the bundled PKP
Intercity-only GTFS snapshot created from PKP PLK open data and Mikołaj
Kuranowski's reusable GTFS feed.

To refresh the snapshot, download and extract `polish_trains.zip` from
[mkuran.pl/gtfs](https://mkuran.pl/gtfs/), then run:

```bash
npm run data:import -- /path/to/extracted/gtfs
```

## Verify

```bash
npm run lint
npm test
```

Primary references:

- [PKP PLK Open Data](https://www.plk-sa.pl/klienci-i-kontrahenci/api-otwarte-dane)
- [Open Railway Data API documentation](https://pdp-api.plk-sa.pl/api-documentation)
- [e-IC](https://ebilet.intercity.pl/)
- [Polish trains GTFS](https://mkuran.pl/gtfs/)
