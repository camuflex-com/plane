import { describe, expect, it } from "vitest";
import { issueDescription } from "@/executor";
import { htmlToText } from "@/html-text";

// Fragmento del HTML real de PANELSEED-1: tabla con cabecera, <strong>,
// <code> y el marcado del editor de Plane.
const REAL = `<table data-id="x"><tbody><tr><th colspan="1"><p class="editor-paragraph-block">Capa</p></th><th><p class="editor-paragraph-block">Tecnología</p></th></tr><tr><td><p><strong>Build / dev</strong></p></td><td><p>Vite 6 (<code class="rounded-sm">vite --port 3000</code>), TypeScript 5.7</p></td></tr><tr><td><p><strong>HTTP</strong></p></td><td><p>Axios (<span>api-client.ts</span>)</p></td></tr><tr><td><p></p></td><td><p></p></td></tr></tbody></table><p class="editor-paragraph-block">Por ahora todo va a estar mock.</p>`;

describe("htmlToText", () => {
  // El fallo que motivó esto: description_stripped pegaba las celdas.
  it("no pega las celdas de una tabla", () => {
    const out = htmlToText(REAL);
    expect(out).not.toContain("CapaTecnología");
    expect(out).not.toContain("devVite");
  });

  it("convierte cada fila en una línea con celdas separadas", () => {
    expect(htmlToText(REAL).split("\n").slice(0, 3)).toEqual([
      "| Capa | Tecnología |",
      "| Build / dev | Vite 6 (`vite --port 3000`), TypeScript 5.7 |",
      "| HTTP | Axios (api-client.ts) |",
    ]);
  });

  it("descarta las filas vacías", () => {
    expect(htmlToText(REAL)).not.toContain("|  |");
    expect(htmlToText(REAL)).not.toContain("| | |");
  });

  it("separa la tabla del párrafo siguiente", () => {
    expect(htmlToText(REAL)).toMatch(/\|\n\nPor ahora todo va a estar mock\.$/);
  });

  it("no deja huecos donde había etiquetas en línea", () => {
    expect(htmlToText(REAL)).toContain("(api-client.ts)");
  });

  it("listas, títulos, saltos y entidades", () => {
    expect(htmlToText("<h2>Alcance</h2><ul><li>Uno</li><li>Dos &amp; tres</li></ul><p>a<br>b</p>")).toBe(
      "## Alcance\n\n- Uno\n- Dos & tres\n\na\nb"
    );
  });

  it("vacío o nulo da cadena vacía", () => {
    expect(htmlToText(null)).toBe("");
    expect(htmlToText("   ")).toBe("");
    expect(htmlToText("<p></p>")).toBe("");
  });
});

describe("issueDescription", () => {
  // La API externa de Plane excluye description_stripped: solo llega el HTML.
  it("usa el HTML aunque no venga description_stripped", () => {
    expect(issueDescription({ description_html: REAL })).toContain("Vite 6");
  });

  it("recurre a description_stripped si no hay HTML", () => {
    expect(issueDescription({ description_html: null, description_stripped: " texto " })).toBe("texto");
  });

  it("sin nada, cadena vacía", () => {
    expect(issueDescription({})).toBe("");
  });
});
