"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Station = {
  id: number;
  name: string;
  slug: string;
  city: string;
};

type Train = {
  uuid: string;
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
  bookingUrl: string;
};

type Ticket = {
  from: number;
  to: number;
  timeFrom: string;
  timeTo: string;
  price: number;
  seated: boolean;
  class: number;
  wagon: string;
  seat: string;
  hasBike: boolean;
  hasQuiet: boolean;
};

type PassengerResult = {
  passengerIndex: number;
  tickets: Ticket[];
};

type CheckState = {
  status:
    | "queued"
    | "checking"
    | "available"
    | "unavailable"
    | "not-connected"
    | "error";
  passengers?: PassengerResult[];
  message?: string;
};

type ScheduleSource = {
  mode: "official-live" | "open-snapshot";
  label: string;
  url: string;
  generatedAt?: string;
  validThrough?: string;
};

type SearchPhase = "idle" | "loading-trains" | "checking" | "done";
type SortKey = "recommended" | "departure" | "price" | "switches";

const PARALLEL_CHECKS = 4;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function localDefaults() {
  const now = new Date();
  const rounded = new Date(now.getTime() + 15 * 60 * 1000);
  rounded.setMinutes(Math.ceil(rounded.getMinutes() / 15) * 15, 0, 0);

  return {
    date: `${rounded.getFullYear()}-${pad(rounded.getMonth() + 1)}-${pad(rounded.getDate())}`,
    time: `${pad(rounded.getHours())}:${pad(rounded.getMinutes())}`,
  };
}

function toIsoWithOffset(date: string, time: string) {
  const local = new Date(`${date}T${time}:00`);
  const offset = -local.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return `${date}T${time}:00.000${sign}${hours}:${minutes}`;
}

function normaliseStationName(value: string) {
  return value.trim().toLocaleLowerCase("pl");
}

