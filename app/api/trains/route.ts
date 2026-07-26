import { isSeatProviderConfigured } from "@/app/lib/seat-provider";
import { searchTimetable, TimetableError } from "@/app/lib/timetable";

type SearchPayload = {
  startStationId?: number;
  endStationId?: number;
  startDateTime?: string;
};

function isValidStationId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as SearchPayload;
    if (
      !isValidStationId(payload.startStationId) ||
      !isValidStationId(payload.endStationId) ||
      payload.startStationId === payload.endStationId ||
      typeof payload.startDateTime !== "string" ||
      Number.isNaN(Date.parse(payload.startDateTime))
    ) {
      return Response.json(
        { error: "Nieprawidłowe dane wyszukiwania." },
        { status: 400 },
      );
    }

    const result = await searchTimetable({
      startStationId: payload.startStationId,
      endStationId: payload.endStationId,
      startDateTime: payload.startDateTime,
    });
    return Response.json({
      ...result,
      availabilityConfigured: isSeatProviderConfigured(),
    });
  } catch (error) {
    console.error("Independent timetable search failed", error);
    if (error instanceof TimetableError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return Response.json(
      { error: "Nie udało się pobrać niezależnego rozkładu." },
      { status: 502 },
    );
  }
}
