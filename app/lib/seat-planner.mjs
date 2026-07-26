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
 * @property {number} occupancyPercent
 */

/**
 * Pick a complete route through available segments. The fewest ticket splits
 * wins; lower peak occupancy and then lower average occupancy break ties.
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
      Number.isFinite(segment.occupancyPercent) &&
      segment.occupancyPercent >= 0 &&
      segment.occupancyPercent < 100
    );
  });

  /** @type {Array<{segments: AvailabilitySegment[], peak: number, sum: number} | null>} */
  const bestAt = Array.from({ length: input.stationIds.length }, () => null);
  bestAt[0] = { segments: [], peak: 0, sum: 0 };

  for (let fromIndex = 0; fromIndex < input.stationIds.length - 1; fromIndex += 1) {
    const current = bestAt[fromIndex];
    if (!current) continue;

    for (const segment of segments) {
      if (stationIndex.get(Number(segment.from)) !== fromIndex) continue;
      const toIndex = stationIndex.get(Number(segment.to));
      if (toIndex === undefined) continue;

      const candidate = {
        segments: [...current.segments, segment],
        peak: Math.max(current.peak, segment.occupancyPercent),
        sum: current.sum + segment.occupancyPercent,
      };
      const existing = bestAt[toIndex];
      const candidateAverage = candidate.sum / candidate.segments.length;
      const existingAverage = existing
        ? existing.sum / existing.segments.length
        : Number.POSITIVE_INFINITY;

      if (
        !existing ||
        candidate.segments.length < existing.segments.length ||
        (candidate.segments.length === existing.segments.length &&
          (candidate.peak < existing.peak ||
            (candidate.peak === existing.peak && candidateAverage < existingAverage)))
      ) {
        bestAt[toIndex] = candidate;
      }
    }
  }

  return bestAt.at(-1)?.segments ?? null;
}
