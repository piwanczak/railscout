import type { Train, CheckState, AvailabilitySegment } from "./search-types";
const AVAILABILITY_TIMEOUT_MS = 32_000;
const AVAILABILITY_RETRY_DELAY_MS = 1_000;
const CONNECTION_CHECK_DELAY_MS = 750;

export type SearchSettings = { ticketClass: 1 | 2; numberOfPassengers: number; bike: boolean };

export async function checkTrains({ candidates, controller, settings, refresh = false, isCurrent, updateCheck, onDone }: {
  candidates: Train[]; controller: AbortController; settings: SearchSettings; refresh?: boolean;
  isCurrent: () => boolean; updateCheck: (id: string, state: CheckState) => void; onDone: () => void;
}) {
    const wait = (milliseconds: number) => {
      if (controller.signal.aborted) {
        return Promise.reject(new DOMException("Search cancelled", "AbortError"));
      }
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(finish, milliseconds);
        const onAbort = () => {
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", onAbort);
          reject(new DOMException("Search cancelled", "AbortError"));
        };
        function finish() {
          controller.signal.removeEventListener("abort", onAbort);
          resolve();
        }
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
    };

    for (const [index, train] of candidates.entries()) {
      if (!isCurrent() || controller.signal.aborted) return;

      updateCheck(train.uuid, { status: "checking" });

      try {
        let response: Response | null = null;
        let result: {
          status?: "available" | "unavailable" | "unknown";
          segments?: AvailabilitySegment[];
          checkedAt?: string;
          seatCountIsLowerBound?: boolean;
          minimumFreeSeats?: number | null;
          checkedSegments?: number;
          unknownSegments?: number;
          totalSegments?: number;
          message?: string;
          error?: string;
          retryable?: boolean;
          retryAfterMs?: number;
        } = {};

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const attemptController = new AbortController();
          let timedOut = false;
          const abortAttempt = () =>
            attemptController.abort(controller.signal.reason);
          controller.signal.addEventListener("abort", abortAttempt, {
            once: true,
          });
          const attemptTimeout = setTimeout(() => {
            timedOut = true;
            attemptController.abort(
              new DOMException("Availability request timed out", "TimeoutError"),
            );
          }, AVAILABILITY_TIMEOUT_MS);

          try {
            response = await fetch("/api/availability", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-RailScout-Attempt": String(attempt + 1),
              },
              signal: attemptController.signal,
              body: JSON.stringify({
                category: train.category,
                trainNumber: train.trainNumber,
                stationStops: train.stationStops,
                ...settings,
                refresh,
              }),
            });
            result = await response.json();
          } catch (error) {
            if (controller.signal.aborted) throw error;
            if (!timedOut || attempt === 1) throw error;
            result = {
              retryable: true,
              retryAfterMs: AVAILABILITY_RETRY_DELAY_MS,
            };
          } finally {
            clearTimeout(attemptTimeout);
            controller.signal.removeEventListener("abort", abortAttempt);
          }

          if (!result.retryable || attempt === 1) break;
          await wait(result.retryAfterMs ?? AVAILABILITY_RETRY_DELAY_MS);
        }

        if (!isCurrent()) return;
        if ((response && !response.ok) || result.error) {
          updateCheck(train.uuid, {
            status: "error",
            message: result.error ?? "Sprawdzenie nie powiodło się.",
          });
        } else if (result.status === "available") {
          updateCheck(train.uuid, {
            status: "available",
            segments: result.segments ?? [],
            minimumFreeSeats: result.minimumFreeSeats,
            checkedAt: result.checkedAt,
            seatCountIsLowerBound: result.seatCountIsLowerBound,
            checkedSegments: result.checkedSegments,
            unknownSegments: result.unknownSegments,
            totalSegments: result.totalSegments,
          });
        } else if (result.status === "unknown" || result.retryable) {
          updateCheck(train.uuid, {
            status: "unknown",
            message:
              result.message ?? "Dane o miejscach są chwilowo niedostępne.",
            checkedSegments: result.checkedSegments,
            unknownSegments: result.unknownSegments,
            totalSegments: result.totalSegments,
          });
        } else if (result.status === "unavailable") {
          updateCheck(train.uuid, {
            status: "unavailable",
            segments: [],
            checkedSegments: result.checkedSegments,
            totalSegments: result.totalSegments,
          });
        } else {
          updateCheck(train.uuid, { status: "unknown", message: "Odpowiedź o miejscach ma nieznany format." });
        }
      } catch {
        if (controller.signal.aborted) return;
        if (isCurrent()) {
          updateCheck(train.uuid, {
            status: "error",
            message: "Brak odpowiedzi po ponownej próbie.",
          });
        }
      }

      if (index < candidates.length - 1) {
        try {
          await wait(CONNECTION_CHECK_DELAY_MS);
        } catch {
          return;
        }
      }
    }

    if (isCurrent() && !controller.signal.aborted) {
      onDone();
    }
}
