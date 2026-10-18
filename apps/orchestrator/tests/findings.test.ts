import { describe, expect, it } from "vitest";
import {
  cleanFinding,
  interpretBugbotReview,
  isBugbot,
  isBugbotCheck,
  isBugbotGraphqlAuthor,
  parseFoundCount,
  parseUnresolvedCount,
} from "@/executor";

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
    expect(isBugbot("bugbot")).toBe(true);
    expect(isBugbot("bugbot[bot]")).toBe(true);
  });

  it("no confunde a otros bots", () => {
    expect(isBugbot("github-actions[bot]")).toBe(false);
    expect(isBugbot("FrijolEnjoyer")).toBe(false);
    expect(isBugbot(undefined)).toBe(false);
  });
});

describe("check de CI de Bugbot", () => {
  it("acepta Cursor Bugbot", () => {
    expect(isBugbotCheck("Cursor Bugbot")).toBe(true);
    expect(isBugbotCheck("Bugbot")).toBe(true);
  });

  it("no trata los checks del agente como revisión", () => {
    expect(isBugbotCheck("Cursor")).toBe(false);
    expect(isBugbotCheck("Cursor Agent")).toBe(false);
  });
});

describe("interpretación de la revisión de Bugbot", () => {
  it("APPROVED es merge, aunque el cuerpo hable de issues", () => {
    expect(interpretBugbotReview({ state: "approved", body: REAL_REVIEW, findings: [] }).kind).toBe("success");
  });

  it("found 0 potential issues es merge", () => {
    const body = "Cursor Bugbot has reviewed your changes and found 0 potential issues.";
    expect(parseFoundCount(body)).toBe(0);
    expect(interpretBugbotReview({ state: "commented", body, findings: [] }).kind).toBe("success");
  });

  it("found N>0 con el resumen, sin comentarios en línea todavía", () => {
    expect(parseFoundCount(REAL_REVIEW)).toBe(2);
    const d = interpretBugbotReview({ state: "commented", body: REAL_REVIEW, findings: [] });
    expect(d.kind).toBe("findings");
    expect(d.findings[0]).toContain("found 2 potential issues");
  });

  it("usa los comentarios en línea cuando existen", () => {
    const d = interpretBugbotReview({
      state: "commented",
      body: REAL_REVIEW,
      findings: ["iam.tf:12 — Log injection via driver identity"],
    });
    expect(d.kind).toBe("findings");
    expect(d.findings).toEqual(["iam.tf:12 — Log injection via driver identity"]);
  });

  it("CHANGES_REQUESTED cuenta como hallazgos", () => {
    expect(interpretBugbotReview({ state: "changes_requested", body: "", findings: ["x"] }).kind).toBe("findings");
  });

  it("una review vacía no dispara ni merge ni corrección", () => {
    expect(interpretBugbotReview({ state: "commented", body: "", findings: [] }).kind).toBe("ignore");
    expect(interpretBugbotReview({ state: "pending", body: REAL_REVIEW, findings: [] }).kind).toBe("ignore");
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

// Re-revisión real del PR #53 de camuflex-backend (2026-10-18): nada nuevo,
// pero los dos problemas de la revisión anterior siguen abiertos. Antes se
// clasificaba como "sin veredicto" y la run esperaba para siempre.
const RE_REVIEW = `<!-- BUGBOT_REVIEW -->
✅ Bugbot reviewed your changes and found no new issues!

2 issues from previous reviews remain unresolved.

<!-- BUGBOT_FIX_ALL -->`;

describe("problemas de revisiones anteriores sin resolver", () => {
  const unresolved = [
    "lambdas/functions/api-camuflex/app-selfie-task/index.mjs:78 — Missing selfies make GET return 500",
    "lambdas/functions/api-camuflex/app-selfie-task/logic.mjs:73 — Live selfie fallback ignores task identity",
  ];

  it("lee el número de pendientes", () => {
    expect(parseUnresolvedCount(RE_REVIEW)).toBe(2);
    expect(parseUnresolvedCount("1 issue from previous review remains unresolved")).toBe(1);
    expect(parseUnresolvedCount(REAL_REVIEW)).toBeNull();
  });

  it("es un veredicto con hallazgos, no un silencio", () => {
    expect(interpretBugbotReview({ state: "commented", body: RE_REVIEW, findings: [], unresolved })).toEqual({
      kind: "findings",
      findings: unresolved,
    });
  });

  it("sin el detalle de los hilos, igual devuelve al agente con un aviso", () => {
    const d = interpretBugbotReview({ state: "commented", body: RE_REVIEW, findings: [] });
    expect(d.kind).toBe("findings");
    expect(d.findings[0]).toMatch(/2 problema\(s\) de revisiones anteriores/);
  });

  it('"found no new issues" sin pendientes sigue esperando el check en verde', () => {
    const body = "✅ Bugbot reviewed your changes and found no new issues!";
    expect(interpretBugbotReview({ state: "commented", body, findings: [] }).kind).toBe("ignore");
  });

  it("en GraphQL el autor de Bugbot es `cursor`, sin [bot]", () => {
    expect(isBugbotGraphqlAuthor("cursor")).toBe(true);
    expect(isBugbotGraphqlAuthor("cursor[bot]")).toBe(true);
    expect(isBugbotGraphqlAuthor("FrijolEnjoyer")).toBe(false);
    // En los webhooks, en cambio, `cursor` a secas no se acepta.
    expect(isBugbot("cursor")).toBe(false);
  });
});
