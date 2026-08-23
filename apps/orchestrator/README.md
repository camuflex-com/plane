# Orquestador de automatización

Cierra el ciclo **Plane → Cursor → GitHub → Plane**: una persona mueve una issue a _In Progress_ y, si todo va bien, aparece un PR revisado y mergeado con la issue en _Done_.

```
Plane: issue entra a In Progress
   │  webhook firmado → /webhooks/plane
   ▼
orchestrator ── POST /v1/agents (autoCreatePR) ──► Cursor Cloud Agent
   ▲                                                     │
   │  webhook: pull_request.opened  ◄─── PR en GitHub ◄──┘
   │      → issue a In Review, comenta "bugbot run"
   │
   │  webhook: check_run.completed success (Bugbot, sin hallazgos)
   │      → merge → issue a Done
   │  webhook: pull_request_review.submitted (Bugbot, con comentarios)
   │      → issue a In Progress + follow-up al agente
   └───────────────────────────────────────────────────────┘
```

La API v1 de Cursor no emite webhooks, y no hace falta: cuando el agente termina abre un PR, y **GitHub sí avisa**. El sondeo queda solo como red de seguridad para agentes que mueran sin abrir PR ([reconciler.ts](src/reconciler.ts)).

## Prevención de bucles

El orquestador mueve issues, y eso vuelve por el webhook. Sin defensas se realimenta sin fin. Hay tres capas independientes:

1. **Filtro por actor** ([server.ts](src/server.ts)) — se descarta todo evento cuyo `activity.actor.id` sea `PLANE_BOT_USER_ID`.
2. **Deduplicación** — clave primaria sobre `(source, delivery_id)`; Plane y GitHub reintentan las entregas.
3. **Guardas de estado** ([machine.ts](src/machine.ts)) — una run activa ignora nuevos eventos de arranque, y una run terminada no reacciona a nada.

Las tres están cubiertas por tests. Si tocas [machine.ts](src/machine.ts), corre `pnpm test` antes de desplegar: es donde vive el riesgo real de este servicio.

## Configuración

Variables en `orchestrator.env` (validadas al arrancar, ver [env.ts](src/env.ts)):

| Variable                | Para qué                                         |
| ----------------------- | ------------------------------------------------ |
| `DATABASE_URL`          | Base `orchestrator`, creada por `deploy.sh`      |
| `PLANE_API_KEY`         | Mover issues y comentar                          |
| `PLANE_WEBHOOK_SECRET`  | Verificar la firma de Plane                      |
| `PLANE_BOT_USER_ID`     | **Crítico**: el usuario cuyos eventos se ignoran |
| `CURSOR_API_KEY`        | Lanzar agentes                                   |
| `GITHUB_TOKEN`          | Comentar, leer checks y mergear                  |
| `GITHUB_WEBHOOK_SECRET` | Verificar la firma de GitHub                     |

### Dos trampas que rompen el filtro anti-bucle

**El `PLANE_API_KEY` tiene que salir de la cuenta del bot.** Plane atribuye
cada acción al dueño del token ([`APIToken.user`](../api/plane/db/models/api.py)),
y el filtro compara el actor del webhook contra `PLANE_BOT_USER_ID`. Con el
token del admin, las acciones del orquestador se atribuirían al admin, el
filtro no coincidiría nunca y el sistema entraría en bucle infinito.

**`PLANE_BOT_USER_ID` es el id de usuario, no el de la membresía.** En la
respuesta de `/workspace-members/` es `member.id`, no el `id` del objeto que
lo envuelve. Un id equivocado falla en silencio: todo parece funcionar hasta
que el primer movimiento del orquestador se realimenta.

Para el bot actual (`bot@camuflex.com`) el valor es
`eea8b7cb-5ecd-426c-a740-1a64bcfef307`.

## Habilitar un proyecto

Nada ocurre hasta que el proyecto está en `project_config`. Es el interruptor de seguridad.

```sql
INSERT INTO project_config
  (plane_project_id, plane_workspace_slug, github_owner, github_repo, base_branch, enabled, max_attempts)
VALUES
  ('<uuid del proyecto>', 'camuflex', 'camuflex-com', '<repo>', 'main', TRUE, 3);
```

**El bot tiene que ser miembro del proyecto.** La API externa valida con
`ProjectEntityPermission`, que exige una fila en `ProjectMember`: ser admin del
workspace no basta. Sin eso, el orquestador recibe 403 al mover la issue.

