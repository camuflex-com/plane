/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { observer } from "mobx-react";
// plane imports
import { PROJECT_SETTINGS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs } from "@plane/ui";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { PROJECT_SETTINGS_ICONS } from "@/components/settings/project/sidebar/item-icon";

export const ProjectWebhookDetailsHeader = observer(function ProjectWebhookDetailsHeader() {
  const { t } = useTranslation();
  const { workspaceSlug, projectId } = useParams();
  const settingsDetails = PROJECT_SETTINGS.webhooks;
  const Icon = PROJECT_SETTINGS_ICONS.webhooks;

  return (
    <SettingsPageHeader
      leftItem={
        <div className="flex items-center gap-2">
          <Breadcrumbs>
            <Breadcrumbs.Item
              component={
                <Link href={`/${workspaceSlug}/settings/projects/${projectId}/webhooks/`}>
                  <BreadcrumbLink
                    label={t(settingsDetails.i18n_label)}
                    icon={<Icon className="size-4 text-tertiary" />}
                  />
                </Link>
              }
            />
            <Breadcrumbs.Item component={<BreadcrumbLink label="Webhook" />} />
          </Breadcrumbs>
        </div>
      }
    />
  );
});
