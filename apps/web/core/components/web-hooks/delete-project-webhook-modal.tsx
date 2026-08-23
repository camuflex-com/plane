/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { useParams } from "next/navigation";
// ui
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { AlertModalCore } from "@plane/ui";
// hooks
import { useProjectWebhook } from "@/hooks/store/use-project-webhook";
import { useAppRouter } from "@/hooks/use-app-router";

interface IDeleteProjectWebhook {
  isOpen: boolean;
  onClose: () => void;
}

export function DeleteProjectWebhookModal(props: IDeleteProjectWebhook) {
  const { isOpen, onClose } = props;
  // states
  const [isDeleting, setIsDeleting] = useState(false);
  // router
  const router = useAppRouter();
  // store hooks
  const { removeWebhook } = useProjectWebhook();

  const { workspaceSlug, projectId, webhookId } = useParams();

  const handleDelete = async () => {
    if (!workspaceSlug || !projectId || !webhookId) return;
    setIsDeleting(true);
    try {
      await removeWebhook(workspaceSlug.toString(), projectId.toString(), webhookId.toString());
      router.replace(`/${workspaceSlug}/settings/projects/${projectId}/webhooks/`);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "Success!",
        message: "Webhook deleted successfully.",
      });
    } catch (_error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Error!",
        message: "Webhook could not be deleted. Please try again.",
      });
    }
    setIsDeleting(false);
  };

  return (
    <AlertModalCore
      handleClose={onClose}
      handleSubmit={handleDelete}
      isSubmitting={isDeleting}
      isOpen={isOpen}
      title="Delete webhook"
      content={
        <>
          Are you sure you want to delete this webhook? Future events in this project will not be delivered to it. This
          action cannot be undone.
        </>
      }
    />
  );
}
