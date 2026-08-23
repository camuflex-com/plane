/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { useParams } from "next/navigation";
import { observer } from "mobx-react";
import useSWR from "swr";
// plane imports
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IWebhook } from "@plane/types";
// components
import { LogoSpinner } from "@/components/common/logo-spinner";
import { PageHead } from "@/components/core/page-title";
import { SettingsContentWrapper } from "@/components/settings/content-wrapper";
import { DeleteProjectWebhookModal, WebhookDeleteSection, WebhookForm } from "@/components/web-hooks";
// hooks
import { useProject } from "@/hooks/store/use-project";
import { useProjectWebhook } from "@/hooks/store/use-project-webhook";
import { useUserPermissions } from "@/hooks/store/user";
// local imports
import { ProjectWebhookDetailsHeader } from "./header";

function ProjectWebhookDetailsPage() {
  // states
  const [deleteWebhookModal, setDeleteWebhookModal] = useState(false);
  // router
  const { workspaceSlug, projectId, webhookId } = useParams();
  // store hooks
  const { getWebhookById, fetchWebhookById, updateWebhook } = useProjectWebhook();
  const { currentProjectDetails } = useProject();
  const { allowPermissions } = useUserPermissions();
  // derived values
  const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.PROJECT);
  const pageTitle = currentProjectDetails?.name ? `${currentProjectDetails.name} - Webhook` : undefined;
  const currentWebhook = webhookId ? getWebhookById(webhookId.toString()) : null;

  useSWR(
    isAdmin && workspaceSlug && projectId && webhookId
      ? `PROJECT_WEBHOOK_DETAILS_${workspaceSlug}_${projectId}_${webhookId}`
      : null,
    isAdmin && workspaceSlug && projectId && webhookId
      ? () => fetchWebhookById(workspaceSlug.toString(), projectId.toString(), webhookId.toString())
      : null
  );

  const handleUpdateWebhook = async (formData: IWebhook) => {
    if (!formData?.id || !workspaceSlug || !projectId) return;

    // No project_ids here: the scope is this project and the API rejects
    // attempts to change it from a project-level route.
    const payload = {
      url: formData.url,
      is_active: formData.is_active,
      project: formData.project,
      cycle: formData.cycle,
      module: formData.module,
      issue: formData.issue,
      issue_comment: formData.issue_comment,
      // Siempre se envia: vaciar la seleccion tiene que poder devolver el
      // webhook a emitir por cualquier evento.
      state_ids: formData.state_ids ?? [],
    };

    try {
      await updateWebhook(workspaceSlug.toString(), projectId.toString(), formData.id, payload);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "Success!",
        message: "Webhook updated successfully.",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Error!",
        message: error?.error ?? "Something went wrong. Please try again.",
      });
    }
  };

  if (!isAdmin)
    return (
      <>
        <PageHead title={pageTitle} />
        <div className="mt-10 flex h-full w-full justify-center p-4">
          <p className="text-13 text-tertiary">You are not authorized to access this page.</p>
        </div>
      </>
    );

  if (!currentWebhook)
    return (
      <div className="grid h-full w-full place-items-center p-4">
        <LogoSpinner />
      </div>
    );

  return (
    <SettingsContentWrapper header={<ProjectWebhookDetailsHeader />}>
      <PageHead title={pageTitle} />
      <DeleteProjectWebhookModal isOpen={deleteWebhookModal} onClose={() => setDeleteWebhookModal(false)} />
      <div className="w-full space-y-8 overflow-y-auto">
        <div>
          <WebhookForm
            onSubmit={handleUpdateWebhook}
            data={currentWebhook}
            showProjectScope={false}
            stateTriggerProjectId={projectId?.toString()}
          />
        </div>
        <WebhookDeleteSection openDeleteModal={() => setDeleteWebhookModal(true)} />
      </div>
    </SettingsContentWrapper>
  );
}

export default observer(ProjectWebhookDetailsPage);