### El webhook de Plane

En _Project Settings → Webhooks_ del proyecto:

- **Payload URL**: `http://orchestrator.internal:3100/automation/webhooks/plane`
- **Eventos**: solo **Work items**. El orquestador descarta cualquier otro
  (`payload.event !== "issue"`), así que ciclos, módulos y comentarios solo
  añadirían entregas inútiles.
- **Fire on entering a state**: solo **In Progress**.

El host lleva punto a propósito. Django valida la URL con `URLValidator`, que
**rechaza los hostnames de una sola etiqueta**: con `orchestrator` a secas,
Plane responde `{"url":["Enter a valid URL."]}`. El contenedor tiene el alias
de red `orchestrator.internal` justamente para esto.

Y como resuelve a una IP privada, hace falta además
`WEBHOOK_ALLOWED_HOSTS=orchestrator.internal` en `plane.env` para que no lo
bloquee la protección SSRF. Lo configura `deploy.sh`; el cambio exige reiniciar
la API, porque el valor se lee al cargar los settings.

El estado se verifica además en el servidor contra el payload, no solo por
configuración: si alguien añadiera otro estado al disparador, el orquestador
lo rechaza en vez de lanzar un agente sobre una issue que no toca.

En GitHub, un webhook a `https://plane.camuflex.com/automation/webhooks/github` con los eventos `pull_request`, `pull_request_review` y `check_run`.

### Permisos del `GITHUB_TOKEN`

Fine-grained PAT con _resource owner_ la organización, acotado al repo:

| Permiso       | Nivel          |
| ------------- | -------------- |
| Contents      | Read and write |
| Pull requests | Read and write |
| Metadata      | Read-only      |

No hace falta **Checks**: el veredicto de Bugbot llega como `pull_request_review`
(aprobó o dejó comentarios), y para el resto de la CI se usa `mergeable_state`
del pull request, que cubre "Pull requests: read".

### Autoría de los pull requests

Los agentes se crean con `openAsCursorGithubApp: true` para que el PR lo abra
la GitHub App de Cursor y no la cuenta humana conectada a la integración. Sin
ese campo los PRs aparecen firmados por esa persona, como si los hubiera
escrito.

El campo no está en la documentación pública de Cursor, aunque aparece en la
respuesta del agente y la API lo acepta al crear.

El **merge** es otra cosa: lo hace el orquestador con `GITHUB_TOKEN`, así que
el merge sí queda a nombre del dueño de ese token. Para que tampoco sea una
persona haría falta una GitHub App propia en vez de un PAT.

### Cómo se decide el veredicto de Bugbot

Bugbot hace dos cosas distintas, y no al mismo tiempo:

- **Si no hay bugs:** pone el check `Cursor Bugbot` en verde. **No** envía
  `pull_request_review`. El orquestador trata `check_run.completed` +
  `conclusion=success` como merge.
- **Si hay bugs:** publica una review con comentarios (minutos después de un
  `neutral` en el check). El `neutral` se ignora. El
  `pull_request_review.submitted` es el que manda a In Progress con las notas.

Si el proceso se reinicia y el webhook ya pasó, el reconciler mira el PR al
arrancar: check en verde → merge; review con hallazgos → corrección.

Los hallazgos se leen de **esa** revisión, no de todo el PR, para no reutilizar
comentarios de un intento anterior.

Tras una corrección, el agente empuja al mismo PR (`synchronize`). Eso
devuelve la run a `in_review` y vuelve a pedir Bugbot.

## Límites conocidos

- **El merge es automático.** Se exige Bugbot en verde y que el PR esté en
  `mergeable_state: clean` —sin conflictos y con los checks requeridos en
  verde—, y se manda el `sha` revisado para que GitHub lo rechace si alguien
  empujó algo después. Tras mergear se borra la rama del PR (`cursor/…`)
  para no dejar refs huérfanos; no se toca `main`. Aun así, Bugbot en verde
  no significa que el cambio sea correcto.
- **`max_attempts` frena los rebotes.** Agotados los intentos la run se aparca y comenta en la issue. Sin ese tope, un bug que el agente no sepa arreglar daría vueltas quemando dinero.
- **La calidad depende de las issues.** El prompt sale del título y la descripción tal cual.
- `project_config` se edita por SQL; no hay interfaz.
