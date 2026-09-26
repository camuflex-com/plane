import { describe, expect, it } from "vitest";
import { collectIssueImages, imagesNote, resolveImageUrl } from "@/issue-images";

const BASE = "https://plane.camuflex.com";
const ASSET = "0092eac4-c232-4e95-9356-cdb7bc03cb3f";

function png(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const plane = {
  getAssetUrl: async (_slug: string, id: string) => `${BASE}/uploads/${id}.png?X-Amz-Signature=abc`,
};

const image = (src: string) => `<image-component src="${src}" status="uploaded"></image-component>`;

describe("imágenes de la issue", () => {
  it("baja el asset de Plane y lo manda en base64 con tipo y dimensiones", async () => {
    const bytes = png(1440, 900);
    const seen: string[] = [];
    const result = await collectIssueImages(
      plane,
      "camuflex-backend",
      BASE,
      `${image(ASSET)}<p>En base a esa imagen…</p>`,
      async (url) => {
        seen.push(url);
        return bytes;
      }
    );
    expect(seen).toEqual([`${BASE}/uploads/${ASSET}.png?X-Amz-Signature=abc`]);
    expect(result.images).toEqual([
      { data: Buffer.from(bytes).toString("base64"), mimeType: "image/png", dimension: { width: 1440, height: 900 } },
    ]);
    expect(result.attached).toEqual([1]);
  });

  it("no sigue URLs fuera de Plane", async () => {
    await expect(resolveImageUrl(plane, "s", BASE, "http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /fuera de Plane/
    );
  });

  it("acepta rutas relativas del propio Plane", async () => {
    expect(await resolveImageUrl(plane, "s", BASE, "/uploads/x.png")).toBe(`${BASE}/uploads/x.png`);
  });

  it("un archivo que no es imagen se salta con motivo", async () => {
    const result = await collectIssueImages(plane, "s", BASE, image(ASSET), async () => Buffer.from("<svg/>"));
    expect(result.images).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/formato no admitido/);
  });

  it("un fallo de descarga no tumba el arranque: se anota y sigue", async () => {
    const html = image(ASSET) + image("1b2c3d4e-0000-4000-8000-000000000000");
    let call = 0;
    const result = await collectIssueImages(plane, "s", BASE, html, async () => {
      call++;
      if (call === 1) throw new Error("403 en la descarga");
      return png(10, 10);
    });
    expect(result.attached).toEqual([2]);
    expect(result.skipped).toEqual([{ index: 1, reason: "403 en la descarga" }]);
  });

  it("respeta el máximo de 5 imágenes de Cursor", async () => {
    const html = Array.from({ length: 7 }, () => image(ASSET)).join("");
    const result = await collectIssueImages(plane, "s", BASE, html, async () => png(1, 1));
    expect(result.images).toHaveLength(5);
    expect(result.skipped.map((s) => s.index)).toEqual([6, 7]);
  });
});

describe("nota para el prompt", () => {
  it("le dice al agente que la imagen es parte de la especificación", () => {
    const note = imagesNote({ images: [], attached: [1], skipped: [] });
    expect(note).toContain("[Imagen 1]");
    expect(note).toMatch(/iconos/);
  });

  it("avisa de las que no llegaron", () => {
    expect(imagesNote({ images: [], attached: [], skipped: [{ index: 2, reason: "x" }] })).toContain(
      "[Imagen 2] no se pudo adjuntar"
    );
  });

  it("sin imágenes no añade nada", () => {
    expect(imagesNote({ images: [], attached: [], skipped: [] })).toBe("");
  });
});
