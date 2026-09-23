import { describe, expect, it } from "vitest";
import { classifyAgentStatus, gateVerdict, type GateInput } from "@/gate";

const input = (over: Partial<GateInput> = {}, pr: Partial<GateInput["pr"]> = {}): GateInput => ({
  verdict: "success",
  agent: "finished",
  reviewedSha: "abc",
  deferrals: 0,
  maxDeferrals: 90,
  ...over,
  pr: {
    merged: false,
    draft: false,
    headSha: "abc",
    mergeable: true,
    mergeableState: "clean",
    ...pr,
  },
});

describe("estado del agente de Cursor", () => {
  it.each([
    ["FINISHED", "finished"],
    ["RUNNING", "running"],
    ["CREATING", "running"],
    ["CANCELLED", "failed"],
    ["ERROR", "failed"],
    [undefined, "unknown"],
    ["ALGO_NUEVO", "unknown"],
  ] as const)("%s -> %s", (status, expected) => {
    expect(classifyAgentStatus(status)).toBe(expected);
  });
});

describe("el agente todavía trabaja", () => {
  // El caso real: Bugbot dio verde a las 15:58 sobre el borrador a medias,
  // y el agente siguió empujando commits hasta las 16:15.
  it("no mergea un verde sobre trabajo a medias", () => {
    expect(gateVerdict(input({ agent: "running" }, { draft: true })).kind).toBe("wait");
  });

  it("tampoco aplica hallazgos: el agente quizá los arregla solo", () => {
    expect(gateVerdict(input({ agent: "running", verdict: "findings" }, { draft: true })).kind).toBe("wait");
  });

  it("si Cursor no responde, espera en vez de suponer", () => {
    expect(gateVerdict(input({ agent: "unknown" })).kind).toBe("wait");
  });

  it("se rinde tras agotar la espera", () => {
    expect(gateVerdict(input({ agent: "running", deferrals: 90 })).kind).toBe("give_up");
  });

  it("un agente cancelado o con error no se mergea", () => {
    expect(gateVerdict(input({ agent: "failed" })).kind).toBe("give_up");
  });
});

describe("commit revisado", () => {
  it("descarta el veredicto de un commit que ya no es HEAD", () => {
    expect(gateVerdict(input({ reviewedSha: "viejo" }, { headSha: "nuevo" })).kind).toBe("stale");
  });

  it("sin sha revisado conocido, no lo da por viejo", () => {
    expect(gateVerdict(input({ reviewedSha: null })).kind).toBe("apply");
  });
});

describe("regla del borrador", () => {
  it("con verde sobre un borrador, lo saca de borrador", () => {
    expect(gateVerdict(input({}, { draft: true, mergeableState: "draft" })).kind).toBe("mark_ready");
  });

  // Regla pedida: solo sale de borrador si Bugbot no encontró nada.
  it("con hallazgos, NO lo saca de borrador", () => {
    expect(gateVerdict(input({ verdict: "findings" }, { draft: true, mergeableState: "draft" })).kind).toBe("apply");
  });
});

describe("mergeabilidad tras salir de borrador", () => {
  it("mergea cuando GitHub lo da por clean", () => {
    expect(gateVerdict(input()).kind).toBe("apply");
  });

  it("espera mientras GitHub calcula", () => {
    expect(gateVerdict(input({}, { mergeable: null, mergeableState: "unknown" })).kind).toBe("wait");
  });

  it.each(["blocked", "unstable", "behind"] as const)("espera con %s (CI en curso)", (state) => {
    expect(gateVerdict(input({}, { mergeableState: state })).kind).toBe("wait");
  });

  it("con conflictos se rinde en vez de esperar para siempre", () => {
    expect(gateVerdict(input({}, { mergeableState: "dirty" })).kind).toBe("give_up");
  });

  it("un PR ya mergeado se deja registrar", () => {
    expect(gateVerdict(input({ agent: "running" }, { merged: true })).kind).toBe("apply");
  });
});
