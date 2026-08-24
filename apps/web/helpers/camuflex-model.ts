/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export type TCursorModelSelection = { id: string; params: string };

const MARKER_P_RE = /<p>\s*\[camuflex-model [^\]]+\]\s*<\/p>/gi;

export function injectModelMarkerHtml(html: string, selection: TCursorModelSelection): string {
  const params = selection.params.trim();
  const marker = params ? `[camuflex-model ${selection.id} ${params}]` : `[camuflex-model ${selection.id}]`;
  const cleaned = (html || "<p></p>").replace(MARKER_P_RE, "");
  return `${cleaned}<p>${marker}</p>`;
}
