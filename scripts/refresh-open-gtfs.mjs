import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  openSync,
  writeSync,
} from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Unzip, UnzipInflate } from "fflate";
import { importFeed } from "./import-open-gtfs.mjs";

export const DEFAULT_GTFS_URL = "https://mkuran.pl/gtfs/polish_trains.zip";

const REQUIRED_FILES = new Set([
  "attributions.txt",
  "calendar_dates.txt",
  "routes.txt",
  "stop_times.txt",
  "stops.txt",
  "trips.txt",
]);
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 768 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readCacheMetadata(metadataPath) {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (
      metadata?.schemaVersion !== 1 ||
      typeof metadata.sourceUrl !== "string" ||
      !metadata.sourceUrl ||
      typeof metadata.archiveFile !== "string" ||
      path.basename(metadata.archiveFile) !== metadata.archiveFile ||
      !/^polish_trains-[a-f0-9]{64}\.zip$/.test(metadata.archiveFile)
    ) {
      return null;
    }
    return metadata;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    await rm(filePath, { force: true });
    await rename(temporaryPath, filePath);
  }
}

function isRetryableResponse(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function requestFeed({
  sourceUrl,
  headers,
  fetchImpl,
  retries,
  retryDelayMs,
}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(sourceUrl, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
    }

    if (response) {
      if (response.status === 304 || response.ok) return response;
      const error = new Error(`GTFS feed returned HTTP ${response.status}.`);
      if (!isRetryableResponse(response.status)) throw error;
      await response.body?.cancel();
      lastError = error;
    }
    if (attempt === retries) break;
    await sleep(retryDelayMs * 2 ** attempt);
  }
  throw lastError ?? new Error("GTFS feed request failed.");
}

function validateZipHeader(header) {
  return (
    header.length >= 4 &&
    header[0] === 0x50 &&
    header[1] === 0x4b &&
    header[2] === 0x03 &&
    header[3] === 0x04
  );
}

async function downloadArchive(response, cacheDirectory) {
  if (!response.body) throw new Error("GTFS response did not contain a body.");

  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (
    contentType &&
    !contentType.includes("application/zip") &&
    !contentType.includes("application/octet-stream") &&
    !contentType.includes("binary/octet-stream")
  ) {
    throw new Error(`GTFS response has an unexpected content type: ${contentType}.`);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`GTFS archive is larger than the ${MAX_ARCHIVE_BYTES}-byte safety limit.`);
  }

  const temporaryPath = path.join(
    cacheDirectory,
    `.polish_trains-${process.pid}-${Date.now()}.part`,
  );
  const handle = await open(temporaryPath, "wx");
  const hash = createHash("sha256");
  let totalBytes = 0;
  let header = Buffer.alloc(0);

  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_ARCHIVE_BYTES) {
        throw new Error(`GTFS archive exceeded the ${MAX_ARCHIVE_BYTES}-byte safety limit.`);
      }
      if (header.length < 4) {
        header = Buffer.concat([header, buffer.subarray(0, 4 - header.length)]);
      }
      hash.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();

  if (!validateZipHeader(header)) {
    await rm(temporaryPath, { force: true });
    throw new Error("GTFS response is not a ZIP archive.");
  }

  const sha256 = hash.digest("hex");
  const archiveFile = `polish_trains-${sha256}.zip`;
  const archivePath = path.join(cacheDirectory, archiveFile);
  if (await pathExists(archivePath)) {
    await rm(temporaryPath, { force: true });
  } else {
    await rename(temporaryPath, archivePath);
  }
  return { archiveFile, archivePath, sha256, totalBytes };
}

function writeAllSync(fileDescriptor, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    offset += writeSync(
      fileDescriptor,
      chunk,
      offset,
      chunk.length - offset,
    );
  }
}

