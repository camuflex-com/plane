# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.app.views import (
    ProjectWebhookEndpoint,
    ProjectWebhookLogsEndpoint,
    ProjectWebhookSecretRegenerateEndpoint,
    WebhookEndpoint,
    WebhookLogsEndpoint,
    WebhookSecretRegenerateEndpoint,
)


urlpatterns = [
    path("workspaces/<str:slug>/webhooks/", WebhookEndpoint.as_view(), name="webhooks"),
    path(
        "workspaces/<str:slug>/webhooks/<uuid:pk>/",
        WebhookEndpoint.as_view(),
        name="webhooks",
    ),
    path(
        "workspaces/<str:slug>/webhooks/<uuid:pk>/regenerate/",
        WebhookSecretRegenerateEndpoint.as_view(),
        name="webhooks",
    ),
    path(
        "workspaces/<str:slug>/webhook-logs/<uuid:webhook_id>/",
        WebhookLogsEndpoint.as_view(),
        name="webhooks",
    ),
    # Project-scoped webhooks: same shape as the workspace routes, but the
    # project in the path is the scope and a project admin is enough.
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/webhooks/",
        ProjectWebhookEndpoint.as_view(),
        name="project-webhooks",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/webhooks/<uuid:pk>/",
        ProjectWebhookEndpoint.as_view(),
        name="project-webhooks",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/webhooks/<uuid:pk>/regenerate/",
        ProjectWebhookSecretRegenerateEndpoint.as_view(),
        name="project-webhooks",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/webhook-logs/<uuid:webhook_id>/",
        ProjectWebhookLogsEndpoint.as_view(),
        name="project-webhooks",
    ),
]
