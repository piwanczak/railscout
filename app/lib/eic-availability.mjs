// @ts-check

import { findAvailabilityPlan } from "./seat-planner.mjs";

/** @typedef {{wagon: string, seat: string, label: string}} ExactSeat */

const naturalOrder = new Intl.Collator("pl", {
  numeric: true,
  sensitivity: "base",
});

/** @param {string} value */
function decodeXml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * @param {string} attributes
 * @param {string} name
 */
function attribute(attributes, name) {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"),
  );
  return match ? decodeXml(match[2]) : "";
}

/**
 * @param {ExactSeat[]} seats
 */
export function sortExactSeats(seats) {
  return [...seats].sort(
    (left, right) =>
      naturalOrder.compare(left.wagon, right.wagon) ||
      naturalOrder.compare(left.seat, right.seat),
  );
}

/**
 * Parse the read-only SVG returned by Intercity's GRM wagon endpoint.
 * `status="1"` is the value used by e-IC for a currently free place.
 *
 * @param {unknown} payload
 * @param {{wagon: string | number, ticketClass: 1 | 2, bike: boolean}} options
 */
export function parseGrmSeatMap(payload, options) {
  if (typeof payload !== "string" || !payload.includes("<svg")) {
    return null;
  }

  /** @type {ExactSeat[]} */
  const seats = [];
  let eligiblePlaces = 0;
  let complete = true;
  const seen = new Set();
  const groupPattern = /<g\b([^>]*)>([\s\S]*?)<\/g>/gi;

  for (const match of payload.matchAll(groupPattern)) {
    const label = attribute(match[1], "aria-label");
    const seatMatch = label.match(
      new RegExp(`\\bMiejsce\\s+([0-9A-Za-z-]+)\\s+klasa\\s+${options.ticketClass}\\b`, "i"),
    );
    if (!seatMatch) continue;

    const isBikePlace = /rower/i.test(label);
    const isAccessiblePlace =
      /w[oó]zk|inwalidz|niepe[lł]nospraw/i.test(label);
    const eligible = options.bike
      ? isBikePlace
      : !isBikePlace && !isAccessiblePlace;
    if (!eligible) continue;

    const image = match[2].match(
      /<image\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bplace\b[^"']*["'])[^>]*\bstatus\s*=\s*["']([^"']+)["'][^>]*>/i,
    );
    if (!image || !["1", "3"].includes(image[1]) || seen.has(seatMatch[1])) {
      complete = false;
      continue;
    }
    seen.add(seatMatch[1]);

    eligiblePlaces += 1;
    if (image[1] === "1") {
      seats.push({
        wagon: String(options.wagon),
        seat: seatMatch[1],
        label: label.replace(/\s+/g, " ").trim(),
      });
    }
  }

  return {
    seats: sortExactSeats(seats),
    eligiblePlaces,
    complete,
  };
}

/** @param {ExactSeat} seat */
function seatKey(seat) {
  return `${seat.wagon}:${seat.seat}`;
}

/**
 * @param {ExactSeat[][]} seatLists
 */
function intersectExactSeats(seatLists) {
  if (seatLists.length === 0) return [];
  const remaining = new Map(
    seatLists[0].map((seat) => [seatKey(seat), seat]),
  );

  for (const seats of seatLists.slice(1)) {
    const keys = new Set(seats.map(seatKey));
    for (const key of remaining.keys()) {
      if (!keys.has(key)) remaining.delete(key);
    }
  }

  return sortExactSeats([...remaining.values()]);
}

/**
 * @typedef {object} LegInventory
 * @property {"available" | "unavailable" | "unknown"} state
 * @property {ExactSeat[]} seats
 */

/**
 * @typedef {object} SegmentOutcome
 * @property {number} from
 * @property {number} to
 * @property {number} fromIndex
 * @property {number} toIndex
 * @property {string} timeFrom
 * @property {string} timeTo
 * @property {"available" | "unavailable" | "unknown"} state
 * @property {ExactSeat[]} seats
 * @property {number} freeSeats
 */

/**
 * Derive every contiguous station-pair result from exact adjacent-leg maps.
 * A place is free for a longer segment only when the same wagon/seat is free
 * on every adjacent leg in that segment.
 *
 * @param {{
 *   stationStops: Array<{id: number, arrival: string, departure: string}>,
 *   legInventories: LegInventory[],
 *   numberOfPassengers: number,
 *   directOutcome?: SegmentOutcome | null,
 * }} input
 */
export function deriveExactSegmentOutcomes(input) {
  /** @type {SegmentOutcome[]} */
  const outcomes = [];
  const lastIndex = input.stationStops.length - 1;

  for (let fromIndex = 0; fromIndex < lastIndex; fromIndex += 1) {
    for (let toIndex = fromIndex + 1; toIndex <= lastIndex; toIndex += 1) {
      const from = input.stationStops[fromIndex];
      const to = input.stationStops[toIndex];
      const legs = input.legInventories.slice(fromIndex, toIndex);
      const base = {
        from: from.id,
        to: to.id,
        fromIndex,
        toIndex,
        timeFrom: from.departure,
        timeTo: to.arrival,
      };

      if (legs.length !== toIndex - fromIndex || legs.some((leg) => leg.state === "unknown")) {
        outcomes.push({
          ...base,
          state: "unknown",
          seats: [],
          freeSeats: 0,
        });
        continue;
      }

      const commonSeats = intersectExactSeats(legs.map((leg) => leg.seats));
      outcomes.push({
        ...base,
        state:
          commonSeats.length >= input.numberOfPassengers
            ? "available"
            : "unavailable",
        seats: commonSeats.slice(0, input.numberOfPassengers),
        freeSeats: commonSeats.length,
      });
    }
  }

  if (input.directOutcome && input.directOutcome.state !== "unknown") {
    const directIndex = outcomes.findIndex(
      (outcome) =>
        outcome.from === input.stationStops[0]?.id &&
        outcome.to === input.stationStops.at(-1)?.id,
    );
    if (directIndex >= 0) outcomes[directIndex] = input.directOutcome;
  }

  return outcomes;
}

/**
 * @param {{stationIds: number[], outcomes: SegmentOutcome[]}} input
 */
export function summariseExactAvailability(input) {
  const availableSegments = input.outcomes.filter(
    (outcome) => outcome.state === "available" && outcome.freeSeats > 0,
  );
  const plan = findAvailabilityPlan({
    stationIds: input.stationIds,
    segments: availableSegments,
  });
  const unknownSegments = input.outcomes.filter(
    (outcome) => outcome.state === "unknown",
  ).length;
  const checkedSegments = input.outcomes.length - unknownSegments;

  if (plan) {
    return {
      status: /** @type {const} */ ("available"),
      segments: plan,
      minimumFreeSeats: Math.min(...plan.map((segment) => segment.freeSeats)),
      checkedSegments,
      unknownSegments,
      totalSegments: input.outcomes.length,
    };
  }

  const missingStatus =
    unknownSegments > 0
      ? /** @type {const} */ ("unknown")
      : /** @type {const} */ ("unavailable");
  return {
    status: missingStatus,
    segments: [],
    minimumFreeSeats: null,
    checkedSegments,
    unknownSegments,
    totalSegments: input.outcomes.length,
  };
}
