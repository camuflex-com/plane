import express, { Router, type Express, type Request, type Response } from "express";
import { createApiRouter } from "@/api";
import { HttpError } from "@/clients/http";
import { PlaneClient } from "@/clients/plane";
import { claimDelivery, type Db } from "@/db";
import type { Env } from "@/env";
import { isBugbot, isBugbotCheck } from "@/executor";
import { createIngestedIssue, parseIssuePayload, resolveIngestProject } from "@/ingest-issue";
import { logger } from "@/logger";
import { enqueue } from "@/queue";
import { verifyApiKey, verifyGitHubSignature, verifyPlaneSignature } from "@/signatures";

/**
 * Prefijo bajo el que se sirve todo.
 *
 * Caddy enruta con `reverse_proxy /automation/*`, que NO recorta el prefijo:
 * al contenedor le llega la ruta completa. Es el mismo trato que reciben
 * /spaces, /god-mode y /live, que también se montan bajo su prefijo.
 */
export const BASE_PATH = "/automation";

export function createServer(db: Db, env: Env): Express {
  const app = express();
  const routes = Router();

  // El cuerpo crudo es imprescindible: la firma se calcula sobre los bytes
  // exactos, y volver a serializar el JSON los cambiaría.
  app.use(express.raw({ type: "application/json", limit: "2mb" }));

  // Sin prefijo además: lo consulta el healthcheck del contenedor, que habla
  // directo con el puerto sin pasar por el proxy.
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  routes.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  /**
   * Ingesta de issues desde camuflex-backend. Auth con la misma API key del
   * bot (`X-API-Key`); con ella se crea la issue para que quede a su nombre.
   */
  routes.post("/issues", (req, res) => {
    ingestExternalIssue(db, env, req, res).catch((error: unknown) => {
      logger.error("fallo creando issue", { error: String(error) });
      if (!res.headersSent) res.status(500).json({ error: "error interno" });
    });
  });

  routes.post("/webhooks/plane", (req, res) => {
    const raw = req.body instanceof Buffer ? req.body.toString("utf8") : "";
    const signature = req.header("X-Plane-Signature");

    if (!verifyPlaneSignature(raw, signature, env.PLANE_WEBHOOK_SECRET)) {
      logger.warn("firma de Plane inválida");
      res.status(401).json({ error: "firma inválida" });
      return;
    }

    const deliveryId = req.header("X-Plane-Delivery") ?? "";
    let payload: PlanePayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.status(400).json({ error: "cuerpo ilegible" });
      return;
    }

    // Se responde antes de trabajar: Plane reintenta si tardamos, y el trabajo
    // real queda encolado de forma durable. El handler es síncrono a
    // propósito: Express 4 no captura los rechazos de uno async.
    res.status(202).json({ accepted: true });

    void ingestPlane(db, env, deliveryId, payload).catch((error: unknown) => {
      logger.error("fallo procesando webhook de Plane", { error: String(error) });
    });
  });

  routes.post("/webhooks/github", (req, res) => {
    const raw = req.body instanceof Buffer ? req.body.toString("utf8") : "";
    const signature = req.header("X-Hub-Signature-256");

    if (!verifyGitHubSignature(raw, signature, env.GITHUB_WEBHOOK_SECRET)) {
      logger.warn("firma de GitHub inválida");
      res.status(401).json({ error: "firma inválida" });
      return;
    }

    const deliveryId = req.header("X-GitHub-Delivery") ?? "";
    const eventName = req.header("X-GitHub-Event") ?? "";
    let payload: GitHubPayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.status(400).json({ error: "cuerpo ilegible" });
      return;
    }

    res.status(202).json({ accepted: true });

    void ingestGitHub(db, deliveryId, eventName, payload).catch((error: unknown) => {
      logger.error("fallo procesando webhook de GitHub", { error: String(error) });
    });
  });

  // El API de lectura va bajo el mismo prefijo, con su propio parseo de JSON:
  // los webhooks necesitan el cuerpo crudo para la firma, estas rutas no.
  routes.use("/api", createApiRouter(db, env));

  app.use(BASE_PATH, routes);

  return app;
}

