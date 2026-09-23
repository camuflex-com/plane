/**
 * ¿Este evento de Plane es la entrada de una issue a In Progress?
 *
 * Hay un único webhook para todo el workspace y sin disparadores por estado:
 * así un proyecto nuevo queda cubierto sin tocar Plane. El precio es que
 * llegan todos los cambios de todas las issues —títulos, asignados,
 * descripciones— y el filtro vive aquí. Mirar solo el estado actual no basta:
 * editar el título de una issue que YA estaba en In Progress lanzaría otro
 * agente en cuanto su run anterior hubiera terminado.
 */

/** Estado que arranca el trabajo. */
export const TRIGGER_STATE = "in progress";

export type PlanePayload = {
  event?: string;
  action?: string;
  data?: { id?: string; project?: string; state?: { id?: string; name?: string } | string };
  activity?: { field?: string | null; new_value?: unknown; actor?: { id?: string } };
};

const CREATED = new Set(["created", "create"]);
const UPDATED = new Set(["updated", "update"]);
const STATE_FIELDS = new Set(["state", "state_id"]);

export function entersTriggerState(payload: PlanePayload): boolean {
  if (payload.event !== "issue") return false;

  const state = typeof payload.data?.state === "object" ? payload.data.state : undefined;
  if (state?.name?.trim().toLowerCase() !== TRIGGER_STATE) return false;

  const action = payload.action ?? "";
  // Una issue creada directamente en In Progress también cuenta.
  if (CREATED.has(action)) return true;
  if (!UPDATED.has(action)) return false;

  const field = payload.activity?.field ?? "";
  if (!STATE_FIELDS.has(field)) return false;

  // `data` se lee al enviar, no al cambiar. Si la issue ya pasó a otro estado,
  // el `new_value` no coincide y el evento está viejo.
  const entered = payload.activity?.new_value;
  return entered === undefined || entered === null || !state.id || String(entered) === state.id;
}
