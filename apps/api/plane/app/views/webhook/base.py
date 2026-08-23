# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.db import IntegrityError

# Third party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.db.models import ProjectWebhook, Webhook, WebhookLog, Workspace
from plane.db.models.webhook import generate_token
from ..base import BaseAPIView
from plane.app.permissions import allow_permission, ROLE
from plane.app.serializers import WebhookSerializer, WebhookLogSerializer


class WebhookEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        try:
            serializer = WebhookSerializer(
                data=request.data,
                context={"request": request, "workspace_id": workspace.id},
            )
            if serializer.is_valid():
                serializer.save(workspace_id=workspace.id)
                return Response(serializer.data, status=status.HTTP_201_CREATED)
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        except IntegrityError as e:
            if "already exists" in str(e):
                return Response(
                    {"error": "URL already exists for the workspace"},
                    status=status.HTTP_409_CONFLICT,
                )
            raise IntegrityError

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, pk=None):
        if pk is None:
            webhooks = Webhook.objects.filter(workspace__slug=slug)
            serializer = WebhookSerializer(
                webhooks,
                fields=(
                    "id",
                    "url",
                    "is_active",
                    "created_at",
                    "updated_at",
                    "project",
                    "issue",
                    "cycle",
                    "module",
                    "issue_comment",
                    "projects",
                "states",
                    "states",
                ),
                many=True,
            )
            return Response(serializer.data, status=status.HTTP_200_OK)
        else:
            webhook = Webhook.objects.get(workspace__slug=slug, pk=pk)
            serializer = WebhookSerializer(
                webhook,
                fields=(
                    "id",
                    "url",
                    "is_active",
                    "created_at",
                    "updated_at",
                    "project",
                    "issue",
                    "cycle",
                    "module",
                    "issue_comment",
                    "projects",
                    "states",
                ),
            )
            return Response(serializer.data, status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, pk):
        webhook = Webhook.objects.get(workspace__slug=slug, pk=pk)
        serializer = WebhookSerializer(
            webhook,
            data=request.data,
            context={"request": request, "workspace_id": webhook.workspace_id},
            partial=True,
            fields=(
                "id",
                "url",
                "is_active",
                "created_at",
                "updated_at",
                "project",
                "issue",
                "cycle",
                "module",
                "issue_comment",
                "projects",
            ),
        )
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_200_OK)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, pk):
        webhook = Webhook.objects.get(pk=pk, workspace__slug=slug)
        webhook.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class WebhookSecretRegenerateEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, pk):
        webhook = Webhook.objects.get(workspace__slug=slug, pk=pk)
        webhook.secret_key = generate_token()
        webhook.save()
        serializer = WebhookSerializer(webhook)
        return Response(serializer.data, status=status.HTTP_200_OK)


class WebhookLogsEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, webhook_id):
        webhook_logs = WebhookLog.objects.filter(workspace__slug=slug, webhook=webhook_id)
        serializer = WebhookLogSerializer(webhook_logs, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)


# Fields returned for project-scoped webhooks. `projects` is omitted on
# purpose: inside a project these are always scoped to that one project.
# `project` (el evento de ciclo de vida del proyecto) queda fuera a propósito:
# un webhook creado dentro de un proyecto no puede emitir "project created"
# —el proyecto ya existe— y el resto del ciclo de vida es del workspace.
PROJECT_WEBHOOK_FIELDS = (
    "id",
    "url",
    "is_active",
    "created_at",
    "updated_at",
    "issue",
    "cycle",
    "module",
    "issue_comment",
    "states",
)


def project_webhook_queryset(slug, project_id):
    """
    Webhooks a project admin may manage: those scoped to this project and to
    no other.

    A webhook shared with sibling projects is deliberately excluded — editing
    or deleting it would silently change behaviour for projects the caller
    doesn't administer. Those stay a workspace-admin concern, as do
    workspace-wide webhooks, which have no scope rows at all.
    """
    owned_ids = ProjectWebhook.objects.filter(project_id=project_id).values_list("webhook_id", flat=True)
    shared_ids = (
        ProjectWebhook.objects.filter(webhook_id__in=owned_ids)
        .exclude(project_id=project_id)
        .values_list("webhook_id", flat=True)
    )
    return Webhook.objects.filter(workspace__slug=slug, pk__in=owned_ids).exclude(pk__in=shared_ids)


