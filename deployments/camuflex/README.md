# CI/CD del Plane self-hosted

Pipeline que construye las imágenes de este fork, las publica en **ECR** y las
despliega en la instancia **EC2** vía **SSM**.

```
push a preview
   │
   ├─ build (6 jobs en paralelo)  ──►  ECR  (tags: sha-<12> y latest)
   │
   └─ deploy  ──►  SSM SendCommand  ──►  EC2
                                          │
                                          ├─ login ECR (rol de instancia)
                                          ├─ pull de las 6 imágenes
                                          ├─ up de infra (db, redis, mq, minio)
                                          ├─ migraciones (bloquea si fallan)
                                          ├─ up de la aplicación
                                          └─ health check ─► rollback si falla
```

## Por qué así

- **OIDC en vez de llaves.** GitHub asume un rol de AWS con un token efímero.
  No hay `AWS_ACCESS_KEY_ID` ni llave SSH guardada en el repositorio.
- **SSM en vez de SSH.** El despliegue no abre ni usa el puerto 22, y el
  permiso está acotado a un `SendCommand` sobre una sola instancia.
- **Overlay en vez de fork del compose.** `docker-compose.ecr.yml` solo
  reemplaza los `image:`. El compose de upstream queda intacto, así rebasar
  sobre `makeplane/plane` no genera conflictos.
- **Los archivos viajan en el comando.** El workflow manda compose, overlay y
  `deploy.sh` en base64 dentro del propio `SendCommand`, así que la instancia
  corre exactamente lo que hay en el commit desplegado y no necesita acceso al
  repositorio.

## Variables de repositorio

`Settings > Secrets and variables > Actions`. Sirve tanto la pestaña
*Variables* como *Secrets* — el workflow acepta las dos. Recomendadas como
Variables: ninguno de estos valores es sensible, el rol es inútil sin la
condición de confianza OIDC, y así se leen en los logs.

> **Tienen que estar a nivel de repositorio.** Si las defines acotadas al
> environment `production`, los jobs de `build` no las ven —no declaran
> environment— y el run muere con
> `Input required and not supplied: aws-region`.

| Variable | Valor |
|---|---|
| `AWS_REGION` | `us-east-1` |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::482545836518:role/plane-github-actions-deploy` |
| `EC2_INSTANCE_ID` | `i-09ff0ee64a00c4195` |
| `HEALTH_HOST` | `plane.camuflex.com` |

El host de ECR **no se configura**. Se deriva en cada job con
`aws sts get-caller-identity` sobre la cuenta en la que el rol ya está
autenticado. Se hizo así después de que un `ECR_REGISTRY` mal escrito hiciera
fallar el `docker login` con un `400 Bad Request` del registry —un error que
no dice nada sobre su causa real—. Derivarlo elimina esa clase entera de
fallo: no puede traer un `https://`, una barra final ni un espacio invisible.
Si quedó un secret `ECR_REGISTRY` de antes, ya no se lee y se puede borrar.

El job `deploy` usa el environment `production`. Si no existe, GitHub lo crea
al primer run; puedes añadirle *required reviewers* para exigir aprobación
manual antes de cada despliegue.

## Confianza OIDC

El rol solo acepta tokens de este repositorio, y solo desde `preview` o desde
el environment `production`:

```
repo:camuflex-com@319952952/plane@1343116864:ref:refs/heads/preview
repo:camuflex-com@319952952/plane@1343116864:environment:production
repo:camuflex-com/plane:ref:refs/heads/preview
repo:camuflex-com/plane:environment:production
```

Los `@<id>` no son un error. Esta organización tiene activado el **formato
inmutable del subject claim**: GitHub inyecta el ID numérico de la org
(`319952952`) y del repo (`1343116864`) dentro del `sub`. Es más seguro que el
formato clásico —renombrar la org o el repo no permite suplantar la
identidad—, pero rompe cualquier trust policy escrita con el patrón de
siempre, con un `AccessDenied` genérico que no dice por qué.

Se dejan las cuatro variantes para que siga funcionando si el flag se
desactiva. Para ver el `sub` real que se está presentando:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --max-results 1 --query 'Events[0].CloudTrailEvent' --output text \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["userIdentity"]["userName"])'
```

Una rama distinta no puede desplegar. Para habilitar otra, hay que añadirla a
la trust policy del rol.

## Uso

- **Automático:** cada push a `preview` que toque código (se ignoran `**.md`
  y `docs/**`).
- **Manual:** `Actions > Deploy self-hosted > Run workflow`. Si dejas
  `image_tag` vacío, construye desde el commit actual. Si pones un tag que ya
  existe en ECR (por ejemplo `sha-abc123456789`), se salta el build y solo
  despliega — esa es la vía rápida para volver a una versión anterior.

## Rollback

El despliegue revierte solo si el health check no pasa tras 30 intentos
(5 minutos). Para revertir a mano, corre el workflow con el `image_tag`
anterior, o directamente en la instancia:

```bash
ssh -i ~/.ssh/plane-selfhost.pem ubuntu@plane.camuflex.com
grep PREVIOUS_IMAGE_TAG /opt/plane-app/plane.env
sudo bash /opt/plane-app/deploy.sh <tag-anterior>
```

## Nota sobre las migraciones

`deploy.sh` corre el migrator **antes** de actualizar la aplicación y aborta
sin tocar los servicios si falla. Esto protege contra desplegar código que
espera un esquema que no se aplicó, pero no protege contra migraciones
destructivas: no hay snapshot automático de la base. Antes de un cambio de
esquema arriesgado, saca un backup (`docker run --rm -v plane-app_pgdata:...`)
o un snapshot EBS del volumen.

## Workflows heredados de upstream

`build-branch.yml` (*Branch Build CE*) también se dispara en cada push a
`preview` y publica en el Docker Hub de makeplane. En este fork fallaba
siempre por falta de `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`, y además
duplicaba el trabajo: construye las mismas 6 imágenes. Quedó acotado con
`if: github.repository == 'makeplane/plane'` en su primer job — como todos
los demás dependen de él, el workflow entero se salta en el fork.

Para reactivarlo habría que quitar ese guard y añadir los secrets de Docker
Hub.

## Lo que NO cubre

- Los servicios de infraestructura (postgres, redis, rabbitmq, minio) siguen
  usando sus imágenes oficiales y no los toca el pipeline.
- No hay entorno de staging: `preview` despliega directo a producción.
- La base de datos vive en el disco de la instancia. Un `terminate` se lleva
  los datos; el volumen es `DeleteOnTermination=true`.
