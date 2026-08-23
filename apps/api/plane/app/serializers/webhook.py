# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import logging
from urllib.parse import urlparse

# Third party imports
from rest_framework import serializers

# Django imports
from django.conf import settings

# Module imports
from .base import DynamicBaseSerializer
from plane.db.models import Project, ProjectWebhook, Webhook, WebhookLog
from plane.db.models.webhook import validate_domain, validate_schema
from plane.utils.ip_address import validate_url

logger = logging.getLogger(__name__)


class WebhookSerializer(DynamicBaseSerializer):
    url = serializers.URLField(validators=[validate_schema, validate_domain])

    # Empty list (or omitted) means workspace-wide: the webhook fires for every
    # project. That's the behaviour webhooks had before scoping existed, so
    # existing rows keep working without migration.
    project_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        write_only=True,
    )
    projects = serializers.SerializerMethodField(read_only=True)

    def get_projects(self, obj):
        return [str(pk) for pk in obj.project_webhooks.values_list("project_id", flat=True)]

    def validate_project_ids(self, value):
        """Reject projects that don't belong to this webhook's workspace."""
        if not value:
            return value

        workspace_id = self.context.get("workspace_id") or getattr(self.instance, "workspace_id", None)
        if workspace_id is None:
            return value

        unique_ids = list(dict.fromkeys(value))
        found = set(
            Project.objects.filter(workspace_id=workspace_id, pk__in=unique_ids).values_list("pk", flat=True)
        )
        missing = [str(pk) for pk in unique_ids if pk not in found]
        if missing:
            raise serializers.ValidationError(f"Projects not found in this workspace: {', '.join(missing)}")
        return unique_ids

    def _sync_project_scope(self, webhook, project_ids):
        """Replace the webhook's project scope with exactly `project_ids`."""
        desired = {str(pk) for pk in project_ids}
        existing = {str(pk) for pk in webhook.project_webhooks.values_list("project_id", flat=True)}

        removed = existing - desired
        if removed:
            webhook.project_webhooks.filter(project_id__in=removed).delete()

        added = desired - existing
        if added:
            ProjectWebhook.objects.bulk_create(
                [
                    ProjectWebhook(webhook=webhook, project_id=pk, workspace_id=webhook.workspace_id)
                    for pk in added
                ],
                batch_size=100,
                ignore_conflicts=True,
            )

    def _validate_webhook_url(self, url):
        """Validate a webhook URL against SSRF and disallowed domain rules."""
        try:
            validate_url(
                url,
                allowed_ips=settings.WEBHOOK_ALLOWED_IPS,
                allowed_hosts=settings.WEBHOOK_ALLOWED_HOSTS,
            )
        except ValueError as e:
            logger.warning("Webhook URL validation failed for %s: %s", url, e)
            raise serializers.ValidationError({"url": "Invalid or disallowed webhook URL."})

        hostname = (urlparse(url).hostname or "").rstrip(".").lower()

        # Hosts explicitly trusted via WEBHOOK_ALLOWED_HOSTS bypass the
        # disallowed-domain check — they're already trusted for SSRF, so
        # the loop-back guard would only get in the way of legitimate
        # sibling services that share a parent domain with Plane.
        if hostname in settings.WEBHOOK_ALLOWED_HOSTS:
            return

        request = self.context.get("request")
        disallowed_domains = list(settings.WEBHOOK_DISALLOWED_DOMAINS)
        if request:
            request_host = request.get_host().split(":")[0].rstrip(".").lower()
            disallowed_domains.append(request_host)

        if any(hostname == domain or hostname.endswith("." + domain) for domain in disallowed_domains):
            raise serializers.ValidationError({"url": "URL domain or its subdomain is not allowed."})

    def create(self, validated_data):
        project_ids = validated_data.pop("project_ids", None)
        url = validated_data.get("url", None)
        self._validate_webhook_url(url)
        webhook = Webhook.objects.create(**validated_data)
        if project_ids:
            self._sync_project_scope(webhook, project_ids)
        return webhook

    def update(self, instance, validated_data):
        # `None` means the caller didn't mention scope, so leave it alone;
        # an empty list explicitly widens the webhook back to workspace-wide.
        project_ids = validated_data.pop("project_ids", None)
        url = validated_data.get("url", None)
        if url:
            self._validate_webhook_url(url)
        webhook = super().update(instance, validated_data)
        if project_ids is not None:
            self._sync_project_scope(webhook, project_ids)
        return webhook

    class Meta:
        model = Webhook
        fields = "__all__"
        read_only_fields = ["workspace", "secret_key", "deleted_at"]


class WebhookLogSerializer(DynamicBaseSerializer):
    class Meta:
        model = WebhookLog
        fields = "__all__"
        read_only_fields = ["workspace", "webhook"]
