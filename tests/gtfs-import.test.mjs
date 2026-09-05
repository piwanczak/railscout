import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { importFeed } from "../scripts/import-open-gtfs.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "railscout-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputRoot = path.join(root, "output");
  await mkdir(path.join(outputRoot, "public"), { recursive: true });
  await writeFile(path.join(outputRoot, "THIRD_PARTY_NOTICES.md"), "test");
  const files = {
    "routes.txt": "route_id,route_short_name\nIC_TLK,TLK\n",
    "trips.txt": "trip_id,route_id,service_id,trip_short_name\ntrain,IC_TLK,service,123\n",
    "calendar_dates.txt": "service_id,date,exception_type\nservice,20260905,1\n",
    "attributions.txt": "attribution_id,organization_name\nPLK,PLK (2026-09-05 02:00:00)\n",
    "stops.txt": "stop_id,stop_name,parent_station\n33605,Warszawa,\n33605_P1,Warszawa peron 1,33605\n80416,Kraków,\n80416_FALLBACK,Kraków,80416\n",
    "stop_times.txt": "trip_id,stop_id,arrival_time,departure_time\ntrain,33605_P1,23:00:00,23:00:00\ntrain,80416_FALLBACK,25:00:00,25:00:00\n",
  };
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  return { root, outputRoot };
}

test("GTFS platform stops resolve to parent station identifiers", async t => {
  const { root, outputRoot } = await fixture(t);
  await importFeed(root, { outputRoot });
  const data = JSON.parse(await readFile(path.join(outputRoot, "app/data/ic-timetable.json")));
  assert.deepEqual(data.trips[0].stops.map(stop => stop[0]), [33605, 80416]);
  assert.equal(data.trips[0].stops[1][1], 1500);
  assert.equal(data.stations.length, 2);
});

test("an empty import leaves the previous data intact", async t => {
  const { root, outputRoot } = await fixture(t);
  await importFeed(root, { outputRoot });
  const file = path.join(outputRoot, "app/data/ic-timetable.json");
  const before = await readFile(file, "utf8");
  await writeFile(path.join(root, "stop_times.txt"), "trip_id,stop_id,arrival_time,departure_time\n");
  await assert.rejects(importFeed(root, { outputRoot }), /no usable Intercity timetable/);
  assert.equal(await readFile(file, "utf8"), before);
});
