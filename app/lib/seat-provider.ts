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
import { BoundedTtlCache } from "./ttl-cache";

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
    number: string;
    category: string;
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
  fromIndex: number;
  toIndex: number;
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
const OFFICIAL_EIC_ORIGIN = "https://ebilet.intercity.pl";
const DEFAULT_EIC_APP_VERSION = "1.5.20";
const configuredGrmBase = process.env.EIC_GRM_API_URL?.trim();
const configuredGrmToken = process.env.EIC_GRM_API_TOKEN?.trim();
const configuredEicAppVersion = process.env.EIC_APP_VERSION?.trim();
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
const EIC_APP_VERSION =
  configuredEicAppVersion && /^\d+(?:\.\d+){2}$/.test(configuredEicAppVersion)
    ? configuredEicAppVersion
    : DEFAULT_EIC_APP_VERSION;
const GRM_API_TOKEN =
  configuredGrmToken && configuredGrmToken.length >= 32
    ? configuredGrmToken
    : null;
const MAP_CONCURRENCY = 4;
const OUTBOUND_CONCURRENCY = 10;
const MAX_OUTBOUND_WAITERS = 100;
const CACHE_MILLISECONDS = 90_000;
const MAX_COMPOSITION_BYTES = 256 * 1024;
const MAX_SEAT_MAP_BYTES = 2 * 1024 * 1024;
const responseCache = new BoundedTtlCache<unknown>(512);
const inFlightRequests = new Map<string, Promise<unknown>>();
const outboundWaiters: Array<() => void> = [];
let activeOutboundRequests = 0;

class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

function grmHeaders(format: "json" | "text") {
  const headers: Record<string, string> = {
    Accept:
      format === "json"
        ? "application/json"
        : "image/svg+xml,text/plain;q=0.8,*/*;q=0.5",
    "App-Version": EIC_APP_VERSION,
    [`App-Version-${EIC_APP_VERSION}`]: "",
    "Content-Type": "application/json",
    Origin: OFFICIAL_EIC_ORIGIN,
    Referer: `${OFFICIAL_EIC_ORIGIN}/`,
  };
  if (GRM_API_TOKEN) headers.Authorization = `Bearer ${GRM_API_TOKEN}`;
  return headers;
}

async function fetchWithTimeout(url: string, format: "json" | "text") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    return await fetch(url, {
      headers: grmHeaders(format),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function withOutboundSlot<T>(task: () => Promise<T>) {
  if (activeOutboundRequests < OUTBOUND_CONCURRENCY) {
    activeOutboundRequests += 1;
  } else {
    if (outboundWaiters.length >= MAX_OUTBOUND_WAITERS) {
      throw new ProviderUnavailableError("Seat-map request queue is full");
    }
    await new Promise<void>((resolve) => outboundWaiters.push(resolve));
  }

  try {
    return await task();
  } finally {
    const next = outboundWaiters.shift();
    if (next) next();
    else activeOutboundRequests -= 1;
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number) {
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null ? null : Number(contentLength);
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    throw new ProviderUnavailableError("Seat-map response is too large");
  }

  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderUnavailableError("Seat-map response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

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
  if (cached !== undefined) return cached;
  const inFlight = inFlightRequests.get(cacheKey);
  if (inFlight) return inFlight;

  const request = withOutboundSlot(async () => {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, format);
    } catch (error) {
      throw new ProviderUnavailableError(
        error instanceof Error
          ? error.message
          : "Seat-map service unavailable",
      );
    }

    if (response.status === 429 || response.status >= 500) {
      throw new ProviderUnavailableError(
        `Seat-map service returned ${response.status}`,
        response.status,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderUnavailableError(
        `Seat-map service rejected the request with ${response.status}`,
        response.status,
      );
    }
    if (!response.ok) return null;

    try {
      const text = await readBoundedResponse(
        response,
        format === "json" ? MAX_COMPOSITION_BYTES : MAX_SEAT_MAP_BYTES,
      );
      const payload = format === "json" ? (JSON.parse(text) as unknown) : text;
      responseCache.set(cacheKey, payload, CACHE_MILLISECONDS);
      return payload;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      return null;
    }
  }).finally(() => inFlightRequests.delete(cacheKey));

  inFlightRequests.set(cacheKey, request);
  return request;
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
  const selectedClass =
    input.ticketClass === 1 ? composition.klasa1 : composition.klasa2;
  if (
    !Array.isArray(composition.wagony) ||
    !Array.isArray(selectedClass) ||
    !composition.wagonySchemat ||
    typeof composition.wagonySchemat !== "object" ||
    Array.isArray(composition.wagonySchemat)
  ) {
    return { state: "unknown", seats: [] };
  }

  const allWagons = new Set(stringList(composition.wagony));
  const classWagons = stringList(selectedClass);
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

  if (allWagons.size === 0) return { state: "unknown", seats: [] };
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
      if (!parsed || parsed.eligiblePlaces === 0) {
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
  fromIndex: number,
  toIndex: number,
): SegmentOutcome {
  return {
    from: from.id,
    to: to.id,
    fromIndex,
    toIndex,
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
  const reportLookupFailure = (error: unknown) => {
    if (!providerUnavailable) {
      const details = {
        provider: "PKP Intercity GRM",
        name: error instanceof Error ? error.name : "UnknownError",
        message:
          error instanceof Error ? error.message : "Unexpected provider failure",
        status:
          error instanceof ProviderUnavailableError ? error.status : null,
      };
      if (error instanceof ProviderUnavailableError) {
        console.warn("Seat inventory provider unavailable", details);
      } else {
        console.error("Seat inventory lookup failed", details);
      }
    }
    providerUnavailable = true;
  };

  let directInventory = unknownLeg();
  try {
    directInventory = await lookupInventory(input, first, last);
  } catch (error) {
    reportLookupFailure(error);
  }
  const directOutcome = outcomeFor(
    directInventory,
    first,
    last,
    input.numberOfPassengers,
    0,
    input.stationStops.length - 1,
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
          reportLookupFailure(error);
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
