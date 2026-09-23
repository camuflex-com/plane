/**
 * Convierte la descripción HTML de una issue de Plane en texto legible para el
 * prompt del agente.
 *
 * No se usa `description_stripped` por dos motivos. El primero es que la API
 * externa de Plane lo excluye de sus respuestas: el orquestador recibía
 * `undefined` y el agente solo veía el título. El segundo es que, aunque
 * llegara, aplana las tablas pegando las celdas ("CapaTecnologíaBuild /
 * devVite 6"), y las especificaciones de stack suelen venir justo en tablas.
 */

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&[a-z]+;|&#39;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);
}

/**
 * Contenido de una celda en una sola línea.
 *
 * Los bloques (`<p>`, `<br>`) separan con espacio; las etiquetas en línea
 * (`<span>`, `<strong>`) se quitan sin dejar hueco, para no convertir
 * "(<span>api-client.ts</span>)" en "( api-client.ts )".
 */
function inline(html: string): string {
  const text = html
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<\/(p|div|li)>|<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

export function htmlToText(html: string | null | undefined): string {
  if (!html?.trim()) return "";

  let text = html;

  // Cada fila de tabla pasa a una línea con las celdas separadas por "|", así
  // la relación fila/columna sobrevive. Las filas quedan contiguas y las
  // vacías se descartan.
  text = text.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row: string) => {
    const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => inline(m[1] ?? ""));
    return cells.some(Boolean) ? `\n| ${cells.join(" | ")} |` : "";
  });

  text = text
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<h([1-6])[^>]*>/gi, (_, level: string) => `\n${"#".repeat(Number(level))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    // Tablas y listas son bloques: línea en blanco antes de lo que siga.
    .replace(/<\/(table|ul|ol)>/gi, "\n\n")
    // `</li>` no cierra con salto: lo pone el `<li>` siguiente. Si no, cada
    // ítem de lista quedaría separado del anterior por una línea en blanco.
    .replace(/<\/(p|div|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  const lines = decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());

  // Una sola línea en blanco entre bloques, y ninguna al principio o al final.
  const compact: string[] = [];
  for (const line of lines) {
    if (line === "" && (compact.length === 0 || compact.at(-1) === "")) continue;
    compact.push(line);
  }
  while (compact.at(-1) === "") compact.pop();
  return compact.join("\n");
}
