import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
  deriveExactSegmentOutcomes,
  parseGrmSeatMap,
  summariseExactAvailability,
} from "../app/lib/eic-availability.mjs";
import {
  everySegment,
  findAvailabilityPlan,
} from "../app/lib/seat-planner.mjs";

const templateRoot = new URL("../", import.meta.url);
const previewRoot = new URL("../app/_sites-preview/", import.meta.url);
const mockGrmRequests = [];

function wagonSvg(places) {
  return `<svg xmlns="http://www.w3.org/2000/svg">${places
    .map(
      ({ seat, status, extra = "korytarz" }) =>
        `<g data-class="second class" aria-label="Miejsce ${seat} klasa 2, ${extra}, ${status === "1" ? "Wolne" : "Zajęte"}, niewybrane"><image class="place" status="${status}"></image><text class="seatNum">${seat}</text></g>`,
    )
    .join("")}</svg>`;
}

const composition = {
  wagony: [3],
  wagonyUdogodnienia: { 3: ["302"] },
  wagonyNiedostepne: [],
  klasa1: [],
  klasa2: [3],
  wagonySchemat: { 3: "2061,WITHOUT_COMPARTMENTS" },
};

const mockGrmServer = createServer((request, response) => {
  mockGrmRequests.push({
    url: request.url,
    receivedAt: Date.now(),
    appVersion: request.headers["app-version"],
    appVersionMarker: request.headers["app-version-1.5.20"],
    contentType: request.headers["content-type"],
    authorization: request.headers.authorization,
    origin: request.headers.origin,
    referer: request.headers.referer,
    userAgent: request.headers["user-agent"],
    secFetchSite: request.headers["sec-fetch-site"],
  });

  if (request.url?.includes("/IC/9999/")) {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "maintenance" }));
    return;
  }

  if (request.url?.includes("/IC/6666/")) {
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(composition));
    }, 250);
    return;
  }

  if (
    request.url?.includes("/IC/8888/") &&
    request.url.includes("/sklad/wbnet/")
  ) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ unexpected: true }));
    return;
  }

  if (request.url?.includes("/sklad/wbnet/")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(composition));
    return;
  }

  if (request.url?.includes("/wagon/svg/wbnet/")) {
    if (request.url.includes("/IC/7777/")) {
      response.writeHead(200, { "Content-Type": "image/svg+xml" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg"><g><text>changed format</text></g></svg>');
      return;
    }
    const isDirectWarsawKrakow = request.url.endsWith("/5100136/5100051");
    const isReferenceTrain = request.url.includes("/IC/5330/");
    const places = isReferenceTrain
      ? [
          { seat: "104", status: "1" },
          { seat: "108", status: "3" },
        ]
      : isDirectWarsawKrakow
        ? [{ seat: "104", status: "3" }]
        : request.url.endsWith("/5100136/5100753")
          ? [
              { seat: "104", status: "1" },
              { seat: "108", status: "1" },
            ]
          : [{ seat: "104", status: "1" }];
    response.writeHead(200, { "Content-Type": "image/svg+xml" });
    response.end(wagonSvg(places));
    return;
  }

  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});

await new Promise((resolve) => mockGrmServer.listen(0, "127.0.0.1", resolve));
const mockGrmAddress = mockGrmServer.address();
assert.ok(mockGrmAddress && typeof mockGrmAddress !== "string");
process.env.EIC_GRM_API_URL =
  `http://127.0.0.1:${mockGrmAddress.port}/grm`;
process.env.EIC_GRM_API_TOKEN = "test-relay-token-with-at-least-32-characters";
process.env.EIC_GRM_REQUEST_TIMEOUT_MS = "80";
process.env.EIC_GRM_MIN_INTERVAL_MS = "20";
after(
  () =>
    new Promise((resolve, reject) =>
      mockGrmServer.close((error) => (error ? reject(error) : resolve())),
    ),
);

async function appFetch(path = "/", init) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, init),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function render() {
  return appFetch("/", {
    headers: { accept: "text/html", host: "localhost" },
  });
}

