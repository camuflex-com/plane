/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { Controller, useForm } from "react-hook-form";
import { WORKSPACE_SETTINGS_TRACKER_ELEMENTS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { IWebhook, TWebhookEventTypes } from "@plane/types";
// hooks
import {
  webhookEventOptionsFor,
  WebhookIndividualEventOptions,
  WebhookInput,
  WebhookOptions,
  WebhookProjectScope,
  WebhookSecretKey,
  WebhookStateTriggers,
  WebhookToggle,
} from "@/components/web-hooks";
import { useWebhook } from "@/hooks/store/use-webhook";
// components
// ui
// types

type Props = {
  data?: Partial<IWebhook>;
  onSubmit: (data: IWebhook, webhookEventType: TWebhookEventTypes) => Promise<void>;
  handleClose?: () => void;
  /**
   * Which settings screen this form lives in. Drives three differences:
   * the project scope picker (workspace only), the event list (project
   * lifecycle is workspace-only) and what "send me everything" means.
   */
  scope?: "workspace" | "project";
  /**
   * When set, shows the state-transition picker for that project's states.
   * Only meaningful inside a project, where the states are unambiguous.
   */
  stateTriggerProjectId?: string;
};

const initialWebhookPayload: Partial<IWebhook> = {
  cycle: true,
  issue: true,
  issue_comment: true,
  module: true,
  project: true,
  url: "",
};

export const WebhookForm = observer(function WebhookForm(props: Props) {
  const { data, onSubmit, handleClose, scope = "workspace", stateTriggerProjectId } = props;
  // Los eventos que esta pantalla ofrece de verdad; el resto no se toca.
  const eventKeys = webhookEventOptionsFor(scope).map((option) => option.key);
  // states
  const [webhookEventType, setWebhookEventType] = useState<TWebhookEventTypes>("all");
  // store hooks
  const { webhookSecretKey } = useWebhook();
  const { t } = useTranslation();
  // use form
  const {
    handleSubmit,
    control,
    formState: { isSubmitting, errors },
  } = useForm<IWebhook>({
    // `projects` is what the API returns; `project_ids` is what it accepts.
    defaultValues: {
      ...initialWebhookPayload,
      // Un webhook de proyecto nunca emite eventos de proyecto.
      ...(scope === "project" ? { project: false } : {}),
      ...data,
      // `projects`/`states` are what the API returns; the `_ids` variants are
      // what it accepts.
      project_ids: data?.projects ?? [],
      state_ids: data?.states ?? [],
    },
  });

  const handleFormSubmit = async (formData: IWebhook) => {
    await onSubmit(formData, webhookEventType);
  };

  useEffect(() => {
    if (!data) return;

    // "Todo" significa todos los eventos de ESTA pantalla, no los cinco
    // siempre: en un proyecto, `project` no está sobre la mesa.
    if (eventKeys.every((key) => data[key])) setWebhookEventType("all");
    else setWebhookEventType("individual");
  }, [data, eventKeys]);

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)}>
      <div className="space-y-5">
        <div className="text-18 font-medium text-secondary">
          {data
            ? t("workspace_settings.settings.webhooks.modal.details")
            : t("workspace_settings.settings.webhooks.modal.title")}
        </div>
        <div className="space-y-3">
          <div className="space-y-1">
            <Controller
              control={control}
              name="url"
              rules={{
                required: t("workspace_settings.settings.webhooks.modal.error"),
              }}
              render={({ field: { onChange, value } }) => (
                <WebhookInput value={value} onChange={onChange} hasError={Boolean(errors.url)} />
              )}
            />
            {errors.url && <div className="text-11 text-danger-primary">{errors.url.message}</div>}
          </div>
          {data && <WebhookToggle control={control} />}
          {scope === "workspace" && <WebhookProjectScope control={control} />}
          <WebhookOptions value={webhookEventType} onChange={(val) => setWebhookEventType(val)} />
        </div>
        <div className="mt-4 space-y-5">
          {webhookEventType === "individual" && <WebhookIndividualEventOptions control={control} scope={scope} />}
          {stateTriggerProjectId && <WebhookStateTriggers control={control} projectId={stateTriggerProjectId} />}
        </div>
      </div>
      {data ? (
        <div className="space-y-5 pt-0">
          <WebhookSecretKey data={data} />
          <Button
            size="lg"
            type="submit"
            loading={isSubmitting}
            data-ph-element={WORKSPACE_SETTINGS_TRACKER_ELEMENTS.WEBHOOK_UPDATE_BUTTON}
          >
            {isSubmitting ? t("updating") : t("update")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-subtle px-5 py-4">
          <Button variant="secondary" size="lg" onClick={handleClose}>
            {t("cancel")}
          </Button>
          {!webhookSecretKey && (
            <Button type="submit" variant="primary" size="lg" loading={isSubmitting} className="capitalize">
              {isSubmitting ? t("common.creating") : t("common.create")}
            </Button>
          )}
        </div>
      )}
    </form>
  );
});
