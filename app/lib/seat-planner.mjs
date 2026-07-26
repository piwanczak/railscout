// @ts-check

/**
 * Return every directed station pair on a train's requested route.
 *
 * @param {number[]} stationIds
 */
export function everySegment(stationIds) {
  const segments = [];
  for (let fromIndex = 0; fromIndex < stationIds.length - 1; fromIndex += 1) {
    for (let toIndex = fromIndex + 1; toIndex < stationIds.length; toIndex += 1) {
      segments.push({ from: stationIds[fromIndex], to: stationIds[toIndex] });
    }
  }
  return segments;
}

/**
 * @typedef {object} AvailabilitySegment
 * @property {number} from
 * @property {number} to
 * @property {string} timeFrom
 * @property {string} timeTo
 * @property {number} freeSeats
 * @property {Array<{wagon: string, seat: string, label: string}>} seats
 */

/**
 * Pick a complete route through available segments. The fewest ticket splits
 * wins; more spare seats on the weakest segment and then in total break ties.
 *
 * @param {{stationIds: number[], segments: AvailabilitySegment[]}} input
 * @returns {AvailabilitySegment[] | null}
 */
export function findAvailabilityPlan(input) {
  const stationIndex = new Map(input.stationIds.map((id, index) => [id, index]));
  const segments = input.segments.filter((segment) => {
    const from = stationIndex.get(Number(segment.from));
    const to = stationIndex.get(Number(segment.to));
    return (
      from !== undefined &&
      to !== undefined &&
      from < to &&
      Number.isFinite(segment.freeSeats) &&
      segment.freeSeats > 0
    );
  });

  /** @type {Array<{segments: AvailabilitySegment[], minimum: number, sum: number} | null>} */
  const bestAt = Array.from({ length: input.stationIds.length }, () => null);
  bestAt[0] = {
    segments: [],
    minimum: Number.POSITIVE_INFINITY,
    sum: 0,
  };

  for (let fromIndex = 0; fromIndex < input.stationIds.length - 1; fromIndex += 1) {
    const current = bestAt[fromIndex];
    if (!current) continue;

    for (const segment of segments) {
      if (stationIndex.get(Number(segment.from)) !== fromIndex) continue;
      const toIndex = stationIndex.get(Number(segment.to));
      if (toIndex === undefined) continue;

      const candidate = {
        segments: [...current.segments, segment],
        minimum: Math.min(current.minimum, segment.freeSeats),
        sum: current.sum + segment.freeSeats,
      };
      const existing = bestAt[toIndex];

      if (
        !existing ||
        candidate.segments.length < existing.segments.length ||
        (candidate.segments.length === existing.segments.length &&
          (candidate.minimum > existing.minimum ||
            (candidate.minimum === existing.minimum && candidate.sum > existing.sum)))
      ) {
        bestAt[toIndex] = candidate;
      }
    }
  }

  return bestAt.at(-1)?.segments ?? null;
}
