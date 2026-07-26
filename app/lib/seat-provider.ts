import {
  formatEicCompactDateTime,
  getEicStationCodes,
  normaliseEicCategory,
  normaliseEicTrainNumber,
} from "./eic";
import {
  deriveExactSegmentOutcomes,
  parseGrmSeatMap,
  sortExactSeats,
  summariseExactAvailability,
} from "./eic-availability.mjs";

export type TrainStationStop = {
  id: number;
  arrival: string;
  departure: string;
};

export type ExactSeat = {
  wagon: string;
  seat: string;
  label: string;
};

export type SeatInventoryRequest = {
  train: {
    id: string;
    number: string;
    category: string;
    departure: string;
    arrival: string;
  };
  stationStops: TrainStationStop[];
  numberOfPassengers: number;
  ticketClass: 1 | 2;
  bike: boolean;
};

type InventoryState = "available" | "unavailable" | "unknown";

type SegmentInventory = {
  state: InventoryState;
  seats: ExactSeat[];
};

type SegmentOutcome = SegmentInventory & {
  from: number;
  to: number;
  timeFrom: string;
  timeTo: string;
  freeSeats: number;
};

type GrmComposition = {
  wagony?: unknown;
  wagonyNiedostepne?: unknown;
  wagonySchemat?: unknown;
  wagonyUdogodnienia?: unknown;
  klasa1?: unknown;
  klasa2?: unknown;
};

const OFFICIAL_GRM_BASE = "https://api-gateway.intercity.pl/grm";
const configuredGrmBase = process.env.EIC_GRM_API_URL?.trim();
const GRM_BASE = (() => {
  if (!configuredGrmBase) return OFFICIAL_GRM_BASE;
  try {
    const url = new URL(configuredGrmBase);
    return /^https?:$/.test(url.protocol)
      ? url.toString().replace(/\/$/, "")
      : OFFICIAL_GRM_BASE;
  } catch {
    return OFFICIAL_GRM_BASE;
  }
})();
const MAP_CONCURRENCY = 6;
const CACHE_MILLISECONDS = 90_000;
const responseCache = new Map<
  string,
  { expiresAt: number; payload: unknown }
>();

class ProviderUnavailableError extends Error {}

function endpoint(parts: Array<string | number>) {
  return `${GRM_BASE}/${parts.map((part) => encodeURIComponent(String(part))).join("/")}`;
}

function compositionUrl(input: {
  category: string;
  trainNumber: string;
  from: TrainStationStop;
  to: TrainStationStop;
  fromCode: number;
  toCode: number;
}) {
  return endpoint([
    "sklad",
    "wbnet",
    normaliseEicCategory(input.category),
    normaliseEicTrainNumber(input.trainNumber),
    formatEicCompactDateTime(input.to.arrival),
    input.fromCode,
    formatEicCompactDateTime(input.from.departure),
    input.toCode,
  ]);
}

function wagonUrl(input: {
  category: string;
  trainNumber: string;
  wagon: string;
  scheme: string;
  from: TrainStationStop;
  to: TrainStationStop;
  fromCode: number;
  toCode: number;
}) {
  return endpoint([
    "wagon",
    "svg",
    "wbnet",
    normaliseEicCategory(input.category),
    normaliseEicTrainNumber(input.trainNumber),
    input.wagon,
    input.scheme,
    formatEicCompactDateTime(input.from.departure),
    formatEicCompactDateTime(input.to.arrival),
    input.fromCode,
    input.toCode,
  ]);
}

async function fetchGrm(url: string, format: "json" | "text") {
  const cacheKey = `${format}:${url}`;
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        "App-Version": "1.5.20",
        "App-Version-1.5.20": "",
        Origin: "https://ebilet.intercity.pl",
        Referer: "https://ebilet.intercity.pl/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new ProviderUnavailableError(
      error instanceof Error ? error.message : "Seat-map service unavailable",
    );
  }

  if (response.status === 429 || response.status >= 500) {
    throw new ProviderUnavailableError(`Seat-map service returned ${response.status}`);
  }
  if (!response.ok) return null;

  try {
    const payload =
      format === "json" ? ((await response.json()) as unknown) : await response.text();
    responseCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_MILLISECONDS,
      payload,
    });
    return payload;
  } catch {
    return null;
  }
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string" || typeof item === "number")
        .map(String)
    : [];
}

function stringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, string>;
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      typeof item === "string" || typeof item === "number"
        ? [[key, String(item)]]
        : [],
    ),
  );
}

function listRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, string[]>;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, stringList(item)]),
  );
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  task: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let cursor = 0;

  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(values[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, worker),
  );
  return results;
}

