import { test, expect } from "@playwright/test";

const stations = [{ id: 33605, name: "Warszawa Centralna" }, { id: 80416, name: "Kraków Główny" }];
const train = {
  uuid: "fixture", category: "IC", trainNumber: "123", trainName: "IC Test",
  departure: "2026-09-05T10:00:00+02:00", arrival: "2026-09-05T12:00:00+02:00",
  duration: 120, changes: 0, originStationId: 33605, destinationStationId: 80416,
  departurePlatform: "1", departureTrack: "", arrivalPlatform: "2", arrivalTrack: "",
  stops: 2, stationIds: [33605, 80416],
  stationStops: stations.map((s, i) => ({ id: s.id, arrival: `2026-09-05T${10 + i * 2}:00:00+02:00`, departure: `2026-09-05T${10 + i * 2}:00:00+02:00` })),
  bookingUrl: "https://ebilet.intercity.pl/wyszukiwanie?test=full",
};
const available = {
  status: "available", checkedAt: new Date(Date.now() - 180000).toISOString(), seatCountIsLowerBound: true,
  minimumFreeSeats: 1, checkedSegments: 1, totalSegments: 1,
  segments: [{ from: 33605, to: 80416, timeFrom: train.departure, timeTo: train.arrival,
    freeSeats: 1, freeSeatsIsLowerBound: true, seats: [{ wagon: "3", seat: "9", label: "9" }],
    bookingUrl: "https://ebilet.intercity.pl/wyszukiwanie?test=section" }],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/stations", route => route.fulfill({ json: stations }));
  await page.route("**/api/trains", route => route.fulfill({ json: { trains: [train] } }));
});

async function search(page) {
  await page.goto("/");
  await page.getByLabel("Data", { exact: true }).fill("2026-09-05");
  await page.getByLabel("Najwcześniej o").fill("09:00");
  await page.getByRole("button", { name: "Znajdź wszystkie połączenia" }).click();
}

test("result settings stay fixed and refresh uses the submitted settings", async ({ page }) => {
  const requests = [];
  await page.route("**/api/availability", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: available });
  });
  await search(page);
  const card = page.locator("article.train-card");
  await expect(card.getByText("2 klasa · mapa miejsc e-IC")).toBeVisible();
  await page.getByRole("combobox", { name: "Klasa", exact: true }).selectOption("1");
  await page.getByRole("combobox", { name: "Podróżni", exact: true }).selectOption("3");
  await expect(card.getByText("2 klasa · mapa miejsc e-IC")).toBeVisible();
  await expect(card.getByText("wagon 3 · miejsce 9")).toBeVisible();
  await expect(card.getByRole("status")).toContainText("odśwież przed zakupem");
  await expect(card.getByRole("link", { name: "Kup bilet na ten odcinek" })).toHaveAttribute("href", available.segments[0].bookingUrl);
  await card.getByRole("button", { name: "Odśwież miejsca" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({ ticketClass: 2, numberOfPassengers: 1, refresh: true });
});

test("stop ends an active search and permits a retry", async ({ page }) => {
  let release;
  await page.route("**/api/availability", async route => {
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: available }).catch(() => {});
  });
  await search(page);
  await expect.poll(() => typeof release).toBe("function");
  await expect(page.getByRole("button", { name: "Zatrzymaj sprawdzanie" })).toBeVisible();
  await page.getByRole("button", { name: "Zatrzymaj sprawdzanie" }).click();
  await expect(page.getByRole("button", { name: "Znajdź wszystkie połączenia" })).toBeEnabled();
  await expect(page.getByText("Sprawdzanie zatrzymane.")).toBeVisible();
  release?.();
  await page.unroute("**/api/availability");
  await page.route("**/api/availability", route => route.fulfill({ json: available }));
  await page.getByRole("button", { name: "Sprawdź ponownie" }).click();
  await expect(page.getByText("wagon 3 · miejsce 9")).toBeVisible();
});

test("keyboard search works and the result fits the viewport", async ({ page }) => {
  await page.route("**/api/availability", route => route.fulfill({ json: available }));
  await page.goto("/");
  await page.getByLabel("Data", { exact: true }).fill("2026-09-05");
  const origin = page.getByLabel("Skąd", { exact: true });
  await origin.focus();
  await expect(origin).toBeFocused();
  await origin.press("Enter");
  await expect(page.getByText("wagon 3 · miejsce 9")).toBeVisible();
  const size = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  expect(size.content).toBeLessThanOrEqual(size.width + 1);
});
