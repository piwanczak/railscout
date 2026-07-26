import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after } from "node:test";
import { createGrmRelayServer } from "../scripts/grm-relay.mjs";

const token = "a-test-relay-secret-that-is-long-enough";
const upstreamRequests = [];
const upstream = createServer((request, response) => {
  upstreamRequests.push({
    url: request.url,
    authorization: request.headers.authorization,
    appVersion: request.headers["app-version"],
    appVersionMarker: request.headers["app-version-1.5.20"],
    origin: request.headers.origin,
    referer: request.headers.referer,
    userAgent: request.headers["user-agent"],
    secFetchSite: request.headers["sec-fetch-site"],
  });
  if (request.url?.includes("/IC/9999/")) {
    const body = "x".repeat(128);
    response.writeHead(200, {
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "text/plain",
    });
    response.end(body);
    return;
  }
  if (request.url?.startsWith("/grm/sklad/")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ wagony: [3] }));
    return;
  }
  response.writeHead(200, { "Content-Type": "image/svg+xml" });
  response.end('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
});

await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamAddress = upstream.address();
assert.ok(upstreamAddress && typeof upstreamAddress !== "string");

const relay = createGrmRelayServer({
  token,
  upstreamBase: `http://127.0.0.1:${upstreamAddress.port}/grm`,
  maximumResponseBytes: 64,
});
await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
const relayAddress = relay.address();
assert.ok(relayAddress && typeof relayAddress !== "string");
const relayRoot = `http://127.0.0.1:${relayAddress.port}`;

after(async () => {
  await Promise.all([
    new Promise((resolve, reject) =>
      relay.close((error) => (error ? reject(error) : resolve())),
    ),
    new Promise((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    ),
  ]);
});

test("GRM relay exposes a minimal unauthenticated health check", async () => {
  const response = await fetch(`${relayRoot}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("GRM relay rejects unauthorised and non-GRM requests", async () => {
  const validPath =
    "/grm/sklad/wbnet/IC/5330/202607271439/5100136/202607271008/5100051";
  const unauthorised = await fetch(`${relayRoot}${validPath}`);
  assert.equal(unauthorised.status, 401);

  const unrelated = await fetch(`${relayRoot}/grm/../../anything`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(unrelated.status, 404);
  assert.equal(upstreamRequests.length, 0);
});

test("GRM relay forwards only the official request contract and strips its token", async () => {
  const path =
    "/grm/sklad/wbnet/IC/5330/202607271439/5100136/202607271008/5100051";
  const response = await fetch(`${relayRoot}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { wagony: [3] });
  assert.equal(upstreamRequests.length, 1);
  assert.deepEqual(upstreamRequests[0], {
    url: path,
    authorization: undefined,
    appVersion: "1.5.20",
    appVersionMarker: "",
    origin: "https://ebilet.intercity.pl",
    referer: "https://ebilet.intercity.pl/",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    secFetchSite: "same-site",
  });
});

test("GRM relay accepts the wagon route but rejects malformed variants", async () => {
  const wagonPath =
    "/grm/wagon/svg/wbnet/IC/5330/3/2061%2CWITHOUT_COMPARTMENTS/202607271008/202607271439/5100136/5100051";
  const wagon = await fetch(`${relayRoot}${wagonPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(wagon.status, 200);
  assert.match(await wagon.text(), /^<svg/);

  const malformed = await fetch(`${relayRoot}${wagonPath}/extra`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(malformed.status, 404);
  assert.equal(upstreamRequests.length, 2);
});

test("GRM relay refuses oversized upstream responses", async () => {
  const path =
    "/grm/sklad/wbnet/IC/9999/202607271439/5100136/202607271008/5100051";
  const response = await fetch(`${relayRoot}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "upstream unavailable" });
  assert.equal(upstreamRequests.length, 3);
});
