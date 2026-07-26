import snapshotJson from "../data/ic-timetable.json";
import {
  buildEicBookingUrl,
  normaliseEicCategory,
} from "./eic";

type SnapshotStop = [
  stationId: number,
  arrivalMinutes: number,
  departureMinutes: number,
  platform: string,
  track: string,
];

type SnapshotTrip = {
  id: string;
  service: string;
  category: string;
  number: string;
  name: string;
  headsign: string;
  stops: SnapshotStop[];
};

type TimetableSnapshot = {
  generatedAt: string;
  validFrom: string;
  validThrough: string;
  sources: Array<{ name: string; url: string }>;
  serviceDates: Record<string, string[]>;
  trips: SnapshotTrip[];
};

type PlkStation = {
  stationId?: number;
  orderNumber?: number;
  arrivalCommercialCategory?: string | null;
  arrivalTrainNumber?: string | null;
  arrivalPlatform?: string | null;
  arrivalTrack?: string | null;
  arrivalDay?: number | null;
  arrivalTime?: string | null;
  departureCommercialCategory?: string | null;
  departureTrainNumber?: string | null;
  departurePlatform?: string | null;
  departureTrack?: string | null;
  departureDay?: number | null;
  departureTime?: string | null;
};

type PlkRoute = {
  scheduleId?: number;
  orderId?: number;
  trainOrderId?: number;
  name?: string | null;
  carrierCode?: string | null;
  nationalNumber?: string | null;
  commercialCategorySymbol?: string | null;
  operatingDates?: string[] | null;
  stations?: PlkStation[] | null;
};

type PlkResponse = {
  routes?: PlkRoute[] | null;
};

export type TrainResult = {
  uuid: string;
  category: string;
  trainNumber: string;
  trainName: string;
  departure: string;
  arrival: string;
  duration: number;
  changes: number;
  originStationId: number;
  destinationStationId: number;
  departurePlatform: string;
  departureTrack: string;
  arrivalPlatform: string;
  arrivalTrack: string;
  stops: number;
  stationIds: number[];
  stationStops: Array<{
    id: number;
    arrival: string;
    departure: string;
  }>;
  bookingUrl: string | null;
};

export type ScheduleSource = {
  mode: "official-live" | "open-snapshot";
  label: string;
  url: string;
  generatedAt?: string;
  validThrough?: string;
};

export class TimetableError extends Error {
  constructor(
    public code: "PLK_API_KEY_REQUIRED" | "PLK_API_ERROR",
    message: string,
    public status = 503,
  ) {
    super(message);
  }
}

const snapshot = snapshotJson as unknown as TimetableSnapshot;
const PLK_API_BASE = "https://pdp-api.plk-sa.pl/api/v1";
const MAX_RESULTS = 100;
const plkCache = new Map<
  string,
  { expiresAt: number; value: { trains: TrainResult[]; source: ScheduleSource } }
>();

function datePart(value: string) {
  return value.slice(0, 10);
}

function offsetPart(value: string) {
  return value.match(/(?:Z|[+-]\d{2}:\d{2})$/)?.[0] ?? "Z";
}

function timestamp(date: string, minutes: number, offset: string) {
  const midnight = Date.parse(`${date}T00:00:00${offset}`);
  return new Date(midnight + Math.round(minutes * 60_000)).toISOString();
}

function timeSpanMinutes(value?: string | null) {
  if (!value) return null;
  const clock = /^(?:(\d+)\.)?(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value);
  if (clock) {
    return (
      Number(clock[1] ?? 0) * 24 * 60 +
      Number(clock[2]) * 60 +
      Number(clock[3]) +
      Number(clock[4]) / 60
    );
  }
  const duration = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(
    value,
  );
  if (!duration) return null;
  return (
    Number(duration[1] ?? 0) * 24 * 60 +
    Number(duration[2] ?? 0) * 60 +
    Number(duration[3] ?? 0) +
    Number(duration[4] ?? 0) / 60
  );
}

function indexesForRoute(stationIds: number[], origin: number, destination: number) {
  for (let originIndex = 0; originIndex < stationIds.length - 1; originIndex += 1) {
    if (stationIds[originIndex] !== origin) continue;
    const destinationIndex = stationIds.indexOf(destination, originIndex + 1);
    if (destinationIndex > originIndex) return { originIndex, destinationIndex };
  }
  return null;
}

function snapshotCovers(date: string) {
  return date >= snapshot.validFrom && date <= snapshot.validThrough;
}