test("server-renders the exact-seat RailScout search experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const html = await response.text();
  assert.match(html, /<title>RailScout — dostępność miejsc we wszystkich połączeniach<\/title>/i);
  assert.match(html, /Jedno wyszukanie/);
  assert.match(html, /Wszystkie kombinacje/);
  assert.match(html, /Numery wagonów i miejsc/);
  assert.match(html, /Znajdź wszystkie połączenia/);
  assert.match(html, /Warszawa Centralna/);
  assert.match(html, /Kraków Główny/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive"/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("ships independent data and no consumer-site endpoint", async () => {
  const [
    page,
    layout,
    packageJson,
    stations,
    trainsRoute,
    seatsRoute,
    seatProvider,
    seatApp,
    timetable,
  ] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../public/stations.json", import.meta.url), "utf8"),
    readFile(new URL("../app/api/trains/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/availability/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/seat-provider.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/seat-sweep-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/data/ic-timetable.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /SeatSweepApp/);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /socialImage/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  const stationCatalogue = JSON.parse(stations);
  assert.ok(stationCatalogue.length > 500);
  assert.ok(
    stationCatalogue.every(
      (station) =>
        Number.isInteger(station.id) &&
        typeof station.name === "string" &&
        Object.keys(station).every((key) => ["id", "name"].includes(key)),
    ),
  );
  assert.ok(JSON.parse(timetable).trips.length > 3000);
  assert.doesNotMatch(
    `${trainsRoute}\n${seatsRoute}\n${seatProvider}`,
    /placefinder\.pl|\/api\/koleo/i,
  );
  assert.match(seatProvider, /api-gateway\.intercity\.pl\/grm/);
  assert.match(seatProvider, /OUTBOUND_INTERVAL_MILLISECONDS/);
  assert.match(seatApp, /AVAILABILITY_RETRY_DELAY_MS = 1_000/);
  assert.match(seatApp, /for \(const \[index, train\] of candidates\.entries\(\)\)/);
  await assert.rejects(access(previewRoot));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../app/lib/timetable.ts", import.meta.url));
  await access(new URL("../app/lib/seat-planner.mjs", import.meta.url));
  await access(new URL("../app/seat-sweep-app.tsx", import.meta.url));
  await access(templateRoot);
});

test("ships complete open-source metadata and visible data provenance", async () => {
  const [packageText, license, notices, security, provenance, socialImage] =
    await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../LICENSE", import.meta.url), "utf8"),
      readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8"),
      readFile(new URL("../SECURITY.md", import.meta.url), "utf8"),
      readFile(new URL("../app/data/provenance.json", import.meta.url), "utf8").then(JSON.parse),
      readFile(new URL("../public/og.png", import.meta.url)),
    ]);
  const packageManifest = JSON.parse(packageText);

  assert.equal(packageManifest.license, "MIT");
  assert.equal(
    packageManifest.repository.url,
    "git+https://github.com/piwanczak/railscout.git",
  );
  assert.match(license, /^MIT License/m);
  assert.match(notices, /PKP PLK public-sector information reuse terms/);
  assert.match(notices, new RegExp(provenance.timetable.sourceGeneratedAt));
  assert.match(security, /private vulnerability-reporting/i);
  assert.equal(socialImage.readUInt32BE(16), 1200);
  assert.equal(socialImage.readUInt32BE(20), 630);

  for (const removedStarterPath of [
    "../app/chatgpt-auth.ts",
    "../db/index.ts",
    "../drizzle.config.ts",
    "../examples/d1/db/schema.ts",
    "../public/file.svg",
  ]) {
    await assert.rejects(access(new URL(removedStarterPath, import.meta.url)));
  }

  const legalResponse = await appFetch("/dane-i-licencje", {
    headers: { accept: "text/html", host: "localhost" },
  });
  assert.equal(legalResponse.status, 200);
  const legalHtml = await legalResponse.text();
  assert.match(legalHtml, /Dane i licencje/);
  assert.match(legalHtml, new RegExp(provenance.timetable.sourceGeneratedAt));
  assert.match(legalHtml, /nie jest powiązany z PKP Intercity/i);
});

