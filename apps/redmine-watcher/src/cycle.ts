/**
 * La máquina de etapas de una incidencia ya enlazada a su conversación: qué hace el vigilante
 * cuando la conversación queda en pausa. Sin red ni disco propios (todo entra por `deps`), para
 * poder probarla con una conversación simulada (tests/redmine-cycle.test.ts).
 *
 * Avanza con la línea `Etapa:` con la que el agente cierra cada mensaje (flow.ts):
 *  - EJECUTADO / RESPUESTA → entra el supervisor; según su veredicto, cierre, corrección o
 *    se le sube al propietario.
 *  - DESPLEGADO / SIN DESPLIEGUE → publica el comentario que aprobó el supervisor, solo si el
 *    propietario finalizó después del cierre y el texto no cambió.
 *  - las demás (PLAN, NO ES NUESTRO, EN ESPERA…) esperan al propietario: no se hace nada.
 */
import { createHash } from "node:crypto";
import type { OwnerDecision, ReviewKind, StageMark } from "./flow.ts";
import {
  NEEDS_REVIEW,
  PUBLISHES,
  afterReview,
  closePrompt,
  decisionFromQuestion,
  decisionFromText,
  escalatePrompt,
  extractPlanSummary,
  fixPrompt,
  isWatcherText,
  normalizeNotes,
  noticePrompt,
  parseStage,
  parseVerdict,
  publishedPrompt,
  reviewPrompt,
} from "./flow.ts";

export type Approved = { hash: string; notes: string; attachments: string[]; at: number; capture?: string };
export type Linked = {
  taskId?: string;
  lastJournalId: number;
  linkedAt: string;
  baseline?: boolean;
  /** 2: la conversación conoce las marcas `Etapa:`. Las anteriores al 12/11 no; no se les reclama la marca. */
  protocol?: number;
  /** `updated_on` de Redmine ya procesado: sin cambio no se vuelve a pedir el detalle. */
  seenUpdatedOn?: string;
  /** Firma de la conversación ya procesada: sin cambio no se vuelve a pedir su historial. */
  seenActivity?: string;
  /** Redmine ya no la devuelve (borrada o sin visibilidad): se deja de seguir. */
  gone?: boolean;
  /** Ya se anotó que está cerrada: no se repite el aviso en cada sondeo. */
  closedNoted?: boolean;
  /** Qué se trabaja: la incidencia o la respuesta a un comentario nuevo. */
  kind?: ReviewKind;
  /** Comentarios de Redmine que abrieron la respuesta en curso (para el supervisor). */
  clarify?: string;
  /** Resumen del plan que presentó el agente (lo que aprueba el propietario). */
  plan?: string;
  /** Momento del mensaje con la última marca atendida: lo anterior ya no cuenta. */
  handledAt?: number;
  lastMark?: StageMark;
  /** Supervisión en curso. */
  review?: { startedAt: number; kind: ReviewKind; second: boolean; preview?: Approved };
  /** Pasadas del supervisor y rondas de corrección de este ciclo. */
  reviews?: number;
  fixes?: number;
  /** Mensaje del vigilante por entregar en cuanto la conversación esté en pausa, ya con el modelo de trabajo. */
  pending?: { prompt: string; close?: boolean };
  /** Mensajes por entregar que llegaron con la conversación ocupada. */
  outbox?: string[];
  /** Comentario que aprobó el supervisor: lo único que se publica. */
  approved?: Approved;
  /** Desde cuándo se espera la decisión de cierre del propietario. */
  closeAt?: number;
  /** Cierre para el que ya se avisó de que falta algo para publicar (un aviso por cierre). */
  noticedAt?: number;
  published?: { hash: string; at: number; result: string };
  /** Último mensaje del propietario ya tomado en cuenta. */
  ownerSeenAt?: number;
  /** Ya se le recordó la marca en este ciclo. */
  nudged?: boolean;
};

