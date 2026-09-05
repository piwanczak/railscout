export type Station = {
  id: number;
  name: string;
};

export type Train = {
  uuid: string;
  category: string;
  trainNumber: string;
  trainName: string;
  departure: string;
  arrival: string;
  duration: number;
  changes: number;
  originStationId: number;
  destinationStationId: number;
  departurePlatform: string;
  departureTrack: string;
  arrivalPlatform: string;
  arrivalTrack: string;
  stops: number;
  stationIds: number[];
  stationStops: Array<{
    id: number;
    arrival: string;
    departure: string;
  }>;
  bookingUrl: string | null;
};

export type AvailabilitySegment = {
  from: number;
  to: number;
  timeFrom: string;
  timeTo: string;
  freeSeats: number;
  bookingUrl?: string | null;
  freeSeatsIsLowerBound?: boolean;
  seats: Array<{
    wagon: string;
    seat: string;
    label: string;
  }>;
};

export type CheckState = {
  status:
    | "queued"
    | "checking"
    | "available"
    | "unavailable"
    | "unknown"
    | "error";
  segments?: AvailabilitySegment[];
  checkedAt?: string;
  seatCountIsLowerBound?: boolean;
  minimumFreeSeats?: number | null;
  checkedSegments?: number;
  unknownSegments?: number;
  totalSegments?: number;
  message?: string;
};

export type ScheduleSource = {
  mode: "official-live" | "open-snapshot";
  label: string;
  url: string;
  generatedAt?: string;
  validThrough?: string;
};

export type SearchPhase = "idle" | "loading-trains" | "checking" | "done" | "stopped";
export type SortKey = "recommended" | "departure" | "seats" | "switches";
