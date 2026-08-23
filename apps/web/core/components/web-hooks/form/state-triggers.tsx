/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useParams } from "next/navigation";
import { observer } from "mobx-react";
import type { Control } from "react-hook-form";
import { Controller } from "react-hook-form";
import useSWR from "swr";
import type { IWebhook } from "@plane/types";
import { Checkbox } from "@plane/ui";
// hooks
import { useProjectState } from "@/hooks/store/use-project-state";

type Props = {
  control: Control<IWebhook, any>;
  projectId: string;
};

/**
 * Narrows a webhook to specific state transitions.
 *
 * Selection is by state and not by state group on purpose: "In Progress" and
 * "In Review" both live in the `started` group, so grouping would make them
 * indistinguishable — which is precisely what this is for.
 */
export const WebhookStateTriggers = observer(function WebhookStateTriggers({ control, projectId }: Props) {
  const { workspaceSlug } = useParams();
  const { getProjectStates, fetchProjectStates } = useProjectState();

  // Los settings de proyecto no siempre pasan por el wrapper que precarga los
  // estados, así que el componente se los trae si no están.
  const states = getProjectStates(projectId);
  useSWR(
    workspaceSlug && projectId && !states ? `WEBHOOK_TRIGGER_STATES_${workspaceSlug}_${projectId}` : null,
    workspaceSlug && projectId && !states ? () => fetchProjectStates(workspaceSlug.toString(), projectId) : null
  );

  if (!states || states.length === 0) return null;

  return (
    <Controller
      control={control}
      name="state_ids"
      render={({ field: { onChange, value } }) => {
        const selected: string[] = value ?? [];

        const toggle = (stateId: string) => {
          if (selected.includes(stateId)) onChange(selected.filter((id) => id !== stateId));
          else onChange([...selected, stateId]);
        };

        return (
          <div className="space-y-3">
            <div>
              <h6 className="text-13 font-medium">Fire on entering a state</h6>
              <p className="text-11 text-tertiary">
                {selected.length === 0
                  ? "Firing on every selected event. Pick states to fire only when a work item moves into them."
                  : `Firing only when a work item moves into ${selected.length} selected state${
                      selected.length === 1 ? "" : "s"
                    } — other work item changes stop firing.`}
              </p>
            </div>
            <div className="max-h-40 space-y-2 overflow-y-auto rounded border border-subtle p-3">
              {states.map((state) => (
                <div key={state.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`webhook-state-${state.id}`}
                    onChange={() => toggle(state.id)}
                    checked={selected.includes(state.id)}
                  />
                  <label className="flex items-center gap-2 truncate text-13" htmlFor={`webhook-state-${state.id}`}>
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: state.color }}
                      aria-hidden="true"
                    />
                    {state.name}
                  </label>
                </div>
              ))}
            </div>
            {selected.length > 0 && (
              <button type="button" className="text-11 text-tertiary underline" onClick={() => onChange([])}>
                Clear selection (fire on all events)
              </button>
            )}
          </div>
        );
      }}
    />
  );
});
