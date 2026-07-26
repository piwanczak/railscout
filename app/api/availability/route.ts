import { fetchSeatOffers, isSeatProviderConfigured } from "@/app/lib/seat-provider";
import { findSeatPlans } from "@/app/lib/seat-planner.mjs";

type AvailabilityPayload = {
  uuid?: string;
  trainNumber?: string;
  stationIds?: number[];
  startDateTime?: string;
  numberOfPassengers?: number;
  bike?: boolean;
  quietZone?: boolean;
  ticketClass?: 1 | 2;
};

function validStationPath(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= 80 &&
    value.every((stationId) => Number.isInteger(stationId) && stationId > 0) &&
    new Set(value).size === value.length
  );
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as AvailabilityPayload;
    const passengerCount = Math.min(
      6,
      Math.max(1, Number(payload.numberOfPassengers ?? 1)),
    );
    const ticketClass = payload.ticketClass === 1 ? 1 : 2;

    if (
      typeof payload.uuid !== "string" ||
      payload.uuid.length < 8 ||
      typeof payload.trainNumber !== "string" ||
      !validStationPath(payload.stationIds) ||
      typeof payload.startDateTime !== "string" ||
      Number.isNaN(Date.parse(payload.startDateTime))
    ) {
      return Response.json(
        { error: "Nieprawidłowe dane pociągu." },
        { status: 400 },
      );
    }

    if (!isSeatProviderConfigured()) {
      return Response.json(
        {
          code: "SEAT_PROVIDER_NOT_CONFIGURED",
          error:
            "Rozkład jest niezależny, ale autoryzowane źródło bieżącej dostępności miejsc nie zostało jeszcze podłączone.",
        },
        { status: 503 },
      );
    }

    const offers = await fetchSeatOffers({
      train: {
        id: payload.uuid,
        number: payload.trainNumber,
        departure: payload.startDateTime,
      },
      stationIds: payload.stationIds,
      passengerCount,
      ticketClass,
      bike: Boolean(payload.bike),
      quietZone: Boolean(payload.quietZone),
    });
    const passengers = findSeatPlans({
      stationIds: payload.stationIds,
      passengerCount,
      ticketClass,
      bike: Boolean(payload.bike),
      quietZone: Boolean(payload.quietZone),
      offers: offers as Parameters<typeof findSeatPlans>[0]["offers"],
    });

    return Response.json({
      status: passengers ? "available" : "unavailable",
      passengers: passengers ?? [],
      checkedSegments: (payload.stationIds.length * (payload.stationIds.length - 1)) / 2,
    });
  } catch (error) {
    console.error("Authorized availability lookup failed", error);
    return Response.json(
      { error: "Autoryzowane źródło miejsc nie odpowiedziało prawidłowo." },
      { status: 502 },
    );
  }
}
