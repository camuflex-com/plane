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

/**
 * Separa una lista de secretos escrita como `a,b,c`.
 *
 * Plane genera un secreto distinto por cada webhook, así que con un proyecto
 * por repo hay tantos secretos como proyectos automatizados.
 */
export function parseSecrets(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Vale si la firma coincide con cualquiera de los secretos. */
export function verifyPlaneSignatureAny(rawBody: string, signature: string | undefined, secrets: string[]): boolean {
  // `some` se detiene en la primera coincidencia, pero cada comparación sigue
  // siendo en tiempo constante; lo único que filtra es cuál de los secretos
  // coincidió, y todos pertenecen a la misma instancia de Plane.
  return secrets.some((secret) => verifyPlaneSignature(rawBody, signature, secret));
}

/** GitHub usa `X-Hub-Signature-256`, con prefijo `sha256=`. */
export function verifyGitHubSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return safeEqual(expected, signature);
}

/**
 * Clave de API del bot (`X-API-Key`). El backend de Camuflex la lee de SSM
 * y la manda igual que contra la API de Plane.
 */
export function verifyApiKey(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return safeEqual(provided, expected);
}
