/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { observer } from "mobx-react";
// plane imports
import type { IWebhook } from "@plane/types";
import { ToggleSwitch } from "@plane/ui";
// hooks
import { useProjectWebhook } from "@/hooks/store/use-project-webhook";

function ProjectWebhooksListItem({ webhook }: { webhook: IWebhook }) {
  const { workspaceSlug, projectId } = useParams();
  const { updateWebhook } = useProjectWebhook();

  const handleToggle = async () => {
    if (!workspaceSlug || !projectId || !webhook.id) return;
    await updateWebhook(workspaceSlug.toString(), projectId.toString(), webhook.id, {
      is_active: !webhook.is_active,
    });
  };

  return (
    <div className="rounded-lg border border-subtle bg-layer-2 px-4 py-3">
      <Link
        href={`/${workspaceSlug}/settings/projects/${projectId}/webhooks/${webhook?.id}`}
        className="flex items-center justify-between gap-4"
      >
        <h5 className="truncate text-body-sm-medium">{webhook.url}</h5>
        <div className="shrink-0">
          <ToggleSwitch value={webhook.is_active} onChange={handleToggle} />
        </div>
      </Link>
    </div>
  );
}

export const ProjectWebhooksList = observer(function ProjectWebhooksList() {
  const { webhooks } = useProjectWebhook();

  return (
    <div className="flex size-full flex-col gap-y-2 overflow-y-auto rounded-lg border border-subtle bg-layer-1 p-3">
      {Object.values(webhooks ?? {}).map((webhook) => (
        <ProjectWebhooksListItem key={webhook.id} webhook={webhook} />
      ))}
    </div>
  );
});
