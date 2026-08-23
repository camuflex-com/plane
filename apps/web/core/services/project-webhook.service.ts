/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type { IWebhook } from "@plane/types";
import { APIService } from "@/services/api.service";

/**
 * Webhooks scoped to a single project.
 *
 * Mirrors WebhookService, but every call is namespaced under the project and
 * the API only ever returns webhooks that belong exclusively to it — webhooks
 * shared across projects, or workspace-wide ones, stay a workspace-admin
 * concern and are not visible here.
 */
export class ProjectWebhookService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async fetchWebhooksList(workspaceSlug: string, projectId: string): Promise<IWebhook[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/projects/${projectId}/webhooks/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async fetchWebhookDetails(workspaceSlug: string, projectId: string, webhookId: string): Promise<IWebhook> {
    return this.get(`/api/workspaces/${workspaceSlug}/projects/${projectId}/webhooks/${webhookId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async createWebhook(workspaceSlug: string, projectId: string, data = {}): Promise<IWebhook> {
    return this.post(`/api/workspaces/${workspaceSlug}/projects/${projectId}/webhooks/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async updateWebhook(workspaceSlug: string, projectId: string, webhookId: string, data = {}): Promise<IWebhook> {
    return this.patch(`/api/workspaces/${workspaceSlug}/projects/${projectId}/webhooks/${webhookId}/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async deleteWebhook(workspaceSlug: string, projectId: string, webhookId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/projects/${projectId}/webhooks/${webhookId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async regenerateSecretKey(workspaceSlug: string, projectId: string, webhookId: string): Promise<IWebhook> {
    return this.post(`/api/workspaces/${workspaceSlug}/projects/${projectId}/webhooks/${webhookId}/regenerate/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }
}
