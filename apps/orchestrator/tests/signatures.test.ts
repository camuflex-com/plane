import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseSecrets,
  verifyApiKey,
  verifyGitHubSignature,
  verifyPlaneSignature,
  verifyPlaneSignatureAny,
} from "@/signatures";

const SECRET = "un-secreto-cualquiera";
const BODY = JSON.stringify({ event: "issue", data: { id: "abc" } });

const planeSig = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body, "utf8").digest("hex");
const githubSig = (body: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");

describe("firma de Plane", () => {
  it("acepta una firma correcta", () => {
    expect(verifyPlaneSignature(BODY, planeSig(BODY), SECRET)).toBe(true);
  });

  it("rechaza si falta la cabecera", () => {
    expect(verifyPlaneSignature(BODY, undefined, SECRET)).toBe(false);
  });

  it("rechaza un cuerpo alterado", () => {
    expect(verifyPlaneSignature(BODY + " ", planeSig(BODY), SECRET)).toBe(false);
  });

  it("rechaza otro secreto", () => {
    expect(verifyPlaneSignature(BODY, planeSig(BODY, "otro"), SECRET)).toBe(false);
  });

  // timingSafeEqual revienta con buffers de distinta longitud si no se
  // comprueba antes; esto verifica que devuelve false en vez de lanzar.
  it("rechaza una firma de longitud distinta sin lanzar", () => {
    expect(() => verifyPlaneSignature(BODY, "corta", SECRET)).not.toThrow();
    expect(verifyPlaneSignature(BODY, "corta", SECRET)).toBe(false);
  });
});

describe("API key del bot", () => {
  it("acepta la clave exacta", () => {
    expect(verifyApiKey("plane_api_abc", "plane_api_abc")).toBe(true);
  });

  it("rechaza si falta la cabecera", () => {
    expect(verifyApiKey(undefined, "plane_api_abc")).toBe(false);
  });

  it("rechaza otra clave", () => {
    expect(verifyApiKey("plane_api_xyz", "plane_api_abc")).toBe(false);
  });
});

describe("firma de GitHub", () => {
  it("acepta una firma correcta con su prefijo", () => {
    expect(verifyGitHubSignature(BODY, githubSig(BODY), SECRET)).toBe(true);
  });

  it("rechaza la misma firma sin el prefijo sha256=", () => {
    expect(verifyGitHubSignature(BODY, planeSig(BODY), SECRET)).toBe(false);
  });

  it("rechaza un cuerpo alterado", () => {
    expect(verifyGitHubSignature('{"x":1}', githubSig(BODY), SECRET)).toBe(false);
  });
});

describe("varios webhooks de Plane", () => {
  // Plane genera un secreto por webhook: con un proyecto por repo, el
  // orquestador tiene que aceptar la firma de cualquiera de ellos.
  const A = "plane_wh_aaaa";
  const B = "plane_wh_bbbb";

  it("separa la lista y descarta vacíos", () => {
    expect(parseSecrets(` ${A} , ${B} ,, `)).toEqual([A, B]);
    expect(parseSecrets(A)).toEqual([A]);
  });

  it("acepta la firma del primer webhook", () => {
    expect(verifyPlaneSignatureAny(BODY, planeSig(BODY, A), [A, B])).toBe(true);
  });

  it("acepta la firma del segundo webhook", () => {
    expect(verifyPlaneSignatureAny(BODY, planeSig(BODY, B), [A, B])).toBe(true);
  });

  it("rechaza una firma que no es de ninguno", () => {
    expect(verifyPlaneSignatureAny(BODY, planeSig(BODY, "otro"), [A, B])).toBe(false);
  });

  // Compatibilidad: la configuración actual es un único secreto sin comas.
  it("sigue funcionando con un único secreto", () => {
    expect(verifyPlaneSignatureAny(BODY, planeSig(BODY, A), parseSecrets(A))).toBe(true);
  });
});
