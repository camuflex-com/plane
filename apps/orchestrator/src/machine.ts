/**
 * Máquina de estados del ciclo Plane -> Cursor -> GitHub -> Plane.
 *
 * Deliberadamente pura: recibe el estado actual y un evento, y devuelve la
 * decisión. No habla con la red ni con la base. Todo el riesgo real de este
 * servicio —bucles infinitos, merges indebidos, rebotes sin fin— vive aquí,
 * y aquí se puede probar exhaustivamente sin levantar nada.
 */

export type RunState = "queued" | "agent_running" | "in_review" | "fixing" | "merged" | "parked" | "failed";

export const TERMINAL_STATES: readonly RunState[] = ["merged", "parked", "failed"];

export const isTerminal = (state: RunState): boolean => TERMINAL_STATES.includes(state);

export type Run = {
  id: number;
  planeIssueId: string;
  planeProjectId: string;
  cursorAgentId: string | null;
  prNumber: number | null;
  state: RunState;
  attempts: number;
};

export type Event =
  /** Una issue entró a In Progress en Plane (por acción humana). */
  | { type: "issue_entered_in_progress"; issueId: string; projectId: string }
  /** El agente abrió su PR. */
  | { type: "pr_opened"; prNumber: number; headSha: string; agentId: string | null }
  /** El agente empujó commits nuevos al mismo PR (tras una corrección). */
  | { type: "pr_synchronized"; prNumber: number; headSha: string }
  /** Bugbot publicó su veredicto sobre el PR. */
  | { type: "bugbot_verdict"; prNumber: number; conclusion: BugbotConclusion; findings: string[] }
  /** El barrido periódico encontró una run atascada. */
  | { type: "agent_stale"; minutes: number };

/**
 * Bugbot publica un check de CI. `success` = limpio; `neutral` = encontró
 * cosas; `failure` = encontró cosas con fail-on-unresolved configurado.
 */
export type BugbotConclusion = "success" | "neutral" | "failure" | "cancelled" | "timed_out";

export type Action =
  | { type: "start_agent"; issueId: string; projectId: string }
  | { type: "move_issue"; issueId: string; to: "in_progress" | "in_review" | "done" }
  | { type: "comment_issue"; issueId: string; body: string }
  | { type: "request_bugbot"; prNumber: number }
  | { type: "send_followup"; agentId: string; findings: string[] }
  | { type: "merge_pr"; prNumber: number }
  | { type: "park"; reason: string };

export type Decision = {
  /** Estado al que pasa la run, o null si no cambia. */
  nextState: RunState | null;
  actions: Action[];
  /** Suma uno al contador de rebotes. */
  incrementAttempts?: boolean;
  /** Por qué se ignoró el evento, cuando no produce nada. */
  ignoredBecause?: string;
};

const NOTHING = (reason: string): Decision => ({ nextState: null, actions: [], ignoredBecause: reason });

/**
 * Decide qué hacer ante un evento.
 *
 * `run` es null cuando todavía no existe una run para esa issue.
 */