async function lookupInventory(
  input: SeatInventoryRequest,
  from: TrainStationStop,
  to: TrainStationStop,
): Promise<SegmentInventory> {
  const fromCodes = getEicStationCodes(from.id);
  const toCodes = getEicStationCodes(to.id);
  if (!fromCodes || !toCodes) return { state: "unknown", seats: [] };

  const compositionPayload = await fetchGrm(
    compositionUrl({
      category: input.train.category,
      trainNumber: input.train.number,
      from,
      to,
      fromCode: fromCodes.availabilityCode,
      toCode: toCodes.availabilityCode,
    }),
    "json",
  );
  if (!compositionPayload || typeof compositionPayload !== "object") {
    return { state: "unknown", seats: [] };
  }

  const composition = compositionPayload as GrmComposition;
  const allWagons = new Set(stringList(composition.wagony));
  const classWagons = stringList(
    input.ticketClass === 1 ? composition.klasa1 : composition.klasa2,
  );
  const unavailableWagons = new Set(
    stringList(composition.wagonyNiedostepne),
  );
  const schemes = stringRecord(composition.wagonySchemat);
  const amenities = listRecord(composition.wagonyUdogodnienia);

  let relevantWagons = classWagons.filter(
    (wagon) => allWagons.has(wagon) && !unavailableWagons.has(wagon),
  );
  if (input.bike) {
    relevantWagons = relevantWagons.filter((wagon) =>
      amenities[wagon]?.includes("309"),
    );
  }

  if (classWagons.length === 0 || relevantWagons.length === 0) {
    return { state: "unavailable", seats: [] };
  }

  let incompleteMaps = false;
  const mapResults = await mapLimit(
    relevantWagons,
    MAP_CONCURRENCY,
    async (wagon) => {
      const scheme = schemes[wagon];
      if (!scheme) {
        incompleteMaps = true;
        return [] as ExactSeat[];
      }

      const svg = await fetchGrm(
        wagonUrl({
          category: input.train.category,
          trainNumber: input.train.number,
          wagon,
          scheme,
          from,
          to,
          fromCode: fromCodes.availabilityCode,
          toCode: toCodes.availabilityCode,
        }),
        "text",
      );
      const parsed = parseGrmSeatMap(svg, {
        wagon,
        ticketClass: input.ticketClass,
        bike: input.bike,
      });
      if (!parsed) {
        incompleteMaps = true;
        return [] as ExactSeat[];
      }
      return parsed.seats as ExactSeat[];
    },
  );

  const seats = sortExactSeats(mapResults.flat()) as ExactSeat[];
  if (seats.length >= input.numberOfPassengers) {
    return { state: "available", seats };
  }
  if (incompleteMaps) return { state: "unknown", seats };
  return { state: "unavailable", seats };
}

function outcomeFor(
  inventory: SegmentInventory,
  from: TrainStationStop,
  to: TrainStationStop,
  numberOfPassengers: number,
): SegmentOutcome {
  return {
    from: from.id,
    to: to.id,
    timeFrom: from.departure,
    timeTo: to.arrival,
    state: inventory.state,
    seats: inventory.seats.slice(0, numberOfPassengers),
    freeSeats: inventory.seats.length,
  };
}

function unknownLeg(): SegmentInventory {
  return { state: "unknown", seats: [] };
}

export async function fetchSeatAvailability(input: SeatInventoryRequest) {
  const stationIds = input.stationStops.map((stop) => stop.id);
  const first = input.stationStops[0];
  const last = input.stationStops.at(-1);
  if (!first || !last) {
    throw new Error("At least two station stops are required");
  }
  let providerUnavailable = false;

  let directInventory = unknownLeg();
  try {
    directInventory = await lookupInventory(input, first, last);
  } catch (error) {
    if (error instanceof ProviderUnavailableError) providerUnavailable = true;
  }
  const directOutcome = outcomeFor(
    directInventory,
    first,
    last,
    input.numberOfPassengers,
  );

  let legInventories: SegmentInventory[];
  if (directInventory.state === "available" || providerUnavailable) {
    legInventories = Array.from(
      { length: input.stationStops.length - 1 },
      unknownLeg,
    );
  } else if (input.stationStops.length === 2) {
    legInventories = [directInventory];
  } else {
    const adjacentStarts = input.stationStops.slice(0, -1);
    legInventories = await mapLimit(
      adjacentStarts,
      MAP_CONCURRENCY,
      async (from, index) => {
        if (providerUnavailable) return unknownLeg();
        try {
          return await lookupInventory(input, from, input.stationStops[index + 1]);
        } catch (error) {
          if (error instanceof ProviderUnavailableError) providerUnavailable = true;
          return unknownLeg();
        }
      },
    );
  }

  const outcomes = deriveExactSegmentOutcomes({
    stationStops: input.stationStops,
    legInventories,
    numberOfPassengers: input.numberOfPassengers,
    directOutcome,
  }) as SegmentOutcome[];
  const summary = summariseExactAvailability({ stationIds, outcomes });

  return {
    ...summary,
    inventorySource: "PKP Intercity GRM",
    message:
      summary.status === "unknown"
        ? providerUnavailable
          ? "PKP Intercity chwilowo nie udostępnia map miejsc."
          : "Nie udało się potwierdzić map miejsc dla części odcinków."
        : undefined,
  };
}
