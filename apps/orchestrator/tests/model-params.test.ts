import { describe, expect, it } from "vitest";
import { parseModelParams } from "@/clients/cursor";
import { loadEnv } from "@/env";
import {
  appendModelMarker,
  flattenModelCatalog,
  formatModelMarker,
  parseModelMarker,
  stripModelMarker,
} from "@/model";

const required = {
  DATABASE_URL: "postgres://localhost/orchestrator",
  PLANE_BASE_URL: "https://plane.example.com",
  PLANE_API_KEY: "plane-key",
  PLANE_WEBHOOK_SECRET: "plane-secret",
  PLANE_BOT_USER_ID: "eea8b7cb-5ecd-426c-a740-1a64bcfef307",
  CURSOR_API_KEY: "cursor-key",
  GITHUB_TOKEN: "gh-token",
  GITHUB_WEBHOOK_SECRET: "gh-secret",
};

describe("parámetros del modelo", () => {
  it("convierte la variante por defecto de grok-4.6", () => {
    expect(parseModelParams("effort=high,fast=true")).toEqual([
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ]);
  });

  it("sin CURSOR_MODEL usa grok-4.6 en high y fast", () => {
    const env = loadEnv(required);
    expect(env.CURSOR_MODEL).toBe("grok-4.6");
    expect(env.CURSOR_MODEL_PARAMS).toBe("effort=high,fast=true");
  });

  it("tolera espacios", () => {
    expect(parseModelParams(" effort = high , fast = true ")).toEqual([
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ]);
  });

  it("sin valor devuelve lista vacía", () => {
    expect(parseModelParams(undefined)).toEqual([]);
    expect(parseModelParams("")).toEqual([]);
    expect(parseModelParams("   ")).toEqual([]);
  });

  // Un par malformado se descarta en vez de mandar basura a la API.
  it("descarta pares sin '='", () => {
    expect(parseModelParams("effort=high,basura,fast=true")).toEqual([
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ]);
  });
});

describe("marcador de modelo en la issue", () => {
  it("redondea id y params", () => {
    const marker = formatModelMarker({ id: "grok-4.6", params: "effort=high,fast=true" });
    expect(marker).toBe("[camuflex-model grok-4.6 effort=high,fast=true]");
    expect(parseModelMarker(`tarea\n\n${marker}`)).toEqual({
      id: "grok-4.6",
      params: "effort=high,fast=true",
    });
  });

  it("lo quita del prompt del agente", () => {
    expect(stripModelMarker("Arregla el health\n\n[camuflex-model grok-4.6 effort=high,fast=true]")).toBe(
      "Arregla el health"
    );
  });

  it("lo añade al final de la descripción de ingest", () => {
    expect(appendModelMarker("falló /health", { id: "composer-2", params: "fast=true" })).toBe(
      "falló /health\n\n[camuflex-model composer-2 fast=true]"
    );
  });

  it("pone el default primero al aplanar el catálogo de Cursor", () => {
    const options = flattenModelCatalog(
      [
        {
          id: "composer-2",
          displayName: "Composer 2",
          variants: [{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2 Fast" }],
        },
      ],
      { id: "grok-4.6", params: "effort=high,fast=true" }
    );
    expect(options[0]).toMatchObject({ id: "grok-4.6", params: "effort=high,fast=true", isDefault: true });
    expect(options.some((option) => option.id === "composer-2")).toBe(true);
  });
});
