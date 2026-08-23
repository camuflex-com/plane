import { describe, expect, it } from "vitest";
import type { MergeableState, PullRequest } from "@/clients/github";
import { assertMergeable } from "@/executor";

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  state: "open",
  merged: false,
  draft: false,
  mergeable: true,
  mergeable_state: "clean",
  head: { sha: "abc", ref: "cursor/x" },
  ...over,
});

describe("puerta de merge", () => {
  it("deja pasar solo 'clean'", () => {
    expect(() => assertMergeable(pr())).not.toThrow();
  });

  // Cada uno de estos significa que algo no está bien: conflictos, checks
  // requeridos en rojo, checks no requeridos fallando, o rama desactualizada.
  it.each<MergeableState>(["blocked", "unstable", "dirty", "behind", "draft"])(
    "rechaza mergeable_state = %s",
    (state) => {
      expect(() => assertMergeable(pr({ mergeable_state: state }))).toThrow(/No se mergea/);
    }
  );

  // GitHub calcula el merge de forma asíncrona. Lanzar hace que el job
  // reintente con backoff en vez de decidir con información incompleta.
  it("reintenta mientras GitHub aún calcula", () => {
    expect(() => assertMergeable(pr({ mergeable: null }))).toThrow(/aún calcula/);
    expect(() => assertMergeable(pr({ mergeable_state: "unknown" }))).toThrow(/aún calcula/);
  });

  it("no vuelve a mergear algo ya mergeado", () => {
    expect(() => assertMergeable(pr({ merged: true }))).toThrow(/ya está mergeado/);
  });
});
