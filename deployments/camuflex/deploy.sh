#!/usr/bin/env bash
#
# Despliega un tag de imagen en la instancia self-hosted de Plane.
# Lo invoca GitHub Actions vía SSM, pero también sirve a mano:
#
#   sudo -u ubuntu /opt/plane-app/deploy.sh sha-abc1234
#
# Secuencia: login a ECR -> pull -> infra -> migraciones -> app -> health check.
# Si el health check falla, revierte al tag anterior automáticamente.

set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/plane-app}
ENV_FILE="$APP_DIR/plane.env"
AWS_REGION=${AWS_REGION:-us-east-1}
ECR_REGISTRY=${ECR_REGISTRY:-482545836518.dkr.ecr.us-east-1.amazonaws.com}
HEALTH_HOST=${HEALTH_HOST:-plane.camuflex.com}
HEALTH_PATH=${HEALTH_PATH:-/api/instances/}
HEALTH_RETRIES=${HEALTH_RETRIES:-30}
HEALTH_DELAY=${HEALTH_DELAY:-10}

NEW_TAG=${1:-}
if [ -z "$NEW_TAG" ]; then
  echo "uso: deploy.sh <image-tag>" >&2
  exit 2
fi

cd "$APP_DIR"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

# Lee una clave de plane.env sin hacer source (el archivo tiene secretos con
# caracteres que romperían el shell).
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }

# Escribe una clave en plane.env, reemplazando la línea si ya existe.
env_set() {
  local key=$1 val=$2
  if grep -q "^$key=" "$ENV_FILE"; then
    # El valor puede traer '/' y ':' — se usa '|' como separador de sed.
    sed -i "s|^$key=.*|$key=$val|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

compose() {
  docker compose \
    --env-file "$ENV_FILE" \
    -p plane-app \
    -f "$APP_DIR/docker-compose.yaml" \
    -f "$APP_DIR/docker-compose.ecr.yml" \
    "$@"
}

# `env_file` se resuelve al parsear el compose: si el archivo no existe, falla
# TODO el `up`, no solo el orquestador. Se crea vacío para que la ausencia de
# secretos degrade a un solo servicio caído en vez de tumbar Plane entero.
ensure_orchestrator_env() {
  local file="$APP_DIR/orchestrator.env"
  if [ ! -f "$file" ]; then
    log "ATENCION: falta orchestrator.env, se crea vacío (el orquestador no arrancará)"
    : > "$file"
    chmod 600 "$file"
  fi
}

# El orquestador usa una base propia dentro del mismo Postgres. Separada de la
# de Plane a propósito: así los backups y restores de Plane siguen siendo
# independientes de la automatización.
ensure_orchestrator_db() {
  local pass
  pass=$(env_get POSTGRES_PASSWORD)
  local exists
  exists=$(compose exec -T -e PGPASSWORD="$pass" plane-db \
    psql -U plane -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='orchestrator'" </dev/null 2>/dev/null || true)
  if [ "$(echo "$exists" | tr -d '[:space:]')" = "1" ]; then
    log "base 'orchestrator' ya existe"
    return
  fi
  log "creando la base 'orchestrator'"
  compose exec -T -e PGPASSWORD="$pass" plane-db \
    psql -U plane -d postgres -c "CREATE DATABASE orchestrator OWNER plane" </dev/null
}

health_ok() {
  # --resolve fuerza la conexión a loopback pero conserva SNI y Host, así se
  # valida la cadena TLS real sin depender de hairpinning por la IP elástica.
  curl -sf --max-time 10 \
    --resolve "$HEALTH_HOST:443:127.0.0.1" \
    "https://$HEALTH_HOST$HEALTH_PATH" >/dev/null 2>&1
}

PREV_TAG=$(env_get IMAGE_TAG || true)
log "tag actual:  ${PREV_TAG:-<ninguno>}"
log "tag nuevo:   $NEW_TAG"

log "autenticando contra ECR"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY" >/dev/null

env_set ECR_REGISTRY "$ECR_REGISTRY"
env_set IMAGE_TAG "$NEW_TAG"

# Deja rastro del tag anterior para poder revertir a mano más adelante.
if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$NEW_TAG" ]; then
  env_set PREVIOUS_IMAGE_TAG "$PREV_TAG"
fi

rollback() {
  if [ -z "$PREV_TAG" ] || [ "$PREV_TAG" = "$NEW_TAG" ]; then
    log "ERROR: despliegue fallido y no hay tag anterior al que volver"
    return
  fi
  log "ERROR: despliegue fallido — revirtiendo a $PREV_TAG"
  env_set IMAGE_TAG "$PREV_TAG"
  compose up -d --remove-orphans || true
  if health_ok; then
    log "rollback a $PREV_TAG completado y saludable"
  else
    log "ATENCION: el rollback a $PREV_TAG tampoco responde al health check"
  fi
}

log "descargando imágenes $NEW_TAG"
if ! compose pull --quiet; then
  log "ERROR: no se pudieron descargar las imágenes del tag $NEW_TAG"
  env_set IMAGE_TAG "${PREV_TAG:-$NEW_TAG}"
  exit 1
fi

log "levantando infraestructura (db, redis, mq, minio)"
compose up -d plane-db plane-redis plane-mq plane-minio

# Antes de las migraciones de Plane: el orquestador aplica su propio esquema
# al arrancar, pero la base tiene que existir primero.
ensure_orchestrator_env
ensure_orchestrator_db

# Plane bloquea por defecto los webhooks hacia IPs privadas (protección SSRF).
# El orquestador vive en la red interna, así que su host tiene que estar
# explícitamente permitido o Plane rechaza la URL al guardarla.
if ! grep -q 'orchestrator.internal' "$ENV_FILE"; then
  log "permitiendo orchestrator.internal como destino de webhooks"
  env_set WEBHOOK_ALLOWED_HOSTS "orchestrator.internal"
fi

log "ejecutando migraciones"
if ! compose run --rm migrator; then
  log "ERROR: las migraciones fallaron — no se toca la aplicación"
  env_set IMAGE_TAG "${PREV_TAG:-$NEW_TAG}"
  exit 1
fi

log "actualizando servicios de aplicación"
compose up -d --remove-orphans

log "esperando health check en https://$HEALTH_HOST$HEALTH_PATH"
for i in $(seq 1 "$HEALTH_RETRIES"); do
  if health_ok; then
    log "OK: instancia saludable tras $i intento(s)"
    log "limpiando imágenes huérfanas"
    docker image prune -f >/dev/null 2>&1 || true
    log "despliegue de $NEW_TAG completado"
    exit 0
  fi
  sleep "$HEALTH_DELAY"
done

rollback
exit 1
