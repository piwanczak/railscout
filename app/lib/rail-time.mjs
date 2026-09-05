// @ts-check
const zone = "Europe/Warsaw";
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** @param {string | number | Date} value */
export function warsawDate(value) {
  const parts = formatter.formatToParts(new Date(value));
  const get = (/** @type {string} */ name) => parts.find(p => p.type === name)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** @param {string} date @param {number} days */
export function addDays(date, days) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/** Resolve a local clock. Reject times in the spring clock-change gap.
 * @param {string} date @param {number} minutes
 */
export function warsawClock(date, minutes) {
  const target = Date.parse(`${date}T00:00:00Z`) + Math.round(minutes * 60000);
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const parts = formatter.formatToParts(new Date(instant));
    const get = (/** @type {string} */ name) => Number(parts.find(p => p.type === name)?.value);
    const represented = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    if (represented === target) return new Date(instant).toISOString();
    instant += target - represented;
  }
  throw new Error("Ta godzina nie istnieje w dniu zmiany czasu. Wybierz inną godzinę.");
}

/** GTFS time starts at local noon minus 12 elapsed hours.
 * https://gtfs.org/documentation/schedule/reference/#stop_timestxt
 * @param {string} date @param {number} minutes
 */
export function gtfsTimestamp(date, minutes) {
  return new Date(Date.parse(warsawClock(date, 720)) + (minutes - 720) * 60000).toISOString();
}

/** Find service dates that can reach the boarding station on the requested date.
 * @param {string[]} dates @param {string} requestedDate @param {number} departureMinutes
 */
export function boardingServices(dates, requestedDate, departureMinutes) {
  const earliest = addDays(requestedDate, -Math.ceil(departureMinutes / 1440) - 1);
  return dates.filter(date => date >= earliest && date <= requestedDate)
    .filter(date => warsawDate(gtfsTimestamp(date, departureMinutes)) === requestedDate);
}
