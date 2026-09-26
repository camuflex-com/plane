/**
 * Tipo y dimensiones de una imagen leyendo solo su cabecera.
 *
 * Evita arrastrar una librería de imágenes nativa al contenedor para lo único
 * que hace falta: saber qué formato es y cuánto mide.
 */

export type ImageInfo = { mime: string; width: number; height: number };

export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: firma de 8 bytes y el chunk IHDR justo después.
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("ascii", 12, 16) === "IHDR") {
    return { mime: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }

  // GIF: "GIF87a"/"GIF89a", ancho y alto little-endian.
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") {
    return { mime: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }

  // WebP: contenedor RIFF con VP8 (con pérdida), VP8L (sin pérdida) o VP8X.
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 ") {
      return { mime: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      return { mime: "image/webp", width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    }
  }

  // JPEG: recorrer los segmentos hasta un SOF, que lleva las dimensiones.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < b.length) {
      if (b[offset] !== 0xff) return null;
      const marker = b[offset + 1] as number;
      const length = b.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { mime: "image/jpeg", width: b.readUInt16BE(offset + 7), height: b.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }

  return null;
}
