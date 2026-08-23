/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import type { Control } from "react-hook-form";
import { Controller } from "react-hook-form";
import type { IWebhook } from "@plane/types";
import { Checkbox } from "@plane/ui";
// hooks
import { useProject } from "@/hooks/store/use-project";

type Props = {
  control: Control<IWebhook, any>;
};

/**
 * Restricts a workspace webhook to a subset of projects.
 *
 * Selecting nothing keeps the webhook workspace-wide, which is what every
 * webhook created before scoping existed does — so the safe default is also
 * the backward-compatible one.
 */
export const WebhookProjectScope = observer(function WebhookProjectScope({ control }: Props) {
  const { joinedProjectIds, getProjectById } = useProject();

  if (joinedProjectIds.length === 0) return null;

  return (
    <Controller
      control={control}
      name="project_ids"
      render={({ field: { onChange, value } }) => {
        const selected: string[] = value ?? [];

        const toggle = (projectId: string) => {
          if (selected.includes(projectId)) {
            onChange(selected.filter((id) => id !== projectId));
          } else {
            onChange([...selected, projectId]);
          }
        };

        return (
          <div className="space-y-3">
            <div>
              <h6 className="text-13 font-medium">Projects</h6>
              <p className="text-11 text-tertiary">
                {selected.length === 0
                  ? "Firing for every project in this workspace. Pick projects to narrow it down."
                  : `Firing only for ${selected.length} selected project${selected.length === 1 ? "" : "s"}.`}
              </p>
            </div>
            <div className="max-h-40 space-y-2 overflow-y-auto rounded border border-subtle p-3">
              {joinedProjectIds.map((projectId) => {
                const project = getProjectById(projectId);
                if (!project) return null;
                return (
                  <div key={projectId} className="flex items-center gap-2">
                    <Checkbox
                      id={`webhook-project-${projectId}`}
                      onChange={() => toggle(projectId)}
                      checked={selected.includes(projectId)}
                    />
                    <label className="truncate text-13" htmlFor={`webhook-project-${projectId}`}>
                      {project.name}
                    </label>
                  </div>
                );
              })}
            </div>
            {selected.length > 0 && (
              <button type="button" className="text-11 text-tertiary underline" onClick={() => onChange([])}>
                Clear selection (fire for all projects)
              </button>
            )}
          </div>
        );
      }}
    />
  );
});
