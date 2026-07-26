import { fetchSeatAvailability } from "@/app/lib/seat-provider";

type AvailabilityPayload = {
  uuid?: string;
  category?: string;
  trainNumber?: string;
  stationStops?: Array<{
    id?: number;
    arrival?: string;
    departure?: string;
  }>;
  startDateTime?: string;
  arrivalDateTime?: string;
  numberOfPassengers?: number;
  bike?: boolean;
  ticketClass?: 1 | 2;
};

function validStationPath(
  value: AvailabilityPayload["stationStops"],
): value is Array<{ id: number; arrival: string; departure: string }> {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= 80 &&
    value.every(
      (stop) =>
        Boolean(stop) &&
        typeof stop === "object" &&
        Number.isInteger(stop.id) &&
        Number(stop.id) > 0 &&
        typeof stop.arrival === "string" &&
        !Number.isNaN(Date.parse(stop.arrival)) &&
        typeof stop.departure === "string" &&
        !Number.isNaN(Date.parse(stop.departure)),
    ) &&
    new Set(value.map((stop) => stop.id)).size === value.length
  );
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as AvailabilityPayload;
    const ticketClass = payload.ticketClass === 1 ? 1 : 2;
    const numberOfPassengers = payload.numberOfPassengers ?? 1;

    if (
      typeof payload.uuid !== "string" ||
      payload.uuid.length < 8 ||
      typeof payload.category !== "string" ||
      typeof payload.trainNumber !== "string" ||
      !validStationPath(payload.stationStops) ||
      typeof payload.startDateTime !== "string" ||
      Number.isNaN(Date.parse(payload.startDateTime)) ||
      typeof payload.arrivalDateTime !== "string" ||
      Number.isNaN(Date.parse(payload.arrivalDateTime)) ||
      !Number.isInteger(numberOfPassengers) ||
      numberOfPassengers < 1 ||
      numberOfPassengers > 6
    ) {
      return Response.json(
        { error: "Nieprawidłowe dane pociągu." },
        { status: 400 },
      );
    }

    const result = await fetchSeatAvailability({
      train: {
        id: payload.uuid,
        number: payload.trainNumber,
        category: payload.category,
        departure: payload.startDateTime,
        arrival: payload.arrivalDateTime,
      },
      stationStops: payload.stationStops,
      numberOfPassengers,
      ticketClass,
      bike: Boolean(payload.bike),
    });
    return Response.json(result);
  } catch (error) {
    console.error("Seat availability lookup failed", error);
    return Response.json(
      { error: "Nie udało się sprawdzić dostępności miejsc." },
      { status: 502 },
    );
  }
}
