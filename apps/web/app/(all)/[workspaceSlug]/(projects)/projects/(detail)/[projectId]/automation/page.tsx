/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { observer } from "mobx-react";
import useSWR from "swr";
// plane imports
import { Loader } from "@plane/ui";
// components
import { ThinkingStream } from "@/components/automation-runs";
import { PageHead } from "@/components/core/page-title";
// hooks
import { useProject } from "@/hooks/store/use-project";
// services
import { AutomationService, type TAutomationRun, type TAutomationRunState } from "@/services/automation.service";

const automationService = new AutomationService();

/** Cuánto tarda una run en considerarse sospechosa de estar colgada. */
const STALE_MINUTES = 30;
const ACTIVE_STATES = new Set<TAutomationRunState>(["queued", "agent_running", "in_review", "fixing"]);

const STATE_LABEL: Record<TAutomationRunState, string> = {
  queued: "En cola",
  agent_running: "Agente trabajando",
  in_review: "En revisión",
  fixing: "Corrigiendo",
  merged: "Mergeado",
  parked: "Detenida",
  failed: "Fallida",
};

const STATE_STYLE: Record<TAutomationRunState, string> = {
  queued: "bg-layer-2 text-secondary",
  agent_running: "bg-info-component-surface-dark text-info-text-medium",
  in_review: "bg-warning-component-surface-dark text-warning-text-medium",
  fixing: "bg-warning-component-surface-dark text-warning-text-medium",
  merged: "bg-success-component-surface-dark text-success-text-medium",
  parked: "bg-danger-component-surface-dark text-danger-text-medium",
  failed: "bg-danger-component-surface-dark text-danger-text-medium",
};

const minutesSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 60000;

/** Una run activa que lleva demasiado sin moverse probablemente esté colgada. */
const isStalled = (run: TAutomationRun) => ACTIVE_STATES.has(run.state) && minutesSince(run.updatedAt) > STALE_MINUTES;

function relativeTime(iso: string): string {
  const mins = Math.floor(minutesSince(iso));
  if (mins < 1) return "hace segundos";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

function ProjectAutomationPage() {
  const { workspaceSlug, projectId } = useParams();
  const { currentProjectDetails } = useProject();
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const { data, error, isLoading } = useSWR(
    projectId ? `AUTOMATION_RUNS_${projectId}` : null,
    projectId ? () => automationService.fetchRuns(projectId.toString()) : null,
    // Refresco periódico: el estado lo mueven eventos externos (Cursor y
    // GitHub), no acciones del usuario en esta pantalla.
    { refreshInterval: 15000 }
  );

  const { data: detail } = useSWR(
    openRunId && projectId ? `AUTOMATION_RUN_${openRunId}` : null,
    openRunId && projectId ? () => automationService.fetchRunDetail(projectId.toString(), openRunId) : null
  );

  const stalled = useMemo(() => (data?.runs ?? []).filter(isStalled).length, [data]);
  const pageTitle = currentProjectDetails?.name ? `${currentProjectDetails.name} - Automatización` : undefined;

  if (isLoading) {
    return (
      <Loader className="space-y-3 p-6">
        <Loader.Item height="40px" />
        <Loader.Item height="40px" />
        <Loader.Item height="40px" />
      </Loader>
    );
  }

  if (error) {
    return (
      <div className="text-danger-text-medium p-6 text-13">
        No se pudo consultar el orquestador. Puede que el servicio esté caído.
      </div>
    );
  }

  if (!data?.enabled) {
    return (
      <div className="p-6">
        <h3 className="text-16 font-medium">Automatización no habilitada</h3>
        <p className="mt-1 text-13 text-tertiary">
          Este proyecto no está dado de alta en el orquestador, así que mover una work item a In Progress no lanza
          ningún agente.
        </p>
      </div>
    );
  }

  return (
    <div className="size-full overflow-y-auto p-6">
      <PageHead title={pageTitle} />

      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-16 font-medium">Automatización</h3>
          <p className="text-13 text-tertiary">
            Tareas encoladas a Cursor para <span className="font-medium">{data.repo}</span>
          </p>
        </div>
        {stalled > 0 && (
          <div className="bg-danger-component-surface-dark text-danger-text-medium rounded-md px-3 py-2 text-12">
            {stalled} {stalled === 1 ? "tarea lleva" : "tareas llevan"} más de {STALE_MINUTES} min sin avanzar
          </div>
        )}
      </div>

      {data.runs.length === 0 ? (
        <p className="text-13 text-tertiary">
          Todavía no hay ninguna tarea. Mueve una work item a In Progress para lanzar un agente.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-subtle">
          <table className="w-full text-13">
            <thead className="bg-layer-1 text-11 text-tertiary uppercase">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Estado</th>
                <th className="px-4 py-2 text-left font-medium">Work item</th>
                <th className="px-4 py-2 text-left font-medium">Intentos</th>
                <th className="px-4 py-2 text-left font-medium">Actualizada</th>
                <th className="px-4 py-2 text-left font-medium">Enlaces</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => (
                <>
                  <tr key={run.id} className="border-t border-subtle hover:bg-layer-1">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="flex items-center gap-2 text-left"
                        aria-expanded={openRunId === run.id}
                        onClick={() => setOpenRunId(openRunId === run.id ? null : run.id)}
                      >
                        <span className={`rounded px-2 py-1 text-11 ${STATE_STYLE[run.state]}`}>
                          {STATE_LABEL[run.state]}
                        </span>
                        {isStalled(run) && <span className="text-danger-text-medium text-11">posible cuelgue</span>}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <a
                        href={`/${workspaceSlug}/projects/${projectId}/issues/${run.issueId}`}
                        className="text-info-text-medium hover:underline"
                      >
                        Ver work item
                      </a>
                    </td>
                    <td className="px-4 py-3 text-tertiary">
                      {run.attempts}
                      {data.maxAttempts ? ` / ${data.maxAttempts}` : ""}
                    </td>
                    <td className="px-4 py-3 text-tertiary">{relativeTime(run.updatedAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-3">
                        {run.agentUrl && (
                          <a
                            href={run.agentUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-info-text-medium hover:underline"
                          >
                            Agente
                          </a>
                        )}
                        {run.prUrl && (
                          <a
                            href={run.prUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-info-text-medium hover:underline"
                          >
                            PR #{run.prNumber}
                          </a>
                        )}
                        {!run.agentUrl && !run.prUrl && <span className="text-tertiary">—</span>}
                      </div>
                    </td>
                  </tr>
                  {openRunId === run.id && (
                    <tr key={`${run.id}-detail`} className="border-t border-subtle bg-layer-1">
                      <td colSpan={5} className="px-4 py-4">
                        {run.lastError && (
                          <div className="mb-3">
                            <div className="text-11 text-tertiary uppercase">Último error</div>
                            <pre className="text-danger-text-medium mt-1 text-12 break-all whitespace-pre-wrap">
                              {run.lastError}
                            </pre>
                          </div>
                        )}
                        <div className="text-11 text-tertiary uppercase">Razonamiento del agente</div>
                        <div className="mt-2">
                          <ThinkingStream
                            url={automationService.streamUrl(projectId!.toString(), run.id)}
                            active={ACTIVE_STATES.has(run.state)}
                          />
                        </div>

                        {detail?.agent?.result && (
                          <div className="mt-3">
                            <div className="text-11 text-tertiary uppercase">Resumen final</div>
                            <pre className="mt-1 text-12 whitespace-pre-wrap text-secondary">{detail.agent.result}</pre>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default observer(ProjectAutomationPage);
