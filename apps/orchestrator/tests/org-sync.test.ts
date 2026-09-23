import { describe, expect, it } from "vitest";
import type { OrgRepo } from "@/clients/github";
import type { Project } from "@/clients/plane";
import { importableRepos, matchProject, projectIdentifier, projectName } from "@/org-sync";

const ORG = "camuflex-com";

describe("nombre del proyecto", () => {
  it.each([
    ["camuflex-design-system", "Camuflex Design System"],
    ["panel-seed-accounts", "Panel Seed Accounts"],
    ["plane", "Plane"],
    ["bot_engine", "Bot Engine"],
  ])("%s -> %s", (repo, expected) => {
    expect(projectName(repo)).toBe(expected);
  });
});

describe("identificador del proyecto", () => {
  const none = new Set<string>();

  it.each([
    ["camuflex-design-system", "DESIGNSYSTEM"],
    ["camuflex-web", "WEB"],
    ["camuflex-bot-engine", "BOTENGINE"],
    ["plane", "PLANE"],
    ["panel-seed-accounts", "PANELSEEDACC"],
  ])("%s -> %s", (repo, expected) => {
    expect(projectIdentifier(repo, ORG, none)).toBe(expected);
  });

  it("nunca pasa de 12 caracteres", () => {
    expect(projectIdentifier("un-nombre-de-repo-larguisimo", ORG, none).length).toBeLessThanOrEqual(12);
  });

  it("un repo llamado solo como la organización conserva el nombre", () => {
    expect(projectIdentifier("camuflex", ORG, none)).toBe("CAMUFLEX");
  });

  it("si choca, añade un número sin pasarse del límite", () => {
    expect(projectIdentifier("camuflex-web", ORG, new Set(["WEB"]))).toBe("WEB2");
    expect(projectIdentifier("camuflex-design-system", ORG, new Set(["DESIGNSYSTEM"]))).toBe("DESIGNSYSTE2");
    expect(projectIdentifier("camuflex-web", ORG, new Set(["WEB", "WEB2"]))).toBe("WEB3");
  });

  it("sin caracteres que Plane rechace", () => {
    expect(projectIdentifier("repo.con-puntos_y+más", ORG, none)).toMatch(/^[A-Z0-9]+$/);
  });
});

describe("repos importables", () => {
  const repo = (name: string, over: Partial<OrgRepo> = {}): OrgRepo => ({
    name,
    owner: { login: ORG },
    default_branch: "main",
    archived: false,
    size: 10,
    ...over,
  });

  it("descarta archivados y deshabilitados", () => {
    const repos = [repo("vivo"), repo("viejo", { archived: true }), repo("bloqueado", { disabled: true })];
    expect(importableRepos(repos).map((r) => r.name)).toEqual(["vivo"]);
  });

  it("conserva los vacíos: se les crea el commit inicial", () => {
    expect(importableRepos([repo("nuevo", { size: 0 })])).toHaveLength(1);
  });
});

const project = (over: Partial<Project>): Project => ({ id: "p", name: "X", identifier: "X", ...over });

describe("proyecto existente", () => {
  it("adopta el que ya lleva el external_id del repo", () => {
    const projects = [
      project({ id: "otro", name: "Camuflex Web" }),
      project({
        id: "marcado",
        name: "Web (renombrado)",
        external_source: "github",
        external_id: "camuflex-com/camuflex-web",
      }),
    ];
    expect(matchProject(projects, ORG, "camuflex-web")?.id).toBe("marcado");
  });

  it("si no, adopta el que se llama igual", () => {
    expect(matchProject([project({ id: "a", name: "panel seed accounts" })], ORG, "panel-seed-accounts")?.id).toBe("a");
  });

  it("sin coincidencia, no adopta nada", () => {
    expect(matchProject([project({ name: "Otra cosa" })], ORG, "camuflex-web")).toBeNull();
  });
});
