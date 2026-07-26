// @ts-check

/**
 * @typedef {object} SeatOffer
 * @property {number} passengerIndex
 * @property {number} from
 * @property {number} to
 * @property {string} [timeFrom]
 * @property {string} [timeTo]
 * @property {number} price
 * @property {boolean} seated
 * @property {number} [class]
 * @property {string} [wagon]
 * @property {string} [seat]
 * @property {boolean} [hasBike]
 * @property {boolean} [hasQuiet]
 */

/**
 * Return every directed station pair on a train's requested route.
 * The inventory adapter receives the whole batch in one request.
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
 * Choose a complete seated path for every passenger. Fewer seat changes wins;
 * price breaks ties. The route is a DAG because offers always move forward.
 *
 * @param {{
 *   stationIds: number[],
 *   passengerCount: number,
 *   ticketClass: 1 | 2,
 *   bike: boolean,
 *   quietZone: boolean,
 *   offers: SeatOffer[]
 * }} input
 * @returns {Array<{passengerIndex: number, tickets: SeatOffer[]}> | null}
 */
export function findSeatPlans(input) {
  const stationIndex = new Map(input.stationIds.map((id, index) => [id, index]));
  const plans = [];

  for (let passengerIndex = 1; passengerIndex <= input.passengerCount; passengerIndex += 1) {
    const offers = input.offers.filter((offer) => {
      const from = stationIndex.get(Number(offer.from));
      const to = stationIndex.get(Number(offer.to));
      return (
        Number(offer.passengerIndex) === passengerIndex &&
        from !== undefined &&
        to !== undefined &&
        from < to &&
        Boolean(offer.seated) &&
        (!input.bike || Boolean(offer.hasBike)) &&
        (!input.quietZone || Boolean(offer.hasQuiet)) &&
        Number(offer.class ?? input.ticketClass) === input.ticketClass
      );
    });

    /** @type {Array<{tickets: SeatOffer[], price: number} | null>} */
    const bestAt = Array.from({ length: input.stationIds.length }, () => null);
    bestAt[0] = { tickets: [], price: 0 };

    for (let fromIndex = 0; fromIndex < input.stationIds.length - 1; fromIndex += 1) {
      const current = bestAt[fromIndex];
      if (!current) continue;

      for (const offer of offers) {
        if (stationIndex.get(Number(offer.from)) !== fromIndex) continue;
        const toIndex = stationIndex.get(Number(offer.to));
        if (toIndex === undefined) continue;

        const ticket = {
          ...offer,
          passengerIndex,
          from: Number(offer.from),
          to: Number(offer.to),
          timeFrom: String(offer.timeFrom ?? ""),
          timeTo: String(offer.timeTo ?? ""),
          price: Math.max(0, Math.round(Number(offer.price) || 0)),
          seated: true,
          class: input.ticketClass,
          wagon: String(offer.wagon ?? ""),
          seat: String(offer.seat ?? ""),
          hasBike: Boolean(offer.hasBike),
          hasQuiet: Boolean(offer.hasQuiet),
        };
        const candidate = {
          tickets: [...current.tickets, ticket],
          price: current.price + ticket.price,
        };
        const existing = bestAt[toIndex];
        if (
          !existing ||
          candidate.tickets.length < existing.tickets.length ||
          (candidate.tickets.length === existing.tickets.length &&
            candidate.price < existing.price)
        ) {
          bestAt[toIndex] = candidate;
        }
      }
    }

    const complete = bestAt.at(-1);
    if (!complete) return null;
    plans.push({ passengerIndex, tickets: complete.tickets });
  }

  return plans;
}
