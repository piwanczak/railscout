import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { refreshGtfs } from "../scripts/refresh-open-gtfs.mjs";

const REQUIRED_GTFS_FILES = [
  "attributions.txt",
  "calendar_dates.txt",
  "routes.txt",
  "stop_times.txt",
  "stops.txt",
  "trips.txt",
];

function fixtureArchive() {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        REQUIRED_GTFS_FILES.map((name) => [
          name,
          Buffer.from(`fixture for ${name}\n`, "utf8"),
        ]),
      ),
    ),
  );
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/polish_trains.zip`;
}

test("GTFS refresh conditionally caches the archive and skips unchanged imports", async (context) => {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "railscout-gtfs-"));
  context.after(() => rm(cacheDirectory, { recursive: true, force: true }));

  const requests = [];
  const archive = fixtureArchive();
  const server = createServer((request, response) => {
    requests.push(request.headers);
    if (request.headers["if-none-match"] === '"fixture-v1"') {
      response.writeHead(304);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": archive.length,
      ETag: '"fixture-v1"',
      "Last-Modified": "Sun, 26 Jul 2026 00:47:50 GMT",
    });
    response.end(archive);
  });
  const sourceUrl = await listen(server);
  context.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  const imports = [];
  const importFeedImpl = async (directory, options) => {
    imports.push({ directory, options });
    for (const name of REQUIRED_GTFS_FILES) {
      assert.equal(await readFile(path.join(directory, name), "utf8"), `fixture for ${name}\n`);
    }
  };

  const first = await refreshGtfs({
    sourceUrl,
    cacheDirectory,
    importFeedImpl,
    retries: 0,
  });
  assert.equal(first.status, "updated");
  assert.equal(first.imported, true);
  assert.equal(imports.length, 1);

  const second = await refreshGtfs({
    sourceUrl,
    cacheDirectory,
    importFeedImpl,
    retries: 0,
  });
  assert.equal(second.status, "unchanged");
  assert.equal(second.imported, false);
  assert.equal(imports.length, 1);
  assert.equal(requests[1]["if-none-match"], '"fixture-v1"');

  const metadata = JSON.parse(
    await readFile(path.join(cacheDirectory, "metadata.json"), "utf8"),
  );
  assert.equal(metadata.etag, '"fixture-v1"');
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.equal(path.basename(first.archivePath), metadata.archiveFile);
});

test("GTFS refresh keeps a usable cache offline but require-fresh fails loudly", async (context) => {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "railscout-gtfs-"));
  context.after(() => rm(cacheDirectory, { recursive: true, force: true }));

  const archive = fixtureArchive();
  let offline = false;
  const fetchImpl = async () => {
    if (offline) throw new Error("fixture network outage");
    return new Response(archive, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        ETag: '"fixture-v1"',
      },
    });
  };
  let importCount = 0;
  const options = {
    sourceUrl: "https://example.test/polish_trains.zip",
    cacheDirectory,
    fetchImpl,
    importFeedImpl: async () => {
      importCount += 1;
    },
    retries: 0,
  };

  await refreshGtfs(options);
  offline = true;
  const fallback = await refreshGtfs(options);
  assert.equal(fallback.status, "stale-cache");
  assert.equal(fallback.imported, false);
  assert.equal(importCount, 1);
  assert.match(fallback.warning, /fixture network outage/);

  await assert.rejects(
    refreshGtfs({ ...options, requireFresh: true }),
    /fixture network outage/,
  );
});

test("GTFS refresh suppresses rewrites when a server resends identical bytes", async (context) => {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "railscout-gtfs-"));
  context.after(() => rm(cacheDirectory, { recursive: true, force: true }));
  const archive = fixtureArchive();
  let importCount = 0;
  const options = {
    sourceUrl: "https://example.test/polish_trains.zip",
    cacheDirectory,
    fetchImpl: async () =>
      new Response(archive, {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      }),
    importFeedImpl: async () => {
      importCount += 1;
    },
    retries: 0,
  };

  assert.equal((await refreshGtfs(options)).status, "updated");
  const repeated = await refreshGtfs(options);
  assert.equal(repeated.status, "unchanged");
  assert.equal(repeated.imported, false);
  assert.equal(importCount, 1);
});

test("GTFS refresh rejects non-ZIP responses before importing", async (context) => {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "railscout-gtfs-"));
  context.after(() => rm(cacheDirectory, { recursive: true, force: true }));
  let imported = false;

  await assert.rejects(
    refreshGtfs({
      sourceUrl: "https://example.test/polish_trains.zip",
      cacheDirectory,
      fetchImpl: async () =>
        new Response("not a zip", {
          status: 200,
          headers: { "Content-Type": "application/zip" },
        }),
      importFeedImpl: async () => {
        imported = true;
      },
      retries: 0,
    }),
    /not a ZIP archive/,
  );
  assert.equal(imported, false);
});
