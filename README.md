# Plane — fork de Camuflex

Fork de [makeplane/plane](https://github.com/makeplane/plane) (Community Edition) desplegado como instancia self-hosted en **https://plane.camuflex.com**.

Este README describe *este* fork. Para documentación del producto, funcionalidades y uso general, la fuente sigue siendo [docs.plane.so](https://docs.plane.so/).

## Despliegue

Corre en una EC2 en AWS, con imágenes construidas desde este repositorio y publicadas en ECR. Cada push a `preview` dispara el pipeline, que construye, publica y despliega vía SSM.

El detalle completo —infraestructura, variables de GitHub Actions, procedimiento de rollback y qué cubre y qué no— está en **[deployments/camuflex/README.md](deployments/camuflex/README.md)**.

```
push a preview  ──►  build (6 imágenes)  ──►  ECR  ──►  SSM  ──►  EC2
```

## Cambios respecto a upstream

| Área | Cambio |
|---|---|
| Despliegue | Pipeline propio a ECR + EC2 (`deployments/camuflex/`), overlay de compose que no toca el de upstream |
| Autenticación | Registro público deshabilitado; solo el admin y usuarios invitados |
| Webhooks | Alcance por proyecto, sección propia en Project Settings y disparadores por transición de estado |
| Estados | Estado `In Review` añadido por defecto, entre `In Progress` y `Done` |
| Repositorio | Eliminada la infraestructura de comunidad de upstream (issue templates, code of conduct, guía de contribución) |

El compose de upstream en `deployments/cli/community/` se deja **sin modificar** a propósito: los cambios de despliegue viven en un overlay aparte para que rebasar sobre `makeplane/plane` no genere conflictos.

## Desarrollo local

```bash
pnpm install
pnpm dev
```

Requiere Node 22.18.0 (ver `.mise.toml`) y pnpm 11.3.0. Para levantar el stack completo con Docker existe `docker-compose-local.yml`.

Antes de abrir un PR, lo que valida el CI:

```bash
pnpm --filter web check:types && pnpm --filter web check:lint
```

## Licencia

AGPL-3.0-only, heredada de upstream. Ver [LICENSE.txt](LICENSE.txt).

Dos consecuencias que conviene tener presentes:

- Las cabeceras de copyright de cada archivo y `COPYRIGHT.txt` son parte de la licencia y no se eliminan. `copyright-check.yml` lo verifica en cada PR.
- La AGPL exige ofrecer el código fuente a los usuarios que accedan al servicio por red. Como esta instancia es accesible por red y está modificada, esa obligación aplica a este repositorio.

## Seguridad

Las vulnerabilidades de **esta instancia o de estos cambios** se reportan internamente, no a Plane.

Las que afecten al Plane original van a `security@plane.so`, siguiendo su [política de seguridad](https://github.com/makeplane/plane/blob/master/SECURITY.md).