async function ingestExternalIssue(db: Db, env: Env, req: Request, res: Response): Promise<void> {
  if (!verifyApiKey(req.header("x-api-key"), env.PLANE_API_KEY)) {
    logger.warn("API key inválida al crear issue");
    res.status(401).json({ error: "no autorizado" });
    return;
  }

  const raw = req.body instanceof Buffer ? req.body.toString("utf8") : "";
  const parsed = parseIssuePayload(raw);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const config = await resolveIngestProject(db, parsed.payload);
  if (!config) {
    res.status(404).json({ error: "proyecto no habilitado" });
    return;
  }

  try {
    const issue = await createIngestedIssue(new PlaneClient(env), config, parsed.payload);
    logger.info("issue creada desde el backend", { issueId: issue.id, projectId: issue.projectId });
    res.status(201).json(issue);
  } catch (error: unknown) {
    if (error instanceof HttpError && error.status === 409) {
      res.status(409).json({ error: "issue duplicada" });
      return;
    }
    throw error;
  }
}

type PlanePayload = {
  event?: string;
  action?: string;
  data?: { id?: string; project?: string; state?: { id?: string; name?: string } };
  activity?: { actor?: { id?: string } };
};

/**
 * Estado que arranca el trabajo. Se comprueba contra el payload en vez de
 * confiar en cómo esté configurado el webhook: si alguien añadiera otro estado
 * al disparador, se lanzarían agentes de Cursor sobre issues que no tocan.
 */
const TRIGGER_STATE = "in progress";

type GitHubPayload = {
  action?: string;
  repository?: { name?: string; owner?: { login?: string } };
  pull_request?: { number?: number; head?: { sha?: string; ref?: string }; draft?: boolean };
  check_run?: {
    name?: string;
    conclusion?: string | null;
    head_sha?: string;
    pull_requests?: { number?: number }[];
  };
  review?: {
    id?: number;
    state?: string;
    body?: string | null;
    commit_id?: string;
    user?: { login?: string };
  };
};

async function ingestPlane(db: Db, env: Env, deliveryId: string, payload: PlanePayload): Promise<void> {
  // Primera barrera contra bucles: el orquestador mueve issues, y ese
  // movimiento vuelve por aquí. Sin este filtro se realimenta sin fin.
  const actorId = payload.activity?.actor?.id;
  if (actorId && actorId === env.PLANE_BOT_USER_ID) {
    logger.debug("evento propio, ignorado");
    return;
  }

  if (payload.event !== "issue") return;

  const issueId = payload.data?.id;
  const projectId = payload.data?.project;
  if (!issueId || !projectId) return;

  // Segunda barrera: Plane reintenta las entregas fallidas.
  if (deliveryId && !(await claimDelivery(db, "plane", deliveryId))) {
    logger.debug("entrega de Plane repetida, ignorada", { deliveryId });
    return;
  }

  // El webhook debería traer solo transiciones a In Progress, pero se verifica
  // igualmente: la configuración vive fuera de este código y puede cambiar.
  const stateName = payload.data?.state?.name?.trim().toLowerCase();
  if (stateName && stateName !== TRIGGER_STATE) {
    logger.info("estado que no dispara trabajo, ignorado", { issueId, state: payload.data?.state?.name });
    return;
  }

  await enqueue(db, "plane.issue_in_progress", { issueId, projectId });
  logger.info("issue encolada", { issueId, projectId });
}

/**
 * ¿Es un evento sobre el que actuamos?
 *
 * Se comprueba ANTES de registrar la entrega: si el webhook está montado a
 * nivel de organización llegan eventos de todos los repos, y anotarlos todos
 * haría crecer `deliveries` sin límite con ruido que nunca se procesa.
 */
/**
 * Acciones de pull_request que significan "hay un PR listo para revisar".
 *
 * `ready_for_review` es imprescindible: Cursor abre sus PRs como BORRADOR y
 * los marca listos un minuto después. Escuchando solo `opened` se recibe el
 * borrador, se descarta —correctamente, un borrador no se revisa— y la
 * transición posterior nunca llega, dejando la run colgada para siempre.
 */
const PR_READY_ACTIONS = new Set(["opened", "ready_for_review"]);
const PR_SYNC_ACTIONS = new Set(["synchronize"]);

