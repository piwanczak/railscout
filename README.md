# RailScout

RailScout is a private-first PKP Intercity seat-availability search. One query
checks every visible direct train and every station-pair combination, then
selects the complete route with the fewest ticket splits and the lowest peak
occupancy.

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

RailScout uses the availability signal exposed by the current e-IC sales
interface. For each train it:

1. Generates every directed station pair on the requested route.
2. Checks the selected class or bicycle-place inventory with bounded
   concurrency.
3. Stops the sweep immediately when the carrier reports a service outage or
   rate limit.
4. Builds the best complete route from segments below 100% occupancy.

Responses are cached briefly to avoid repeating identical checks. Results use
the same occupancy bands as e-IC: high availability up to 40%, moderate up to
80%, low below 100%, and unavailable at 100%.

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
