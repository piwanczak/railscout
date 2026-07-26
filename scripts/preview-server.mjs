import { access, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const clientRoot = resolve(projectRoot, "dist/client");
const workerEntry = resolve(projectRoot, "dist/server/index.js");
const maximumRequestBodyBytes = 64 * 1024;

class PayloadTooLargeError extends Error {}

const contentTypes = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function option(name, fallback) {
  const equalsPrefix = `${name}=`;
  const equalsValue = process.argv.find((argument) =>
    argument.startsWith(equalsPrefix),
  );
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);

  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const port = Number(option("--port", process.env.PORT ?? "3001"));
const host = option("--host", process.env.HOST ?? "127.0.0.1");

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid port: ${port}`);
}

await access(workerEntry).catch(() => {
  throw new Error("Missing dist/server/index.js. Run `npm run build` first.");
});
await access(clientRoot).catch(() => {
  throw new Error("Missing dist/client. Run `npm run build` first.");
});

const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));

function assetPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decoded.replace(/^\/+/, "");
  if (!relativePath || relativePath.includes("\0")) return null;

  const absolutePath = resolve(clientRoot, relativePath);
  if (
    absolutePath !== clientRoot &&
    !absolutePath.startsWith(`${clientRoot}${sep}`)
  ) {
    return null;
  }

  return absolutePath;
}

async function fetchAsset(request) {
  const path = assetPath(new URL(request.url).pathname);
  if (!path) return new Response("Not found", { status: 404 });

  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return new Response("Not found", { status: 404 });

    const headers = new Headers({
      "Content-Length": String(metadata.size),
      "Content-Type": contentTypes.get(extname(path).toLowerCase()) ??
        "application/octet-stream",
    });
    if (path.includes(`${sep}assets${sep}`)) {
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }

    return new Response(await readFile(path), { headers });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}

async function requestBody(request) {
  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    receivedBytes += chunk.byteLength;
    if (receivedBytes > maximumRequestBodyBytes) {
      throw new PayloadTooLargeError();
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const server = createServer(async (nodeRequest, nodeResponse) => {
  try {
    const authority = nodeRequest.headers.host ?? `${host}:${port}`;
    const url = new URL(nodeRequest.url ?? "/", `http://${authority}`);
    const method = nodeRequest.method ?? "GET";
    const directAsset =
      method === "GET" || method === "HEAD"
        ? await fetchAsset(new Request(url, { method }))
        : null;
    const init = {
      headers: new Headers(nodeRequest.headers),
      method,
    };

    if (method !== "GET" && method !== "HEAD") {
      init.body = await requestBody(nodeRequest);
    }

    const response =
      directAsset && directAsset.status !== 404
        ? directAsset
        : await worker.fetch(
            new Request(url, init),
            { ASSETS: { fetch: fetchAsset } },
            {
              passThroughOnException() {},
              waitUntil() {},
            },
          );

    nodeResponse.statusCode = response.status;
    nodeResponse.statusMessage = response.statusText;
    for (const [name, value] of response.headers) {
      nodeResponse.setHeader(name, value);
    }

    if (method === "HEAD" || response.body === null) {
      nodeResponse.end();
      return;
    }

    nodeResponse.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    if (!nodeResponse.headersSent) {
      nodeResponse.writeHead(error instanceof PayloadTooLargeError ? 413 : 500, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
    }
    nodeResponse.end(
      error instanceof PayloadTooLargeError
        ? "Request body too large"
        : "Internal server error",
    );
  }
});

server.listen(port, host, () => {
  console.log(`RailScout preview: http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