function formatTime(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("pl-PL", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(value));
}

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours} h ${rest} min` : `${rest} min`;
}

function formatMoney(grosze: number) {
  return new Intl.NumberFormat("pl-PL", {
    style: "currency",
    currency: "PLN",
  }).format(grosze / 100);
}

function totalPrice(check?: CheckState) {
  if (!check?.passengers) return Number.POSITIVE_INFINITY;
  return check.passengers.reduce(
    (total, passenger) =>
      total + passenger.tickets.reduce((sum, ticket) => sum + ticket.price, 0),
    0,
  );
}

function seatSwitches(check?: CheckState) {
  if (!check?.passengers?.length) return Number.POSITIVE_INFINITY;
  return Math.max(
    ...check.passengers.map((passenger) =>
      Math.max(0, passenger.tickets.length - 1),
    ),
  );
}

function statusRank(check?: CheckState) {
  return {
    available: 0,
    checking: 1,
    queued: 2,
    "not-connected": 3,
    unavailable: 4,
    error: 5,
  }[check?.status ?? "queued"];
}

function pluralConnections(count: number) {
  if (count === 1) return "połączenie";
  if (count >= 2 && count <= 4) return "połączenia";
  return "połączeń";
}

export function SeatSweepApp() {
  const [stations, setStations] = useState<Station[]>([]);
  const [originName, setOriginName] = useState("Warszawa Centralna");
  const [destinationName, setDestinationName] = useState("Kraków Główny");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [passengers, setPassengers] = useState(1);
  const [ticketClass, setTicketClass] = useState<1 | 2>(2);
  const [quietZone, setQuietZone] = useState(false);
  const [bike, setBike] = useState(false);
  const [phase, setPhase] = useState<SearchPhase>("idle");
  const [trains, setTrains] = useState<Train[]>([]);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [sortKey, setSortKey] = useState<SortKey>("recommended");
  const [error, setError] = useState("");
  const [availabilityConfigured, setAvailabilityConfigured] = useState<
    boolean | null
  >(null);
  const [scheduleSource, setScheduleSource] = useState<ScheduleSource | null>(
    null,
  );
  const [sourceWarning, setSourceWarning] = useState("");
  const [searchedRoute, setSearchedRoute] = useState<{
    origin: Station;
    destination: Station;
    dateTime: string;
  } | null>(null);
  const searchToken = useRef(0);
  const searchController = useRef<AbortController | null>(null);

  useEffect(() => {
    const defaults = localDefaults();
    // These values depend on the visitor's local clock and must be set after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDate(defaults.date);
    setTime(defaults.time);

    fetch("/stations.json")
      .then((response) => {
        if (!response.ok) throw new Error("Station catalogue unavailable");
        return response.json() as Promise<Station[]>;
      })
      .then(setStations)
      .catch(() => setError("Nie udało się wczytać listy stacji."));
  }, []);

  useEffect(
    () => () => {
      searchController.current?.abort();
    },
    [],
  );

  const stationByName = useMemo(
    () =>
      new Map(
        stations.map((station) => [normaliseStationName(station.name), station]),
      ),
    [stations],
  );

  const stationById = useMemo(
    () => new Map(stations.map((station) => [station.id, station])),
    [stations],
  );

  const progress = useMemo(() => {
    const values = Object.values(checks);
    const finished = values.filter((check) =>
      ["available", "unavailable", "not-connected", "error"].includes(
        check.status,
      ),
    ).length;
    const available = values.filter(
      (check) => check.status === "available",
    ).length;
    const active = values.filter((check) => check.status === "checking").length;
    return { finished, available, active, total: trains.length };
  }, [checks, trains.length]);

  const sortedTrains = useMemo(() => {
    const next = [...trains];
    next.sort((left, right) => {
      const leftCheck = checks[left.uuid];
      const rightCheck = checks[right.uuid];

      if (sortKey === "departure") {
        return Date.parse(left.departure) - Date.parse(right.departure);
      }

      if (sortKey === "price") {
        return (
          totalPrice(leftCheck) - totalPrice(rightCheck) ||
          Date.parse(left.departure) - Date.parse(right.departure)
        );
      }

      if (sortKey === "switches") {
        return (
          seatSwitches(leftCheck) - seatSwitches(rightCheck) ||
          totalPrice(leftCheck) - totalPrice(rightCheck) ||
          Date.parse(left.departure) - Date.parse(right.departure)
        );
      }

      return (
        statusRank(leftCheck) - statusRank(rightCheck) ||
        seatSwitches(leftCheck) - seatSwitches(rightCheck) ||
        totalPrice(leftCheck) - totalPrice(rightCheck) ||
        Date.parse(left.departure) - Date.parse(right.departure)
      );
    });
    return next;
  }, [checks, sortKey, trains]);

  function swapStations() {
    setOriginName(destinationName);
    setDestinationName(originName);
  }

  function updateCheck(uuid: string, state: CheckState) {
    setChecks((current) => ({ ...current, [uuid]: state }));
  }

  async function checkEveryTrain(
    candidates: Train[],
    token: number,
    controller: AbortController,
  ) {
    let cursor = 0;

    async function worker() {
      while (cursor < candidates.length) {
        const index = cursor;
        cursor += 1;
        const train = candidates[index];
        if (token !== searchToken.current || controller.signal.aborted) return;

        updateCheck(train.uuid, { status: "checking" });

        try {
          const response = await fetch("/api/availability", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              uuid: train.uuid,
              trainNumber: train.trainNumber,
              stationIds: train.stationIds,
              startDateTime: train.departure,
              numberOfPassengers: passengers,
              bike,
              quietZone,
              ticketClass,
            }),
          });

          const result = (await response.json()) as {
            status?: "available" | "unavailable";
            passengers?: PassengerResult[];
            error?: string;
          };

          if (token !== searchToken.current) return;
          if (!response.ok || result.error) {
            updateCheck(train.uuid, {
              status: "error",
              message: result.error ?? "Sprawdzenie nie powiodło się.",
            });
          } else if (result.status === "available") {
            updateCheck(train.uuid, {
              status: "available",
              passengers: result.passengers ?? [],
            });
          } else {
            updateCheck(train.uuid, { status: "unavailable", passengers: [] });
          }
        } catch (lookupError) {
          if (
            lookupError instanceof Error &&
            lookupError.name === "AbortError"
          ) {
            return;
          }
          if (token === searchToken.current) {
            updateCheck(train.uuid, {
              status: "error",
              message: "Brak odpowiedzi.",
            });
          }
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(PARALLEL_CHECKS, candidates.length) },
        worker,
      ),
    );

    if (token === searchToken.current && !controller.signal.aborted) {
      setPhase("done");
    }
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const origin = stationByName.get(normaliseStationName(originName));
    const destination = stationByName.get(
      normaliseStationName(destinationName),
    );

    if (!origin || !destination) {
      setError("Wybierz obie stacje z podpowiedzi.");
      return;
    }
    if (origin.id === destination.id) {
      setError("Stacja początkowa i końcowa muszą być różne.");
      return;
    }
    if (!date || !time) {
      setError("Wybierz datę i godzinę wyjazdu.");
      return;
    }

    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    const token = searchToken.current + 1;
    searchToken.current = token;
    const dateTime = toIsoWithOffset(date, time);

    setPhase("loading-trains");
    setTrains([]);
    setChecks({});
    setAvailabilityConfigured(null);
    setScheduleSource(null);
    setSourceWarning("");
    setSearchedRoute({ origin, destination, dateTime });

    try {
      const response = await fetch("/api/trains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          startStationId: origin.id,
          endStationId: destination.id,
          startDateTime: dateTime,
          numberOfPassengers: passengers,
        }),
      });
      const result = (await response.json()) as {
        trains?: Train[];
        availabilityConfigured?: boolean;
        source?: ScheduleSource;
        warning?: string;
        error?: string;
      };

      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Nie udało się pobrać połączeń.");
      }

      const candidates = result.trains ?? [];
      const canCheckSeats = Boolean(result.availabilityConfigured);
      setAvailabilityConfigured(canCheckSeats);
      setScheduleSource(result.source ?? null);
      setSourceWarning(result.warning ?? "");
      if (candidates.length === 0) {
        setPhase("done");
        setError("Brak połączeń o tej godzinie. Zmień godzinę i spróbuj ponownie.");
        return;
      }

      setTrains(candidates);
      setChecks(
        Object.fromEntries(
          candidates.map((train) => [
            train.uuid,
            { status: canCheckSeats ? "queued" : "not-connected" },
          ]),
        ),
      );
      if (!canCheckSeats) {
        setPhase("done");
        return;
      }
      setPhase("checking");

      void checkEveryTrain(
        candidates,
        token,
        controller,
      );
    } catch (searchError) {
      if (searchError instanceof Error && searchError.name === "AbortError") {
        return;
      }
      setPhase("done");
      setError(
        searchError instanceof Error
          ? searchError.message
          : "Nie udało się rozpocząć wyszukiwania.",
      );
    }
  }

  const isBusy = phase === "loading-trains" || phase === "checking";
  const showResults = phase !== "idle" || trains.length > 0;

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="RailScout — początek strony">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <span>RailScout</span>
          <small>private beta</small>
        </a>
        <div className="topbar-note">
          <span className="live-dot" aria-hidden="true" />
          {availabilityConfigured
            ? "Autoryzowane dane miejsc: połączone"
            : "Rozkład: otwarte dane kolejowe"}
        </div>
      </header>

      <section className={`hero ${showResults ? "hero-compact" : ""}`} id="top">
        <div className="hero-copy">
          <p className="eyebrow">LOKALNY WYSZUKIWACZ MIEJSC</p>
          <h1>
            Jedno wyszukanie.
            <br />
            <em>Wszystkie miejsca.</em>
          </h1>
          <p className="hero-lede">
            RailScout ma własny silnik podziałów trasy i niezależny rozkład.
            Dostępność miejsc jest sprawdzana wyłącznie po podłączeniu
            autoryzowanego źródła — bez scrapingu cudzej usługi.
          </p>
          <div className="promise-row" aria-label="Zakres wyszukiwania">
            <span>Każdy widoczny pociąg</span>
            <span>Każdy sensowny podział</span>
            <span>Jeden czytelny ranking</span>
          </div>
        </div>

        {!showResults && (
          <div className="scan-preview" aria-label="Podgląd działania">
            <div className="preview-heading">
              <span>Niezależny pipeline</span>
              <b>bez PlaceFinder</b>
            </div>
            <div className="rail-line" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="preview-list">
              <div>
                <small>IC 8300 · 11:40</small>
                <strong className="preview-found">Rozkład gotowy</strong>
              </div>
              <div>
                <small>EIP 5302 · 13:44</small>
                <strong className="preview-checking">Wszystkie segmenty</strong>
              </div>
              <div>
                <small>IC 8352 · 14:40</small>
                <strong className="preview-queued">Własny ranking</strong>
              </div>
            </div>
            <p>Jedna autoryzowana odpowiedź zasila wszystkie możliwe podziały trasy.</p>
          </div>
        )}
      </section>

      <section className={`search-panel ${showResults ? "search-panel-compact" : ""}`}>
        <form onSubmit={handleSearch}>
          <div className="route-fields">
            <label className="field field-station">
              <span>Skąd</span>
              <input
                type="text"
                list="rail-stations"
                value={originName}
                onChange={(event) => setOriginName(event.target.value)}
                placeholder="Wpisz stację początkową"
                autoComplete="off"
                required
              />
            </label>
            <button
              type="button"
              className="swap-button"
              onClick={swapStations}
              aria-label="Zamień stacje"
            >
              ⇄
            </button>
            <label className="field field-station">
              <span>Dokąd</span>
              <input
                type="text"
                list="rail-stations"
                value={destinationName}
                onChange={(event) => setDestinationName(event.target.value)}
                placeholder="Wpisz stację końcową"
                autoComplete="off"
                required
              />
            </label>
          </div>

          <datalist id="rail-stations">
            {stations.map((station) => (
              <option key={station.id} value={station.name}>
                {station.city && station.city !== station.name ? station.city : "Polska"}
              </option>
            ))}
          </datalist>

          <div className="detail-fields">
            <label className="field">
              <span>Data</span>
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Najwcześniej o</span>
              <input
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Pasażerowie</span>
              <input
                type="number"
                min="1"
                max="6"
                value={passengers}
                onChange={(event) =>
                  setPassengers(
                    Math.min(6, Math.max(1, Number(event.target.value))),
                  )
                }
              />
            </label>
            <label className="field">
              <span>Klasa</span>
              <select
                value={ticketClass}
                onChange={(event) =>
                  setTicketClass(Number(event.target.value) as 1 | 2)
                }
              >
                <option value="2">2 klasa</option>
                <option value="1">1 klasa</option>
              </select>
            </label>
          </div>

          <div className="search-actions">
            <div className="preference-row">
              <label className="check-pill">
                <input
                  type="checkbox"
                  checked={quietZone}
                  onChange={(event) => setQuietZone(event.target.checked)}
                />
                <span>Cicha strefa</span>
              </label>
              <label className="check-pill">
                <input
                  type="checkbox"
                  checked={bike}
                  onChange={(event) => setBike(event.target.checked)}
                />
                <span>Rower</span>
              </label>
            </div>
            <button
              type="submit"
              className="search-button"
              disabled={stations.length === 0 || isBusy}
            >
              {phase === "loading-trains"
                ? "Pobieram połączenia…"
                : phase === "checking"
                  ? "Sprawdzanie w toku"
                  : "Znajdź wszystkie połączenia"}
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>

      {showResults && searchedRoute && (
        <section className="results-section" aria-labelledby="results-title">
          <div className="results-heading">
            <div>
              <p className="eyebrow">WYNIKI ROZKŁADU</p>
              <h2 id="results-title">
                {searchedRoute.origin.name} <span>→</span>{" "}
                {searchedRoute.destination.name}
              </h2>
              <p>
                {formatDate(searchedRoute.dateTime)} · od {formatTime(searchedRoute.dateTime)}
              </p>
            </div>

            {trains.length > 0 && (
              <div className="progress-card" aria-live="polite">
                <div className="progress-numbers">
                  <strong>
                    {progress.finished}/{progress.total}
                  </strong>
                  <span>
                    {phase === "done" ? "sprawdzono" : "sprawdzamy"}
                  </span>
                </div>
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.finished}
                >
                  <span
                    style={{
                      width: `${progress.total ? (progress.finished / progress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <small>
                  {availabilityConfigured
                    ? `${progress.available} ${pluralConnections(progress.available)} z miejscami${progress.active > 0 ? ` · ${progress.active} aktywne` : ""}`
                    : "Dostępność miejsc czeka na autoryzowane źródło"}
                </small>
              </div>
            )}
          </div>

          {scheduleSource && (
            <div className="source-notice">
              <span>
                {scheduleSource.mode === "official-live" ? "DANE AKTUALNE" : "SNAPSHOT"}
              </span>
              <p>
                Rozkład: <a href={scheduleSource.url} target="_blank" rel="noreferrer">{scheduleSource.label}</a>
                {scheduleSource.validThrough
                  ? ` · ważny do ${scheduleSource.validThrough}`
                  : ""}
                {sourceWarning ? ` · ${sourceWarning}` : ""}
              </p>
            </div>
          )}

          {trains.length > 0 && (
            <div className="results-toolbar">
              <span>Sortuj:</span>
              {(
                [
                  ["recommended", "Najlepsze"],
                  ["departure", "Najwcześniej"],
                  ["price", "Cena"],
                  ["switches", "Najmniej zmian"],
                ] as Array<[SortKey, string]>
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={sortKey === value ? "active" : ""}
                  onClick={() => setSortKey(value)}
                >
                  {label}
                </button>
              ))}
              <small>
                {availabilityConfigured
                  ? `${PARALLEL_CHECKS} sprawdzenia równolegle`
                  : "tryb rozkładu"}
              </small>
            </div>
          )}

          {phase === "loading-trains" && (
            <div className="loading-board" role="status">
              <span className="loading-pulse" />
              <div>
                <strong>Zbieram wszystkie widoczne połączenia</strong>
                <p>Za chwilę każde z nich dostanie własny status.</p>
              </div>
            </div>
          )}

          <div className="train-list">
            {sortedTrains.map((train, index) => (
              <TrainCard
                key={train.uuid}
                train={train}
                check={checks[train.uuid] ?? { status: "queued" }}
                rank={index + 1}
                stationById={stationById}
                passengerCount={passengers}
              />
            ))}
          </div>

          {availabilityConfigured &&
            phase === "done" &&
            trains.length > 0 &&
            progress.available === 0 && (
            <div className="empty-result">
              <strong>Nie znaleźliśmy siedzącej kombinacji.</strong>
              <p>Spróbuj wcześniejszej godziny, innej klasy albo wyłącz dodatkowe preferencje.</p>
            </div>
            )}
        </section>
      )}

      <footer>
        <p>
          RailScout nie wysyła żadnych zapytań do PlaceFinder. Rozkład pochodzi
          z otwartych danych kolejowych; dostępność zawsze potwierdź u przewoźnika.
        </p>
        <span className="footer-links">
          <a
            href="https://www.plk-sa.pl/klienci-i-kontrahenci/api-otwarte-dane"
            target="_blank"
            rel="noreferrer"
          >
            PKP PLK Open Data
          </a>
          <a href="https://mkuran.pl/gtfs/" target="_blank" rel="noreferrer">
            GTFS
          </a>
        </span>
      </footer>
    </main>
  );
}