function searchSnapshot(input: {
  startStationId: number;
  endStationId: number;
  startDateTime: string;
}) {
  const date = datePart(input.startDateTime);
  if (!snapshotCovers(date)) {
    throw new TimetableError(
      "PLK_API_KEY_REQUIRED",
      `Lokalny rozkład obejmuje okres do ${snapshot.validThrough}. Dodaj klucz PLK_API_KEY, aby pobierać aktualne dane bezpośrednio z oficjalnego API PKP PLK.`,
    );
  }

  const requestedDeparture = Date.parse(input.startDateTime);
  const offset = offsetPart(input.startDateTime);
  const trains = snapshot.trips.flatMap((trip) => {
    if (!snapshot.serviceDates[trip.service]?.includes(date)) return [];
    const route = indexesForRoute(
      trip.stops.map((stop) => stop[0]),
      input.startStationId,
      input.endStationId,
    );
    if (!route) return [];

    const origin = trip.stops[route.originIndex];
    const destination = trip.stops[route.destinationIndex];
    const departure = timestamp(date, origin[2], offset);
    const arrival = timestamp(date, destination[1], offset);
    if (Date.parse(departure) < requestedDeparture) return [];
    const category = normaliseEicCategory(trip.category);
    const stationStops = trip.stops
      .slice(route.originIndex, route.destinationIndex + 1)
      .map((stop) => ({
        id: stop[0],
        arrival: timestamp(date, stop[1], offset),
        departure: timestamp(date, stop[2], offset),
      }));

    return [
      {
        uuid: `gtfs-${trip.id}-${date}`,
        category,
        trainNumber: trip.number || "—",
        trainName: [trip.category, trip.name].filter(Boolean).join(" ") || "PKP Intercity",
        departure,
        arrival,
        duration: Math.max(0, Math.round((Date.parse(arrival) - Date.parse(departure)) / 60_000)),
        changes: 0,
        originStationId: input.startStationId,
        destinationStationId: input.endStationId,
        departurePlatform: origin[3] || "",
        departureTrack: origin[4] || "",
        arrivalPlatform: destination[3] || "",
        arrivalTrack: destination[4] || "",
        stops: stationStops.length,
        stationIds: stationStops.map((stop) => stop.id),
        stationStops,
        bookingUrl: buildEicBookingUrl({
          originStationId: input.startStationId,
          destinationStationId: input.endStationId,
          departure,
        }),
      },
    ];
  });

  trains.sort((left, right) => Date.parse(left.departure) - Date.parse(right.departure));
  return {
    trains: trains.slice(0, MAX_RESULTS),
    source: {
      mode: "open-snapshot" as const,
      label: "Otwarte dane PKP PLK — lokalny snapshot GTFS",
      url: snapshot.sources[0]?.url ?? "https://www.plk-sa.pl/klienci-i-kontrahenci/api-otwarte-dane",
      generatedAt: snapshot.generatedAt,
      validThrough: snapshot.validThrough,
    },
  };
}

