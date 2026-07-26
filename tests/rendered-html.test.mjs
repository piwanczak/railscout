import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test, { after } from "node:test";
import {
  occupancyFromFrequency,
  summariseAvailability,
} from "../app/lib/eic-availability.mjs";
import {
  everySegment,
  findAvailabilityPlan,
} from "../app/lib/seat-planner.mjs";

const templateRoot = new URL("../", import.meta.url);
const previewRoot = new URL("../app/_sites-preview/", import.meta.url);
const mockAvailabilityRequests = [];
const mockAvailabilityServer = createServer((request, response) => {
  mockAvailabilityRequests.push({
    url: request.url,
    appVersion: request.headers["app-version"],
    origin: request.headers.origin,
    referer: request.headers.referer,
  });
  if (request.url?.includes("/IC/9999/")) {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "maintenance" }));
    return;
  }
  const isFullWarsawKrakow =
    request.url?.includes("/5100136/5100051/") ?? false;
  const occupancyPercent = isFullWarsawKrakow ? 100 : 34;
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      CLASS1: [{ type: "COMMON", occupancyPercent }],
      CLASS2: [
        { type: "COMMON", occupancyPercent },
        { type: "BIKE", occupancyPercent: Math.min(99, occupancyPercent + 10) },
      ],
    }),
  );
});
await new Promise((resolve) =>
  mockAvailabilityServer.listen(0, "127.0.0.1", resolve),
);
const mockAvailabilityAddress = mockAvailabilityServer.address();
assert.ok(mockAvailabilityAddress && typeof mockAvailabilityAddress !== "string");
process.env.EIC_AVAILABILITY_API_URL =
  `http://127.0.0.1:${mockAvailabilityAddress.port}`;
after(
  () =>
    new Promise((resolve, reject) =>
      mockAvailabilityServer.close((error) => (error ? reject(error) : resolve())),
    ),
);

async function appFetch(path = "/", init) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
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

