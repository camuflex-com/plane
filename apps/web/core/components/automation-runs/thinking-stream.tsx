/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";

type StreamEvent = {
  /** Identificador propio: los eventos no traen uno y el índice del array
   *  no sirve como clave estable en una lista que crece y se recorta. */
  id: number;
  kind: string;
  text: string;
};

/** Eventos del stream de Cursor que merece la pena mostrar. */
const RENDERED: Record<string, { label: string; className: string }> = {
  thinking: { label: "Razonando", className: "text-tertiary italic" },
  assistant: { label: "Agente", className: "text-secondary" },
  tool_call: { label: "Herramienta", className: "text-info-text-medium" },
  status: { label: "Estado", className: "text-tertiary" },
  result: { label: "Resultado", className: "text-success-text-medium" },
  error: { label: "Error", className: "text-danger-text-medium" },
};

/** Saca algo legible de un payload cuya forma exacta varía por tipo de evento. */
function extractText(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      for (const key of ["text", "message", "content", "status", "name", "result"]) {
        if (typeof o[key] === "string" && o[key]) return o[key] as string;
      }
      return JSON.stringify(parsed);
    }
    return raw;
  } catch {
    return raw;
  }
}

type Props = {
  /** URL del proxy SSE del orquestador. */
  url: string;
  /** Solo se conecta si la run sigue viva; una terminada no emite nada. */
  active: boolean;
};

export function ThinkingStream({ url, active }: Props) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [state, setState] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active) {
      setState("closed");
      return;
    }

    const source = new EventSource(url, { withCredentials: true });
    let nextId = 0;
    const push = (kind: string, raw: string) =>
      setEvents((prev) => [...prev.slice(-300), { id: nextId++, kind, text: extractText(raw) }]);

    source.addEventListener("open", () => setState("open"));
    source.addEventListener("error", () => {
      // EventSource reintenta solo; solo se marca error si ya está cerrado.
      if (source.readyState === EventSource.CLOSED) setState("error");
    });

    for (const kind of Object.keys(RENDERED)) {
      source.addEventListener(kind, (e) => push(kind, (e as MessageEvent).data));
    }
    source.addEventListener("done", () => {
      setState("closed");
      source.close();
    });

    return () => source.close();
  }, [url, active]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [events]);

  if (!active && events.length === 0) {
    return (
      <p className="text-12 text-tertiary">
        Esta tarea ya terminó, así que no hay razonamiento en vivo. El resumen final está abajo.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-11 text-tertiary">
        <span
          className={`size-2 rounded-full ${
            state === "open" ? "bg-success-solid" : state === "error" ? "bg-danger-solid" : "bg-layer-3"
          }`}
          aria-hidden="true"
        />
        {state === "connecting" && "Conectando con el agente…"}
        {state === "open" && "En vivo"}
        {state === "closed" && "Stream terminado"}
        {state === "error" && "Se perdió la conexión con el agente"}
      </div>

      <div className="font-mono max-h-80 space-y-1 overflow-y-auto rounded border border-subtle bg-layer-2 p-3 text-11">
        {events.length === 0 ? (
          <p className="text-tertiary">Esperando la primera señal del agente…</p>
        ) : (
          events.map((event) => {
            const meta = RENDERED[event.kind];
            return (
              <div key={event.id} className="flex gap-2">
                <span className="shrink-0 text-tertiary">{meta?.label ?? event.kind}</span>
                <span className={`break-words whitespace-pre-wrap ${meta?.className ?? "text-secondary"}`}>
                  {event.text}
                </span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