function isActionableGitHubEvent(eventName: string, payload: GitHubPayload): boolean {
  if (eventName === "pull_request") {
    const action = payload.action ?? "";
    return PR_READY_ACTIONS.has(action) || PR_SYNC_ACTIONS.has(action);
  }
  if (eventName === "pull_request_review") {
    return payload.action === "submitted" && isBugbot(payload.review?.user?.login);
  }
  // Sin hallazgos Bugbot NO envía pull_request_review: solo pone el check en
  // verde. El `neutral` del mismo check llega antes de los comentarios y se
  // ignora; solo el success cuenta como "aprobó".
  if (eventName === "check_run") {
    return (
      payload.action === "completed" &&
      payload.check_run?.conclusion === "success" &&
      isBugbotCheck(payload.check_run?.name)
    );
  }
  return false;
}

async function ingestGitHub(db: Db, deliveryId: string, eventName: string, payload: GitHubPayload): Promise<void> {
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  if (!owner || !repo) return;

  logger.info("webhook de GitHub", {
    eventName,
    action: payload.action,
    owner,
    repo,
    deliveryId: deliveryId || undefined,
  });

  if (!isActionableGitHubEvent(eventName, payload)) {
    if (eventName === "pull_request_review" || eventName === "check_run") {
      logger.info("evento de GitHub ignorado", {
        eventName,
        action: payload.action,
        login: payload.review?.user?.login,
        checkName: payload.check_run?.name,
        conclusion: payload.check_run?.conclusion,
      });
    }
    return;
  }

  if (deliveryId && !(await claimDelivery(db, "github", deliveryId))) {
    logger.debug("entrega de GitHub repetida, ignorada", { deliveryId });
    return;
  }

  if (eventName === "pull_request") {
    const pr = payload.pull_request;
    if (!pr?.number || !pr.head?.sha) {
      logger.warn("PR sin número o sin sha, se ignora", { owner, repo, action: payload.action });
      return;
    }
    // Un borrador todavía no se revisa; ya volverá como `ready_for_review`.
    if (pr.draft) {
      logger.info("PR en borrador, se espera a que esté listo", { owner, repo, prNumber: pr.number });
      return;
    }
    const job = {
      owner,
      repo,
      prNumber: pr.number,
      headSha: pr.head.sha,
      branch: pr.head.ref ?? "",
    };
    if (PR_SYNC_ACTIONS.has(payload.action ?? "")) {
      await enqueue(db, "github.pr_synchronized", job);
      logger.info("PR actualizado, se encola el sync", { owner, repo, prNumber: pr.number });
      return;
    }
    await enqueue(db, "github.pr_opened", job);
    logger.info("PR encolado", { owner, repo, prNumber: pr.number, action: payload.action });
    return;
  }

  if (eventName === "pull_request_review" && payload.action === "submitted") {
    const prNumber = payload.pull_request?.number;
    const review = payload.review;
    if (!prNumber || !review?.id) {
      logger.warn("revisión de Bugbot sin PR o sin id, se ignora", { owner, repo });
      return;
    }
    await enqueue(db, "github.bugbot_review", {
      owner,
      repo,
      prNumber,
      headSha: review.commit_id ?? payload.pull_request?.head?.sha ?? null,
      reviewId: review.id,
      state: review.state ?? "",
      body: review.body ?? "",
    });
    logger.info("revisión de Bugbot encolada", {
      owner,
      repo,
      prNumber,
      reviewId: review.id,
      state: review.state,
    });
    return;
  }

  if (eventName === "check_run" && payload.action === "completed") {
    const check = payload.check_run;
    const prNumber = check?.pull_requests?.[0]?.number ?? null;
    const headSha = check?.head_sha ?? null;
    if (!prNumber && !headSha) {
      logger.warn("check de Bugbot en verde sin PR ni sha", { owner, repo, name: check?.name });
      return;
    }
    await enqueue(db, "github.bugbot_check_success", {
      owner,
      repo,
      prNumber,
      headSha,
    });
    logger.info("Bugbot en verde, se encola el merge", { owner, repo, prNumber, headSha });
  }
}
