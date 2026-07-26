import type { Metadata } from "next";
import Link from "next/link";
import provenance from "../data/provenance.json";

export const metadata: Metadata = {
  title: "Dane i licencje — RailScout",
  description:
    "Pochodzenie danych, warunki ponownego wykorzystania i licencje RailScout.",
};

export default function DataAndLicensesPage() {
  const { timetable, eicStationMapping } = provenance;

  return (
    <main className="legal-shell">
      <Link className="legal-back" href="/">
        ← RailScout
      </Link>
      <p className="eyebrow">PRZEJRZYSTOŚĆ</p>
      <h1>Dane i licencje</h1>
      <p className="legal-lede">
        RailScout łączy przetworzony rozkład jazdy z krótkotrwałym odczytem
        map miejsc. Poniżej podajemy dokładne źródła, czas pozyskania i zakres
        przetwarzania.
      </p>

      <section>
        <h2>Rozkład jazdy i katalog stacji</h2>
        <dl>
          <div>
            <dt>Źródło danych</dt>
            <dd>
              <a href={timetable.sourceUrl}>{timetable.sourceName}</a>
            </dd>
          </div>
          <div>
            <dt>Plik źródłowy</dt>
            <dd>
              <a href={timetable.feedUrl}>{timetable.feedName}</a>
            </dd>
          </div>
          <div>
            <dt>Czas wytworzenia źródła</dt>
            <dd>{timetable.sourceGeneratedAt}</dd>
          </div>
          <div>
            <dt>Pozyskano i przetworzono</dt>
            <dd>
              {timetable.retrievedAt} / {timetable.processedAt}
            </dd>
          </div>
        </dl>
        <p>
          RailScout wybrał połączenia PKP Intercity oraz przekształcił daty
          kursowania, postoje, perony i tory do zwartego pliku JSON. Obowiązują
          <a href={timetable.reuseTermsUrl}> warunki ponownego wykorzystywania PKP PLK</a>.
          PKP PLK ani autor feedu GTFS nie odpowiadają za sposób przetworzenia,
          dostępność, poprawność, aktualność, kompletność ani jakość wyników
          RailScout.
        </p>
      </section>

      <section>
        <h2>Identyfikatory e-IC i mapy miejsc</h2>
        <dl>
          <div>
            <dt>Źródło</dt>
            <dd>
              <a href={eicStationMapping.sourceUrl}>
                {eicStationMapping.sourceName}
              </a>
            </dd>
          </div>
          <div>
            <dt>Pozyskano i przetworzono</dt>
            <dd>
              {eicStationMapping.retrievedAt} / {eicStationMapping.processedAt}
            </dd>
          </div>
        </dl>
        <p>
          Repozytorium zawiera zwartą mapę identyfikatorów liczbowych
          udostępnianych przez bieżący katalog stacji e-IC. Mapa nie jest objęta
          licencją MIT projektu. Bieżące mapy wagonów są odczytywane podczas
          wyszukiwania, przechowywane najwyżej 90 sekund i nie są dołączane do
          kodu ani archiwizowane przez aplikację.
        </p>
      </section>

      <section>
        <h2>Kod, grafika i zależności</h2>
        <p>
          Oryginalny kod RailScout i grafika podglądu są dostępne na licencji
          MIT. Krój Geist zachowuje licencję SIL Open Font License 1.1, a
          biblioteki JavaScript zachowują własne licencje zapisane w pliku
          blokady zależności.
        </p>
        <p>
          RailScout nie jest powiązany z PKP Intercity ani PKP Polskimi Liniami
          Kolejowymi. Nazwy i znaki towarowe należą do ich właścicieli.
        </p>
      </section>
    </main>
  );
}
