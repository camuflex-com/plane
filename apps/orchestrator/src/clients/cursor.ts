import type { Env } from "@/env";
import type { CursorModel, ModelSelection } from "@/model";
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
/**
 * Convierte `effort=high,fast=true` en `[{id:"effort",value:"high"}, ...]`,
 * que es la forma que espera la API.
 */
export function parseModelParams(raw: string | undefined): { id: string; value: string }[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf("=");
      if (index === -1) return null;
      const id = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      return id && value ? { id, value } : null;
    })
    .filter((p): p is { id: string; value: string } => p !== null);
}

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
    model?: ModelSelection;
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
    // `model` es un objeto; sus parámetros van como lista de {id, value}.
    // Si la issue no eligió, cae al default del env (grok-4.6 high+fast).
    const modelId = input.model?.id || this.env.CURSOR_MODEL;
    const params = parseModelParams(input.model?.params || this.env.CURSOR_MODEL_PARAMS);
    body.model = params.length > 0 ? { id: modelId, params } : { id: modelId };

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

  /** Estado y texto final de un run: es el "razonamiento" que se muestra. */
  async getRun(agentId: string, runId: string): Promise<{ status?: string; result?: string; durationMs?: number }> {
    return requestJson(`${this.env.CURSOR_BASE_URL}/v1/agents/${agentId}/runs/${runId}`, {
      headers: this.headers,
      retries: 1,
    });
  }

  async getAgent(agentId: string): Promise<AgentDetail> {
    return requestJson<AgentDetail>(`${this.env.CURSOR_BASE_URL}/v1/agents/${agentId}`, {
      headers: this.headers,
    });
  }

  /** Modelos y variantes que acepta POST /v1/agents. */
  async listModels(): Promise<CursorModel[]> {
    const response = await requestJson<{ items?: CursorModel[] }>(`${this.env.CURSOR_BASE_URL}/v1/models`, {
      headers: this.headers,
      retries: 1,
    });
    return Array.isArray(response?.items) ? response.items : [];
  }
}
