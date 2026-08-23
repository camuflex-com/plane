import type { Env } from "@/env";
import { requestJson } from "./http";

export type CreatedAgent = { id: string; status?: string };
export type AgentDetail = {
  id: string;
  status?: string;
  latestRunId?: string;
  target?: { prUrl?: string; branchName?: string };
};

/**
 * Cliente de los Cloud Agents de Cursor.
 *
 * La v1 no emite webhooks, así que este cliente es solo de salida: se le
 * encarga trabajo y se olvida. Quien avisa de que el trabajo terminó es
 * GitHub, cuando el agente abre el PR.
 */
export class CursorClient {
  constructor(private readonly env: Env) {}

  private get headers() {
    return {
      Authorization: `Bearer ${this.env.CURSOR_API_KEY}`,
      "Content-Type": "application/json",
    };
  }

  /** Lanza un agente sobre un repo. `autoCreatePR` es lo que cierra el ciclo. */
  async createAgent(input: {
    prompt: string;
    repoUrl: string;
    baseBranch: string;
    name?: string;
  }): Promise<CreatedAgent> {
    // Los nombres importan y no son los obvios: la API espera `url` y
    // `startingRef` dentro de cada repo, no `repoUrl`/`baseBranch`. Con los
    // nombres equivocados responde `validation_error: "Required"` sin decir
    // qué campo falta.
    const body: Record<string, unknown> = {
      prompt: { text: input.prompt },
      repos: [{ url: input.repoUrl, startingRef: input.baseBranch }],
      autoCreatePR: true,
    };
    if (input.name) body.name = input.name;
    // `model` también es un objeto, no un string.
    if (this.env.CURSOR_MODEL) body.model = { id: this.env.CURSOR_MODEL };

    return requestJson<CreatedAgent>(`${this.env.CURSOR_BASE_URL}/v1/agents`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
  }

  /**
   * Manda una corrección al mismo agente en vez de crear uno nuevo: el agente
   * conserva el contexto de lo que ya escribió y empuja sobre la misma rama,
   * así que el PR se actualiza en lugar de abrirse otro.
   */
  async sendFollowUp(agentId: string, prompt: string): Promise<void> {
    await requestJson(`${this.env.CURSOR_BASE_URL}/v1/agents/${agentId}/runs`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ prompt: { text: prompt } }),
    });
  }

  async getAgent(agentId: string): Promise<AgentDetail> {
    return requestJson<AgentDetail>(`${this.env.CURSOR_BASE_URL}/v1/agents/${agentId}`, {
      headers: this.headers,
    });
  }
}
