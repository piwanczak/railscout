import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { everySegment, findSeatPlans } from "../app/lib/seat-planner.mjs";

const templateRoot = new URL("../", import.meta.url);
const previewRoot = new URL("../app/_sites-preview/", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
    }),
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

test("server-renders the independent RailScout search experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>RailScout — wszystkie miejsca w jednym wyszukaniu<\/title>/i);
  assert.match(html, /Jedno wyszukanie/);
  assert.match(html, /Wszystkie miejsca/);
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

test("checks every segment and chooses the fewest-change seated plan", () => {
  const stationIds = [10, 20, 30, 40];
  assert.deepEqual(everySegment(stationIds), [
    { from: 10, to: 20 },
    { from: 10, to: 30 },
    { from: 10, to: 40 },
    { from: 20, to: 30 },
    { from: 20, to: 40 },
    { from: 30, to: 40 },
  ]);

  const plan = findSeatPlans({
    stationIds,
    passengerCount: 1,
    ticketClass: 2,
    bike: false,
    quietZone: false,
    offers: [
      { passengerIndex: 1, from: 10, to: 20, price: 1000, seated: true, class: 2 },
      { passengerIndex: 1, from: 20, to: 40, price: 1000, seated: true, class: 2 },
      { passengerIndex: 1, from: 10, to: 40, price: 3000, seated: true, class: 2 },
    ],
  });

  assert.equal(plan?.length, 1);
  assert.deepEqual(
    plan?.[0].tickets.map(({ from, to }) => ({ from, to })),
    [{ from: 10, to: 40 }],
  );
});
