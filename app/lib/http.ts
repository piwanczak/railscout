const DEFAULT_MAXIMUM_BODY_BYTES = 64 * 1024;

export class HttpInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 413 | 415,
  ) {
    super(message);
  }
}

export async function readJsonBody<T>(
  request: Request,
  maximumBytes = DEFAULT_MAXIMUM_BODY_BYTES,
): Promise<T> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new HttpInputError("Wymagany jest format JSON.", 415);
  }

  const contentLength = request.headers.get("content-length");
  const declaredLength = contentLength === null ? null : Number(contentLength);
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    throw new HttpInputError("Żądanie jest zbyt duże.", 413);
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > maximumBytes) {
          await reader.cancel().catch(() => undefined);
          throw new HttpInputError("Żądanie jest zbyt duże.", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON body must be an object");
    }
    return parsed as T;
  } catch {
    throw new HttpInputError("Nieprawidłowy dokument JSON.", 400);
  }
}

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, { ...init, headers });
}
