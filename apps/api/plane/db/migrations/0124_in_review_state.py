# Añade el estado "In Review" a los proyectos que ya existen.
#
# DEFAULT_STATES solo se aplica al crear un proyecto, así que sin esto los
# proyectos anteriores se quedarían sin el estado.

from django.db import migrations


IN_REVIEW = {
    "name": "In Review",
    "slug": "in-review",
    "color": "#3B82F6",
    "sequence": 40000,
    "group": "started",
}


def add_in_review_state(apps, schema_editor):
    Project = apps.get_model("db", "Project")
    State = apps.get_model("db", "State")

    # Saltar los proyectos que ya tengan un estado con ese nombre: la
    # restricción unique (name, project) haría fallar la inserción, y puede
    # que alguien ya lo creara a mano.
    already_have = set(
        State.objects.filter(name=IN_REVIEW["name"], deleted_at__isnull=True).values_list("project_id", flat=True)
    )

    pending = Project.objects.filter(deleted_at__isnull=True).exclude(pk__in=already_have)

    # bulk_create y no save(): State.save() recalcula `sequence` a partir del
    # máximo del proyecto, lo que dejaría "In Review" al final de la lista en
    # vez de entre "In Progress" (35000) y "Done" (45000).
    State.objects.bulk_create(
        [
            State(
                name=IN_REVIEW["name"],
                slug=IN_REVIEW["slug"],
                color=IN_REVIEW["color"],
                sequence=IN_REVIEW["sequence"],
                group=IN_REVIEW["group"],
                description="",
                is_triage=False,
                default=False,
                project_id=project.id,
                workspace_id=project.workspace_id,
            )
            for project in pending.iterator(chunk_size=500)
        ],
        batch_size=500,
        ignore_conflicts=True,
    )


def remove_in_review_state(apps, schema_editor):
    """
    Solo elimina los "In Review" que nadie esté usando.

    Borrar uno con issues dentro los dejaría huérfanos o los arrastraría por
    el CASCADE, así que revertir es deliberadamente parcial: se limpia lo que
    no cuesta nada y se deja en pie lo que tiene datos.
    """
    State = apps.get_model("db", "State")
    Issue = apps.get_model("db", "Issue")

    in_use = set(Issue.objects.filter(state__name=IN_REVIEW["name"]).values_list("state_id", flat=True))
    State.objects.filter(name=IN_REVIEW["name"], group=IN_REVIEW["group"]).exclude(pk__in=in_use).delete()


class Migration(migrations.Migration):
    dependencies = [("db", "0123_webhook_states")]

    operations = [migrations.RunPython(add_in_review_state, remove_in_review_state)]
