// @ts-check

import { findAvailabilityPlan } from "./seat-planner.mjs";

/** @typedef {{type?: string, occupancyPercent?: number}} FrequencyEntry */

/**
 * Read the occupancy signal used by e-IC for the chosen class and place type.
 *
 * @param {unknown} payload
 * @param {1 | 2} ticketClass
 * @param {boolean} bike
 */
export function occupancyFromFrequency(payload, ticketClass, bike) {
  if (!payload || typeof payload !== "object") return null;
  const key = ticketClass === 1 ? "CLASS1" : "CLASS2";
  const entries = /** @type {Record<string, unknown>} */ (payload)[key];
  if (!Array.isArray(entries)) return null;

  const wantedType = bike ? "BIKE" : "COMMON";
  const entry = /** @type {FrequencyEntry | undefined} */ (
    entries.find((item) => item && typeof item === "object" && item.type === wantedType)
  );
  const value = Number(entry?.occupancyPercent);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(100, value);
}

/**
 * @typedef {object} SegmentOutcome
 * @property {number} from
 * @property {number} to
 * @property {string} timeFrom
 * @property {string} timeTo
 * @property {"available" | "unavailable" | "unknown"} state
 * @property {number} [occupancyPercent]
 */

/**
 * Combine every checked station pair into the best complete route.
 *
 * @param {{stationIds: number[], outcomes: SegmentOutcome[]}} input
 */
export function summariseAvailability(input) {
  const availableSegments = input.outcomes.flatMap((outcome) =>
    outcome.state === "available" && Number.isFinite(outcome.occupancyPercent)
      ? [
          {
            from: outcome.from,
            to: outcome.to,
            timeFrom: outcome.timeFrom,
            timeTo: outcome.timeTo,
            occupancyPercent: Number(outcome.occupancyPercent),
          },
        ]
      : [],
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
      peakOccupancy: Math.max(...plan.map((segment) => segment.occupancyPercent)),
      checkedSegments,
      unknownSegments,
      totalSegments: input.outcomes.length,
    };
  }

  return {
    status: /** @type {const} */ (unknownSegments > 0 ? "unknown" : "unavailable"),
    segments: [],
    peakOccupancy: null,
    checkedSegments,
    unknownSegments,
    totalSegments: input.outcomes.length,
  };
}
