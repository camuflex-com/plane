import { describe, expect, it } from "vitest";
import { decide, isTerminal, type Event, type Run, type RunState } from "@/machine";

const MAX = 3;

const run = (over: Partial<Run> = {}): Run => ({
  id: 1,
  planeIssueId: "11111111-1111-1111-1111-111111111111",
  planeProjectId: "22222222-2222-2222-2222-222222222222",
  cursorAgentId: "agent_1",
  prNumber: 7,
  state: "agent_running",
  attempts: 0,
  ...over,
});

const kinds = (d: ReturnType<typeof decide>) => d.actions.map((a) => a.type);

describe("arranque", () => {
  it("lanza el agente cuando no hay run previa", () => {
    const d = decide(null, { type: "issue_entered_in_progress", issueId: "i", projectId: "p" }, MAX);
    expect(d.nextState).toBe("agent_running");
    expect(kinds(d)).toEqual(["start_agent"]);
  });

  it("reanuda tras una corrección: desde 'fixing' vuelve a lanzar agente", () => {
    const d = decide(
      run({ state: "fixing" }),
      { type: "issue_entered_in_progress", issueId: "i", projectId: "p" },
      MAX
    );
    expect(d.nextState).toBe("agent_running");
  });
});

describe("prevención de bucles", () => {
  // El orquestador mueve issues, y eso vuelve por el webhook. Si esto fallara,
  // cada movimiento propio lanzaría otro agente indefinidamente.
  it.each<RunState>(["queued", "agent_running", "in_review"])(
    "ignora 'entró a In Progress' cuando ya hay una run en %s",
    (state) => {
      const d = decide(run({ state }), { type: "issue_entered_in_progress", issueId: "i", projectId: "p" }, MAX);
      expect(d.nextState).toBeNull();
      expect(d.actions).toHaveLength(0);
      expect(d.ignoredBecause).toBeTruthy();
    }
  );

  // Sin esta excepción, un fallo transitorio al crear el agente deja la run
  // en agent_running sin agente y el reintento choca contra la guarda: la
  // issue queda bloqueada para siempre.
  it("permite reanudar si el arranque del agente falló y no hay agente", () => {
    const d = decide(
      run({ state: "agent_running", cursorAgentId: null }),
      { type: "issue_entered_in_progress", issueId: "i", projectId: "p" },
      MAX
    );
    expect(d.nextState).toBe("agent_running");
    expect(kinds(d)).toEqual(["start_agent"]);
  });

  it.each<RunState>(["merged", "parked", "failed"])("una run en %s no reacciona a nada", (state) => {
    const events: Event[] = [
      { type: "issue_entered_in_progress", issueId: "i", projectId: "p" },
      { type: "pr_opened", prNumber: 9, headSha: "abc", agentId: "agent_1" },
      { type: "bugbot_verdict", prNumber: 9, conclusion: "success", findings: [] },
    ];
    for (const event of events) {
      const d = decide(run({ state }), event, MAX);
      expect(d.actions).toHaveLength(0);
      expect(d.nextState).toBeNull();
    }
  });
});

describe("PR abierto", () => {
  it("pasa a in_review y pide la revisión", () => {
    const d = decide(
      run({ state: "agent_running" }),
      { type: "pr_opened", prNumber: 9, headSha: "s", agentId: "a" },
      MAX
    );
    expect(d.nextState).toBe("in_review");
    expect(kinds(d)).toEqual(["move_issue", "request_bugbot"]);
  });

  it("ignora un PR que llega fuera de tiempo", () => {
    const d = decide(run({ state: "in_review" }), { type: "pr_opened", prNumber: 9, headSha: "s", agentId: "a" }, MAX);
    expect(d.actions).toHaveLength(0);
  });
});

