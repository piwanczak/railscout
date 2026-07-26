# RailScout

RailScout is an independent, private-first search interface for PKP Intercity
trains. A single route search lists every matching direct train. When an
authorized seat-inventory adapter is connected, RailScout asks for every
possible station pair in one batch and computes the best complete seated route
locally for every passenger.

No timetable or seat request is sent through another consumer search website.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

The repository includes an attributed open-data timetable snapshot, so route
search works without credentials for dates covered by that snapshot. Copy
`.env.example` to `.env.local` to enable current official data or an authorized
seat adapter.

## Data providers

Timetables use the documented PKP PLK Open Railway Data API when `PLK_API_KEY`
is configured. Results are cached briefly to respect the official rate limits.
Without a key, the server uses the bundled PKP Intercity-only GTFS snapshot
created from PKP PLK open data and Mikołaj Kuranowski's reusable GTFS feed.

Live seat inventory is intentionally separate. PKP PLK publishes schedules,
not carrier booking inventory. RailScout therefore does not scrape a booking
site. Set both `SEAT_INVENTORY_API_URL` and `SEAT_INVENTORY_API_TOKEN` only when
you have permission to use an inventory service.

The adapter receives one versioned POST request containing the train,
preferences, and every directed station pair. It returns:

```json
{
  "offers": [
    {
      "passengerIndex": 1,
      "from": 33605,
      "to": 80416,
      "timeFrom": "2026-07-26T13:28:00+02:00",
      "timeTo": "2026-07-26T16:55:00+02:00",
      "price": 16900,
      "seated": true,
      "class": 2,
      "wagon": "7",
      "seat": "42",
      "hasBike": false,
      "hasQuiet": false
    }
  ]
}
```

`price` is expressed in grosze. RailScout validates the response and computes
the complete path itself, preferring fewer seat changes and then lower price.

## Refresh the offline snapshot

Download and extract `polish_trains.zip` from
[mkuran.pl/gtfs](https://mkuran.pl/gtfs/), then run:

```bash
npm run data:import -- /path/to/extracted/gtfs
```

The importer keeps rail services operated by PKP Intercity, regenerates the
station catalogue, embeds source attribution, and writes a compact snapshot.
It creates no runtime dependency on the feed host.

## Verify

```bash
npm run lint
npm test
```

Primary data documentation:

- [PKP PLK Open Data](https://www.plk-sa.pl/klienci-i-kontrahenci/api-otwarte-dane)
- [Open Railway Data API documentation](https://pdp-api.plk-sa.pl/api-documentation)
- [Polish trains GTFS](https://mkuran.pl/gtfs/)