test("parses concrete GRM places and excludes occupied or specialised seats", () => {
  const svg = wagonSvg([
    { seat: "104", status: "1" },
    { seat: "108", status: "3" },
    { seat: "112", status: "1", extra: "miejsce na rower" },
    { seat: "116", status: "1", extra: "wózek inwalidzki" },
  ]);
  const regular = parseGrmSeatMap(svg, {
    wagon: 3,
    ticketClass: 2,
    bike: false,
  });
  assert.deepEqual(
    regular?.seats.map(({ wagon, seat }) => ({ wagon, seat })),
    [{ wagon: "3", seat: "104" }],
  );
  assert.equal(regular?.eligiblePlaces, 2);

  const bicycle = parseGrmSeatMap(svg, {
    wagon: 3,
    ticketClass: 2,
    bike: true,
  });
  assert.deepEqual(bicycle?.seats.map((seat) => seat.seat), ["112"]);
});

test("derives every combination by intersecting the same exact seat", () => {
  const stationStops = [
    { id: 10, arrival: "a", departure: "a" },
    { id: 20, arrival: "b", departure: "b" },
    { id: 30, arrival: "c", departure: "c" },
    { id: 40, arrival: "d", departure: "d" },
  ];
  const seat = (value) => ({ wagon: "3", seat: String(value), label: "free" });
  const outcomes = deriveExactSegmentOutcomes({
    stationStops,
    numberOfPassengers: 1,
    legInventories: [
      { state: "available", seats: [seat(1), seat(2)] },
      { state: "available", seats: [seat(2), seat(3)] },
      { state: "available", seats: [seat(2), seat(4)] },
    ],
    directOutcome: {
      from: 10,
      to: 40,
      fromIndex: 0,
      toIndex: 3,
      timeFrom: "a",
      timeTo: "d",
      state: "unavailable",
      seats: [],
      freeSeats: 0,
    },
  });

  assert.deepEqual(everySegment([10, 20, 30, 40]), [
    { from: 10, to: 20 },
    { from: 10, to: 30 },
    { from: 10, to: 40 },
    { from: 20, to: 30 },
    { from: 20, to: 40 },
    { from: 30, to: 40 },
  ]);
  assert.equal(outcomes.length, 6);
  assert.deepEqual(
    outcomes.find((outcome) => outcome.from === 10 && outcome.to === 30)?.seats.map((item) => item.seat),
    ["2"],
  );
  assert.equal(
    outcomes.find((outcome) => outcome.from === 10 && outcome.to === 40)?.state,
    "unavailable",
    "the carrier's explicit through-route result wins over a derived result",
  );

  const summary = summariseExactAvailability({
    stationIds: [10, 20, 30, 40],
    outcomes,
  });
  assert.equal(summary.status, "available");
  assert.equal(summary.segments.length, 2);
  assert.equal(summary.totalSegments, 6);
});

test("the planner prefers one ticket, then the plan with more spare seats", () => {
  const direct = findAvailabilityPlan({
    stationIds: [10, 20, 40],
    segments: [
      { from: 10, to: 20, timeFrom: "a", timeTo: "b", freeSeats: 9, seats: [] },
      { from: 20, to: 40, timeFrom: "b", timeTo: "d", freeSeats: 9, seats: [] },
      { from: 10, to: 40, timeFrom: "a", timeTo: "d", freeSeats: 1, seats: [] },
    ],
  });
  assert.deepEqual(
    direct?.map(({ from, to }) => ({ from, to })),
    [{ from: 10, to: 40 }],
  );

  const split = findAvailabilityPlan({
    stationIds: [10, 20, 30, 40],
    segments: [
      { from: 10, to: 20, timeFrom: "a", timeTo: "b", freeSeats: 1, seats: [] },
      { from: 20, to: 40, timeFrom: "b", timeTo: "d", freeSeats: 1, seats: [] },
      { from: 10, to: 30, timeFrom: "a", timeTo: "c", freeSeats: 4, seats: [] },
      { from: 30, to: 40, timeFrom: "c", timeTo: "d", freeSeats: 3, seats: [] },
    ],
  });
  assert.deepEqual(
    split?.map(({ from, to }) => ({ from, to })),
    [
      { from: 10, to: 30 },
      { from: 30, to: 40 },
    ],
  );
});

