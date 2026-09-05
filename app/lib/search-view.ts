import type { CheckState } from "./search-types";
import { warsawClock } from "./rail-time.mjs";
const WARSAW_TIME_ZONE = "Europe/Warsaw";

export function localDefaults() {
  const rounded = new Date(
    Math.ceil((Date.now() + 15 * 60_000) / (15 * 60_000)) * 15 * 60_000,
  );
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WARSAW_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(rounded);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

export function toIsoWithOffset(date: string, time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return warsawClock(date, hour * 60 + minute);
}

export function normaliseStationName(value: string) {
  return value.trim().toLocaleLowerCase("pl");
}

export function formatTime(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: WARSAW_TIME_ZONE,
  }).format(new Date(value));
}

export function formatDate(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("pl-PL", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: WARSAW_TIME_ZONE,
  }).format(new Date(value));
}

export function dateKey(value: string) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: WARSAW_TIME_ZONE,
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("pl-PL", {
    day: "numeric",
    month: "short",
    timeZone: WARSAW_TIME_ZONE,
  }).format(new Date(value));
}

export function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours} h ${rest} min` : `${rest} min`;
}

export function seatSwitches(check?: CheckState) {
  if (!check?.segments?.length) return Number.POSITIVE_INFINITY;
  return Math.max(0, check.segments.length - 1);
}

export function availableSeatCount(check?: CheckState) {
  return check?.minimumFreeSeats ?? -1;
}

export function statusRank(check?: CheckState) {
  return {
    available: 0,
    checking: 1,
    queued: 2,
    unavailable: 3,
    unknown: 4,
    error: 5,
  }[check?.status ?? "queued"];
}

export function pluralConnections(count: number) {
  if (count === 1) return "połączenie";
  if (count >= 2 && count <= 4) return "połączenia";
  return "połączeń";
}

export function freeSeatLabel(count: number) {
  if (count === 1) return "1 wolne miejsce";
  if (count >= 2 && count <= 4) return `${count} wolne miejsca`;
  return `${count} wolnych miejsc`;
}
