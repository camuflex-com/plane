/**
 * Valida la selección de modelo contra el catálogo de Cursor antes de lanzar
 * el agente.
 *
 * Cada modelo tiene sus propios parámetros y no se parecen entre sí: Grok 4.6
 * usa `effort`, Grok 4.7 `reasoning_effort` + `context`, GPT-5.6 `reasoning` +
 * `context`, los Claude `effort` + `context` + `thinking`. Mandarle a un modelo
 * los parámetros de otro lo rompe o lo degrada en silencio. Y un marcador
 * guardado en una issue puede quedar viejo cuando Cursor retira un modelo o
 * cambia sus valores.
 *
 * Regla: lo que sale de aquí es siempre una variante que existe en el catálogo
 * para ese modelo. Lo que no encaja se completa con la variante por defecto
 * del propio modelo, nunca con los parámetros de otro.
 */

import type { CursorModel, CursorModelVariant, ModelSelection } from "@/model";

export type ResolvedModel = ModelSelection & {
  /** Qué hubo que corregir, para dejarlo en el log. Vacío si pasó tal cual. */
  adjustments: string[];
};

type Params = Map<string, string>;

export function parseParamString(raw: string): Params {
  const params: Params = new Map();
  for (const pair of raw.split(",")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    const id = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (id && value) params.set(id, value);
  }
  return params;
}

const variantParams = (variant: CursorModelVariant): Params =>
  new Map(
    (variant.params ?? [])
      .filter((p): p is { id: string; value: string } => Boolean(p.id && p.value))
      .map((p) => [p.id, p.value])
  );

/** Mismo orden que el catálogo: así el marcador se lee igual que en la UI. */
const formatParams = (variant: CursorModelVariant): string =>
  (variant.params ?? [])
    .filter((p) => p.id && p.value)
    .map((p) => `${p.id}=${p.value}`)
    .join(",");

const sameParams = (a: Params, b: Params): boolean =>
  a.size === b.size && [...a].every(([id, value]) => b.get(id) === value);

export function findModel(catalog: CursorModel[], id: string): CursorModel | undefined {
  const wanted = id.toLowerCase();
  return (
    catalog.find((m) => m.id?.toLowerCase() === wanted) ??
    catalog.find((m) => m.aliases?.some((alias) => alias.toLowerCase() === wanted))
  );
}

/** Ajusta una selección a una variante real de ese modelo. */
export function fitToModel(model: CursorModel, requested: Params): ResolvedModel {
  const id = model.id as string;
  const variants = model.variants?.length ? model.variants : [{ params: [] }];
  const fallback = variants.find((v) => v.isDefault) ?? variants[0];

  const exact = variants.find((v) => sameParams(variantParams(v), requested));
  if (exact) return { id, params: formatParams(exact), adjustments: [] };

  // Se conservan los valores pedidos que el modelo entiende y se rellenan los
  // que faltan con los de su variante por defecto.
  const defaults = variantParams(fallback);
  const known = new Set(variants.flatMap((v) => [...variantParams(v).keys()]));
  const adjustments: string[] = [];
  const merged: Params = new Map(defaults);
  for (const [key, value] of requested) {
    if (!known.has(key)) {
      adjustments.push(`${key}=${value} no existe en ${id}; se descarta`);
      continue;
    }
    merged.set(key, value);
  }
  const candidate = variants.find((v) => sameParams(variantParams(v), merged));
  if (candidate) {
    if (adjustments.length === 0) adjustments.push("parámetros incompletos; se completan con los del modelo");
    return { id, params: formatParams(candidate), adjustments };
  }

  adjustments.push(`combinación sin variante en ${id}; se usa la variante por defecto`);
  return { id, params: formatParams(fallback), adjustments };
}

/**
 * Decide el modelo y los parámetros definitivos.
 *
 * `selection` es lo que eligió la issue (o null); `fallback`, el default de
 * la configuración. Si el catálogo no está disponible, no se inventa nada:
 * se manda la selección tal cual, sin mezclarle parámetros ajenos.
 */
export function resolveModel(
  selection: ModelSelection | null,
  fallback: ModelSelection,
  catalog: CursorModel[]
): ResolvedModel {
  const wanted = selection ?? fallback;
  if (catalog.length === 0) return { ...wanted, adjustments: ["catálogo no disponible; se manda sin validar"] };

  const model = findModel(catalog, wanted.id);
  if (model) return fitToModel(model, parseParamString(wanted.params));

  const notes = [`${wanted.id} ya no está en el catálogo de Cursor`];
  const fallbackModel = selection ? findModel(catalog, fallback.id) : undefined;
  if (fallbackModel) {
    const resolved = fitToModel(fallbackModel, parseParamString(fallback.params));
    return { ...resolved, adjustments: [...notes, `se usa el default ${resolved.id}`, ...resolved.adjustments] };
  }
  // Ni la selección ni el default existen: Cursor elige.
  return { id: "default", params: "", adjustments: [...notes, "se deja elegir a Cursor (Auto)"] };
}
