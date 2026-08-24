import { describe, expect, it, vi } from "vitest";
import { parseIssuePayload, resolveIngestProject, createIngestedIssue, dedupeKey } from "@/ingest-issue";
import { issueIsClosed } from "@/clients/plane";
import type { PlaneClient } from "@/clients/plane";
import type { Db } from "@/db";

const config = {
  planeProjectId: "proj",
  planeWorkspaceSlug: "camuflex",
  githubOwner: "camuflex-com",
  githubRepo: "camuflex-backend",
  baseBranch: "main",
  enabled: true,
  maxAttempts: 3,
};

const payload = {
  name: "Alerta",
  description: "algo se rompió",
  owner: "camuflex-com",
  repo: "camuflex-backend",
  resource: "lambda:app-health",
  priority: "high",
  externalSource: "camuflex-backend",
};

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
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload.name).toBe("Fallo en /health");
    expect(parsed.payload.owner).toBe("camuflex-com");
    expect(parsed.payload.repo).toBe("camuflex-backend");
    expect(parsed.payload.externalSource).toBe("camuflex-backend");
  });

  it("acepta projectId, resource y description", () => {
    const parsed = parseIssuePayload(
      JSON.stringify({
        name: "Alerta",
        description: "detalle",
        projectId: "11111111-1111-1111-1111-111111111111",
        resource: "POST /health",
        priority: "high",
      })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.description).toBe("detalle");
      expect(parsed.payload.resource).toBe("POST /health");
      expect(parsed.payload.priority).toBe("high");
    }
  });

  it("acepta model y modelParams", () => {
    const parsed = parseIssuePayload(
      JSON.stringify({ name: "Alerta", model: "composer-2", modelParams: "fast=true" })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.model).toBe("composer-2");
      expect(parsed.payload.modelParams).toBe("fast=true");
    }
  });

  it("rechaza un model inválido", () => {
    const parsed = parseIssuePayload(JSON.stringify({ name: "x", model: "no spaces" }));
    expect(parsed.ok).toBe(false);
  });

  it("rechaza una priority desconocida", () => {
    const parsed = parseIssuePayload(JSON.stringify({ name: "x", priority: "critical" }));
    expect(parsed.ok).toBe(false);
  });
});

describe("dedupeKey", () => {
  it("usa resource por encima del título", () => {
    expect(dedupeKey({ name: "Error A", resource: "lambda:app-health" })).toBe("lambda:app-health");
    expect(dedupeKey({ name: "Error B", resource: "lambda:app-health" })).toBe("lambda:app-health");
  });

  it("normaliza espacios y mayúsculas", () => {
    expect(dedupeKey({ name: "Fallo en /Health" })).toBe("fallo-en-/health");
  });

  it("prefiere externalId si viene", () => {
    expect(dedupeKey({ name: "x", resource: "r", externalId: "id-1" })).toBe("id-1");
  });
});

describe("issueIsClosed", () => {
  it("trata Done/cancelled como cerrada", () => {
    expect(
      issueIsClosed({ id: "1", name: "x", description_stripped: null, state: { name: "Done", group: "completed" } })
    ).toBe(true);
    expect(
      issueIsClosed({
        id: "1",
        name: "x",
        description_stripped: null,
        state: { name: "Cancelled", group: "cancelled" },
      })
    ).toBe(true);
  });

  it("deja abierta In Progress e In Review", () => {
    expect(
      issueIsClosed({
        id: "1",
        name: "x",
        description_stripped: null,
        state: { name: "In Progress", group: "started" },
      })
    ).toBe(false);
    expect(
      issueIsClosed({ id: "1", name: "x", description_stripped: null, state: { name: "In Review", group: "started" } })
    ).toBe(false);
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
    const resolved = await resolveIngestProject(db, parsed.payload);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("github_owner"), ["camuflex-com", "camuflex-backend"]);
    expect(resolved?.planeProjectId).toBe("proj");
  });
});

describe("createIngestedIssue", () => {
  it("crea en In Progress con la clave del recurso", async () => {
    const createIssue = vi.fn().mockResolvedValue({ id: "issue-1", name: "Alerta", sequence_id: 12 });
    const findIssueByExternal = vi.fn().mockResolvedValue(null);
    const plane = { createIssue, findIssueByExternal } as unknown as PlaneClient;
    const result = await createIngestedIssue(plane, config, payload);
    expect(createIssue).toHaveBeenCalledWith("camuflex", "proj", {
      name: "Alerta",
      description: "algo se rompió",
      priority: "high",
      stateName: "In Progress",
      externalId: "lambda:app-health",
      externalSource: "camuflex-backend",
    });
    expect(result).toEqual({
      id: "issue-1",
      name: "Alerta",
      sequenceId: 12,
      projectId: "proj",
      created: true,
      reopened: false,
    });
  });

  it("deja el modelo elegido en la descripción", async () => {
    const createIssue = vi.fn().mockResolvedValue({ id: "issue-1", name: "Alerta", sequence_id: 12 });
    const findIssueByExternal = vi.fn().mockResolvedValue(null);
    const plane = { createIssue, findIssueByExternal } as unknown as PlaneClient;
    await createIngestedIssue(plane, config, {
      ...payload,
      model: "composer-2",
      modelParams: "fast=true",
    });
    expect(createIssue.mock.calls[0][2].description).toContain("[camuflex-model composer-2 fast=true]");
  });

  it("reutiliza la issue abierta del mismo recurso y no crea otra", async () => {
    const createIssue = vi.fn();
    const moveIssue = vi.fn();
    const findIssueByExternal = vi.fn().mockResolvedValue({
      id: "issue-1",
      name: "Alerta",
      sequence_id: 12,
      state: { name: "In Progress", group: "started" },
    });
    const plane = { createIssue, moveIssue, findIssueByExternal } as unknown as PlaneClient;
    const result = await createIngestedIssue(plane, config, payload);
    expect(createIssue).not.toHaveBeenCalled();
    expect(moveIssue).not.toHaveBeenCalled();
    expect(result.created).toBe(false);
    expect(result.reopened).toBe(false);
    expect(result.id).toBe("issue-1");
  });

  it("reabre una issue Done del mismo recurso a In Progress", async () => {
    const createIssue = vi.fn();
    const moveIssue = vi.fn().mockResolvedValue(undefined);
    const findIssueByExternal = vi.fn().mockResolvedValue({
      id: "issue-1",
      name: "Alerta",
      sequence_id: 12,
      state: { name: "Done", group: "completed" },
    });
    const plane = { createIssue, moveIssue, findIssueByExternal } as unknown as PlaneClient;
    const result = await createIngestedIssue(plane, config, payload);
    expect(createIssue).not.toHaveBeenCalled();
    expect(moveIssue).toHaveBeenCalledWith("camuflex", "proj", "issue-1", "in_progress");
    expect(result.created).toBe(false);
    expect(result.reopened).toBe(true);
  });
});
