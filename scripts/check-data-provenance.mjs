import { access, readFile } from "node:fs/promises";

const [snapshot, stations, eicStations, provenance, notices] =
  await Promise.all([
    readFile("app/data/ic-timetable.json", "utf8").then(JSON.parse),
    readFile("public/stations.json", "utf8").then(JSON.parse),
    readFile("app/data/eic-stations.json", "utf8").then(JSON.parse),
    readFile("app/data/provenance.json", "utf8").then(JSON.parse),
    readFile("THIRD_PARTY_NOTICES.md", "utf8"),
  ]);

const errors = [];
const requiredSnapshotSources = [
  "https://www.plk-sa.pl/klienci-i-kontrahenci/api-otwarte-dane",
  "https://mkuran.pl/gtfs/",
];
for (const source of requiredSnapshotSources) {
  if (!snapshot.sources?.some((candidate) => candidate.url === source)) {
    errors.push(`Snapshot does not identify ${source}`);
  }
}

if (
  provenance.timetable?.sourceGeneratedAt !== snapshot.generatedAt ||
  !provenance.timetable?.retrievedAt ||
  !provenance.timetable?.processedAt
) {
  errors.push("Timetable provenance is missing or does not match the snapshot");
}
if (
  provenance.timetable?.sourceUrl !== requiredSnapshotSources[0] ||
  provenance.timetable?.feedUrl !==
    "https://mkuran.pl/gtfs/polish_trains.zip" ||
  provenance.timetable?.reuseTermsUrl !==
    "https://bip.plk-sa.pl/ponowne-wykorzystywanie"
) {
  errors.push("Timetable provenance does not identify the exact source and reuse terms");
}
for (const [label, value] of [
  ["snapshot generation time", snapshot.generatedAt],
  ["acquisition time", provenance.timetable?.retrievedAt],
  ["processing time", provenance.timetable?.processedAt],
]) {
  if (!value || !notices.includes(value)) {
    errors.push(`THIRD_PARTY_NOTICES.md does not state the ${label}`);
  }
}
if (
  snapshot.schemaVersion !== 1 ||
  !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.validFrom) ||
  !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.validThrough) ||
  !Array.isArray(snapshot.trips) ||
  snapshot.trips.length === 0
) {
  errors.push("Timetable snapshot schema or trips are malformed");
}

const minimumValidityDays = Number(process.env.GTFS_MIN_VALIDITY_DAYS ?? 7);
const minimumValidThrough = new Date();
minimumValidThrough.setUTCHours(0, 0, 0, 0);
minimumValidThrough.setUTCDate(minimumValidThrough.getUTCDate() + minimumValidityDays);
if (
  !Number.isInteger(minimumValidityDays) ||
  minimumValidityDays < 0 ||
  Date.parse(`${snapshot.validThrough}T23:59:59Z`) < minimumValidThrough.getTime()
) {
  errors.push(
    `Timetable snapshot expires too soon (${snapshot.validThrough}); refresh the GTFS feed`,
  );
}
if (
  !Array.isArray(stations) ||
  stations.length === 0 ||
  stations.some(
    (station) =>
      !station ||
      typeof station !== "object" ||
      !Number.isInteger(station.id) ||
      station.id <= 0 ||
      typeof station.name !== "string" ||
      !station.name.trim() ||
      Object.keys(station).some((key) => !["id", "name"].includes(key)),
  )
) {
  errors.push("Public station catalogue is malformed");
}
if (
  !Array.isArray(eicStations) ||
  eicStations.length === 0 ||
  eicStations.some(
    (row) =>
      !Array.isArray(row) ||
      row.length !== 3 ||
      !Number.isInteger(row[0]) ||
      row[0] <= 0 ||
      !Number.isInteger(row[1]) ||
      row[1] < 0 ||
      !Number.isInteger(row[2]) ||
      row[2] <= 0,
  )
) {
  errors.push("e-IC station mapping is malformed");
}

const plkIds = eicStations.map((row) => row[0]);
if (new Set(plkIds).size !== plkIds.length) {
  errors.push("e-IC station mapping contains duplicate PLK station IDs");
}

try {
  await access("app/data/provenance.json");
} catch {
  errors.push("app/data/provenance.json is missing");
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Data provenance verified for ${snapshot.trips.length} trips, ${stations.length} stations, and ${eicStations.length} e-IC mappings.`,
  );
}