function TrainCard({
  train,
  check,
  rank,
  stationById,
  passengerCount,
}: {
  train: Train;
  check: CheckState;
  rank: number;
  stationById: Map<number, Station>;
  passengerCount: number;
}) {
  const price = totalPrice(check);
  const switches = seatSwitches(check);
  const isAvailable = check.status === "available";
  const isBest = rank === 1 && isAvailable;
  const routeLabel =
    switches === 0
      ? "Bez zmiany fotela"
      : switches === 1
        ? "1 zmiana fotela"
        : `${switches} zmiany fotela`;

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
          {check.status === "not-connected" && (
            <span className="status-badge not-connected">Rozkład gotowy</span>
          )}
          {check.status === "error" && (
            <span className="status-badge error">Nie sprawdzono</span>
          )}
          {isAvailable && (
            <>
              <span className="status-badge available">Miejsca znalezione</span>
              <strong className="result-price">{formatMoney(price)}</strong>
              <small>
                łącznie · {passengerCount} {passengerCount === 1 ? "osoba" : "osoby"}
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

      {check.status === "not-connected" && (
        <div className="availability-action">
          <span>
            Live inventory nie jest publicznym elementem rozkładu. Podłączymy go
            dopiero przez autoryzowany interfejs przewoźnika lub sprzedawcy.
          </span>
          <a href={train.bookingUrl} target="_blank" rel="noreferrer">
            Sprawdź teraz w e-IC →
          </a>
        </div>
      )}

      {isAvailable && check.passengers && (
        <details className="seat-details" open={isBest}>
          <summary>
            <span>{routeLabel}</span>
            <span>Zobacz podział trasy</span>
          </summary>
          <div className="passenger-list">
            {check.passengers.map((passenger) => (
              <section key={passenger.passengerIndex} className="passenger-route">
                {check.passengers && check.passengers.length > 1 && (
                  <h3>Pasażer {passenger.passengerIndex}</h3>
                )}
                <div className="segment-list">
                  {passenger.tickets.map((ticket, ticketIndex) => {
                    const from = stationById.get(ticket.from)?.name ?? `Stacja ${ticket.from}`;
                    const to = stationById.get(ticket.to)?.name ?? `Stacja ${ticket.to}`;
                    return (
                      <div className="segment" key={`${ticket.from}-${ticket.to}-${ticketIndex}`}>
                        <span className="segment-number">{ticketIndex + 1}</span>
                        <div className="segment-route">
                          <strong>
                            {from} <span>→</span> {to}
                          </strong>
                          <small>
                            {formatTime(ticket.timeFrom)}–{formatTime(ticket.timeTo)} · {ticket.class} klasa
                          </small>
                        </div>
                        <div className="segment-seat">
                          <strong>
                            {ticket.seat
                              ? `wagon ${ticket.wagon}, miejsce ${ticket.seat}`
                              : ticket.seated
                                ? "miejsce przydzielane"
                                : "bez gwarancji miejsca"}
                          </strong>
                          <small>{formatMoney(ticket.price)}</small>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
          <div className="details-footer">
            <span>
              Rezerwuj odcinki w tej kolejności; miejsca mogą zmienić się przed płatnością.
            </span>
            <a href={train.bookingUrl} target="_blank" rel="noreferrer">
              Otwórz e-IC →
            </a>
          </div>
        </details>
      )}

      {check.status === "error" && check.message && (
        <p className="card-message">{check.message}</p>
      )}
    </article>
  );
}
