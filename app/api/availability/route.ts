import { fetchSeatAvailability } from "@/app/lib/seat-provider";
import {
  HttpInputError,
  jsonResponse,
  readJsonBody,
} from "@/app/lib/http";

type AvailabilityPayload = {
  category?: string;
  trainNumber?: string;
  stationStops?: Array<{
    id?: number;
    arrival?: string;
    departure?: string;
  }>;
  numberOfPassengers?: number;
  bike?: boolean;
  ticketClass?: 1 | 2;
};

function validStationPath(
  value: AvailabilityPayload["stationStops"],
): value is Array<{ id: number; arrival: string; departure: string }> {
  if (!Array.isArray(value) || value.length < 2 || value.length > 80) {
    return false;
  }

  let previousDeparture = Number.NEGATIVE_INFINITY;
  for (const stop of value) {
    if (
      !stop ||
      typeof stop !== "object" ||
      !Number.isInteger(stop.id) ||
      Number(stop.id) <= 0 ||
      typeof stop.arrival !== "string" ||
      typeof stop.departure !== "string"
    ) {
      return false;
    }

    const arrival = Date.parse(stop.arrival);
    const departure = Date.parse(stop.departure);
    if (
      Number.isNaN(arrival) ||
      Number.isNaN(departure) ||
      arrival > departure ||
      arrival < previousDeparture
    ) {
      return false;
    }
    previousDeparture = departure;
  }

  return true;
}

export async function POST(request: Request) {
  const deadline = new AbortController();
  const abortFromClient = () => deadline.abort(request.signal.reason);
  const timeout = setTimeout(
    () =>
      deadline.abort(
        new DOMException("Availability deadline exceeded", "TimeoutError"),
      ),
    10_000,
  );
  if (request.signal.aborted) abortFromClient();
  else request.signal.addEventListener("abort", abortFromClient, { once: true });

  try {
    const payload = await readJsonBody<AvailabilityPayload>(request);
    const ticketClass = payload.ticketClass === 1 ? 1 : 2;
    const numberOfPassengers = payload.numberOfPassengers ?? 1;

    if (
      typeof payload.category !== "string" ||
      !/^[A-Za-z/\s-]{1,24}$/.test(payload.category) ||
      typeof payload.trainNumber !== "string" ||
      !/^[0-9/\s-]{1,24}$/.test(payload.trainNumber) ||
      !validStationPath(payload.stationStops) ||
      !Number.isInteger(numberOfPassengers) ||
      numberOfPassengers < 1 ||
      numberOfPassengers > 6
    ) {
      return jsonResponse(
        { error: "Nieprawidłowe dane pociągu." },
        { status: 400 },
      );
    }

    const result = await fetchSeatAvailability(
      {
        train: {
          number: payload.trainNumber,
          category: payload.category,
        },
        stationStops: payload.stationStops,
        numberOfPassengers,
        ticketClass,
        bike: Boolean(payload.bike),
      },
      deadline.signal,
    );
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof HttpInputError) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }
    console.error("Seat availability lookup failed", error);
    return jsonResponse(
      { error: "Nie udało się sprawdzić dostępności miejsc." },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromClient);
  }
}