export type Part = { kind: string; text?: string; tool?: string; status?: string; output?: string };
export type ChatMessage = { role: string; createdAt: number; completedAt?: number; parts: Part[] };
export type Snapshot = { task: { status: string; model?: string | null; directory: string }; messages: ChatMessage[] };
export type Overview = Map<string, { status: string; signature: string }>;

export interface CycleDeps {
  task(taskId: string): Promise<Snapshot>;
  setModel(taskId: string, model: string): Promise<void>;
  send(taskId: string, text: string): Promise<void>;
  /** Estado de todas las conversaciones (una lectura por sondeo). */
  conversations(): Promise<Overview>;
  /** Lo que pidieron, para el supervisor. */
  request(issueId: string, linked: Linked): Promise<string>;
  /** Vista previa del comentario posterior a `since`, si la hay. */
  readPreview(issueId: string, since: number): Approved | undefined;
  /** Publica el comentario aprobado; devuelve el resultado en una línea. */
  publish(issueId: string, approved: Approved, directory: string): Promise<string>;
  save(): void;
  log(line: string): void;
  now(): number;
  cfg: { model?: string; reviewModel?: string; maxFixes: number; maxReviews: number; reviewTimeoutMs: number };
}

export const hashOf = (notes: string) => createHash("sha256").update(normalizeNotes(notes)).digest("hex");
export const isBusy = (status: string) => status === "running" || status === "queued";
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const textOf = (m: ChatMessage) => m.parts.filter((p) => p.kind === "text").map((p) => p.text ?? "").join("\n");

/** Última decisión del propietario tras el cierre: el botón de la pregunta o lo que escribió. */
export function ownerDecision(snap: Snapshot, since: number): OwnerDecision | undefined {
  let latest: { at: number; decision: OwnerDecision } | undefined;
  const consider = (at: number, decision: OwnerDecision | undefined) => {
    if (decision && at > since && (!latest || at >= latest.at)) latest = { at, decision };
  };
  for (const m of snap.messages) {
    if (m.role === "assistant") {
      for (const p of m.parts)
        if (p.kind === "tool" && p.tool === "question" && p.status === "completed") consider(m.completedAt ?? m.createdAt, decisionFromQuestion(p.output ?? ""));
    } else if (m.role === "user") {
      const text = textOf(m);
      if (!isWatcherText(text)) consider(m.createdAt, decisionFromText(text));
    }
  }
  return latest?.decision;
}

/** Nuevo ciclo tras un mensaje del propietario o un comentario de Redmine: rondas en cero. */
export function resetCycle(linked: Linked) {
  linked.reviews = 0;
  linked.fixes = 0;
  linked.nudged = false;
}