export function decide(run: Run | null, event: Event, maxAttempts: number): Decision {
  // Una run terminada no reacciona a nada. Es la última barrera contra que un
  // evento tardío de GitHub reabra un ciclo ya cerrado.
  if (run && isTerminal(run.state)) {
    return NOTHING(`run en estado terminal ${run.state}`);
  }

  switch (event.type) {
    case "issue_entered_in_progress": {
      // Ya hay trabajo vivo para esta issue. Ignorar es lo que impide que el
      // propio movimiento del orquestador (In Review -> In Progress al
      // encontrar bugs) lance un segundo agente.
      //
      // La excepción es una run en `agent_running` que todavía no tiene
      // agente: eso no es trabajo vivo sino un intento de arranque que falló,
      // y sin permitir reanudarlo la run se quedaría varada para siempre.
      if (run && run.state !== "fixing") {
        const failedToStart = run.state === "agent_running" && run.cursorAgentId === null;
        if (!failedToStart) {
          return NOTHING(`ya existe una run activa en ${run.state}`);
        }
      }
      return {
        nextState: "agent_running",
        actions: [{ type: "start_agent", issueId: event.issueId, projectId: event.projectId }],
      };
    }

    case "pr_opened": {
      if (!run) return NOTHING("PR sin run asociada");
      if (run.state !== "agent_running") {
        return NOTHING(`PR recibido en estado ${run.state}`);
      }
      return {
        nextState: "in_review",
        actions: [
          { type: "move_issue", issueId: run.planeIssueId, to: "in_review" },
          { type: "request_bugbot", prNumber: event.prNumber },
        ],
      };
    }

    case "pr_synchronized": {
      if (!run) return NOTHING("sync sin run asociada");
      // Un push mientras ya estamos en revisión no cambia el ciclo: Bugbot
      // re-corre o ya está pedido. Solo hay que rearmar cuando veníamos de
      // corregir, para volver a aceptar el veredicto.
      if (run.state === "in_review") {
        return { nextState: null, actions: [] };
      }
      if (run.state !== "fixing") {
        return NOTHING(`sync recibido en estado ${run.state}`);
      }
      return {
        nextState: "in_review",
        actions: [
          { type: "move_issue", issueId: run.planeIssueId, to: "in_review" },
          { type: "request_bugbot", prNumber: event.prNumber },
        ],
      };
    }

    case "bugbot_verdict": {
      if (!run) return NOTHING("veredicto sin run asociada");
      // `fixing` también: el agente ya empujó la corrección y Bugbot volvió a
      // opinar antes de que procesáramos el synchronize, o un success llegó
      // tarde después de un veredicto incompleto. Descartarlo deja la run
      // colgada y el PR sin mergear.
      if (run.state !== "in_review" && run.state !== "fixing") {
        return NOTHING(`veredicto recibido en estado ${run.state}`);
      }

      if (event.conclusion === "success") {
        return {
          nextState: "merged",
          actions: [
            { type: "merge_pr", prNumber: event.prNumber },
            { type: "move_issue", issueId: run.planeIssueId, to: "done" },
          ],
        };
      }

      if (event.conclusion === "cancelled" || event.conclusion === "timed_out") {
        return {
          nextState: "parked",
          actions: [
            {
              type: "park",
              reason: `Bugbot terminó en ${event.conclusion}; hace falta revisión manual.`,
            },
            {
              type: "comment_issue",
              issueId: run.planeIssueId,
              body: `La revisión automática terminó en \`${event.conclusion}\`. El PR #${event.prNumber} queda a la espera de revisión manual.`,
            },
          ],
        };
      }

      // Encontró problemas. Si ya se agotaron los intentos se aparca en vez de
      // seguir rebotando: un bug que el agente no sabe arreglar daría vueltas
      // indefinidamente quemando dinero.
      if (run.attempts + 1 >= maxAttempts) {
        return {
          nextState: "parked",
          incrementAttempts: true,
          actions: [
            { type: "park", reason: `agotados los ${maxAttempts} intentos` },
            {
              type: "comment_issue",
              issueId: run.planeIssueId,
              body: buildGiveUpComment(event.prNumber, maxAttempts, event.findings),
            },
          ],
        };
      }

      const actions: Action[] = [
        { type: "move_issue", issueId: run.planeIssueId, to: "in_progress" },
        {
          type: "comment_issue",
          issueId: run.planeIssueId,
          body: buildFindingsComment(event.prNumber, event.findings),
        },
      ];
      if (run.cursorAgentId) {
        actions.push({ type: "send_followup", agentId: run.cursorAgentId, findings: event.findings });
      }

      return { nextState: "fixing", incrementAttempts: true, actions };
    }

    case "agent_stale": {
      if (!run) return NOTHING("barrido sin run");
      if (run.state !== "agent_running") return NOTHING(`no está esperando agente (${run.state})`);
      return {
        nextState: "parked",
        actions: [
          { type: "park", reason: `sin PR tras ${event.minutes} minutos` },
          {
            type: "comment_issue",
            issueId: run.planeIssueId,
            body: `El agente no produjo un PR tras ${event.minutes} minutos. La automatización se detiene aquí.`,
          },
        ],
      };
    }
  }
}

function buildFindingsComment(prNumber: number, findings: string[]): string {
  const list = findings.length ? findings.map((f) => `- ${f}`).join("\n") : "- (sin detalle)";
  return `La revisión automática encontró problemas en el PR #${prNumber}:\n\n${list}\n\nSe devuelve a In Progress para corregir.`;
}

function buildGiveUpComment(prNumber: number, maxAttempts: number, findings: string[]): string {
  const list = findings.length ? findings.map((f) => `- ${f}`).join("\n") : "- (sin detalle)";
  return `La automatización se detiene tras ${maxAttempts} intentos. El PR #${prNumber} sigue con problemas:\n\n${list}\n\nHace falta intervención manual.`;
}