export async function extractRequiredGtfs(archivePath, cacheDirectory) {
  const extractionDirectory = await mkdtemp(path.join(cacheDirectory, "extract-"));
  const found = new Set();
  let extractedBytes = 0;
  let extractionError = null;

  try {
    const unzip = new Unzip((file) => {
      const entryName = file.name.replaceAll("\\", "/");
      const baseName = path.posix.basename(entryName);
      if (!REQUIRED_FILES.has(baseName)) return;
      if (found.has(baseName)) {
        extractionError = new Error(`GTFS archive contains duplicate ${baseName} entries.`);
        return;
      }
      if (file.originalSize !== undefined && file.originalSize > MAX_FILE_BYTES) {
        extractionError = new Error(`${baseName} exceeds the extraction safety limit.`);
        return;
      }

      found.add(baseName);
      const destination = path.join(extractionDirectory, baseName);
      const fileDescriptor = openSync(destination, "wx");
      let fileBytes = 0;
      let closed = false;
      const closeFile = () => {
        if (!closed) {
          closeSync(fileDescriptor);
          closed = true;
        }
      };

      file.ondata = (error, chunk, final) => {
        if (extractionError) {
          closeFile();
          file.terminate();
          return;
        }
        if (error) {
          closeFile();
          extractionError = error;
          return;
        }
        fileBytes += chunk.length;
        extractedBytes += chunk.length;
        if (fileBytes > MAX_FILE_BYTES || extractedBytes > MAX_EXTRACTED_BYTES) {
          closeFile();
          extractionError = new Error("GTFS archive exceeded the extraction safety limits.");
          file.terminate();
          return;
        }
        writeAllSync(fileDescriptor, chunk);
        if (final) closeFile();
      };
      file.start();
    });
    unzip.register(UnzipInflate);

    for await (const chunk of createReadStream(archivePath, {
      highWaterMark: 1024 * 1024,
    })) {
      if (extractionError) throw extractionError;
      unzip.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    unzip.push(new Uint8Array(), true);
    if (extractionError) throw extractionError;

    const missing = [...REQUIRED_FILES].filter((file) => !found.has(file));
    if (missing.length > 0) {
      throw new Error(`GTFS archive is missing required files: ${missing.join(", ")}.`);
    }
    return extractionDirectory;
  } catch (error) {
    await rm(extractionDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function importArchive({
  archivePath,
  cacheDirectory,
  sourceUrl,
  retrievedAt,
  importFeedImpl,
}) {
  const extractionDirectory = await extractRequiredGtfs(archivePath, cacheDirectory);
  try {
    await importFeedImpl(extractionDirectory, { sourceUrl, retrievedAt });
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
}

export async function refreshGtfs({
  sourceUrl = DEFAULT_GTFS_URL,
  cacheDirectory = path.resolve(".cache", "gtfs"),
  requireFresh = false,
  force = false,
  forceImport = false,
  fetchImpl = fetch,
  importFeedImpl = importFeed,
  retries = 2,
  retryDelayMs = 1_000,
} = {}) {
  const resolvedCacheDirectory = path.resolve(cacheDirectory);
  await mkdir(resolvedCacheDirectory, { recursive: true });
  const metadataPath = path.join(resolvedCacheDirectory, "metadata.json");
  const cachedMetadata = await readCacheMetadata(metadataPath);
  const previousMetadata =
    cachedMetadata?.sourceUrl === sourceUrl ? cachedMetadata : null;
  const previousArchivePath = previousMetadata
    ? path.join(resolvedCacheDirectory, previousMetadata.archiveFile)
    : null;
  const hasPreviousArchive = previousArchivePath
    ? await pathExists(previousArchivePath)
    : false;
  const headers = { Accept: "application/zip, application/octet-stream" };
  if (!force && hasPreviousArchive) {
    if (previousMetadata.etag) headers["If-None-Match"] = previousMetadata.etag;
    if (previousMetadata.lastModified) {
      headers["If-Modified-Since"] = previousMetadata.lastModified;
    }
  }

  let response;
  try {
    response = await requestFeed({
      sourceUrl,
      headers,
      fetchImpl,
      retries,
      retryDelayMs,
    });
  } catch (error) {
    if (!hasPreviousArchive || requireFresh) throw error;
    if (forceImport) {
      await importArchive({
        archivePath: previousArchivePath,
        cacheDirectory: resolvedCacheDirectory,
        sourceUrl,
        retrievedAt: previousMetadata.retrievedAt,
        importFeedImpl,
      });
    }
    return {
      status: "stale-cache",
      imported: forceImport,
      archivePath: previousArchivePath,
      warning: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status === 304) {
    if (!hasPreviousArchive) {
      throw new Error("GTFS server returned 304 but no cached archive exists.");
    }
    if (forceImport) {
      await importArchive({
        archivePath: previousArchivePath,
        cacheDirectory: resolvedCacheDirectory,
        sourceUrl,
        retrievedAt: previousMetadata.retrievedAt,
        importFeedImpl,
      });
    }
    return {
      status: "unchanged",
      imported: forceImport,
      archivePath: previousArchivePath,
    };
  }

  const downloaded = await downloadArchive(response, resolvedCacheDirectory);
  const retrievedAt = new Date().toISOString();
  const sameContent =
    hasPreviousArchive && previousMetadata.sha256 === downloaded.sha256;
  const metadata = {
    schemaVersion: 1,
    sourceUrl,
    archiveFile: downloaded.archiveFile,
    sha256: downloaded.sha256,
    contentLength: downloaded.totalBytes,
    etag: response.headers.get("etag") ?? previousMetadata?.etag ?? null,
    lastModified:
      response.headers.get("last-modified") ??
      previousMetadata?.lastModified ??
      null,
    retrievedAt,
  };
  if (!sameContent || forceImport) {
    await importArchive({
      archivePath: downloaded.archivePath,
      cacheDirectory: resolvedCacheDirectory,
      sourceUrl,
      retrievedAt,
      importFeedImpl,
    });
  }
  await writeJsonAtomic(metadataPath, metadata);
  if (
    hasPreviousArchive &&
    previousArchivePath !== downloaded.archivePath
  ) {
    await rm(previousArchivePath, { force: true });
  }

  return {
    status: sameContent ? "unchanged" : "updated",
    imported: !sameContent || forceImport,
    archivePath: downloaded.archivePath,
    sha256: downloaded.sha256,
    bytes: downloaded.totalBytes,
  };
}

function parseCliArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--require-fresh") options.requireFresh = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--force-import") options.forceImport = true;
    else if (argument === "--cache-dir" || argument === "--url") {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === "--cache-dir") options.cacheDirectory = value;
      else options.sourceUrl = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const result = await refreshGtfs(parseCliArguments(process.argv.slice(2)));
  if (result.status === "updated") {
    console.log(
      `Downloaded and imported GTFS ${result.sha256.slice(0, 12)} (${result.bytes} bytes).`,
    );
  } else if (result.status === "unchanged") {
    console.log(
      result.imported
        ? "GTFS feed is unchanged; re-imported the verified cached archive."
        : "GTFS feed is unchanged; kept the existing generated snapshot.",
    );
  } else {
    console.warn(
      result.imported
        ? `GTFS refresh failed; re-imported the last verified cached archive. ${result.warning}`
        : `GTFS refresh failed; kept the cached archive and generated snapshot. ${result.warning}`,
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
