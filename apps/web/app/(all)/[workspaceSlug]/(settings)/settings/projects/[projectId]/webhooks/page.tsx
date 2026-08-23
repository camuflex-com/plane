/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { observer } from "mobx-react";
import useSWR from "swr";
// plane imports
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EmptyStateCompact } from "@plane/propel/empty-state";
import type { IWebhook } from "@plane/types";
// components
import { NotAuthorizedView } from "@/components/auth-screens/not-authorized-view";
import { PageHead } from "@/components/core/page-title";
import { SettingsContentWrapper } from "@/components/settings/content-wrapper";
import { SettingsHeading } from "@/components/settings/heading";
import { WebhookSettingsLoader } from "@/components/ui/loader/settings/web-hook";
import { CreateWebhookModal, ProjectWebhooksList } from "@/components/web-hooks";
// hooks
import { useProject } from "@/hooks/store/use-project";
import { useProjectWebhook } from "@/hooks/store/use-project-webhook";
import { useUserPermissions } from "@/hooks/store/user";
import { useWorkspace } from "@/hooks/store/use-workspace";
// local imports
import { WebhooksProjectSettingsHeader } from "./header";

function ProjectWebhooksListPage() {
  // states
  const [showCreateWebhookModal, setShowCreateWebhookModal] = useState(false);
  // router
  const { workspaceSlug, projectId } = useParams();
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const { workspaceUserInfo, allowPermissions } = useUserPermissions();
  const { fetchWebhooks, webhooks, clearSecretKey, webhookSecretKey, createWebhook } = useProjectWebhook();
  const { currentProjectDetails } = useProject();
  const { currentWorkspace } = useWorkspace();
  // derived values
  const canPerformProjectAdminActions = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.PROJECT);

  useSWR(
    canPerformProjectAdminActions && workspaceSlug && projectId
      ? `PROJECT_WEBHOOKS_LIST_${workspaceSlug}_${projectId}`
      : null,
    canPerformProjectAdminActions && workspaceSlug && projectId
      ? () => fetchWebhooks(workspaceSlug.toString(), projectId.toString())
      : null
  );

  // The shared modal is workspace-shaped; bind the project into it so the
  // project's own endpoint is the one that gets called.
  const handleCreate = useCallback(
    async (slug: string, data: Partial<IWebhook>) => createWebhook(slug, projectId!.toString(), data),
    [createWebhook, projectId]
  );

  const pageTitle = currentProjectDetails?.name
    ? `${currentProjectDetails.name} - ${t("workspace_settings.settings.webhooks.title")}`
    : undefined;

  useEffect(() => {
    if (!showCreateWebhookModal && webhookSecretKey) clearSecretKey();
  }, [showCreateWebhookModal, webhookSecretKey, clearSecretKey]);

  if (workspaceUserInfo && !canPerformProjectAdminActions) {
    return <NotAuthorizedView section="settings" isProjectView className="h-auto" />;
  }

  if (!webhooks) return <WebhookSettingsLoader />;

  return (
    <SettingsContentWrapper header={<WebhooksProjectSettingsHeader />}>
      <PageHead title={pageTitle} />
      <div className="w-full">
        <CreateWebhookModal
          createWebhook={handleCreate}
          clearSecretKey={clearSecretKey}
          currentWorkspace={currentWorkspace}
          isOpen={showCreateWebhookModal}
          onClose={() => setShowCreateWebhookModal(false)}
          showProjectScope={false}
          stateTriggerProjectId={projectId?.toString()}
        />
        <SettingsHeading
          title={t("workspace_settings.settings.webhooks.title")}
          description="Webhooks that fire only for events in this project."
          control={
            <Button variant="primary" size="lg" onClick={() => setShowCreateWebhookModal(true)}>
              {t("workspace_settings.settings.webhooks.add_webhook")}
            </Button>
          }
        />
        {Object.keys(webhooks).length > 0 ? (
          <div className="mt-4">
            <ProjectWebhooksList />
          </div>
        ) : (
          <div className="flex h-full w-full flex-col">
            <div className="flex h-full w-full items-center justify-center">
              <EmptyStateCompact
                assetKey="webhook"
                title={t("settings_empty_state.webhooks.title")}
                description={t("settings_empty_state.webhooks.description")}
                actions={[
                  {
                    label: t("settings_empty_state.webhooks.cta_primary"),
                    onClick: () => setShowCreateWebhookModal(true),
                  },
                ]}
                align="start"
                rootClassName="py-20"
              />
            </div>
          </div>
        )}
      </div>
    </SettingsContentWrapper>
  );
}

export default observer(ProjectWebhooksListPage);
