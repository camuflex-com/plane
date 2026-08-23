import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Comparación en tiempo constante. `timingSafeEqual` revienta si los buffers
 * miden distinto, así que se comprueba la longitud antes.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Plane firma el cuerpo con HMAC-SHA256 y lo manda en `X-Plane-Signature`,
 * en hexadecimal y sin prefijo.
 */
export function verifyPlaneSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return safeEqual(expected, signature);
}

/** GitHub usa `X-Hub-Signature-256`, con prefijo `sha256=`. */
export function verifyGitHubSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return safeEqual(expected, signature);
}
