import { searchTimetable, TimetableError } from "@/app/lib/timetable";
import {
  HttpInputError,
  jsonResponse,
  readJsonBody,
} from "@/app/lib/http";

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
    const payload = await readJsonBody<SearchPayload>(request);
    if (
      !isValidStationId(payload.startStationId) ||
      !isValidStationId(payload.endStationId) ||
      payload.startStationId === payload.endStationId ||
      typeof payload.startDateTime !== "string" ||
      Number.isNaN(Date.parse(payload.startDateTime))
    ) {
      return jsonResponse(
        { error: "Nieprawidłowe dane wyszukiwania." },
        { status: 400 },
      );
    }

    const result = await searchTimetable({
      startStationId: payload.startStationId,
      endStationId: payload.endStationId,
      startDateTime: payload.startDateTime,
    });
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof HttpInputError) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }
    console.error("Independent timetable search failed", error);
    if (error instanceof TimetableError) {
      return jsonResponse(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return jsonResponse(
      { error: "Nie udało się pobrać niezależnego rozkładu." },
      { status: 502 },
    );
  }
}