export function createCycle(deps: CycleDeps) {
  const { cfg, log, save } = deps;

  /** Tras «DESPLEGADO» o «SIN DESPLIEGUE»: publica el comentario aprobado si el propietario finalizó. */
  async function publishIfFinal(issueId: string, linked: Linked, snap: Snapshot, mark: StageMark) {
    const notice = (what: string) => {
      if (linked.noticedAt === (linked.closeAt ?? 0)) return;
      linked.noticedAt = linked.closeAt ?? 0;
      linked.pending = { prompt: noticePrompt(issueId, what) };
      log(`#${issueId}: ${mark} pero no se publica: ${what.split(",")[0]}`);
    };
    const approved = linked.approved;
    if (approved && linked.published?.hash === approved.hash) {
      log(`#${issueId}: ${mark}; el comentario aprobado ya estaba publicado (${linked.published.result})`);
      return;
    }
    if (!linked.closeAt || ownerDecision(snap, linked.closeAt) !== "FINALIZAR")
      return notice("vi tu marca de cierre pero no encuentro el «Finalizar» del propietario, así que no publiqué nada en Redmine. Pregúntale otra vez con `question` (Finalizar, Rechazar, Esperar) y cierra con la marca que corresponda a su respuesta.");
    if (!approved)
      return notice("no hay un comentario aprobado por el supervisor, así que no publiqué nada. Deja la vista previa del comentario de cierre y cierra con `Etapa: EJECUTADO` para que lo revise.");
    const current = deps.readPreview(issueId, Date.parse(linked.linkedAt));
    if (current && current.hash !== approved.hash)
      return notice("el comentario de la vista previa cambió después de la supervisión, así que no publiqué nada. Cierra con `Etapa: EJECUTADO` (o `Etapa: RESPUESTA`) para que el supervisor revise el texto nuevo.");
    try {
      const result = await deps.publish(issueId, approved, snap.task.directory);
      linked.published = { hash: approved.hash, at: deps.now(), result };
      linked.pending = { prompt: publishedPrompt(issueId, result) };
      log(`#${issueId}: ${mark} con «Finalizar» del propietario → comentario publicado por la API (${result})`);
    } catch (err) {
      linked.pending = { prompt: noticePrompt(issueId, `no pude publicar el comentario en Redmine: ${errorText(err)}. No lo publiques tú; dile al propietario el error tal cual.`) };
      log(`#${issueId}: no se pudo publicar (${errorText(err)})`);
    }
  }

  /** Avanza la conversación de una incidencia cuando está en pausa. */
  async function cycle(issueId: string, linked: Linked) {
    if (!linked.taskId) return;
    const taskId = linked.taskId;
    const seen = (await deps.conversations()).get(taskId);
    if (!seen || isBusy(seen.status)) return;
    const waiting = Boolean(linked.review || linked.pending || linked.outbox?.length);
    if (!waiting && linked.seenActivity === seen.signature) return;
    const snap = await deps.task(taskId);
    if (isBusy(snap.task.status)) return;
    const assistants = snap.messages.filter((m) => m.role === "assistant");

    // 1. Supervisión en curso: esperar a que termine y decidir qué sigue.
    if (linked.review) {
      const review = linked.review;
      const answers = assistants.filter((m) => m.createdAt > review.startedAt);
      const done = answers.some((m) => m.completedAt !== undefined);
      if (!done && deps.now() - review.startedAt < cfg.reviewTimeoutMs) return;
      const verdict = done ? parseVerdict(answers.map(textOf).join("\n")) : undefined;
      const next = afterReview(verdict, linked.fixes ?? 0, cfg.maxFixes);
      if (next === "close") {
        linked.approved = review.preview;
        linked.pending = { prompt: closePrompt(issueId, review.kind), close: true };
      } else if (next === "fix") {
        linked.fixes = (linked.fixes ?? 0) + 1;
        linked.pending = { prompt: fixPrompt(issueId, review.kind) };
      } else {
        linked.pending = { prompt: escalatePrompt(issueId, review.kind, verdict ? "observaciones" : "sin-veredicto"), close: true };
      }
      // Lo que dijo el supervisor no son marcas del agente.
      linked.handledAt = deps.now();
      linked.review = undefined;
      save();
      log(`#${issueId}: supervisión terminada (${verdict ?? "sin veredicto"}) → ${next === "close" ? "cierre con Finalizar/Rechazar/Esperar" : next === "fix" ? `corrección ${linked.fixes}/${cfg.maxFixes}` : "se sube al propietario"}`);
    }

    // 2. Mensaje del vigilante pendiente: de vuelta al modelo de trabajo y se entrega.
    if (linked.pending) {
      if (cfg.model && snap.task.model !== cfg.model) {
        await deps.setModel(taskId, cfg.model);
        log(`#${issueId}: conversación de vuelta a ${cfg.model}`);
      }
      await deps.send(taskId, linked.pending.prompt);
      if (linked.pending.close) {
        linked.closeAt = deps.now();
        linked.noticedAt = undefined;
      }
      linked.pending = undefined;
      save();
      return;
    }
    if (linked.outbox?.length) {
      if (cfg.model && snap.task.model !== cfg.model) await deps.setModel(taskId, cfg.model);
      for (const text of linked.outbox) await deps.send(taskId, text);
      log(`#${issueId}: ${linked.outbox.length} mensaje(s) pendiente(s) entregado(s)`);
      linked.outbox = [];
      save();
      return;
    }

    // 3. Mensajes del propietario: abren un ciclo nuevo (rondas en cero).
    const ownerAt = snap.messages
      .filter((m) => m.role === "user" && !isWatcherText(textOf(m)))
      .reduce((t, m) => Math.max(t, m.createdAt), 0);
    if (ownerAt > (linked.ownerSeenAt ?? 0)) {
      linked.ownerSeenAt = ownerAt;
      resetCycle(linked);
    }

    // El resumen del plan que aprobó el propietario, para el supervisor: el último que presentó el agente.
    const plan = assistants.map((m) => extractPlanSummary(textOf(m))).filter(Boolean).pop();
    if (plan) linked.plan = plan;

    // 4. La marca con la que el agente cerró su último mensaje.
    const since = linked.handledAt ?? Date.parse(linked.linkedAt);
    const fresh = assistants.filter((m) => m.createdAt > since && m.completedAt !== undefined);
    const marked = fresh.map((m) => ({ m, mark: parseStage(textOf(m)) })).filter((x) => x.mark).pop();
    if (!marked) {
      // Terminó sin marca: se le recuerda una vez por ciclo, solo si conoce el protocolo.
      if (fresh.length && linked.protocol === 2 && !linked.nudged && snap.messages.at(-1)?.role === "assistant") {
        await deps.send(taskId, noticePrompt(issueId, "tu último mensaje no cierra con la línea `Etapa: <marca>`, y sin ella no puedo avanzar. Repite solo esa línea con la marca que corresponda a lo que ya dijiste (PLAN, EJECUTADO, RESPUESTA, SIN RESPUESTA, NO ES NUESTRO, BLOQUEADO, EN ESPERA, RECHAZADO, DESPLEGADO o SIN DESPLIEGUE). No repitas el trabajo."));
        linked.nudged = true;
        save();
        log(`#${issueId}: mensaje sin marca de etapa; se le recordó`);
        return;
      }
      linked.seenActivity = seen.signature;
      save();
      return;
    }
    const mark = marked.mark!;

    if (NEEDS_REVIEW.has(mark)) {
      const kind: ReviewKind = mark === "RESPUESTA" ? "respuesta" : "trabajo";
      const preview = deps.readPreview(issueId, Date.parse(linked.linkedAt));
      if (!cfg.reviewModel) {
        linked.approved = preview;
        linked.pending = { prompt: closePrompt(issueId, kind), close: true };
      } else if ((linked.reviews ?? 0) >= cfg.maxReviews) {
        linked.pending = { prompt: escalatePrompt(issueId, kind, "observaciones"), close: true };
        log(`#${issueId}: ${mark} sin más pasadas del supervisor en este ciclo → se sube al propietario`);
      } else {
        linked.kind = kind;
        const request = await deps.request(issueId, linked);
        const second = (linked.reviews ?? 0) > 0;
        await deps.setModel(taskId, cfg.reviewModel);
        const startedAt = deps.now();
        await deps.send(taskId, reviewPrompt({ issueId, kind, request, plan: kind === "trabajo" ? linked.plan : undefined, preview, second }));
        linked.review = { startedAt, kind, second, preview };
        linked.reviews = (linked.reviews ?? 0) + 1;
        log(`#${issueId}: ${mark}${preview ? " con vista previa" : " sin vista previa"} → supervisión ${linked.reviews}/${cfg.maxReviews} con ${cfg.reviewModel}`);
      }
    } else if (PUBLISHES.has(mark)) {
      await publishIfFinal(issueId, linked, snap, mark);
    } else {
      log(`#${issueId}: ${mark}${mark === "PLAN" ? " → espera la aprobación del propietario" : mark === "NO ES NUESTRO" ? " → detenido; el propietario decide qué se comenta" : ""}`);
    }
    linked.handledAt = marked.m.createdAt;
    linked.lastMark = mark;
    linked.protocol = 2;
    linked.nudged = false;
    save();
  }

  return { cycle, resetCycle };
}
