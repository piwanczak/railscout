import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OFFICIAL_GRM_BASE = "https://api-gateway.intercity.pl/grm";
const OFFICIAL_EIC_ORIGIN = "https://ebilet.intercity.pl";
const DEFAULT_EIC_APP_VERSION = "1.5.20";
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function json(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function normaliseUpstreamBase(value) {
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" &&
    ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Relay upstream must be HTTPS (or loopback HTTP for tests)");
  }
  return url.toString().replace(/\/$/, "");
}

function validToken(token) {
  return typeof token === "string" && Buffer.byteLength(token) >= 32 &&
    Buffer.byteLength(token) <= 512;
}

function authorised(header, token) {
  if (typeof header !== "string") return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decodedSegments(pathname) {
  if (!pathname.startsWith("/grm/") || pathname.length > 512) return null;
  try {
    return pathname.slice("/grm/".length).split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
}

const categoryPattern = /^[A-Za-z][A-Za-z /-]{0,23}$/;
const trainPattern = /^[0-9][0-9 /-]{0,23}$/;
const dateTimePattern = /^\d{12}$/;
const stationPattern = /^\d{1,12}$/;
const wagonPattern = /^[A-Za-z0-9._-]{1,24}$/;
const schemePattern = /^[A-Za-z0-9,._ -]{1,96}$/;

function allowedUpstreamPath(pathname) {
  const parts = decodedSegments(pathname);
  if (!parts) return null;

  const composition =
    parts.length === 8 &&
    parts[0] === "sklad" &&
    parts[1] === "wbnet" &&
    categoryPattern.test(parts[2]) &&
    trainPattern.test(parts[3]) &&
    dateTimePattern.test(parts[4]) &&
    stationPattern.test(parts[5]) &&
    dateTimePattern.test(parts[6]) &&
    stationPattern.test(parts[7]);
  const wagon =
    parts.length === 11 &&
    parts[0] === "wagon" &&
    parts[1] === "svg" &&
    parts[2] === "wbnet" &&
    categoryPattern.test(parts[3]) &&
    trainPattern.test(parts[4]) &&
    wagonPattern.test(parts[5]) &&
    schemePattern.test(parts[6]) &&
    dateTimePattern.test(parts[7]) &&
    dateTimePattern.test(parts[8]) &&
    stationPattern.test(parts[9]) &&
    stationPattern.test(parts[10]);

  return composition || wagon
    ? parts.map((part) => encodeURIComponent(part)).join("/")
    : null;
}

async function boundedBody(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("upstream response too large");
  }

  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("upstream response too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received);
}

export function createGrmRelayServer({
  token,
  upstreamBase = OFFICIAL_GRM_BASE,
  appVersion = DEFAULT_EIC_APP_VERSION,
  fetchImpl = fetch,
  timeoutMilliseconds = 10_000,
  maximumResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maximumConcurrency = 20,
  requestsPerMinute = 600,
} = {}) {
  if (!validToken(token)) {
    throw new Error("RAILSCOUT_RELAY_TOKEN must contain 32 to 512 bytes");
  }
  if (!/^\d+(?:\.\d+){2}$/.test(appVersion)) {
    throw new Error("EIC_APP_VERSION must use x.y.z format");
  }
  const root = normaliseUpstreamBase(upstreamBase);
  const windows = new Map();
  let activeRequests = 0;

  return createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://relay.invalid");

    if (url.pathname === "/healthz" && (method === "GET" || method === "HEAD")) {
      if (method === "HEAD") {
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
      } else {
        json(response, 200, { status: "ok" });
      }
      return;
    }

    if (method !== "GET" || url.search) {
      json(response, 405, { error: "method not allowed" }, { Allow: "GET" });
      return;
    }
    if (!authorised(request.headers.authorization, token)) {
      json(response, 401, { error: "unauthorised" }, {
        "WWW-Authenticate": "Bearer",
      });
      return;
    }

    const upstreamPath = allowedUpstreamPath(url.pathname);
    if (!upstreamPath) {
      json(response, 404, { error: "route not found" });
      return;
    }

    const now = Date.now();
    const client = request.socket.remoteAddress ?? "unknown";
    const previous = windows.get(client);
    const bucket =
      !previous || now - previous.startedAt >= 60_000
        ? { startedAt: now, requests: 0 }
        : previous;
    bucket.requests += 1;
    windows.set(client, bucket);
    if (bucket.requests > requestsPerMinute || activeRequests >= maximumConcurrency) {
      json(response, 429, { error: "relay busy" }, { "Retry-After": "1" });
      return;
    }

    activeRequests += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
      const upstream = await fetchImpl(`${root}/${upstreamPath}`, {
        headers: {
          Accept: upstreamPath.startsWith("sklad/")
            ? "application/json"
            : "image/svg+xml,text/plain;q=0.8,*/*;q=0.5",
          "App-Version": appVersion,
          [`App-Version-${appVersion}`]: "",
          "Content-Type": "application/json",
          Origin: OFFICIAL_EIC_ORIGIN,
          Referer: `${OFFICIAL_EIC_ORIGIN}/`,
        },
        signal: controller.signal,
      });
      const body = await boundedBody(upstream, maximumResponseBytes);
      response.writeHead(upstream.status, {
        "Cache-Control": "no-store",
        "Content-Length": body.byteLength,
        "Content-Type": upstream.headers.get("content-type") ??
          "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
    } catch (error) {
      const timeoutFailure = error instanceof Error && error.name === "AbortError";
      console.warn("GRM relay upstream failure", {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : "upstream unavailable",
      });
      json(response, timeoutFailure ? 504 : 502, {
        error: timeoutFailure ? "upstream timeout" : "upstream unavailable",
      });
    } finally {
      clearTimeout(timeout);
      activeRequests -= 1;
      if (windows.size > 1_000) {
        for (const [key, value] of windows) {
          if (now - value.startedAt >= 60_000) windows.delete(key);
        }
      }
    }
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? "8080");
  const host = process.env.HOST ?? "0.0.0.0";
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }
  const server = createGrmRelayServer({
    token: process.env.RAILSCOUT_RELAY_TOKEN,
    upstreamBase: process.env.EIC_GRM_UPSTREAM_URL ?? OFFICIAL_GRM_BASE,
    appVersion: process.env.EIC_APP_VERSION ?? DEFAULT_EIC_APP_VERSION,
  });
  server.listen(port, host, () => {
    console.log(`RailScout GRM relay listening on ${host}:${port}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
