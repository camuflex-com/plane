/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { cn } from "@plane/utils";

type Props = {
  className?: string;
};

export function BulkOperationsUpgradeBanner(props: Props) {
  const { className } = props;

  return (
    <div className={cn("sticky bottom-0 left-0 z-[2] grid h-20 place-items-center px-3.5", className)}>
      <div className="flex h-14 w-full items-center justify-between gap-2 rounded-md border-[0.5px] border-accent-strong/50 bg-accent-primary/10 px-3.5 py-4">
        <p className="font-medium text-accent-primary">
          Change state, priority, and more for several work items at once. Save three minutes on an average per
          operation.
        </p>
      </div>
    </div>
  );
}
