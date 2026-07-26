import { everySegment } from "./seat-planner.mjs";

export type SeatInventoryRequest = {
  train: {
    id: string;
    number: string;
    departure: string;
  };
  stationIds: number[];
  passengerCount: number;
  ticketClass: 1 | 2;
  bike: boolean;
  quietZone: boolean;
};

type SeatInventoryResponse = {
  offers?: unknown[];
};

function providerConfiguration() {
  const endpoint = process.env.SEAT_INVENTORY_API_URL?.trim() ?? "";
  const token = process.env.SEAT_INVENTORY_API_TOKEN?.trim() ?? "";
  try {
    const url = new URL(endpoint);
    if (!/^https?:$/.test(url.protocol) || !token) return null;
    return { endpoint: url.toString(), token };
  } catch {
    return null;
  }
}

export function isSeatProviderConfigured() {
  return providerConfiguration() !== null;
}

export async function fetchSeatOffers(input: SeatInventoryRequest) {
  const configuration = providerConfiguration();
  if (!configuration) {
    throw new Error("SEAT_PROVIDER_NOT_CONFIGURED");
  }

  const response = await fetch(configuration.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${configuration.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version: 1,
      train: input.train,
      passengers: {
        count: input.passengerCount,
        class: input.ticketClass,
        bike: input.bike,
        quietZone: input.quietZone,
      },
      segments: everySegment(input.stationIds),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`SEAT_PROVIDER_HTTP_${response.status}`);
  }

  const payload = (await response.json()) as SeatInventoryResponse;
  if (!Array.isArray(payload.offers)) {
    throw new Error("SEAT_PROVIDER_INVALID_RESPONSE");
  }
  return payload.offers;
}
