import stationRowsJson from "../data/eic-stations.json";

type EicStationRow = [plkId: number, searchCode: number, availabilityCode: number];

type EicStationCodes = {
  searchCode: number;
  availabilityCode: number;
};

const stationByPlkId = new Map<number, EicStationCodes>(
  (stationRowsJson as EicStationRow[]).map(([plkId, searchCode, availabilityCode]) => [
    plkId,
    { searchCode, availabilityCode },
  ]),
);

const SUPPORTED_CATEGORIES = ["EIP", "EIC", "TLK", "ICN", "IC", "EC", "EN"];

function warsawParts(value: string | number | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";

  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
    dateTime: `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`,
  };
}

export function getEicStationCodes(plkId: number) {
  return stationByPlkId.get(plkId) ?? null;
}

export function normaliseEicCategory(value: string) {
  const upper = value.toUpperCase();
  return SUPPORTED_CATEGORIES.find((category) =>
    new RegExp(`(?:^|[/\\s])${category}(?:$|[/\\s])`).test(upper),
  ) ?? "IC";
}

export function normaliseEicTrainNumber(value: string) {
  return value.match(/\d+/)?.[0] ?? value.trim();
}

export function formatEicCompactDateTime(value: string) {
  return (warsawParts(value)?.dateTime ?? "").replace(/[-:T]/g, "").slice(0, 12);
}

export function buildEicBookingUrl(input: {
  originStationId: number;
  destinationStationId: number;
  departure: string;
}) {
  const origin = getEicStationCodes(input.originStationId);
  const destination = getEicStationCodes(input.destinationStationId);
  const departure = new Date(input.departure);
  if (
    !origin ||
    !destination ||
    origin.searchCode <= 0 ||
    destination.searchCode <= 0 ||
    Number.isNaN(departure.getTime())
  ) {
    return null;
  }

  // Starting one minute before departure makes the selected train the first result.
  const searchStart = warsawParts(departure.getTime() - 60_000);
  if (!searchStart) return null;

  const query = new URLSearchParams({
    dwyj: searchStart.date,
    swyj: String(origin.searchCode),
    sprzy: String(destination.searchCode),
    time: searchStart.time,
    przy: "0",
    sprzez: "",
    ticket100: "1010",
    ticket50: "",
    polbez: "0",
  });
  return `https://ebilet.intercity.pl/wyszukiwanie?${query.toString()}`;
}