test("the planner handles routes that visit the same station twice", () => {
  const plan = findAvailabilityPlan({
    stationIds: [10, 20, 10, 40],
    segments: [
      {
        from: 10,
        to: 10,
        fromIndex: 0,
        toIndex: 2,
        timeFrom: "a",
        timeTo: "c",
        freeSeats: 3,
        seats: [],
      },
      {
        from: 10,
        to: 40,
        fromIndex: 2,
        toIndex: 3,
        timeFrom: "c",
        timeTo: "d",
        freeSeats: 2,
        seats: [],
      },
    ],
  });

  assert.deepEqual(
    plan?.map(({ fromIndex, toIndex }) => ({ fromIndex, toIndex })),
    [
      { fromIndex: 0, toIndex: 2 },
      { fromIndex: 2, toIndex: 3 },
    ],
  );
});

test("returns connection-specific e-IC links and a safe unknown inventory state", async () => {
  const trainsResponse = await appFetch("/api/trains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startStationId: 33605,
      endStationId: 80416,
      startDateTime: "2026-07-26T13:00:00+02:00",
    }),
  });
  assert.equal(trainsResponse.status, 200);
  const trainsPayload = await trainsResponse.json();
  assert.ok(trainsPayload.trains.length > 0);
  const booking = new URL(trainsPayload.trains[0].bookingUrl);
  assert.equal(booking.hostname, "ebilet.intercity.pl");
  assert.equal(booking.pathname, "/wyszukiwanie");
  assert.equal(booking.searchParams.get("swyj"), "242");
  assert.equal(booking.searchParams.get("sprzy"), "85");
  assert.notEqual(booking.searchParams.get("time"), null);

  const availabilityResponse = await appFetch("/api/availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "IC",
      trainNumber: "1234",
      stationStops: [
        { id: 999001, arrival: "2026-07-26T13:00:00+02:00", departure: "2026-07-26T13:00:00+02:00" },
        { id: 999002, arrival: "2026-07-26T14:00:00+02:00", departure: "2026-07-26T14:00:00+02:00" },
      ],
      numberOfPassengers: 1,
      ticketClass: 2,
      bike: false,
    }),
  });
  assert.equal(availabilityResponse.status, 200);
  const availabilityPayload = await availabilityResponse.json();
  assert.equal(availabilityPayload.status, "unknown");
  assert.equal(availabilityPayload.totalSegments, 1);
  assert.equal(availabilityPayload.unknownSegments, 1);
});

test("availability API returns the exact reference seat from official-style GRM maps", async () => {
  mockGrmRequests.length = 0;
  const response = await appFetch("/api/availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "IC",
      trainNumber: "5330",
      stationStops: [
        { id: 33605, arrival: "2026-07-27T10:08:00+02:00", departure: "2026-07-27T10:08:00+02:00" },
        { id: 80416, arrival: "2026-07-27T14:39:00+02:00", departure: "2026-07-27T14:39:00+02:00" },
      ],
      numberOfPassengers: 1,
      ticketClass: 2,
      bike: false,
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "available");
  assert.equal(payload.inventorySource, "PKP Intercity GRM");
  assert.equal(payload.minimumFreeSeats, 1);
  assert.deepEqual(payload.segments[0].seats[0], {
    wagon: "3",
    seat: "104",
    label: "Miejsce 104 klasa 2, korytarz, Wolne, niewybrane",
  });
  assert.equal(mockGrmRequests.length, 2);
  assert.ok(
    mockGrmRequests.every(
      (request) =>
        request.url?.includes("/grm/") &&
        request.appVersion === "1.5.20" &&
        request.appVersionMarker === "" &&
        request.contentType === "application/json" &&
        request.authorization ===
          "Bearer test-relay-token-with-at-least-32-characters" &&
        request.origin === "https://ebilet.intercity.pl" &&
        request.referer === "https://ebilet.intercity.pl/" &&
        request.userAgent?.includes("Chrome/150.0.0.0") &&
        request.secFetchSite === "same-site",
    ),
  );
});

