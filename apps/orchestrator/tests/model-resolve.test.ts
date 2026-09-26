import { describe, expect, it } from "vitest";
import type { CursorModel, CursorModelVariant } from "@/model";
import { resolveModel } from "@/model-resolve";

/** Todas las combinaciones de los dominios, como hace el catálogo real. */
function variants(domains: Record<string, string[]>, defaults: Record<string, string>): CursorModelVariant[] {
  let combos: [string, string][][] = [[]];
  for (const [id, values] of Object.entries(domains)) {
    combos = combos.flatMap((combo) => values.map((value) => combo.concat([[id, value]])));
  }
  return combos.map((combo) => ({
    params: combo.map(([id, value]) => ({ id, value })),
    isDefault: combo.every(([id, value]) => defaults[id] === value),
  }));
}

// Recorte fiel del catálogo de Cursor del 2026-09-26.
const CATALOG: CursorModel[] = [
  {
    id: "grok-4.6",
    variants: variants(
      { effort: ["low", "medium", "high", "xhigh"], fast: ["false", "true"] },
      { effort: "high", fast: "true" }
    ),
  },
  {
    id: "grok-4.7",
    variants: variants(
      { context: ["256k", "500k"], reasoning_effort: ["low", "medium", "high", "xhigh"], fast: ["false", "true"] },
      { context: "500k", reasoning_effort: "high", fast: "true" }
    ),
  },
  {
    id: "claude-fable-5-1",
    aliases: ["fable-5-1"],
    variants: variants(
      { thinking: ["false", "true"], context: ["300k", "1m"], effort: ["low", "medium", "high", "xhigh", "max"] },
      { thinking: "true", context: "1m", effort: "high" }
    ),
  },
  {
    id: "gpt-5.6-sol",
    aliases: ["gpt-latest"],
    variants: variants(
      {
        context: ["272k", "1m"],
        reasoning: ["none", "low", "medium", "high", "xhigh", "max"],
        fast: ["false", "true"],
      },
      { context: "1m", reasoning: "medium", fast: "false" }
    ),
  },
  { id: "gemini-3.1-pro", variants: [{ params: [], isDefault: true }] },
  { id: "default", aliases: ["auto"], variants: [{ params: [], isDefault: true }] },
];

const FALLBACK = { id: "claude-fable-5-1", params: "thinking=true,context=1m,effort=high" };

describe("selección válida", () => {
  it("una variante exacta pasa tal cual", () => {
    const r = resolveModel({ id: "grok-4.6", params: "effort=high,fast=true" }, FALLBACK, CATALOG);
    expect(r).toEqual({ id: "grok-4.6", params: "effort=high,fast=true", adjustments: [] });
  });

  it("el orden de los parámetros no importa", () => {
    const r = resolveModel({ id: "grok-4.6", params: "fast=true,effort=high" }, FALLBACK, CATALOG);
    expect(r.params).toBe("effort=high,fast=true");
    expect(r.adjustments).toEqual([]);
  });

  it("un alias se resuelve al id canónico", () => {
    expect(resolveModel({ id: "gpt-latest", params: "" }, FALLBACK, CATALOG).id).toBe("gpt-5.6-sol");
  });

  it("un modelo sin parámetros no recibe ninguno", () => {
    const r = resolveModel({ id: "gemini-3.1-pro", params: "" }, FALLBACK, CATALOG);
    expect(r).toEqual({ id: "gemini-3.1-pro", params: "", adjustments: [] });
  });
});

describe("nunca se mezclan parámetros de otro modelo", () => {
  // El bug de antes: una issue que elegía un modelo sin parámetros heredaba
  // los del default (`effort=high,fast=true` de Grok).
  it("un modelo elegido sin parámetros no hereda los del default", () => {
    const r = resolveModel(
      { id: "gemini-3.1-pro", params: "" },
      { id: "grok-4.6", params: "effort=high,fast=true" },
      CATALOG
    );
    expect(r.params).toBe("");
  });

  it("`effort` de Grok 4.6 no llega a Grok 4.7, que usa `reasoning_effort`", () => {
    const r = resolveModel({ id: "grok-4.7", params: "effort=high,fast=true" }, FALLBACK, CATALOG);
    expect(r.params).toBe("context=500k,reasoning_effort=high,fast=true");
    expect(r.adjustments.join(" ")).toContain("effort=high no existe en grok-4.7");
  });

  it("`fast` no llega a Fable, que no lo tiene", () => {
    const r = resolveModel({ id: "claude-fable-5-1", params: "effort=max,fast=true" }, FALLBACK, CATALOG);
    expect(r.params).toBe("thinking=true,context=1m,effort=max");
  });
});

describe("selección incompleta o vieja", () => {
  it("completa los parámetros que faltan con los del propio modelo", () => {
    const r = resolveModel({ id: "gpt-5.6-sol", params: "reasoning=high" }, FALLBACK, CATALOG);
    expect(r.params).toBe("context=1m,reasoning=high,fast=false");
  });

  it("un valor que el modelo ya no admite cae a su variante por defecto", () => {
    const r = resolveModel({ id: "grok-4.6", params: "effort=ultra,fast=true" }, FALLBACK, CATALOG);
    expect(r.params).toBe("effort=high,fast=true");
    expect(r.adjustments.length).toBeGreaterThan(0);
  });

  it("un modelo retirado cae al default configurado", () => {
    const r = resolveModel({ id: "grok-4.1", params: "effort=high" }, FALLBACK, CATALOG);
    expect(r.id).toBe("claude-fable-5-1");
    expect(r.params).toBe("thinking=true,context=1m,effort=high");
  });

  it("si ni el default existe, deja elegir a Cursor", () => {
    const r = resolveModel({ id: "grok-4.1", params: "" }, { id: "otro-retirado", params: "" }, CATALOG);
    expect(r).toMatchObject({ id: "default", params: "" });
  });
});

describe("sin catálogo", () => {
  it("manda la selección tal cual, sin mezclarle el default", () => {
    const r = resolveModel({ id: "gemini-3.1-pro", params: "" }, FALLBACK, []);
    expect(r).toMatchObject({ id: "gemini-3.1-pro", params: "" });
  });

  it("sin selección, manda el default", () => {
    expect(resolveModel(null, FALLBACK, [])).toMatchObject(FALLBACK);
  });
});
