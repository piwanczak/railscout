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

type AvailabilitySegment = {
  from: number;
  to: number;
  timeFrom: string;
  timeTo: string;
  freeSeats: number;
  seats: Array<{
    wagon: string;
    seat: string;
    label: string;
  }>;
};

type CheckState = {
  status:
    | "queued"
    | "checking"
    | "available"
    | "unavailable"
    | "unknown"
    | "error";
  segments?: AvailabilitySegment[];
  minimumFreeSeats?: number | null;
  checkedSegments?: number;
  unknownSegments?: number;
  totalSegments?: number;
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
type SortKey = "recommended" | "departure" | "seats" | "switches";

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

function seatSwitches(check?: CheckState) {
  if (!check?.segments?.length) return Number.POSITIVE_INFINITY;
  return Math.max(0, check.segments.length - 1);
}

function availableSeatCount(check?: CheckState) {
  return check?.minimumFreeSeats ?? -1;
}

function statusRank(check?: CheckState) {
  return {
    available: 0,
    checking: 1,
    queued: 2,
    unavailable: 3,
    unknown: 4,
    error: 5,
  }[check?.status ?? "queued"];
}

function pluralConnections(count: number) {
  if (count === 1) return "połączenie";
  if (count >= 2 && count <= 4) return "połączenia";
  return "połączeń";
}

function freeSeatLabel(count: number) {
  if (count === 1) return "1 wolne miejsce";
  if (count >= 2 && count <= 4) return `${count} wolne miejsca`;
  return `${count} wolnych miejsc`;
}

export function SeatSweepApp() {
  const [stations, setStations] = useState<Station[]>([]);
  const [originName, setOriginName] = useState("Warszawa Centralna");
  const [destinationName, setDestinationName] = useState("Kraków Główny");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [ticketClass, setTicketClass] = useState<1 | 2>(2);
  const [numberOfPassengers, setNumberOfPassengers] = useState(1);
  const [bike, setBike] = useState(false);
  const [phase, setPhase] = useState<SearchPhase>("idle");
  const [trains, setTrains] = useState<Train[]>([]);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [sortKey, setSortKey] = useState<SortKey>("recommended");
  const [error, setError] = useState("");
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
      ["available", "unavailable", "unknown", "error"].includes(
        check.status,
      ),
    ).length;
    const available = values.filter(
      (check) => check.status === "available",
    ).length;
    const unresolved = values.filter((check) =>
      ["unknown", "error"].includes(check.status),
    ).length;
    const active = values.filter((check) => check.status === "checking").length;
    return { finished, available, unresolved, active, total: trains.length };
  }, [checks, trains.length]);

  const sortedTrains = useMemo(() => {
    const next = [...trains];
    next.sort((left, right) => {
      const leftCheck = checks[left.uuid];
      const rightCheck = checks[right.uuid];

      if (sortKey === "departure") {
        return Date.parse(left.departure) - Date.parse(right.departure);
      }

      if (sortKey === "seats") {
        return availableSeatCount(rightCheck) - availableSeatCount(leftCheck);
      }

      if (sortKey === "switches") {
        return (
          seatSwitches(leftCheck) - seatSwitches(rightCheck) ||
          availableSeatCount(rightCheck) - availableSeatCount(leftCheck) ||
          Date.parse(left.departure) - Date.parse(right.departure)
        );
      }

      return (
        statusRank(leftCheck) - statusRank(rightCheck) ||
        seatSwitches(leftCheck) - seatSwitches(rightCheck) ||
        availableSeatCount(rightCheck) - availableSeatCount(leftCheck) ||
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
              category: train.category,
              trainNumber: train.trainNumber,
              stationStops: train.stationStops,
              startDateTime: train.departure,
              arrivalDateTime: train.arrival,
              numberOfPassengers,
              bike,
              ticketClass,
            }),
          });

          const result = (await response.json()) as {
            status?: "available" | "unavailable" | "unknown";
            segments?: AvailabilitySegment[];
            minimumFreeSeats?: number | null;
            checkedSegments?: number;
            unknownSegments?: number;
            totalSegments?: number;
            message?: string;
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
              segments: result.segments ?? [],
              minimumFreeSeats: result.minimumFreeSeats,
              checkedSegments: result.checkedSegments,
              unknownSegments: result.unknownSegments,
              totalSegments: result.totalSegments,
            });
          } else if (result.status === "unknown") {
            updateCheck(train.uuid, {
              status: "unknown",
              message: result.message ?? "Dane o miejscach są chwilowo niedostępne.",
              checkedSegments: result.checkedSegments,
              unknownSegments: result.unknownSegments,
              totalSegments: result.totalSegments,
            });
          } else {
            updateCheck(train.uuid, {
              status: "unavailable",
              segments: [],
              checkedSegments: result.checkedSegments,
              totalSegments: result.totalSegments,
            });
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
        }),
      });
      const result = (await response.json()) as {
        trains?: Train[];
        source?: ScheduleSource;
        warning?: string;
        error?: string;
      };

      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Nie udało się pobrać połączeń.");
      }

      const candidates = result.trains ?? [];
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
            { status: "queued" },
          ]),
        ),
      );
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
          Rozkład i miejsca w jednym widoku
        </div>
      </header>

      <section className={`hero ${showResults ? "hero-compact" : ""}`} id="top">
        <div className="hero-copy">
          <p className="eyebrow">WYSZUKIWARKA DOSTĘPNOŚCI</p>
          <h1>
            Jedno wyszukanie.
            <br />
            <em>Wszystkie kombinacje.</em>
          </h1>
          <p className="hero-lede">
            RailScout sprawdza dokładne miejsca w każdym widocznym pociągu.
            Gdy pełna trasa jest zajęta, przelicza każdy możliwy podział.
          </p>
          <div className="promise-row" aria-label="Zakres wyszukiwania">
            <span>Każdy widoczny pociąg</span>
            <span>Numery wagonów i miejsc</span>
            <span>Wszystkie potrzebne podziały</span>
          </div>
        </div>

        {!showResults && (
          <div className="scan-preview" aria-label="Podgląd działania">
            <div className="preview-heading">
              <span>Pełny skan</span>
              <b>wszystkie pociągi</b>
            </div>
            <div className="rail-line" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="preview-list">
              <div>
                <small>IC 8300 · 11:40</small>
                <strong className="preview-found">Trasa bez podziału</strong>
              </div>
              <div>
                <small>EIP 5302 · 13:44</small>
                <strong className="preview-checking">Podziały trasy</strong>
              </div>
              <div>
                <small>IC 8352 · 14:40</small>
                <strong className="preview-queued">Najlepszy wariant</strong>
              </div>
            </div>
            <p>Dostępność całej trasy i odcinków w jednym wyniku.</p>
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
            <label className="field">
              <span>Podróżni</span>
              <select
                value={numberOfPassengers}
                onChange={(event) =>
                  setNumberOfPassengers(Number(event.target.value))
                }
              >
                {[1, 2, 3, 4, 5, 6].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="search-actions">
            <div className="preference-row">
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
                  {phase === "done" && progress.unresolved > 0
                    ? `${progress.available} potwierdzonych · ${progress.unresolved} bez danych`
                    : `${progress.available} ${pluralConnections(progress.available)} z miejscami${progress.active > 0 ? ` · ${progress.active} aktywne` : ""}`}
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
                  ["seats", "Najwięcej wolnych"],
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
                {`${PARALLEL_CHECKS} pociągi równolegle`}
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
                ticketClass={ticketClass}
                numberOfPassengers={numberOfPassengers}
              />
            ))}
          </div>

          {phase === "done" &&
            trains.length > 0 &&
            progress.available === 0 && (
            <div className="empty-result">
              {progress.unresolved > 0 ? (
                <>
                  <strong>Dostępności miejsc nie udało się teraz potwierdzić.</strong>
                  <p>Rozkład jest gotowy. Odśwież wyszukiwanie, gdy dane będą znów dostępne.</p>
                </>
              ) : (
                <>
                  <strong>Brak kombinacji z dostępnymi miejscami.</strong>
                  <p>Sprawdź inną klasę, godzinę albo połączenie.</p>
                </>
              )}
            </div>
            )}
        </section>
      )}

      <footer>
        <p>
          Rozkład i dostępność mają charakter informacyjny. Szczegóły zakupu
          potwierdź w e-IC.
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
  ticketClass,
  numberOfPassengers,
}: {
  train: Train;
  check: CheckState;
  rank: number;
  stationById: Map<number, Station>;
  ticketClass: 1 | 2;
  numberOfPassengers: number;
}) {
  const switches = seatSwitches(check);
  const isAvailable = check.status === "available";
  const isBest = rank === 1 && isAvailable;
  const freeSeats = check.minimumFreeSeats ?? 0;
  const firstSeat = check.segments?.[0]?.seats[0];
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
          {check.status === "unknown" && (
            <span className="status-badge unknown">Brak danych</span>
          )}
          {check.status === "error" && (
            <span className="status-badge error">Nie sprawdzono</span>
          )}
          {isAvailable && (
            <>
              <span className="status-badge available">
                {freeSeatLabel(freeSeats)}
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
                        <strong>{freeSeatLabel(segment.freeSeats)}</strong>
                        <div className="seat-chips" aria-label="Wolne miejsca">
                          {segment.seats.map((seat) => (
                            <span key={`${seat.wagon}-${seat.seat}`}>
                              W{seat.wagon} · {seat.seat}
                            </span>
                          ))}
                        </div>
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
            {train.bookingUrl && (
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
    </article>
  );
}