test("availability API checks the full route, derives every pair, and returns a split", async () => {
  mockGrmRequests.length = 0;
  const response = await appFetch("/api/availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "IC",
      trainNumber: "1234/5",
      stationStops: [
        { id: 33605, arrival: "2026-07-26T13:00:00+02:00", departure: "2026-07-26T13:00:00+02:00" },
        { id: 64899, arrival: "2026-07-26T14:30:00+02:00", departure: "2026-07-26T14:32:00+02:00" },
        { id: 80416, arrival: "2026-07-26T16:00:00+02:00", departure: "2026-07-26T16:00:00+02:00" },
      ],
      numberOfPassengers: 1,
      ticketClass: 2,
      bike: false,
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "available");
  assert.equal(payload.totalSegments, 3);
  assert.equal(payload.checkedSegments, 3);
  assert.equal(payload.unknownSegments, 0);
  assert.equal(payload.segments.length, 2);
  assert.deepEqual(
    payload.segments.map((segment) => segment.seats[0].seat),
    ["104", "104"],
  );
  assert.equal(payload.minimumFreeSeats, 1);
  assert.equal(mockGrmRequests.length, 6);
  assert.ok(
    mockGrmRequests.slice(1).every(
      (request, index) =>
        request.receivedAt - mockGrmRequests[index].receivedAt >= 10,
    ),
  );
  assert.ok(
    mockGrmRequests.some((request) =>
      request.url?.includes("/sklad/wbnet/IC/1234/202607261600/5100136/202607261300/5100051"),
    ),
  );
});

test("carrier outages stay unknown instead of becoming false sold-out results", async () => {
  mockGrmRequests.length = 0;
  const response = await appFetch("/api/availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "IC",
      trainNumber: "9999",
      stationStops: [
        { id: 33605, arrival: "2026-07-26T13:00:00+02:00", departure: "2026-07-26T13:00:00+02:00" },
        { id: 64899, arrival: "2026-07-26T14:30:00+02:00", departure: "2026-07-26T14:32:00+02:00" },
        { id: 80416, arrival: "2026-07-26T16:00:00+02:00", departure: "2026-07-26T16:00:00+02:00" },
      ],
      numberOfPassengers: 1,
      ticketClass: 2,
      bike: false,
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "unknown");
  assert.equal(payload.checkedSegments, 0);
  assert.equal(payload.unknownSegments, 3);
  assert.equal(payload.totalSegments, 3);
  assert.match(payload.message, /PKP Intercity/i);
  assert.equal(payload.retryable, true);
  assert.equal(payload.retryAfterMs, 1_000);
  assert.equal(mockGrmRequests.length, 1);
});

test("slow carrier calls stop at the upstream deadline and ask for one fresh retry", async () => {
  mockGrmRequests.length = 0;
  const startedAt = Date.now();
  const response = await appFetch("/api/availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "IC",
      trainNumber: "6666",
      stationStops: [
        { id: 33605, arrival: "2026-07-27T10:08:00+02:00", departure: "2026-07-27T10:08:00+02:00" },
        { id: 80416, arrival: "2026-07-27T14:39:00+02:00", departure: "2026-07-27T14:39:00+02:00" },
      ],
      numberOfPassengers: 1,
      ticketClass: 2,
      bike: false,
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "unknown");
  assert.equal(payload.retryable, true);
  assert.equal(payload.retryAfterMs, 1_000);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(mockGrmRequests.length, 1);
});

