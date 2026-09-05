"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import type { Station, Train, CheckState, ScheduleSource, SearchPhase, SortKey } from "./lib/search-types";
import { TrainCard } from "./components/train-card";
import { localDefaults, normaliseStationName, availableSeatCount, seatSwitches, statusRank, toIsoWithOffset, formatDate, formatTime, pluralConnections } from "./lib/search-view";

import { checkTrains, type SearchSettings } from "./lib/check-trains";

export function SeatSweepApp() {
  const [stations, setStations] = useState<Station[]>([]);
  const [originName, setOriginName] = useState("Warszawa Centralna");
  const [destinationName, setDestinationName] = useState("Kraków Główny");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [ticketClass, setTicketClass] = useState<1 | 2>(2);
  const [numberOfPassengers, setNumberOfPassengers] = useState(1);
  const [bike, setBike] = useState(false);
  const [submittedSettings, setSubmittedSettings] = useState({ ticketClass, numberOfPassengers, bike });
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

    fetch("/api/stations")
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

  function checkEveryTrain(candidates: Train[], token: number, controller: AbortController,
    settings: SearchSettings, refresh = false) {
    return checkTrains({ candidates, controller, settings, refresh,
      isCurrent: () => token === searchToken.current, updateCheck,
      onDone: () => setPhase("done"),
    });
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
    let dateTime: string;
    try { dateTime = toIsoWithOffset(date, time); }
    catch (error) { setError(error instanceof Error ? error.message : "Nieprawidłowa godzina."); return; }
    const settings = { ticketClass, numberOfPassengers, bike };
    setSubmittedSettings(settings);

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

      if (token !== searchToken.current || controller.signal.aborted) return;
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
        settings,
      );
    } catch (searchError) {
      if (searchError instanceof Error && searchError.name === "AbortError") {
        return;
      }
      if (token !== searchToken.current) return;
      setPhase("done");
      setError(
        searchError instanceof Error
          ? searchError.message
          : "Nie udało się rozpocząć wyszukiwania.",
      );
    }
  }

  function stopChecking() {
    searchController.current?.abort();
    searchToken.current += 1;
    setChecks(current => Object.fromEntries(Object.entries(current).map(([id, check]) => [id,
      ["queued", "checking"].includes(check.status) ? { status: "unknown", message: "Sprawdzanie zatrzymane." } : check])));
    setPhase("stopped");
  }

  function retryTrain(train: Train) {
    const controller = new AbortController();
    searchController.current = controller;
    const token = ++searchToken.current;
    setPhase("checking");
    void checkEveryTrain([train], token, controller, submittedSettings, true);
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
          <small>beta</small>
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
              <option key={station.id} value={station.name} />
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
            {isBusy && <button type="button" className="secondary-button" onClick={stopChecking}>Zatrzymaj sprawdzanie</button>}
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
                  aria-label="Postęp sprawdzania pociągów"
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
                  ["seats", "Najwięcej potwierdzonych"],
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
                Pociągi sprawdzane kolejno
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
                ticketClass={submittedSettings.ticketClass}
                numberOfPassengers={submittedSettings.numberOfPassengers}
                onRetry={() => retryTrain(train)}
                retryDisabled={isBusy}
                searchDateTime={searchedRoute.dateTime}
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
          <a href="/dane-i-licencje">Dane i licencje</a>
          <a
            href="https://github.com/piwanczak/railscout"
            target="_blank"
            rel="noreferrer"
          >
            Kod źródłowy
          </a>
        </span>
      </footer>
    </main>
  );
}
