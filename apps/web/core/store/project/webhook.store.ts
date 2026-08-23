/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// mobx
import { action, observable, makeObservable, runInAction } from "mobx";
import { computedFn } from "mobx-utils";
// types
import type { IWebhook } from "@plane/types";
// services
import { ProjectWebhookService } from "@/services/project-webhook.service";
// store
import type { CoreRootStore } from "../root.store";

export interface IProjectWebhookStore {
  // observables
  webhooks: Record<string, IWebhook> | null;
  webhookSecretKey: string | null;
  // computed actions
  getWebhookById: (webhookId: string) => IWebhook | null;
  // fetch actions
  fetchWebhooks: (workspaceSlug: string, projectId: string) => Promise<IWebhook[]>;
  fetchWebhookById: (workspaceSlug: string, projectId: string, webhookId: string) => Promise<IWebhook>;
  // crud actions
  createWebhook: (
    workspaceSlug: string,
    projectId: string,
    data: Partial<IWebhook>
  ) => Promise<{ webHook: IWebhook; secretKey: string | null }>;
  updateWebhook: (
    workspaceSlug: string,
    projectId: string,
    webhookId: string,
    data: Partial<IWebhook>
  ) => Promise<IWebhook>;
  removeWebhook: (workspaceSlug: string, projectId: string, webhookId: string) => Promise<void>;
  // secret key actions
  regenerateSecretKey: (
    workspaceSlug: string,
    projectId: string,
    webhookId: string
  ) => Promise<{ webHook: IWebhook; secretKey: string | null }>;
  clearSecretKey: () => void;
}

/**
 * Webhooks owned by a single project.
 *
 * Deliberately separate from WebhookStore rather than a parameterised version
 * of it: the two lists cover different sets (a project never sees
 * workspace-wide webhooks) and keeping them apart avoids one view clobbering
 * the other's cache when a user moves between settings screens.
 */
export class ProjectWebhookStore implements IProjectWebhookStore {
  // observables
  webhooks: Record<string, IWebhook> | null = null;
  webhookSecretKey: string | null = null;
  // services
  projectWebhookService;
  // root store
  rootStore;

  constructor(_rootStore: CoreRootStore) {
    makeObservable(this, {
      // observables
      webhooks: observable,
      webhookSecretKey: observable.ref,
      // fetch actions
      fetchWebhooks: action,
      fetchWebhookById: action,
      // CRUD actions
      createWebhook: action,
      updateWebhook: action,
      removeWebhook: action,
      // secret key actions
      regenerateSecretKey: action,
      clearSecretKey: action,
    });

    this.projectWebhookService = new ProjectWebhookService();
    this.rootStore = _rootStore;
  }

  getWebhookById = computedFn((webhookId: string) => this.webhooks?.[webhookId] || null);

  fetchWebhooks = async (workspaceSlug: string, projectId: string) =>
    await this.projectWebhookService.fetchWebhooksList(workspaceSlug, projectId).then((response) => {
      const webhookObject = response.reduce<Record<string, IWebhook>>((accumulator, currentWebhook) => {
        if (currentWebhook?.id) accumulator[currentWebhook.id] = currentWebhook;
        return accumulator;
      }, {});
      runInAction(() => {
        // Replace rather than merge: switching projects must not leave the
        // previous project's webhooks visible in the list.
        this.webhooks = webhookObject;
      });
      return response;
    });

  fetchWebhookById = async (workspaceSlug: string, projectId: string, webhookId: string) =>
    await this.projectWebhookService.fetchWebhookDetails(workspaceSlug, projectId, webhookId).then((response) => {
      runInAction(() => {
        this.webhooks = { ...this.webhooks, [response.id]: response };
      });
      return response;
    });

  createWebhook = async (workspaceSlug: string, projectId: string, data: Partial<IWebhook>) =>
    await this.projectWebhookService.createWebhook(workspaceSlug, projectId, data).then((response) => {
      const secretKey = response?.secret_key ?? null;
      delete response?.secret_key;
      runInAction(() => {
        this.webhookSecretKey = secretKey || null;
        if (response?.id) this.webhooks = { ...this.webhooks, [response.id]: response };
      });
      return { webHook: response, secretKey };
    });

  updateWebhook = async (workspaceSlug: string, projectId: string, webhookId: string, data: Partial<IWebhook>) =>
    await this.projectWebhookService.updateWebhook(workspaceSlug, projectId, webhookId, data).then((response) => {
      runInAction(() => {
        const current = this.webhooks?.[webhookId];
        if (current) this.webhooks = { ...this.webhooks, [webhookId]: { ...current, ...data } };
      });
      return response;
    });

  removeWebhook = async (workspaceSlug: string, projectId: string, webhookId: string) =>
    await this.projectWebhookService.deleteWebhook(workspaceSlug, projectId, webhookId).then(() => {
      runInAction(() => {
        const next = { ...this.webhooks };
        delete next[webhookId];
        this.webhooks = next;
      });
      return undefined;
    });

  regenerateSecretKey = async (workspaceSlug: string, projectId: string, webhookId: string) =>
    await this.projectWebhookService.regenerateSecretKey(workspaceSlug, projectId, webhookId).then((response) => {
      const secretKey = response?.secret_key ?? null;
      delete response?.secret_key;
      runInAction(() => {
        this.webhookSecretKey = secretKey || null;
        if (response?.id) this.webhooks = { ...this.webhooks, [response.id]: response };
      });
      return { webHook: response, secretKey };
    });

  clearSecretKey = () => {
    this.webhookSecretKey = null;
  };
}