test("malformed carrier payloads stay unknown instead of becoming sold out", async () => {
  for (const trainNumber of ["7777", "8888"]) {
    const response = await appFetch("/api/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "IC",
        trainNumber,
        stationStops: [
          {
            id: 33605,
            arrival: "2026-07-27T10:08:00+02:00",
            departure: "2026-07-27T10:08:00+02:00",
          },
          {
            id: 80416,
            arrival: "2026-07-27T14:39:00+02:00",
            departure: "2026-07-27T14:39:00+02:00",
          },
        ],
        numberOfPassengers: 1,
        ticketClass: 2,
        bike: false,
      }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "unknown");
  }
});

test("API input failures are bounded, explicit, and never cached", async () => {
  const malformed = await appFetch("/api/availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("cache-control"), "no-store");

  const wrongType = await appFetch("/api/trains", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);

  const nullBody = await appFetch("/api/trains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "null",
  });
  assert.equal(nullBody.status, 400);

  const oversized = await appFetch("/api/trains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(70_000) }),
  });
  assert.equal(oversized.status, 413);

  const backwards = await appFetch("/api/availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "IC",
      trainNumber: "1234",
      stationStops: [
        {
          id: 33605,
          arrival: "2026-07-27T12:00:00+02:00",
          departure: "2026-07-27T12:00:00+02:00",
        },
        {
          id: 80416,
          arrival: "2026-07-27T11:00:00+02:00",
          departure: "2026-07-27T11:00:00+02:00",
        },
      ],
      numberOfPassengers: 1,
      ticketClass: 2,
      bike: false,
    }),
  });
  assert.equal(backwards.status, 400);
});

test("local preview serves the hydrated UI and seat API on one origin", async (context) => {
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const address = portProbe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) =>
    portProbe.close((error) => (error ? reject(error) : resolve())),
  );

  const output = [];
  const errors = [];
  const preview = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/preview-server.mjs", import.meta.url)),
      "--port",
      String(port),
    ],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  preview.stdout.on("data", (chunk) => output.push(chunk.toString()));
  preview.stderr.on("data", (chunk) => errors.push(chunk.toString()));
  context.after(async () => {
    if (preview.exitCode === null) {
      preview.kill();
      await once(preview, "exit");
    }
  });

  let pageResponse;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      pageResponse = await fetch(`http://127.0.0.1:${port}/`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(
    pageResponse,
    `Preview did not start. stdout: ${output.join("")} stderr: ${errors.join("")}`,
  );
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  const clientEntry = html.match(
    /\/(?:assets|_next\/static\/chunks)\/[A-Za-z0-9._~-]+\.js/,
  )?.[0];
  assert.ok(clientEntry, "Rendered page should reference its hydration bundle");

  const assetResponse = await fetch(`http://127.0.0.1:${port}${clientEntry}`);
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers.get("content-type") ?? "", /javascript/i);
  assert.ok((await assetResponse.arrayBuffer()).byteLength > 10_000);

  const availabilityResponse = await fetch(
    `http://127.0.0.1:${port}/api/availability`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "IC",
        trainNumber: "5330",
        stationStops: [
          {
            id: 33605,
            arrival: "2026-07-27T10:08:00+02:00",
            departure: "2026-07-27T10:08:00+02:00",
          },
          {
            id: 80416,
            arrival: "2026-07-27T14:39:00+02:00",
            departure: "2026-07-27T14:39:00+02:00",
          },
        ],
        numberOfPassengers: 1,
        ticketClass: 2,
        bike: false,
      }),
    },
  );
  assert.equal(availabilityResponse.status, 200);
  const availability = await availabilityResponse.json();
  assert.equal(availability.status, "available");
  assert.equal(availability.inventorySource, "PKP Intercity GRM");
  assert.deepEqual(availability.segments[0].seats[0], {
    wagon: "3",
    seat: "104",
    label: "Miejsce 104 klasa 2, korytarz, Wolne, niewybrane",
  });

  const oversizedResponse = await fetch(
    `http://127.0.0.1:${port}/api/trains`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(70_000) }),
    },
  );
  assert.equal(oversizedResponse.status, 413);
});
