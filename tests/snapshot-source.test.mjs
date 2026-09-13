import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const bundled = JSON.parse(await readFile(new URL("../app/data/ic-timetable.json", import.meta.url)));

test("runtime snapshot validation accepts the imported data and rejects missing service data", async () => {
  const { validSnapshot } = await import("../app/lib/snapshot-source.ts");
  assert.equal(validSnapshot(bundled), true);
  assert.equal(validSnapshot({ ...bundled, trips: [] }), false);
  assert.equal(validSnapshot({ ...bundled, serviceDates: {} }), false);
});

test("runtime snapshot refresh retains good data when the remote schema changes", async t => {
  const { currentSnapshot } = await import("../app/lib/snapshot-source.ts?invalid");
  t.mock.method(globalThis, "fetch", async () => Response.json({ unexpected: true }));
  const result = await currentSnapshot(bundled);
  assert.equal(result, bundled);
});

test("runtime snapshot refresh caches a validated response", async t => {
  const { currentSnapshot } = await import("../app/lib/snapshot-source.ts?valid");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(bundled); });
  const first = await currentSnapshot(bundled);
  assert.equal(first.validThrough, bundled.validThrough);
  await currentSnapshot(bundled);
  assert.equal(calls, 1);
});

test("a deployed expired snapshot is replaced without a new build", async t => {
  const { currentSnapshot } = await import("../app/lib/snapshot-source.ts?expired");
  const expired = { ...bundled, generatedAt: "2026-07-27T02:45:10Z", validFrom: "2026-07-25", validThrough: "2026-08-26" };
  t.mock.method(globalThis, "fetch", async () => Response.json(bundled));
  const result = await currentSnapshot(expired);
  assert.equal(result.validThrough, bundled.validThrough);
  assert.deepEqual(result.trips, bundled.trips);
});

test("an older remote snapshot cannot replace current timetable data", async t => {
  const { currentSnapshot } = await import("../app/lib/snapshot-source.ts?older");
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...bundled, generatedAt: "2026-07-27T02:45:10Z" }));
  assert.equal(await currentSnapshot(bundled), bundled);
});

