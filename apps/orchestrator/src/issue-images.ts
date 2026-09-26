// oxlint-disable no-await-in-loop -- las imágenes se bajan de una en una a
// propósito: son pocas (máx. 5) y así el pico de memoria es una sola.
import { fetchBytes } from "@/clients/http";
import type { PlaneClient } from "@/clients/plane";
import { extractImageSources } from "@/html-text";
import { imageInfo } from "@/image-size";

/**
 * Imágenes de la descripción de una issue, listas para el prompt de Cursor.
 *
 * Plane guarda cada imagen del editor como un asset y en el HTML solo deja su
 * id. Antes el orquestador pasaba el HTML a texto y la imagen desaparecía: el
 * agente leía "en base a esa imagen" sin imagen, y construía la interfaz a
 * ciegas.
 */

/** Límites de `prompt.images` en la API v1 de Cursor. */
export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PromptImage = {
  data: string;
  mimeType: string;
  dimension?: { width: number; height: number };
};

export type CollectedImages = {
  images: PromptImage[];
  /** Número (1-based, como en el texto) de cada imagen adjuntada. */
  attached: number[];
  /** Por qué no se adjuntó cada una de las demás. */
  skipped: { index: number; reason: string }[];
};

/**
 * Resuelve el `src` a una URL descargable. Solo se aceptan assets de Plane o
 * URLs del propio Plane: seguir cualquier URL de una descripción convertiría
 * al orquestador en un proxy hacia la red interna.
 */
export async function resolveImageUrl(
  plane: Pick<PlaneClient, "getAssetUrl">,
  slug: string,
  planeBaseUrl: string,
  src: string
): Promise<string> {
  if (UUID_RE.test(src)) return plane.getAssetUrl(slug, src);
  const base = new URL(planeBaseUrl);
  const url = new URL(src, base);
  if (url.origin !== base.origin) throw new Error(`imagen fuera de Plane (${url.host}), no se descarga`);
  return url.toString();
}

export async function collectIssueImages(
  plane: Pick<PlaneClient, "getAssetUrl">,
  slug: string,
  planeBaseUrl: string,
  html: string | null | undefined,
  download: (url: string) => Promise<Uint8Array> = (url) => fetchBytes(url, MAX_IMAGE_BYTES)
): Promise<CollectedImages> {
  const result: CollectedImages = { images: [], attached: [], skipped: [] };
  const sources = extractImageSources(html);

  for (const [position, src] of sources.entries()) {
    const index = position + 1;
    if (result.images.length >= MAX_IMAGES) {
      result.skipped.push({ index, reason: `Cursor admite como máximo ${MAX_IMAGES} imágenes` });
      continue;
    }
    try {
      const bytes = await download(await resolveImageUrl(plane, slug, planeBaseUrl, src));
      const info = imageInfo(bytes);
      if (!info || !ALLOWED_MIME.has(info.mime)) {
        result.skipped.push({ index, reason: "formato no admitido (solo PNG, JPEG, GIF o WebP)" });
        continue;
      }
      result.images.push({
        data: Buffer.from(bytes).toString("base64"),
        mimeType: info.mime,
        ...(info.width > 0 && info.height > 0 ? { dimension: { width: info.width, height: info.height } } : {}),
      });
      result.attached.push(index);
    } catch (error) {
      result.skipped.push({ index, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** Nota para el prompt: qué imagen es cuál y cuáles no llegaron. */
export function imagesNote(collected: CollectedImages): string {
  const lines: string[] = [];
  if (collected.attached.length) {
    const refs = collected.attached.map((i) => `[Imagen ${i}]`).join(", ");
    lines.push(
      `Esta tarea incluye ${collected.attached.length === 1 ? "una imagen adjunta" : "imágenes adjuntas"} (${refs}), ` +
        "en el mismo orden en que aparecen en la descripción. Son parte de la especificación: reprodúcelas con fidelidad " +
        "(layout, colores, tipografía, espaciados e iconos)."
    );
  }
  for (const { index, reason } of collected.skipped) {
    lines.push(`[Imagen ${index}] no se pudo adjuntar (${reason}); guíate por el texto.`);
  }
  return lines.join("\n");
}