async function searchOfficialPlk(input: {
  startStationId: number;
  endStationId: number;
  startDateTime: string;
  apiKey: string;
}) {
  const date = datePart(input.startDateTime);
  const cacheKey = `${date}:${input.startStationId}:${input.endStationId}`;
  const cached = plkCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const query = new URLSearchParams({
    dateFrom: date,
    dateTo: date,
    fromStations: String(input.startStationId),
    toStations: String(input.endStationId),
    carriersInclude: "IC",
    fullRoute: "false",
    dictionaries: "false",
  });
  const response = await fetch(`${PLK_API_BASE}/schedules?${query}`, {
    headers: { "X-API-Key": input.apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new TimetableError(
      "PLK_API_ERROR",
      response.status === 401
        ? "Klucz PLK_API_KEY nie został zaakceptowany przez oficjalne API PKP PLK."
        : `Oficjalne API PKP PLK zwróciło błąd ${response.status}.`,
      response.status === 429 ? 429 : 502,
    );
  }

  const payload = (await response.json()) as PlkResponse;
  const requestedDeparture = Date.parse(input.startDateTime);
  const offset = offsetPart(input.startDateTime);
  const trains = (payload.routes ?? []).flatMap((route) => {
    if (route.operatingDates?.length && !route.operatingDates.includes(date)) return [];
    const stations = [...(route.stations ?? [])].sort(
      (left, right) => Number(left.orderNumber ?? 0) - Number(right.orderNumber ?? 0),
    );
    const routeIndexes = indexesForRoute(
      stations.map((station) => Number(station.stationId)),
      input.startStationId,
      input.endStationId,
    );
    if (!routeIndexes) return [];

    const origin = stations[routeIndexes.originIndex];
    const destination = stations[routeIndexes.destinationIndex];
    const departureClock = timeSpanMinutes(origin.departureTime ?? origin.arrivalTime);
    const arrivalClock = timeSpanMinutes(destination.arrivalTime ?? destination.departureTime);
    if (departureClock === null || arrivalClock === null) return [];
    const departureMinutes = Number(origin.departureDay ?? 0) * 1440 + departureClock;
    let arrivalMinutes = Number(destination.arrivalDay ?? 0) * 1440 + arrivalClock;
    if (arrivalMinutes < departureMinutes) arrivalMinutes += 1440;
    const departure = timestamp(date, departureMinutes, offset);
    const arrival = timestamp(date, arrivalMinutes, offset);
    if (Date.parse(departure) < requestedDeparture) return [];

    const category =
      origin.departureCommercialCategory ??
      origin.arrivalCommercialCategory ??
      route.commercialCategorySymbol ??
      "IC";
    const routeStations = stations.slice(
      routeIndexes.originIndex,
      routeIndexes.destinationIndex + 1,
    );
    let previousMinutes = Number.NEGATIVE_INFINITY;
    const stationStops = routeStations.flatMap((station) => {
      const arrivalClock = timeSpanMinutes(
        station.arrivalTime ?? station.departureTime,
      );
      const departureClock = timeSpanMinutes(
        station.departureTime ?? station.arrivalTime,
      );
      if (arrivalClock === null || departureClock === null) return [];

      let stopArrival = Number(station.arrivalDay ?? 0) * 1440 + arrivalClock;
      while (stopArrival < previousMinutes) stopArrival += 1440;
      let stopDeparture =
        Number(station.departureDay ?? station.arrivalDay ?? 0) * 1440 +
        departureClock;
      while (stopDeparture < stopArrival) stopDeparture += 1440;
      previousMinutes = stopDeparture;

      return [
        {
          id: Number(station.stationId),
          arrival: timestamp(date, stopArrival, offset),
          departure: timestamp(date, stopDeparture, offset),
        },
      ];
    });
    const eicCategory = normaliseEicCategory(category);
    return [
      {
        uuid: `plk-${route.scheduleId ?? 0}-${route.orderId ?? 0}-${route.trainOrderId ?? 0}-${date}`,
        category: eicCategory,
        trainNumber:
          origin.departureTrainNumber ?? origin.arrivalTrainNumber ?? route.nationalNumber ?? "—",
        trainName: [category, route.name].filter(Boolean).join(" ") || "PKP Intercity",
        departure,
        arrival,
        duration: Math.max(0, Math.round(arrivalMinutes - departureMinutes)),
        changes: 0,
        originStationId: input.startStationId,
        destinationStationId: input.endStationId,
        departurePlatform: origin.departurePlatform ?? "",
        departureTrack: origin.departureTrack ?? "",
        arrivalPlatform: destination.arrivalPlatform ?? "",
        arrivalTrack: destination.arrivalTrack ?? "",
        stops: stationStops.length,
        stationIds: stationStops.map((station) => station.id),
        stationStops,
        bookingUrl: buildEicBookingUrl({
          originStationId: input.startStationId,
          destinationStationId: input.endStationId,
          departure,
        }),
      },
    ];
  });
  trains.sort((left, right) => Date.parse(left.departure) - Date.parse(right.departure));

  const value = {
    trains: trains.slice(0, MAX_RESULTS),
    source: {
      mode: "official-live" as const,
      label: "Oficjalne API otwartych danych PKP PLK",
      url: "https://www.plk-sa.pl/klienci-i-kontrahenci/api-otwarte-dane",
    },
  };
  plkCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value });
  return value;
}

export async function searchTimetable(input: {
  startStationId: number;
  endStationId: number;
  startDateTime: string;
}) {
  const apiKey = process.env.PLK_API_KEY?.trim();
  if (!apiKey) return searchSnapshot(input);

  try {
    return await searchOfficialPlk({ ...input, apiKey });
  } catch (error) {
    if (!snapshotCovers(datePart(input.startDateTime))) throw error;
    return {
      ...searchSnapshot(input),
      warning:
        error instanceof Error
          ? `Oficjalne API jest chwilowo niedostępne; pokazujemy lokalny snapshot. ${error.message}`
          : "Oficjalne API jest chwilowo niedostępne; pokazujemy lokalny snapshot.",
    };
  }
}
