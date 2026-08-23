import { describe, expect, it } from "vitest";
import { cleanFinding, isBugbot } from "@/executor";

// Cuerpos reales tomados del PR #3 de camuflex-backend.
const REAL_INLINE = `### Log injection via driver identity

**High Severity**

<!-- DESCRIPTION START -->
El identificador del conductor se escribe sin sanear.`;

const REAL_REVIEW = `<!-- BUGBOT_REVIEW -->
Cursor Bugbot has reviewed your changes using high effort and found 2 potential issues.`;

describe("autoría de Bugbot", () => {
  it("reconoce cursor[bot]", () => {
    expect(isBugbot("cursor[bot]")).toBe(true);
    expect(isBugbot("Cursor")).toBe(true);
    expect(isBugbot("bugbot")).toBe(true);
  });

  it("no confunde a otros bots", () => {
    expect(isBugbot("github-actions[bot]")).toBe(false);
    expect(isBugbot("FrijolEnjoyer")).toBe(false);
    expect(isBugbot(undefined)).toBe(false);
  });
});

describe("extracción del hallazgo", () => {
  it("saca el título del comentario en línea, sin la almohadilla", () => {
    expect(cleanFinding(REAL_INLINE)).toBe("Log injection via driver identity");
  });

  // El resumen empieza por un comentario HTML; si no se saltara, el texto
  // mostrado en la issue sería `<!-- BUGBOT_REVIEW -->`.
  it("salta el marcador HTML del resumen de la review", () => {
    expect(cleanFinding(REAL_REVIEW)).toContain("found 2 potential issues");
    expect(cleanFinding(REAL_REVIEW)).not.toContain("<!--");
  });

  it("tolera un cuerpo vacío", () => {
    expect(cleanFinding("")).toBe("");
    expect(cleanFinding("\n\n  \n")).toBe("");
  });

  it("recorta cuerpos muy largos", () => {
    expect(cleanFinding("x".repeat(500)).length).toBe(300);
  });
});
