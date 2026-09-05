"use client";
import { useEffect, useState } from "react";
import type { Train, CheckState, Station } from "../lib/search-types";
import { seatSwitches, dateKey, formatShortDate, formatTime, formatDuration, freeSeatLabel } from "../lib/search-view";

export function TrainCard({
  train,
  check,
  rank,
  stationById,
  ticketClass,
  numberOfPassengers,
  searchDateTime,
  onRetry,
  retryDisabled,
}: {
  train: Train;
  check: CheckState;
  rank: number;
  stationById: Map<number, Station>;
  ticketClass: 1 | 2;
  numberOfPassengers: number;
  searchDateTime: string;
  onRetry: () => void;
  retryDisabled: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const ageSeconds = check.checkedAt ? Math.max(0, Math.floor((now - Date.parse(check.checkedAt)) / 1000)) : null;
  const switches = seatSwitches(check);
  const isAvailable = check.status === "available";
  const isBest = rank === 1 && isAvailable;
  const freeSeats = check.minimumFreeSeats ?? 0;
  const firstSeat = check.segments?.[0]?.seats[0];
  const departureDate =
    dateKey(train.departure) === dateKey(searchDateTime)
      ? ""
      : formatShortDate(train.departure);
  const arrivalDate =
    dateKey(train.arrival) === dateKey(searchDateTime)
      ? ""
      : formatShortDate(train.arrival);
  const routeLabel =
    switches === 0
      ? "Bez podziału trasy"
      : switches === 1
        ? "1 podział trasy"
        : `${switches} podziały trasy`;

  return (
    <article className={`train-card status-${check.status} ${isBest ? "best" : ""}`}>
      <div className="train-main">
        <div className="train-identity">
          {isBest && <span className="best-flag">NAJLEPSZY WYNIK</span>}
          <small>{train.trainName}</small>
          <strong>{train.trainNumber}</strong>
        </div>

        <div className="train-time">
          <div>
            <strong>{formatTime(train.departure)}</strong>
            <small>
              {departureDate ? `${departureDate} · ` : ""}
              {train.departurePlatform
                ? `peron ${train.departurePlatform}${train.departureTrack ? ` / tor ${train.departureTrack}` : ""}`
                : "odjazd"}
            </small>
          </div>
          <div className="time-rail" aria-label={formatDuration(train.duration)}>
            <span />
            <small>{formatDuration(train.duration)}</small>
          </div>
          <div>
            <strong>{formatTime(train.arrival)}</strong>
            <small>
              {arrivalDate ? `${arrivalDate} · ` : ""}
              {train.arrivalPlatform
                ? `peron ${train.arrivalPlatform}${train.arrivalTrack ? ` / tor ${train.arrivalTrack}` : ""}`
                : "przyjazd"}
            </small>
          </div>
        </div>

        <div className="availability-summary">
          {check.status === "queued" && (
            <span className="status-badge queued">W kolejce</span>
          )}
          {check.status === "checking" && (
            <span className="status-badge checking">
              <i aria-hidden="true" /> Sprawdzanie
            </span>
          )}
          {check.status === "unavailable" && (
            <span className="status-badge unavailable">Brak kombinacji</span>
          )}
          {check.status === "unknown" && (
            <span className="status-badge unknown">Brak danych</span>
          )}
          {check.status === "error" && (
            <span className="status-badge error">Nie sprawdzono</span>
          )}
          {isAvailable && (
            <>
              <span className="status-badge available">
                {check.seatCountIsLowerBound ? "Co najmniej " : ""}{freeSeatLabel(freeSeats)}
              </span>
              <strong className="result-price">
                {numberOfPassengers === 1 && switches === 0 && firstSeat
                  ? `wagon ${firstSeat.wagon} · miejsce ${firstSeat.seat}`
                  : `miejsca dla ${numberOfPassengers} os.`}
              </strong>
              <small>
                {ticketClass} klasa · mapa miejsc e-IC
              </small>
            </>
          )}
        </div>
      </div>

      {check.status === "checking" && (
        <div className="card-progress" aria-hidden="true">
          <span />
        </div>
      )}

      {!isAvailable && train.bookingUrl && check.status !== "checking" && (
        <div className="availability-action">
          <span>{train.category} {train.trainNumber} · odjazd {formatTime(train.departure)}</span>
          <a href={train.bookingUrl} target="_blank" rel="noreferrer">
            Pokaż ten pociąg w e-IC →
          </a>
        </div>
      )}

      {isAvailable && check.segments && (
        <details className="seat-details" open={isBest}>
          <summary>
            <span>{routeLabel}</span>
            <span>Zobacz miejsca</span>
          </summary>
          <div className="passenger-list">
            <section className="passenger-route">
              <div className="segment-list">
                {check.segments.map((segment, segmentIndex) => {
                  const from = stationById.get(segment.from)?.name ?? `Stacja ${segment.from}`;
                  const to = stationById.get(segment.to)?.name ?? `Stacja ${segment.to}`;
                  return (
                    <div className="segment" key={`${segment.from}-${segment.to}-${segmentIndex}`}>
                      <span className="segment-number">{segmentIndex + 1}</span>
                      <div className="segment-route">
                        <strong>
                          {from} <span>→</span> {to}
                        </strong>
                        <small>
                          {formatTime(segment.timeFrom)}–{formatTime(segment.timeTo)} · {ticketClass} klasa
                        </small>
                      </div>
                      <div className="segment-seat">
                        <strong>{segment.freeSeatsIsLowerBound ? "Co najmniej " : ""}{freeSeatLabel(segment.freeSeats)}</strong>
                        <div className="seat-chips" aria-label="Wolne miejsca">
                          {segment.seats.map((seat) => (
                            <span key={`${seat.wagon}-${seat.seat}`}>
                              W{seat.wagon} · {seat.seat}
                            </span>
                          ))}
                        </div>
                        {segment.bookingUrl && <a href={segment.bookingUrl} target="_blank" rel="noreferrer">Kup bilet na ten odcinek →</a>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
          <div className="details-footer">
            <span>
              Miejsca były wolne w chwili sprawdzenia. e-IC potwierdzi przydział
              podczas zakupu.
            </span>
            {train.bookingUrl && switches === 0 && (
              <a href={train.bookingUrl} target="_blank" rel="noreferrer">
                Kup ten pociąg w e-IC →
              </a>
            )}
          </div>
        </details>
      )}

      {["unknown", "error"].includes(check.status) && check.message && (
        <p className="card-message">{check.message}</p>
      )}
      <div className="availability-action">
        <span role="status">{ageSeconds !== null ? `Sprawdzono ${ageSeconds < 60 ? "przed chwilą" : `${Math.floor(ageSeconds / 60)} min temu`}${ageSeconds >= 90 ? " · odśwież przed zakupem" : ""}` : ""}</span>
        <button type="button" className="secondary-button" disabled={retryDisabled} onClick={onRetry}>
          {check.status === "available" ? "Odśwież miejsca" : "Sprawdź ponownie"}
        </button>
      </div>
    </article>
  );
}
