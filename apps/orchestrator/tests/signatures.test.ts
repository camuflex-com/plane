import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubSignature, verifyPlaneSignature } from "@/signatures";

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
