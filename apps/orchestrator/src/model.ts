/**
 * El modelo se elige al crear la issue y viaja en la descripción, porque
 * el orquestador no ve el formulario: solo el webhook y el GET de la issue.
 *
 * El marcador es texto plano (`[camuflex-model …]`) para sobrevivir al
 * sanitizado HTML de Plane. Si no está, se usa el default del env.
 */

export type ModelSelection = { id: string; params: string };

export type ModelOption = ModelSelection & { label: string; isDefault?: boolean };

export type CursorModelVariant = {
  params?: { id?: string; value?: string; displayName?: string }[];
  displayName?: string;
  isDefault?: boolean;
};

export type CursorModel = {
  id?: string;
  displayName?: string;
  variants?: CursorModelVariant[];
};

const MARKER_RE = /\[camuflex-model\s+(\S+)(?:\s+([^\]]*?))?\]/i;
const MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/;

export function formatModelMarker(selection: ModelSelection): string {
  const params = selection.params.trim();
  return params ? `[camuflex-model ${selection.id} ${params}]` : `[camuflex-model ${selection.id}]`;
}

export function parseModelMarker(text: string | null | undefined): ModelSelection | null {
  if (!text) return null;
  const match = text.match(MARKER_RE);
  if (!match) return null;
  return { id: match[1], params: (match[2] ?? "").trim() };
}

export function stripModelMarker(text: string | null | undefined): string {
  return (text ?? "").replace(/\s*\[camuflex-model [^\]]+\]\s*/gi, "").trim();
}

export function appendModelMarker(text: string, selection: ModelSelection): string {
  const marker = formatModelMarker(selection);
  const without = text.replace(/\s*\[camuflex-model [^\]]+\]\s*/gi, "").trim();
  return without ? `${without}\n\n${marker}` : marker;
}

export function isValidModelId(id: string): boolean {
  return MODEL_ID_RE.test(id) && id.length <= 80;
}

export function selectionFromEnv(env: { CURSOR_MODEL: string; CURSOR_MODEL_PARAMS: string }): ModelSelection {
  return { id: env.CURSOR_MODEL, params: env.CURSOR_MODEL_PARAMS };
}

export function flattenModelCatalog(items: CursorModel[], fallback: ModelSelection): ModelOption[] {
  const options: ModelOption[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (!item.id || !isValidModelId(item.id)) continue;
    const variants = item.variants?.length ? item.variants : [{ params: [], displayName: item.displayName }];
    for (const variant of variants) {
      const params = (variant.params ?? [])
        .filter((p): p is { id: string; value: string } => Boolean(p.id && p.value))
        .map((p) => `${p.id}=${p.value}`)
        .join(",");
      const key = `${item.id}|${params}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        id: item.id,
        params,
        label: variantLabel(item, variant, params),
      });
    }
  }

  const fallbackKey = `${fallback.id}|${fallback.params}`;
  if (!seen.has(fallbackKey)) {
    options.unshift({
      ...fallback,
      label: fallbackLabel(fallback),
      isDefault: true,
    });
  }

  for (const option of options) {
    option.isDefault = `${option.id}|${option.params}` === fallbackKey;
  }
  return options.toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

function variantLabel(item: CursorModel, variant: CursorModelVariant, params: string): string {
  const base = item.displayName || item.id || "modelo";
  if (variant.displayName && variant.displayName !== base) return variant.displayName;
  if (!params) return base;
  const extras = params
    .split(",")
    .map((pair) => pair.split("=")[1])
    .filter(Boolean);
  return extras.length ? `${base} · ${extras.join(" · ")}` : base;
}

function fallbackLabel(selection: ModelSelection): string {
  const extras = selection.params
    .split(",")
    .map((pair) => pair.split("=")[1])
    .filter(Boolean);
  return extras.length ? `${selection.id} · ${extras.join(" · ")}` : selection.id;
}
