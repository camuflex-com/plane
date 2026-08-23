import type { Env } from "@/env";
import { requestJson } from "./http";

/**
 * La respuesta de creación viene ENVUELTA: `{agent: {...}, run: {...}}`, no
 * el agente en el nivel superior. Leerlo mal no da error —solo un `undefined`
 * silencioso— y el orquestador pierde el id del agente que acaba de lanzar,
 * quedándose sin poder mandarle correcciones ni consultar su estado.
 */
type CreateAgentResponse = {
  agent?: { id?: string; status?: string; url?: string };
  run?: { id?: string };
  // Por si la API alguna vez devuelve el agente sin envolver.
  id?: string;
};

export type CreatedAgent = { id: string; runId: string | null; url: string | null };
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
      // Que el PR lo abra la GitHub App de Cursor y no la cuenta humana
      // conectada a la integración. Sin esto los PRs quedan a nombre de esa
      // persona, como si los hubiera escrito ella.
      //
      // El campo aparece en la respuesta del agente y la API lo acepta al
      // crear, pero no está en la documentación pública.
      openAsCursorGithubApp: true,
    };
    if (input.name) body.name = input.name;
    // `model` también es un objeto, no un string.
    if (this.env.CURSOR_MODEL) body.model = { id: this.env.CURSOR_MODEL };

    const response = await requestJson<CreateAgentResponse>(`${this.env.CURSOR_BASE_URL}/v1/agents`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    const id = response.agent?.id ?? response.id;
    if (!id) {
      // Fallar ruidosamente: el agente ya está corriendo y cuesta dinero, así
      // que perder su id en silencio es peor que un error visible.
      throw new Error(`Cursor creó el agente pero no se pudo leer su id: ${JSON.stringify(response).slice(0, 300)}`);
    }

    return { id, runId: response.run?.id ?? null, url: response.agent?.url ?? null };
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
