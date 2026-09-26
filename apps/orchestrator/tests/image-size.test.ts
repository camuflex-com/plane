import { describe, expect, it } from "vitest";
import { imageInfo } from "@/image-size";

function png(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, un APP0 de relleno y el SOF0 con las dimensiones.
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  const sof = [
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x01,
    0x00,
    0x00,
    0x00,
  ];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof]);
}

function gif(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

describe("dimensiones por cabecera", () => {
  it("PNG", () => {
    expect(imageInfo(png(1440, 900))).toEqual({ mime: "image/png", width: 1440, height: 900 });
  });

  it("JPEG, saltando segmentos previos al SOF", () => {
    expect(imageInfo(jpeg(1920, 1080))).toEqual({ mime: "image/jpeg", width: 1920, height: 1080 });
  });

  it("GIF", () => {
    expect(imageInfo(gif(320, 200))).toEqual({ mime: "image/gif", width: 320, height: 200 });
  });

  it("algo que no es imagen", () => {
    expect(imageInfo(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });

  it("un archivo truncado no revienta", () => {
    expect(imageInfo(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});