describe("veredicto de Bugbot", () => {
  it("en verde: mergea y cierra la issue", () => {
    const d = decide(
      run({ state: "in_review" }),
      { type: "bugbot_verdict", prNumber: 7, conclusion: "success", findings: [] },
      MAX
    );
    expect(d.nextState).toBe("merged");
    expect(kinds(d)).toEqual(["merge_pr", "move_issue"]);
  });

  it("en verde también mergea si el agente todavía está corrigiendo", () => {
    const d = decide(
      run({ state: "fixing" }),
      { type: "bugbot_verdict", prNumber: 7, conclusion: "success", findings: [] },
      MAX
    );
    expect(d.nextState).toBe("merged");
    expect(kinds(d)).toEqual(["merge_pr", "move_issue"]);
  });

  it("con hallazgos: devuelve a In Progress y reenvía al agente", () => {
    const d = decide(
      run({ state: "in_review", attempts: 0 }),
      { type: "bugbot_verdict", prNumber: 7, conclusion: "neutral", findings: ["falta un null check"] },
      MAX
    );
    expect(d.nextState).toBe("fixing");
    expect(d.incrementAttempts).toBe(true);
    expect(kinds(d)).toEqual(["move_issue", "comment_issue", "send_followup"]);
  });

  it("sin agente registrado no intenta reenviar", () => {
    const d = decide(
      run({ state: "in_review", cursorAgentId: null }),
      { type: "bugbot_verdict", prNumber: 7, conclusion: "neutral", findings: ["x"] },
      MAX
    );
    expect(kinds(d)).not.toContain("send_followup");
  });

  // Sin este tope, un bug que el agente no sepa arreglar rebota para siempre.
  it("agotados los intentos, aparca en vez de rebotar", () => {
    const d = decide(
      run({ state: "in_review", attempts: MAX - 1 }),
      { type: "bugbot_verdict", prNumber: 7, conclusion: "neutral", findings: ["sigue mal"] },
      MAX
    );
    expect(d.nextState).toBe("parked");
    expect(kinds(d)).toEqual(["park", "comment_issue"]);
  });

  it("nunca mergea cuando hay hallazgos", () => {
    for (const conclusion of ["neutral", "failure", "cancelled", "timed_out"] as const) {
      const d = decide(
        run({ state: "in_review" }),
        { type: "bugbot_verdict", prNumber: 7, conclusion, findings: [] },
        MAX
      );
      expect(kinds(d)).not.toContain("merge_pr");
    }
  });

  it("un veredicto fuera de in_review/fixing no hace nada", () => {
    const d = decide(
      run({ state: "agent_running" }),
      { type: "bugbot_verdict", prNumber: 7, conclusion: "success", findings: [] },
      MAX
    );
    expect(d.actions).toHaveLength(0);
  });

  it("con hallazgos mientras corrige: vuelve a mandar el follow-up", () => {
    const d = decide(
      run({ state: "fixing", attempts: 1 }),
      { type: "bugbot_verdict", prNumber: 7, conclusion: "neutral", findings: ["sigue el null"] },
      MAX
    );
    expect(d.nextState).toBe("fixing");
    expect(kinds(d)).toEqual(["move_issue", "comment_issue", "send_followup"]);
  });
});

describe("PR actualizado tras una corrección", () => {
  it("desde fixing vuelve a in_review y pide Bugbot otra vez", () => {
    const d = decide(run({ state: "fixing" }), { type: "pr_synchronized", prNumber: 7, headSha: "s2" }, MAX);
    expect(d.nextState).toBe("in_review");
    expect(kinds(d)).toEqual(["move_issue", "request_bugbot"]);
  });

  it("un sync en in_review no dispara otro ciclo", () => {
    const d = decide(run({ state: "in_review" }), { type: "pr_synchronized", prNumber: 7, headSha: "s2" }, MAX);
    expect(d.nextState).toBeNull();
    expect(d.actions).toHaveLength(0);
    expect(d.ignoredBecause).toBeUndefined();
  });

  it("ignora un sync fuera de fixing/in_review", () => {
    const d = decide(run({ state: "agent_running" }), { type: "pr_synchronized", prNumber: 7, headSha: "s2" }, MAX);
    expect(d.actions).toHaveLength(0);
    expect(d.ignoredBecause).toBeTruthy();
  });
});

describe("agente atascado", () => {
  it("aparca la run si no hubo PR", () => {
    const d = decide(run({ state: "agent_running" }), { type: "agent_stale", minutes: 60 }, MAX);
    expect(d.nextState).toBe("parked");
  });

  it("no toca una run que ya está en revisión", () => {
    const d = decide(run({ state: "in_review" }), { type: "agent_stale", minutes: 60 }, MAX);
    expect(d.actions).toHaveLength(0);
  });
});

describe("recorrido completo", () => {
  it("un rebote y luego verde termina en merged", () => {
    let state: RunState = "agent_running";
    let attempts = 0;
    const step = (event: Parameters<typeof decide>[1]) => {
      const d = decide(run({ state, attempts }), event, MAX);
      if (d.nextState) state = d.nextState;
      if (d.incrementAttempts) attempts += 1;
      return d;
    };

    step({ type: "pr_opened", prNumber: 7, headSha: "s", agentId: "a" });
    expect(state).toBe("in_review");

    step({ type: "bugbot_verdict", prNumber: 7, conclusion: "neutral", findings: ["x"] });
    expect(state).toBe("fixing");
    expect(attempts).toBe(1);

    step({ type: "issue_entered_in_progress", issueId: "i", projectId: "p" });
    expect(state).toBe("agent_running");

    step({ type: "pr_opened", prNumber: 7, headSha: "s2", agentId: "a" });
    step({ type: "bugbot_verdict", prNumber: 7, conclusion: "success", findings: [] });
    expect(state).toBe("merged");
    expect(isTerminal(state)).toBe(true);
  });

  it("corrección en el mismo PR: follow-up, push, Bugbot en verde, merge", () => {
    let state: RunState = "agent_running";
    let attempts = 0;
    const step = (event: Parameters<typeof decide>[1]) => {
      const d = decide(run({ state, attempts }), event, MAX);
      if (d.nextState) state = d.nextState;
      if (d.incrementAttempts) attempts += 1;
      return d;
    };

    step({ type: "pr_opened", prNumber: 7, headSha: "s", agentId: "a" });
    step({ type: "bugbot_verdict", prNumber: 7, conclusion: "neutral", findings: ["x"] });
    expect(state).toBe("fixing");

    const afterPush = step({ type: "pr_synchronized", prNumber: 7, headSha: "s2" });
    expect(state).toBe("in_review");
    expect(kinds(afterPush)).toEqual(["move_issue", "request_bugbot"]);

    step({ type: "bugbot_verdict", prNumber: 7, conclusion: "success", findings: [] });
    expect(state).toBe("merged");
  });
});
