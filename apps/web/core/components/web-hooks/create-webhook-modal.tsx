/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { useParams } from "next/navigation";
// types
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IWebhook, IWorkspace, TWebhookEventTypes } from "@plane/types";
// ui
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
// helpers
import { csvDownload } from "@plane/utils";
// hooks
import useKeypress from "@/hooks/use-keypress";
// components
import { WebhookForm } from "./form";
import { GeneratedHookDetails } from "./generated-hook-details";
// utils
import { getCurrentHookAsCSV } from "./utils";

interface ICreateWebhookModal {
  currentWorkspace: IWorkspace | null;
  isOpen: boolean;
  clearSecretKey: () => void;
  createWebhook: (
    workspaceSlug: string,
    data: Partial<IWebhook>
  ) => Promise<{
    webHook: IWebhook;
    secretKey: string | null;
  }>;
  onClose: () => void;
  /** Which settings screen the modal was opened from. */
  scope?: "workspace" | "project";
  /** Enables the state-transition picker for that project's states. */
  stateTriggerProjectId?: string;
}

export function CreateWebhookModal(props: ICreateWebhookModal) {
  const {
    isOpen,
    onClose,
    currentWorkspace,
    createWebhook,
    clearSecretKey,
    scope = "workspace",
    stateTriggerProjectId,
  } = props;
  // states
  const [generatedWebhook, setGeneratedKey] = useState<IWebhook | null>(null);
  // router
  const { workspaceSlug } = useParams();
  const { t } = useTranslation();

  const handleCreateWebhook = async (formData: IWebhook, webhookEventType: TWebhookEventTypes) => {
    if (!workspaceSlug) return;

    let payload: Partial<IWebhook> = {
      url: formData.url,
      // Empty array = workspace-wide, which is the API's default too.
      project_ids: formData.project_ids ?? [],
      // Empty array = fire on every event, no transition filter.
      state_ids: formData.state_ids ?? [],
    };

    // Un webhook de proyecto no emite eventos de proyecto, ni siquiera con
    // "enviármelo todo": el ciclo de vida del proyecto es del workspace.
    const allowsProjectEvents = scope === "workspace";

    if (webhookEventType === "all")
      payload = {
        ...payload,
        project: allowsProjectEvents,
        cycle: true,
        module: true,
        issue: true,
        issue_comment: true,
      };
    else
      payload = {
        ...payload,
        project: allowsProjectEvents ? (formData.project ?? false) : false,
        cycle: formData.cycle ?? false,
        module: formData.module ?? false,
        issue: formData.issue ?? false,
        issue_comment: formData.issue_comment ?? false,
      };

    await createWebhook(workspaceSlug.toString(), payload)
      .then(({ webHook, secretKey }) => {
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("workspace_settings.settings.webhooks.toasts.created.title"),
          message: t("workspace_settings.settings.webhooks.toasts.created.message"),
        });

        setGeneratedKey(webHook);

        const csvData = getCurrentHookAsCSV(currentWorkspace, webHook, secretKey ?? undefined);
        csvDownload(csvData, `webhook-secret-key-${Date.now()}`);
      })
      .catch((error) => {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: t("workspace_settings.settings.webhooks.toasts.not_created.title"),
          message: error?.error ?? t("workspace_settings.settings.webhooks.toasts.not_created.message"),
        });
      });
  };

  const handleClose = () => {
    onClose();
    setTimeout(() => {
      clearSecretKey();
      setGeneratedKey(null);
    }, 350);
  };

  useKeypress("Escape", () => {
    if (isOpen && !generatedWebhook) handleClose();
  });

  return (
    <ModalCore isOpen={isOpen} position={EModalPosition.TOP} width={EModalWidth.XXL} className="p-4 pb-0">
      {!generatedWebhook ? (
        <WebhookForm
          onSubmit={handleCreateWebhook}
          handleClose={handleClose}
          scope={scope}
          stateTriggerProjectId={stateTriggerProjectId}
        />
      ) : (
        <GeneratedHookDetails webhookDetails={generatedWebhook} handleClose={handleClose} />
      )}
    </ModalCore>
  );
}
