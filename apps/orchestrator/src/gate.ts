/**
 * Puerta entre un veredicto de Bugbot y la máquina de estados.
 *
 * Cursor abre el PR como borrador en cuanto empieza y sigue empujando
 * commits; Bugbot revisa cada uno. Sin esta puerta, el orquestador actuaba
 * sobre una foto a medias del trabajo: una revisión en verde de un commit
 * intermedio habría mergeado código incompleto.
 *
 * Reglas:
 * - Ningún veredicto se aplica mientras el agente siga trabajando.
 * - Un veredicto sobre un commit que ya no es HEAD se descarta.
 * - El PR solo sale de borrador cuando Bugbot lo da limpio.
 * - Con hallazgos, el PR se queda en borrador y el veredicto pasa tal cual.
 *
 * Lógica pura: no habla con la red. El executor le trae los datos.
 */

import type { MergeableState } from "@/clients/github";

export type AgentRunStatus = "running" | "finished" | "failed" | "unknown";

/** Traduce el estado de un run de Cursor. */
export function classifyAgentStatus(status: string | undefined | null): AgentRunStatus {
  switch ((status ?? "").toUpperCase()) {
    case "FINISHED":
    case "COMPLETED":
      return "finished";
    case "CREATING":
    case "PENDING":
    case "QUEUED":
    case "RUNNING":
      return "running";
    case "CANCELLED":
    case "CANCELED":
    case "ERROR":
    case "FAILED":
    case "EXPIRED":
      return "failed";
    default:
      return "unknown";
  }
}

export type GateInput = {
  verdict: "success" | "findings";
  agent: AgentRunStatus;
  pr: {
    merged: boolean;
    draft: boolean;
    headSha: string;
    mergeable: boolean | null;
    mergeableState: MergeableState;
  };
  /** Commit sobre el que opinó Bugbot. */
  reviewedSha: string | null;
  /** Cuántas veces se ha pospuesto ya este veredicto. */
  deferrals: number;
  maxDeferrals: number;
};

export type GateDecision =
  /** Bugbot opinó sobre un commit anterior: hay otro veredicto en camino. */
  | { kind: "stale" }
  /** Todavía no: volver a mirar más tarde. */
  | { kind: "wait"; reason: string }
  /** No va a resolverse solo: aparcar para revisión manual. */
  | { kind: "give_up"; reason: string }
  /** Verde sobre un borrador: sacarlo de borrador y volver a mirar. */
  | { kind: "mark_ready" }
  /** Todo listo: pasar el veredicto a la máquina de estados. */
  | { kind: "apply" };

export function gateVerdict(input: GateInput): GateDecision {
  const { pr, verdict, agent } = input;

  // Ya mergeado por otra vía: la máquina lo registra y cierra la issue.
  if (pr.merged) return { kind: "apply" };

  if (input.reviewedSha && input.reviewedSha !== pr.headSha) return { kind: "stale" };

  const wait = (reason: string): GateDecision =>
    input.deferrals >= input.maxDeferrals
      ? { kind: "give_up", reason: `${reason}, y se agotó la espera (${input.maxDeferrals} intentos)` }
      : { kind: "wait", reason };

  if (agent === "failed") {
    return { kind: "give_up", reason: "el agente de Cursor terminó con error o fue cancelado" };
  }
  if (agent !== "finished") return wait("el agente de Cursor sigue trabajando");

  // Con hallazgos el PR se queda en borrador; la máquina lo devuelve al agente.
  if (verdict === "findings") return { kind: "apply" };

  // Verde. Solo ahora puede salir de borrador.
  if (pr.draft || pr.mergeableState === "draft") return { kind: "mark_ready" };

  if (pr.mergeable === null || pr.mergeableState === "unknown") {
    return wait("GitHub aún calcula si el PR es mergeable");
  }
  if (pr.mergeableState === "clean") return { kind: "apply" };

  if (pr.mergeableState === "dirty") {
    return { kind: "give_up", reason: "el PR tiene conflictos con la rama base" };
  }
  // blocked / unstable / behind: normalmente checks de CI todavía en curso.
  return wait(`el PR no está listo para mergear (mergeable_state = ${pr.mergeableState})`);
}

export type BugbotRequestInput = {
  runState: string;
  pr: { merged: boolean; state: string; headSha: string };
  /** HEAD para el que se programó la comprobación. */
  scheduledSha: string;
  /** Último commit para el que ya se pidió "bugbot run". */
  requestedSha: string | null;
};

/**
 * ¿Hay que pedir "bugbot run" para el HEAD del PR?
 *
 * Bugbot no revisa solo los commits nuevos de un borrador, así que un push
 * durante la revisión deja el HEAD sin veredicto. Se pide solo si nadie lo
 * pidió ya para ese commit y si sigue siendo el HEAD: cada push programa su
 * propia comprobación, y la del último es la única que cuenta.
 */
export function bugbotRequestDecision(input: BugbotRequestInput): { request: boolean; reason: string } {
  if (input.runState !== "in_review") return { request: false, reason: `run en ${input.runState}` };
  if (input.pr.merged || input.pr.state !== "open") return { request: false, reason: "PR cerrado" };
  if (input.pr.headSha !== input.scheduledSha) return { request: false, reason: "hubo otro push" };
  if (input.requestedSha === input.pr.headSha) return { request: false, reason: "ya pedido para este commit" };
  return { request: true, reason: "HEAD sin revisión pedida" };
}
