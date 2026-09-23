import { describe, expect, it } from "vitest";
import { entersTriggerState, type PlanePayload } from "@/plane-trigger";

const IN_PROGRESS = { id: "st-progress", name: "In Progress" };

const payload = (over: Partial<PlanePayload> = {}, activity: PlanePayload["activity"] = {}): PlanePayload => ({
  event: "issue",
  action: "updated",
  data: { id: "issue-1", project: "proj-1", state: IN_PROGRESS },
  ...over,
  activity: { field: "state_id", new_value: IN_PROGRESS.id, ...activity },
});

describe("entrada a In Progress", () => {
  it("un cambio de estado hacia In Progress dispara", () => {
    expect(entersTriggerState(payload())).toBe(true);
  });

  it("también con el campo llamado `state`", () => {
    expect(entersTriggerState(payload({}, { field: "state" }))).toBe(true);
  });

  it("una issue creada directamente en In Progress dispara", () => {
    expect(entersTriggerState(payload({ action: "created" }, { field: null, new_value: null }))).toBe(true);
  });

  // El caso que rompería el webhook de workspace: cualquier edición de una
  // issue que ya está en In Progress llega con ese estado en `data`.
  it("editar el título de una issue en In Progress NO dispara", () => {
    expect(entersTriggerState(payload({}, { field: "name", new_value: "otro título" }))).toBe(false);
  });

  it("cambiar asignados NO dispara", () => {
    expect(entersTriggerState(payload({}, { field: "assignee_ids", new_value: ["u1"] }))).toBe(false);
  });

  it("pasar a otro estado NO dispara", () => {
    const done = { id: "st-done", name: "Done" };
    expect(entersTriggerState(payload({ data: { id: "i", project: "p", state: done } }, { new_value: done.id }))).toBe(
      false
    );
  });

  it("un evento viejo (la issue ya se movió) NO dispara", () => {
    expect(entersTriggerState(payload({}, { new_value: "st-todo" }))).toBe(false);
  });

  it("borrar la issue NO dispara", () => {
    expect(entersTriggerState(payload({ action: "deleted" }))).toBe(false);
  });

  it("eventos que no son de issue NO disparan", () => {
    expect(entersTriggerState(payload({ event: "project" }))).toBe(false);
  });

  it("sin estado expandido NO dispara", () => {
    expect(entersTriggerState(payload({ data: { id: "i", project: "p", state: "st-progress" } }))).toBe(false);
  });
});
