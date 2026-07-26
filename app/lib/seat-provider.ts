import {
  formatEicDateTime,
  getEicStationCodes,
  normaliseEicCategory,
  normaliseEicTrainNumber,
} from "./eic";
import { occupancyFromFrequency, summariseAvailability } from "./eic-availability.mjs";
import { everySegment } from "./seat-planner.mjs";

export type TrainStationStop = {
  id: number;
  arrival: string;
  departure: string;
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
  ticketClass: 1 | 2;
  bike: boolean;
};

type SegmentOutcome = {
  from: number;
  to: number;
  timeFrom: string;
  timeTo: string;
  state: "available" | "unavailable" | "unknown";
  occupancyPercent?: number;
};

const OFFICIAL_AVAILABILITY_BASE =
  "https://api-gateway.intercity.pl/availability/frequency";
const configuredAvailabilityBase = process.env.EIC_AVAILABILITY_API_URL?.trim();
const AVAILABILITY_BASE = (() => {
  if (!configuredAvailabilityBase) return OFFICIAL_AVAILABILITY_BASE;
  try {
    const url = new URL(configuredAvailabilityBase);
    return /^https?:$/.test(url.protocol)
      ? url.toString().replace(/\/$/, "")
      : OFFICIAL_AVAILABILITY_BASE;
  } catch {
    return OFFICIAL_AVAILABILITY_BASE;
  }
})();
const CHECK_CONCURRENCY = 6;
const responseCache = new Map<
  string,
  { expiresAt: number; payload: unknown }
>();

class ProviderUnavailableError extends Error {}

function availabilityUrl(input: {
  category: string;
  trainNumber: string;
  from: TrainStationStop;
  to: TrainStationStop;
  fromCode: number;
  toCode: number;
}) {
  const path = [
    normaliseEicCategory(input.category),
    normaliseEicTrainNumber(input.trainNumber),
    formatEicDateTime(input.from.departure),
    formatEicDateTime(input.to.arrival),
    String(input.fromCode),
    String(input.toCode),
  ].map(encodeURIComponent);
  return `${AVAILABILITY_BASE}/${path.join("/")}/`;
}

async function fetchFrequency(url: string) {
  const cached = responseCache.get(url);
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
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new ProviderUnavailableError(
      error instanceof Error ? error.message : "Seat service unavailable",
    );
  }

  if (response.status === 429 || response.status >= 500) {
    throw new ProviderUnavailableError(`Seat service returned ${response.status}`);
  }
  if (!response.ok) return null;

  try {
    const payload = (await response.json()) as unknown;
    responseCache.set(url, { expiresAt: Date.now() + 90_000, payload });
    return payload;
  } catch {
    return null;
  }
}

async function lookupSegment(
  input: SeatInventoryRequest,
  from: TrainStationStop,
  to: TrainStationStop,
): Promise<SegmentOutcome> {
  const base = {
    from: from.id,
    to: to.id,
    timeFrom: from.departure,
    timeTo: to.arrival,
  };
  const fromCodes = getEicStationCodes(from.id);
  const toCodes = getEicStationCodes(to.id);
  if (!fromCodes || !toCodes) return { ...base, state: "unknown" };

  const payload = await fetchFrequency(
    availabilityUrl({
      category: input.train.category,
      trainNumber: input.train.number,
      from,
      to,
      fromCode: fromCodes.availabilityCode,
      toCode: toCodes.availabilityCode,
    }),
  );
  const occupancyPercent = occupancyFromFrequency(
    payload,
    input.ticketClass,
    input.bike,
  );
  if (occupancyPercent === null) return { ...base, state: "unknown" };
  return {
    ...base,
    state: occupancyPercent < 100 ? "available" : "unavailable",
    occupancyPercent,
  };
}

export async function fetchSeatAvailability(input: SeatInventoryRequest) {
  const stationIds = input.stationStops.map((stop) => stop.id);
  const stopById = new Map(input.stationStops.map((stop) => [stop.id, stop]));
  const pairs = everySegment(stationIds);
  const outcomes = new Array<SegmentOutcome>(pairs.length);
  let cursor = 0;
  let providerUnavailable = false;

  async function worker() {
    while (cursor < pairs.length) {
      const index = cursor;
      cursor += 1;
      const pair = pairs[index];
      const from = stopById.get(pair.from);
      const to = stopById.get(pair.to);
      if (!from || !to || providerUnavailable) {
        outcomes[index] = {
          from: pair.from,
          to: pair.to,
          timeFrom: from?.departure ?? "",
          timeTo: to?.arrival ?? "",
          state: "unknown",
        };
        continue;
      }

      try {
        outcomes[index] = await lookupSegment(input, from, to);
      } catch (error) {
        if (error instanceof ProviderUnavailableError) providerUnavailable = true;
        outcomes[index] = {
          from: pair.from,
          to: pair.to,
          timeFrom: from.departure,
          timeTo: to.arrival,
          state: "unknown",
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CHECK_CONCURRENCY, pairs.length) }, worker),
  );

  const summary = summariseAvailability({ stationIds, outcomes });
  return {
    ...summary,
    message:
      summary.status === "unknown"
        ? providerUnavailable
          ? "PKP Intercity chwilowo nie udostępnia danych o miejscach."
          : "Brakuje danych dla części odcinków tego pociągu."
        : undefined,
  };
}