class ProjectWebhookEndpoint(BaseAPIView):
    """Webhooks managed from within a single project's settings."""

    @allow_permission(allowed_roles=[ROLE.ADMIN])
    def post(self, request, slug, project_id):
        workspace = Workspace.objects.get(slug=slug)
        try:
            # The scope is the URL's project, never whatever the body claims.
            data = {k: v for k, v in request.data.items() if k != "project_ids"}
            data["project_ids"] = [str(project_id)]
            # Y los eventos de ciclo de vida del proyecto no se emiten desde
            # aquí, aunque el cliente los pida.
            data["project"] = False

            serializer = WebhookSerializer(
                data=data,
                context={"request": request, "workspace_id": workspace.id, "project_id": project_id},
            )
            if serializer.is_valid():
                serializer.save(workspace_id=workspace.id)
                return Response(serializer.data, status=status.HTTP_201_CREATED)
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        except IntegrityError as e:
            if "already exists" in str(e):
                return Response(
                    {"error": "URL already exists for the workspace"},
                    status=status.HTTP_409_CONFLICT,
                )
            raise

    @allow_permission(allowed_roles=[ROLE.ADMIN])
    def get(self, request, slug, project_id, pk=None):
        queryset = project_webhook_queryset(slug, project_id)

        if pk is None:
            serializer = WebhookSerializer(queryset, fields=PROJECT_WEBHOOK_FIELDS, many=True)
            return Response(serializer.data, status=status.HTTP_200_OK)

        webhook = queryset.filter(pk=pk).first()
        if webhook is None:
            return Response({"error": "Webhook not found"}, status=status.HTTP_404_NOT_FOUND)
        serializer = WebhookSerializer(webhook, fields=PROJECT_WEBHOOK_FIELDS)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN])
    def patch(self, request, slug, project_id, pk):
        webhook = project_webhook_queryset(slug, project_id).filter(pk=pk).first()
        if webhook is None:
            return Response({"error": "Webhook not found"}, status=status.HTTP_404_NOT_FOUND)

        # Scope is fixed by the URL: a project admin can't re-point a webhook
        # at other projects from here, ni activar los eventos de proyecto.
        data = {k: v for k, v in request.data.items() if k != "project_ids"}
        data["project"] = False

        serializer = WebhookSerializer(
            webhook,
            data=data,
            context={"request": request, "workspace_id": webhook.workspace_id, "project_id": project_id},
            partial=True,
            fields=PROJECT_WEBHOOK_FIELDS,
        )
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_200_OK)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @allow_permission(allowed_roles=[ROLE.ADMIN])
    def delete(self, request, slug, project_id, pk):
        webhook = project_webhook_queryset(slug, project_id).filter(pk=pk).first()
        if webhook is None:
            return Response({"error": "Webhook not found"}, status=status.HTTP_404_NOT_FOUND)
        webhook.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ProjectWebhookSecretRegenerateEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN])
    def post(self, request, slug, project_id, pk):
        webhook = project_webhook_queryset(slug, project_id).filter(pk=pk).first()
        if webhook is None:
            return Response({"error": "Webhook not found"}, status=status.HTTP_404_NOT_FOUND)
        webhook.secret_key = generate_token()
        webhook.save()
        serializer = WebhookSerializer(webhook)
        return Response(serializer.data, status=status.HTTP_200_OK)


class ProjectWebhookLogsEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN])
    def get(self, request, slug, project_id, webhook_id):
        # Scope the lookup first so a project admin can't read the delivery
        # logs — request and response bodies included — of a webhook that
        # isn't theirs.
        if not project_webhook_queryset(slug, project_id).filter(pk=webhook_id).exists():
            return Response({"error": "Webhook not found"}, status=status.HTTP_404_NOT_FOUND)

        webhook_logs = WebhookLog.objects.filter(workspace__slug=slug, webhook=webhook_id)
        serializer = WebhookLogSerializer(webhook_logs, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)
