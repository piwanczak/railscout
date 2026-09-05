import type { TimetableSnapshot } from "./timetable";

const DEFAULT_SOURCE = "https://raw.githubusercontent.com/piwanczak/railscout/master/app/data/ic-timetable.json";
const MAX_BYTES = 8 * 1024 * 1024;
let cached: TimetableSnapshot | undefined;
let nextCheckAt = 0;
let pending: Promise<TimetableSnapshot> | undefined;

export function validSnapshot(value: unknown): value is TimetableSnapshot {
  if (!value || typeof value !== "object") return false;
  const data = value as TimetableSnapshot;
  const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
  return data.schemaVersion === 1 && date(data.validFrom) && date(data.validThrough) &&
    data.validFrom <= data.validThrough && typeof data.generatedAt === "string" &&
    Number.isFinite(Date.parse(data.generatedAt)) &&
    Array.isArray(data.sources) && data.sources.length > 0 &&
    data.sources.every(source => typeof source.name === "string" && typeof source.url === "string" && source.url.startsWith("https://")) &&
    !!data.serviceDates && typeof data.serviceDates === "object" && !Array.isArray(data.serviceDates) &&
    Object.values(data.serviceDates).every(dates => Array.isArray(dates) && dates.length > 0 && dates.every(date)) &&
    (data.stations === undefined || (Array.isArray(data.stations) && data.stations.length > 0 && data.stations.every(station =>
      Number.isInteger(station.id) && station.id > 0 && typeof station.name === "string" && station.name.length > 0))) &&
    Array.isArray(data.trips) && data.trips.length > 0 && data.trips.length <= 20000 &&
    data.trips.every(trip => typeof trip.id === "string" && typeof trip.service === "string" &&
      typeof trip.category === "string" && typeof trip.number === "string" && typeof trip.name === "string" &&
      Array.isArray(data.serviceDates[trip.service]) && Array.isArray(trip.stops) && trip.stops.length >= 2 &&
      trip.stops.length <= 1000 && trip.stops.every((stop, i) => Array.isArray(stop) && stop.length === 5 &&
        Number.isInteger(stop[0]) && stop[0] > 0 && Number.isFinite(stop[1]) && stop[1] >= 0 &&
        Number.isFinite(stop[2]) && stop[2] >= stop[1] && stop[2] <= 10080 &&
        typeof stop[3] === "string" && typeof stop[4] === "string" &&
        (i === 0 || stop[1] >= trip.stops[i - 1][2])));
}

// A validated repository update reaches immutable deployments without a new build.
export async function currentSnapshot(bundled: TimetableSnapshot): Promise<TimetableSnapshot> {
  cached ??= bundled;
  const source = process.env.TIMETABLE_SNAPSHOT_URL?.trim() ?? DEFAULT_SOURCE;
  if (source === "off" || Date.now() < nextCheckAt) return cached;
  if (pending) return pending;
  pending = (async () => {
    try {
      const url = new URL(source);
      if (url.protocol !== "https:") throw new Error("Snapshot source requires HTTPS");
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error(`Snapshot source returned ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Snapshot source has no body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Snapshot source is too large"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!validSnapshot(data)) throw new Error("Snapshot source has invalid timetable data");
      if (Date.parse(data.generatedAt) > Date.now() + 86400000) throw new Error("Snapshot generation date is in the future");
      if (Date.parse(data.generatedAt) >= Date.parse(cached!.generatedAt)) cached = data;
      nextCheckAt = Date.now() + 3600000;
      console.info(JSON.stringify({ event: "snapshot_refresh", status: "ok", validThrough: cached!.validThrough }));
    } catch (error) {
      nextCheckAt = Date.now() + 300000;
      console.warn(JSON.stringify({ event: "snapshot_refresh", status: "fallback", message: error instanceof Error ? error.message : "Unknown error" }));
    }
    return cached!;
  })().finally(() => { pending = undefined; });
  return pending;
}
