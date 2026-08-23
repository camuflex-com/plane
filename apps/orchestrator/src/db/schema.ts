/**
 * Esquema del orquestador, embebido como string en vez de leerse de disco:
 * tsdown empaqueta solo TS, y un .sql suelto no llegaría al contenedor.
 * Es idempotente y se aplica en cada arranque.
 */
export const SCHEMA_SQL = `
-- Esquema del orquestador. Se aplica al arrancar, es idempotente.

CREATE TABLE IF NOT EXISTS project_config (
    plane_project_id  UUID PRIMARY KEY,
    plane_workspace_slug TEXT NOT NULL,
    github_owner      TEXT NOT NULL,
    github_repo       TEXT NOT NULL,
    base_branch       TEXT NOT NULL DEFAULT 'main',
    -- Interruptor de seguridad: un proyecto que no esté aquí, o esté en
    -- false, se ignora por completo.
    enabled           BOOLEAN NOT NULL DEFAULT FALSE,
    -- Ciclos In Review -> In Progress antes de rendirse.
    max_attempts      SMALLINT NOT NULL DEFAULT 3,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plane_issue_id    UUID NOT NULL,
    plane_project_id  UUID NOT NULL REFERENCES project_config(plane_project_id) ON DELETE CASCADE,
    cursor_agent_id   TEXT,
    pr_number         INTEGER,
    head_sha          TEXT,
    state             TEXT NOT NULL,
    attempts          SMALLINT NOT NULL DEFAULT 0,
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Una sola run viva por issue: es la guarda que impide que dos eventos de
-- "entra a In Progress" lancen dos agentes sobre la misma issue.
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_issue
    ON runs (plane_issue_id)
    WHERE state NOT IN ('merged', 'parked', 'failed');

CREATE INDEX IF NOT EXISTS runs_by_pr ON runs (plane_project_id, pr_number);
CREATE INDEX IF NOT EXISTS runs_by_agent ON runs (cursor_agent_id);

-- Deduplicación de entregas. Plane manda X-Plane-Delivery y GitHub
-- X-GitHub-Delivery; ambos reintentan, y procesar dos veces significaría dos
-- agentes o dos merges.
CREATE TABLE IF NOT EXISTS deliveries (
    source       TEXT NOT NULL,
    delivery_id  TEXT NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source, delivery_id)
);

CREATE TABLE IF NOT EXISTS jobs (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind         TEXT NOT NULL,
    payload      JSONB NOT NULL,
    run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts     SMALLINT NOT NULL DEFAULT 0,
    locked_at    TIMESTAMPTZ,
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_pending ON jobs (run_after) WHERE locked_at IS NULL;
`;
