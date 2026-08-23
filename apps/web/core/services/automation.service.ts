/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

export type TAutomationRunState = "queued" | "agent_running" | "in_review" | "fixing" | "merged" | "parked" | "failed";

export type TAutomationRun = {
  id: string;
  issueId: string;
  state: TAutomationRunState;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  agentUrl: string | null;
  prUrl: string | null;
  prNumber: number | null;
};

export type TAutomationRunList = {
  enabled: boolean;
  repo?: string;
  maxAttempts?: number;
  runs: TAutomationRun[];
};

export type TAutomationRunDetail = TAutomationRun & {
  agent: { status?: string; result?: string; durationMs?: number } | null;
};

/**
 * Habla con el orquestador, que vive fuera de Plane pero se sirve bajo el
 * mismo dominio en /automation. Al ser mismo origen, la cookie de sesión viaja
 * sola y el orquestador la reenvía a Plane para autorizar.
 */
export class AutomationService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async fetchRuns(projectId: string): Promise<TAutomationRunList> {
    return this.get(`/automation/api/projects/${projectId}/runs`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async fetchRunDetail(projectId: string, runId: string): Promise<TAutomationRunDetail> {
    return this.get(`/automation/api/projects/${projectId}/runs/${runId}`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }
}
