import { describe, expect, it, vi } from "vitest";
import { parseIssuePayload, resolveIngestProject, createIngestedIssue } from "@/ingest-issue";
import type { PlaneClient } from "@/clients/plane";
import type { Db } from "@/db";

describe("parseIssuePayload", () => {
  it("exige un name o title", () => {
    const parsed = parseIssuePayload(JSON.stringify({ description: "hola" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toBe("falta name");
  });

  it("rechaza JSON inválido", () => {
    const parsed = parseIssuePayload("{no");
    expect(parsed.ok).toBe(false);
  });

  it("toma title como alias de name y defaulta al repo del backend", () => {
    const parsed = parseIssuePayload(JSON.stringify({ title: "Fallo en /health" }));
    expect(parsed).toEqual({
      ok: true,
      payload: {
        name: "Fallo en /health",
        description: "",
        projectId: undefined,
        owner: "camuflex-com",
        repo: "camuflex-backend",
        priority: undefined,
        state: undefined,
        externalId: undefined,
        externalSource: undefined,
      },
    });
  });

  it("acepta projectId y description", () => {
    const parsed = parseIssuePayload(
      JSON.stringify({
        name: "Alerta",
        description: "detalle",
        projectId: "11111111-1111-1111-1111-111111111111",
        priority: "high",
      })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.description).toBe("detalle");
      expect(parsed.payload.projectId).toBe("11111111-1111-1111-1111-111111111111");
      expect(parsed.payload.priority).toBe("high");
    }
  });

  it("rechaza una priority desconocida", () => {
    const parsed = parseIssuePayload(JSON.stringify({ name: "x", priority: "critical" }));
    expect(parsed.ok).toBe(false);
  });
});

describe("resolveIngestProject", () => {
  it("busca por repo cuando no hay projectId", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          plane_project_id: "proj",
          plane_workspace_slug: "camuflex",
          github_owner: "camuflex-com",
          github_repo: "camuflex-backend",
          base_branch: "main",
          enabled: true,
          max_attempts: 3,
        },
      ],
    });
    const db = { query } as unknown as Db;
    const parsed = parseIssuePayload(JSON.stringify({ name: "x" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const config = await resolveIngestProject(db, parsed.payload);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("github_owner"), ["camuflex-com", "camuflex-backend"]);
    expect(config?.planeProjectId).toBe("proj");
  });
});

describe("createIngestedIssue", () => {
  it("crea la issue a través del cliente de Plane", async () => {
    const createIssue = vi.fn().mockResolvedValue({ id: "issue-1", name: "Alerta", sequence_id: 12 });
    const plane = { createIssue } as unknown as PlaneClient;
    const result = await createIngestedIssue(
      plane,
      {
        planeProjectId: "proj",
        planeWorkspaceSlug: "camuflex",
        githubOwner: "camuflex-com",
        githubRepo: "camuflex-backend",
        baseBranch: "main",
        enabled: true,
        maxAttempts: 3,
      },
      {
        name: "Alerta",
        description: "algo se rompió",
        owner: "camuflex-com",
        repo: "camuflex-backend",
        priority: "high",
      }
    );
    expect(createIssue).toHaveBeenCalledWith("camuflex", "proj", {
      name: "Alerta",
      description: "algo se rompió",
      priority: "high",
      stateName: undefined,
      externalId: undefined,
      externalSource: undefined,
    });
    expect(result).toEqual({ id: "issue-1", name: "Alerta", sequenceId: 12, projectId: "proj" });
  });
});
