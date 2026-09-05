import assert from "node:assert/strict";
import test from "node:test";
import { boardingServices, gtfsTimestamp, warsawClock, warsawDate } from "../app/lib/rail-time.mjs";
import { parseGrmSeatMap } from "../app/lib/eic-availability.mjs";

test("boarding after midnight uses the previous service date", () => {
  assert.deepEqual(boardingServices(["2026-09-04", "2026-09-05"], "2026-09-05", 1503), ["2026-09-04"]);
  assert.equal(gtfsTimestamp("2026-09-04", 1503), "2026-09-04T23:03:00.000Z");
  assert.equal(warsawDate("2026-09-04T23:03:00Z"), "2026-09-05");
});

test("rail times use Warsaw time and the GTFS noon anchor at clock changes", () => {
  assert.equal(warsawClock("2026-01-10", 600), "2026-01-10T09:00:00.000Z");
  assert.equal(warsawClock("2026-07-10", 600), "2026-07-10T08:00:00.000Z");
  assert.equal(gtfsTimestamp("2026-03-29", 240), "2026-03-29T02:00:00.000Z");
  assert.equal(gtfsTimestamp("2026-10-25", 240), "2026-10-25T03:00:00.000Z");
  assert.throws(() => warsawClock("2026-03-29", 150), /zmiany czasu/);
});

test("unknown seat statuses and partial maps cannot prove no seats", () => {
  const parse = body => parseGrmSeatMap(`<svg>${body}</svg>`, { wagon: "3", ticketClass: 2, bike: false });
  const group = status => `<g aria-label="Miejsce 11 klasa 2"><image class="place" status="${status}" /></g>`;
  assert.equal(parse(group("3")).complete, true);
  assert.equal(parse(group("new-status")).complete, false);
  assert.equal(parse(group("3") + '<g aria-label="Miejsce 12 klasa 2"><text>changed</text></g>').complete, false);
});
