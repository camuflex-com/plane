/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
import { CustomMenu } from "@plane/ui";
import { AutomationService, type TCursorModelOption } from "@/services/automation.service";

const automationService = new AutomationService();

const FALLBACK: TCursorModelOption = {
  id: "grok-4.6",
  params: "effort=high,fast=true",
  label: "Grok 4.6 · high · fast",
  isDefault: true,
};

type Props = {
  projectId: string | null;
  value: TCursorModelOption | null;
  onChange: (value: TCursorModelOption) => void;
};

export const CursorModelSelect = observer(function CursorModelSelect(props: Props) {
  const { projectId, value, onChange } = props;

  const { data } = useSWR(
    projectId ? `AUTOMATION_MODELS_${projectId}` : null,
    projectId ? () => automationService.fetchModels(projectId) : null,
    { revalidateOnFocus: false }
  );

  const enabled = data?.enabled === true;
  const options = data?.options?.length ? data.options : [FALLBACK];
  const selected = value ?? options.find((option) => option.isDefault) ?? options[0];

  useEffect(() => {
    if (!enabled || !selected) return;
    if (value && value.id === selected.id && value.params === selected.params) return;
    onChange(selected);
    // Solo sincroniza el default cuando llega el catálogo o cambia el proyecto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectId, selected.id, selected.params]);

  if (!projectId || !enabled) return null;

  return (
    <div className="h-7">
      <CustomMenu
        customButton={
          <button
            type="button"
            className="flex h-full max-w-64 cursor-pointer items-center justify-between gap-1 rounded-sm border-[0.5px] border-strong px-2 py-0.5 text-caption-sm-regular hover:bg-layer-1"
          >
            <span className="truncate">{selected.label}</span>
          </button>
        }
        placement="bottom-start"
        className="h-full"
        customButtonClassName="h-full"
        maxHeight="lg"
      >
        {options.map((option) => (
          <CustomMenu.MenuItem
            key={`${option.id}|${option.params}`}
            className="!p-1"
            onClick={() => onChange(option)}
          >
            {option.label}
          </CustomMenu.MenuItem>
        ))}
      </CustomMenu>
    </div>
  );
});