test("server-renders the independent RailScout search experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>RailScout — dostępność miejsc we wszystkich połączeniach<\/title>/i);
  assert.match(html, /Jedno wyszukanie/);
  assert.match(html, /Wszystkie kombinacje/);
  assert.match(html, /Znajdź wszystkie połączenia/);
  assert.match(html, /Warszawa Centralna/);
  assert.match(html, /Kraków Główny/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("ships the independent timetable snapshot and no consumer-site endpoint", async () => {
  const [page, layout, packageJson, stations, trainsRoute, seatsRoute, timetable] =
    await Promise.all([
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../public/stations.json", import.meta.url), "utf8"),
      readFile(new URL("../app/api/trains/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/availability/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/data/ic-timetable.json", import.meta.url), "utf8"),
    ]);

  assert.match(page, /SeatSweepApp/);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /socialImage/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.ok(JSON.parse(stations).length > 500);
  assert.ok(JSON.parse(timetable).trips.length > 3000);
  assert.doesNotMatch(`${trainsRoute}\n${seatsRoute}`, /placefinder\.pl|\/api\/koleo/i);
  await assert.rejects(access(previewRoot));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../app/lib/timetable.ts", import.meta.url));
  await access(new URL("../app/lib/seat-planner.mjs", import.meta.url));
  await access(new URL("../app/seat-sweep-app.tsx", import.meta.url));
  await access(templateRoot);
});

test("checks every station pair and chooses the fewest-split availability plan", () => {
  const stationIds = [10, 20, 30, 40];
  assert.deepEqual(everySegment(stationIds), [
    { from: 10, to: 20 },
    { from: 10, to: 30 },
    { from: 10, to: 40 },
    { from: 20, to: 30 },
    { from: 20, to: 40 },
    { from: 30, to: 40 },
  ]);

  const plan = findAvailabilityPlan({
    stationIds,
    segments: [
      { from: 10, to: 20, timeFrom: "a", timeTo: "b", occupancyPercent: 15 },
      { from: 20, to: 40, timeFrom: "b", timeTo: "d", occupancyPercent: 20 },
      { from: 10, to: 40, timeFrom: "a", timeTo: "d", occupancyPercent: 95 },
    ],
  });

  assert.equal(plan?.length, 1, "a complete single ticket wins over a split");
  assert.deepEqual(
    plan?.map(({ from, to }) => ({ from, to })),
    [{ from: 10, to: 40 }],
  );
});

test("parses e-IC class and bicycle occupancy without cross-falling back", () => {
  const payload = {
    CLASS1: [{ type: "COMMON", occupancyPercent: 18 }],
    CLASS2: [
      { type: "COMMON", occupancyPercent: 63.4 },
      { type: "BIKE", occupancyPercent: 92 },
    ],
  };

  assert.equal(occupancyFromFrequency(payload, 2, false), 63.4);
  assert.equal(occupancyFromFrequency(payload, 2, true), 92);
  assert.equal(occupancyFromFrequency(payload, 1, true), null);
  assert.equal(occupancyFromFrequency({ CLASS2: [] }, 2, false), null);
});

test("falls back to a complete split and keeps partial data unknown", () => {
  const stationIds = [10, 20, 40];
  const split = summariseAvailability({
    stationIds,
    outcomes: [
      { from: 10, to: 20, timeFrom: "a", timeTo: "b", state: "available", occupancyPercent: 25 },
      { from: 10, to: 40, timeFrom: "a", timeTo: "d", state: "unavailable", occupancyPercent: 100 },
      { from: 20, to: 40, timeFrom: "b", timeTo: "d", state: "available", occupancyPercent: 70 },
    ],
  });
  assert.equal(split.status, "available");
  assert.equal(split.segments.length, 2);
  assert.equal(split.peakOccupancy, 70);
  assert.equal(split.checkedSegments, 3);

  const partial = summariseAvailability({
    stationIds,
    outcomes: [
      { from: 10, to: 20, timeFrom: "a", timeTo: "b", state: "available", occupancyPercent: 25 },
      { from: 10, to: 40, timeFrom: "a", timeTo: "d", state: "unavailable", occupancyPercent: 100 },
      { from: 20, to: 40, timeFrom: "b", timeTo: "d", state: "unknown" },
    ],
  });
  assert.equal(partial.status, "unknown");
  assert.equal(partial.unknownSegments, 1);
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
      uuid: "test-train-1",
      category: "IC",
      trainNumber: "1234",
      startDateTime: "2026-07-26T13:00:00+02:00",
      arrivalDateTime: "2026-07-26T14:00:00+02:00",
      stationStops: [
        { id: 999001, arrival: "2026-07-26T13:00:00+02:00", departure: "2026-07-26T13:00:00+02:00" },
        { id: 999002, arrival: "2026-07-26T14:00:00+02:00", departure: "2026-07-26T14:00:00+02:00" },
      ],
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

test("availability API exhaustively checks every pair and returns a working split", async () => {
  mockAvailabilityRequests.length = 0;
  const response = await appFetch("/api/availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      uuid: "test-train-available",
      category: "IC",
      trainNumber: "1234/5",
      startDateTime: "2026-07-26T13:00:00+02:00",
      arrivalDateTime: "2026-07-26T16:00:00+02:00",
      stationStops: [
        { id: 33605, arrival: "2026-07-26T13:00:00+02:00", departure: "2026-07-26T13:00:00+02:00" },
        { id: 64899, arrival: "2026-07-26T14:30:00+02:00", departure: "2026-07-26T14:32:00+02:00" },
        { id: 80416, arrival: "2026-07-26T16:00:00+02:00", departure: "2026-07-26T16:00:00+02:00" },
      ],
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
  assert.equal(payload.segments.length, 2, "the full route is full, so two available legs are selected");
  assert.equal(payload.peakOccupancy, 34);
  assert.equal(mockAvailabilityRequests.length, 3);
  assert.ok(
    mockAvailabilityRequests.every(
      (request) =>
        request.url?.startsWith("/IC/1234/") &&
        request.appVersion === "1.5.20" &&
        request.origin === "https://ebilet.intercity.pl" &&
        request.referer === "https://ebilet.intercity.pl/",
    ),
  );
});

test("carrier outages stay unknown instead of becoming false sold-out results", async () => {
  mockAvailabilityRequests.length = 0;
  const response = await appFetch("/api/availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      uuid: "test-train-outage",
      category: "IC",
      trainNumber: "9999",
      startDateTime: "2026-07-26T13:00:00+02:00",
      arrivalDateTime: "2026-07-26T16:00:00+02:00",
      stationStops: [
        { id: 33605, arrival: "2026-07-26T13:00:00+02:00", departure: "2026-07-26T13:00:00+02:00" },
        { id: 64899, arrival: "2026-07-26T14:30:00+02:00", departure: "2026-07-26T14:32:00+02:00" },
        { id: 80416, arrival: "2026-07-26T16:00:00+02:00", departure: "2026-07-26T16:00:00+02:00" },
      ],
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
});
