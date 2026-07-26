import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }

  values.push(value);
  return values;
}

async function readCsv(filePath) {
  const text = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift() ?? "");

  return lines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function toMinutes(value) {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 60;
}

function toIsoDate(value) {
  if (!/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export async function importFeed(directory, options = {}) {
  const [routes, trips, stops, calendarDates, attributions] = await Promise.all([
    readCsv(path.join(directory, "routes.txt")),
    readCsv(path.join(directory, "trips.txt")),
    readCsv(path.join(directory, "stops.txt")),
    readCsv(path.join(directory, "calendar_dates.txt")),
    readCsv(path.join(directory, "attributions.txt")),
  ]);

  const routeById = new Map(routes.map((route) => [route.route_id, route]));
  const intercityTrips = trips.filter(
    (trip) => trip.route_id.startsWith("IC_") && !trip.route_id.endsWith("_BUS"),
  );
  const tripById = new Map(intercityTrips.map((trip) => [trip.trip_id, trip]));
  const serviceIds = new Set(intercityTrips.map((trip) => trip.service_id));

  const serviceDateSets = new Map();
  for (const row of calendarDates) {
    if (!serviceIds.has(row.service_id)) continue;
    const date = toIsoDate(row.date);
    if (!date) continue;
    const dates = serviceDateSets.get(row.service_id) ?? new Set();
    if (row.exception_type === "2") dates.delete(date);
    else if (row.exception_type === "1") dates.add(date);
    serviceDateSets.set(row.service_id, dates);
  }

  const stopTimesText = (await readFile(path.join(directory, "stop_times.txt"), "utf8"))
    .replace(/^\uFEFF/, "");
  const stopTimeLines = stopTimesText.split(/\r?\n/);
  const stopTimeHeaders = parseCsvLine(stopTimeLines.shift() ?? "");
  const column = Object.fromEntries(stopTimeHeaders.map((name, index) => [name, index]));
  const stopTimesByTrip = new Map();
  const usedStationIds = new Set();

  for (const line of stopTimeLines) {
    if (!line) continue;
    const values = parseCsvLine(line);
    const tripId = values[column.trip_id];
    if (!tripById.has(tripId)) continue;

    const stationId = Number(values[column.stop_id]);
    const arrival = toMinutes(values[column.arrival_time]);
    const departure = toMinutes(values[column.departure_time]);
    if (!Number.isInteger(stationId) || arrival === null || departure === null) continue;

    const tripStops = stopTimesByTrip.get(tripId) ?? [];
    tripStops.push([
      stationId,
      arrival,
      departure,
      values[column.platform] ?? "",
      values[column.track] ?? "",
    ]);
    stopTimesByTrip.set(tripId, tripStops);
    usedStationIds.add(stationId);
  }

  const stationNames = new Map(
    stops
      .map((stop) => [Number(stop.stop_id), stop.stop_name])
      .filter(([id, name]) => Number.isInteger(id) && Boolean(name)),
  );
  const stationsOutput = [...usedStationIds]
    .flatMap((id) => {
      const name = stationNames.get(id);
      return name
        ? [{ id, name }]
        : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name, "pl"));

  const tripsOutput = intercityTrips.flatMap((trip) => {
    const tripStops = stopTimesByTrip.get(trip.trip_id);
    const serviceDates = serviceDateSets.get(trip.service_id);
    if (!tripStops || tripStops.length < 2 || !serviceDates?.size) return [];
    tripStops.sort((left, right) => left[1] - right[1]);
    const route = routeById.get(trip.route_id);

    return [
      {
        id: trip.trip_id,
        service: trip.service_id,
        category: trip.plk_category_code || route?.route_short_name || "IC",
        number: trip.plk_train_number || trip.trip_short_name,
        name: trip.plk_train_name || "",
        stops: tripStops,
      },
    ];
  });

  const serviceDatesOutput = Object.fromEntries(
    [...serviceDateSets]
      .filter(([, dates]) => dates.size > 0)
      .map(([service, dates]) => [service, [...dates].sort()]),
  );
  const allDates = Object.values(serviceDatesOutput).flat();
  const plkAttribution = attributions.find((row) => row.attribution_id === "PLK");
  const makerAttribution = attributions.find((row) => row.attribution_id === "MK");
  const generatedMatch = attributions
    .map((row) => row.organization_name.match(/\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\)/)?.[1])
    .find(Boolean);
  if (!generatedMatch) {
    throw new Error("GTFS attributions do not report the source generation time.");
  }

  const timetableOutput = {
    schemaVersion: 1,
    generatedAt: generatedMatch,
    validFrom: allDates.sort()[0] ?? null,
    validThrough: allDates.sort().at(-1) ?? null,
    sources: [
      {
        name: plkAttribution?.organization_name ?? "PKP Polskie Linie Kolejowe S.A.",
        url:
          plkAttribution?.attribution_url ||
          "https://www.plk-sa.pl/klienci-i-kontrahenci/api-otwarte-dane",
      },
      {
        name: makerAttribution?.organization_name ?? "GTFS: Mikołaj Kuranowski",
        url: makerAttribution?.attribution_url || "https://mkuran.pl/gtfs/",
      },
    ],
    serviceDates: serviceDatesOutput,
    trips: tripsOutput,
  };

  const workspaceRoot = path.resolve(import.meta.dirname, "..");
  const timetableDirectory = path.join(workspaceRoot, "app", "data");
  await mkdir(timetableDirectory, { recursive: true });
  const provenancePath = path.join(timetableDirectory, "provenance.json");
  let existingProvenance = {};
  try {
    existingProvenance = JSON.parse(await readFile(provenancePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const processedAt = options.processedAt ?? new Date().toISOString();
  const retrievedAt = options.retrievedAt ?? processedAt;
  const feedUrl =
    options.sourceUrl ?? "https://mkuran.pl/gtfs/polish_trains.zip";
  const provenanceOutput = {
    ...existingProvenance,
    timetable: {
      sourceName: "PKP Polskie Linie Kolejowe S.A.",
      sourceUrl:
        "https://www.plk-sa.pl/klienci-i-kontrahenci/api-otwarte-dane",
      feedName: "Polish Trains GTFS by Mikołaj Kuranowski",
      feedUrl,
      sourceGeneratedAt: timetableOutput.generatedAt,
      retrievedAt,
      processedAt,
      reuseTermsUrl: "https://bip.plk-sa.pl/ponowne-wykorzystywanie",
    },
  };
  const noticesPath = path.join(workspaceRoot, "THIRD_PARTY_NOTICES.md");
  const timingNotice = [
    `- Acquisition time: \`${retrievedAt}\``,
    `- Processing time: \`${processedAt}\``,
  ].join("\n");
  const notices = (await readFile(noticesPath, "utf8"))
    .replace(
      /^- Source generation time reported by the feed: `[^`]*`$/m,
      `- Source generation time reported by the feed: \`${timetableOutput.generatedAt}\``,
    )
    .replace(
      /^(?:- Acquisition and processing (?:date|time): `[^`]*`|- Acquisition time: `[^`]*`\r?\n- Processing time: `[^`]*`)$/m,
      timingNotice,
    );
  await Promise.all([
    writeFile(
      path.join(workspaceRoot, "public", "stations.json"),
      `${JSON.stringify(stationsOutput)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(timetableDirectory, "ic-timetable.json"),
      `${JSON.stringify(timetableOutput)}\n`,
      "utf8",
    ),
    writeFile(
      provenancePath,
      `${JSON.stringify(provenanceOutput, null, 2)}\n`,
      "utf8",
    ),
    writeFile(noticesPath, notices, "utf8"),
  ]);

  console.log(
    `Imported ${tripsOutput.length} PKP Intercity trips, ${stationsOutput.length} stations, valid through ${timetableOutput.validThrough}.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const feedDirectory = process.argv[2];
  if (!feedDirectory) {
    console.error("Usage: node scripts/import-open-gtfs.mjs <extracted-gtfs-directory>");
    process.exitCode = 1;
  } else {
    await importFeed(path.resolve(feedDirectory));
  }
}
