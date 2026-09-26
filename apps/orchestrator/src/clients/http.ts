// oxlint-disable no-await-in-loop -- la secuencialidad es intencionada:
// reintentos con backoff, sondeo de la cola y acciones que deben aplicarse
// en orden. Paralelizarlas rompería justamente lo que se busca.
import { logger } from "@/logger";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string
  ) {
    super(`${status} en ${url}: ${body.slice(0, 400)}`);
    this.name = "HttpError";
  }
}

/**
 * Un fetch con reintentos para fallos transitorios.
 *
 * Solo reintenta 429 y 5xx: un 4xx distinto significa que la petición está
 * mal y repetirla no la va a arreglar.
 */
export async function requestJson<T>(url: string, init: RequestInit & { retries?: number } = {}): Promise<T> {
  const { retries = 3, ...rest } = init;

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, rest);
    } catch (cause) {
      if (attempt >= retries) throw cause;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (response.ok) {
      const text = await response.text();
      return (text ? JSON.parse(text) : null) as T;
    }

    const body = await response.text().catch(() => "");
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= retries) {
      throw new HttpError(response.status, url, body);
    }

    const wait = retryAfterMs(response) ?? backoffMs(attempt);
    logger.warn("reintentando petición", { url, status: response.status, attempt, waitMs: wait });
    await sleep(wait);
  }
}

/** Descarga binaria con tope de tamaño: una imagen enorme no llena la memoria. */
export async function fetchBytes(url: string, maxBytes: number, init: RequestInit = {}): Promise<Uint8Array> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new HttpError(response.status, url.split("?")[0] ?? url, await response.text().catch(() => ""));
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(`archivo de ${declared} bytes, supera el máximo de ${maxBytes}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes)
    throw new Error(`archivo de ${bytes.byteLength} bytes, supera el máximo de ${maxBytes}`);
  return bytes;
}

const backoffMs = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt);

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
