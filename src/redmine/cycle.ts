/**
 * La máquina de etapas de una incidencia ya enlazada a su conversación: qué hace el vigilante
 * cuando la conversación queda en pausa. Sin red ni disco propios (todo entra por `deps`), para
 * poder probarla con una conversación simulada (tests/redmine-cycle.test.ts).
 *
 * Avanza con la línea `Etapa:` con la que el agente cierra cada mensaje (flow.ts):
 *  - EJECUTADO / RESPUESTA → entra el supervisor; según su veredicto, cierre, corrección o
 *    se le sube al propietario.
 *  - PLAN → espera al propietario; en cuanto lo aprueba (en la Agenda o escribiéndolo) se aparta
 *    el tiempo en la agenda y la petición pasa a «En curso».
 *  - APROBADO → el agente espera su bloque; cuando empieza, el vigilante le manda el arranque
 *    (ya con el modelo de trabajo) y ejecuta.
 *  - CIERRE → el cierre está entregado y decide el propietario: Finalizar (publicar ya), A su
 *    hora, Rechazar o Esperar.
 *  - PROGRAMADO → el propietario eligió «A su hora»: al terminar el bloque el vigilante pide la
 *    publicación (`hold`).
 *  - DESPLEGADO / SIN DESPLIEGUE → ya subió a dev y a producción: se publica el comentario que
 *    aprobó el supervisor (o el que editó el propietario), solo si el propietario lo decidió
 *    después del cierre y el texto no cambió.
 *  - las demás (NO ES NUESTRO, EN ESPERA…) esperan al propietario: no se hace nada.
 */
import { createHash } from "node:crypto";
import type { OwnerDecision, ReviewKind, StageMark } from "./flow.ts";
import type { CloseTiming } from "./flow.ts";
import {
  NEEDS_REVIEW,
  PUBLISHES,
  MARK_LIST,
  afterReview,
  agendaDecisionPrompt,
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
  planDecisionFromQuestion,
  planDecisionFromText,
  publishedPrompt,
  releasePrompt,
  reviewPrompt,
} from "./flow.ts";
import { storyOf } from "../agenda/story.ts";

export type Approved = { hash: string; notes: string; attachments: string[]; at: number; capture?: string; /** Lo editó el propietario en la Agenda: es su texto, no pasa por el supervisor. */ edited?: boolean };
/** Lo que el propietario decide desde la Agenda (botones), sin pasar por el chat. */
export type AgendaDecision = "aprobar" | "ajustar" | "finalizar" | "programar" | "rechazar" | "esperar" | "retomar";
export class DecisionError extends Error {}
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
  /** Ya se anotó que está asignada a otra persona: sus comentarios no se atienden. */
  notOursNoted?: boolean;
  /** Qué se trabaja: la incidencia o la respuesta a un comentario nuevo. */
  kind?: ReviewKind;
  /** Comentarios de Redmine que abrieron la respuesta en curso (para el supervisor). */
  clarify?: string;
  /** Resumen del plan que presentó el agente (lo que aprueba el propietario). */
  plan?: string;
  /** Momento del mensaje que presentó ese plan. */
  planAt?: number;
  /** Desde cuándo los planes de esta conversación se llevan a la agenda (los anteriores al 14/11 no). */
  agendaSince?: number;
  /** Plan (`planAt`) que el propietario ya aprobó. */
  planApproved?: number;
  /** Plan ya llevado a la agenda: cuál (`planAt`), cuándo y qué quedó apartado. */
  scheduled?: { planAt: number; at: number; summary: string };
  /** Aprobado pero la agenda falló: se reintenta en cada sondeo. */
  scheduleRetry?: boolean;
  /** Actividad de la conversación ya revisada en busca de la aprobación del plan, con el agente ocupado. */
  seenBusy?: string;
  /** Cuándo pasó a «En curso» en Redmine (al empezar su bloque de la agenda). */
  startedAt?: number;
  /** Plan (`scheduled.planAt`) para el que ya se hizo el paso a «En curso»: no se repite. */
  startedPlan?: number;
  /** Subtareas y sesiones ya creadas para el frontal, por persona: no se repiten. */
  front?: Record<string, { subtaskId?: number; sessions?: number; error?: string }>;
  /** Cierre listo que espera al final del bloque agendado para publicarse. */
  hold?: { mark: StageMark; until?: number; since: number };
  /** Momento del mensaje con la última marca atendida: lo anterior ya no cuenta. */
  handledAt?: number;
  lastMark?: StageMark;
  /** Supervisión en curso. */
  review?: { startedAt: number; kind: ReviewKind; second: boolean; preview?: Approved };
  /** Pasadas del supervisor y rondas de corrección de este ciclo. */
  reviews?: number;
  fixes?: number;
  /** Mensaje del vigilante por entregar en cuanto la conversación esté en pausa, ya con el modelo que toca. */
  pending?: { prompt: string; close?: boolean; /** Arranca el trabajo: desde aquí la conversación usa el modelo de trabajo. */ work?: boolean };
  /** Con qué modelo se atiende la conversación fuera de la supervisión: análisis (plan, respuestas) o trabajo (ejecución). */
  mode?: "analisis" | "trabajo";
  /** Plan (`scheduled.planAt`) cuyo arranque ya se mandó al agente, y cuándo. */
  kickedPlan?: number;
  kickedAt?: number;
  /** Lo último que el propietario decidió desde la Agenda. */
  decision?: { kind: "plan" | "cierre"; value: "APROBAR" | "AJUSTAR" | OwnerDecision; at: number; note?: string };
  /** Marca que tenía cuando el propietario eligió «Esperar» en la Agenda: «Retomar» la devuelve. */
  pausedFrom?: StageMark;
  /** Ya se le pidió al agente publicar todo (llegó la hora o lo decidió el propietario): el comentario no espera más. */
  releasedAt?: number;
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
  /** Lo último que el propietario le dijo a Poo en la conversación (para la Agenda). */
  ownerSaid?: { at: number; text: string };
  /** «Falta» del último cierre del agente (para la Agenda). */
  missing?: string;
  /** Cuándo se leyó la conversación para lo anterior; sin él se lee una vez al arrancar. */
  storyAt?: number;
  /** Carpeta de trabajo de la conversación (ahí deja el agente el README para el frontal). */
  directory?: string;
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
  publish(issueId: string, approved: Approved, directory: string, kind: ReviewKind): Promise<string>;
  /** Plan aprobado: aparta el tiempo en la agenda (y lo del frontal). Devuelve qué quedó, en una línea. */
  schedule?(issueId: string, linked: Linked): Promise<string>;
  /** ¿Le queda tiempo agendado a la petición? (`until`: cuándo termina su bloque). */
  publishGate?(issueId: string): { wait: boolean; until?: number };
  /** ¿Ya empezó el bloque de trabajo de la petición? */
  workStarted?(issueId: string): boolean;
  /** El mensaje de arranque para el agente (el plan aprobado y cómo ejecutarlo). */
  kickoff?(issueId: string, linked: Linked): Promise<string>;
  /** Hora planificada de fin y hora actual, en texto, si el trabajo quedó listo antes de tiempo. */
  closeTiming?(issueId: string): CloseTiming;
  save(): void;
  log(line: string): void;
  now(): number;
  cfg: { model?: string; /** Modelo del análisis (alcance, plan y respuestas); sin él, todo va con el de trabajo. */ analysisModel?: string; reviewModel?: string; maxFixes: number; maxReviews: number; reviewTimeoutMs: number };
}

export const hashOf = (notes: string) => createHash("sha256").update(normalizeNotes(notes)).digest("hex");
export const isBusy = (status: string) => status === "running" || status === "queued";
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const textOf = (m: ChatMessage) => m.parts.filter((p) => p.kind === "text").map((p) => p.text ?? "").join("\n");

/** Última decisión del propietario tras el cierre: el botón de la pregunta o lo que escribió. */
export const ownerDecision = (snap: Snapshot, since: number): OwnerDecision | undefined => ownerDecisionAt(snap, since)?.decision;

export function ownerDecisionAt(snap: Snapshot, since: number): { at: number; decision: OwnerDecision } | undefined {
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
  return latest;
}

/** Lo que el propietario decidió sobre el plan presentado en `since`: el botón de la pregunta o lo que escribió. */
export function planDecision(snap: Snapshot, since: number): "APROBAR" | "AJUSTAR" | undefined {
  let latest: { at: number; decision: "APROBAR" | "AJUSTAR" } | undefined;
  const consider = (at: number, decision: "APROBAR" | "AJUSTAR" | undefined) => {
    if (decision && at >= since && (!latest || at >= latest.at)) latest = { at, decision };
  };
  for (const m of snap.messages) {
    if (m.role === "assistant") {
      for (const p of m.parts)
        if (p.kind === "tool" && p.tool === "question" && p.status === "completed") consider(m.completedAt ?? m.createdAt, planDecisionFromQuestion(p.output ?? ""));
    } else if (m.role === "user" && m.createdAt > since) {
      const text = textOf(m);
      if (!isWatcherText(text)) consider(m.createdAt, planDecisionFromText(text));
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

/** ¿Hay un cierre entregado que espera la decisión del propietario? */
export const awaitingClose = (linked: Linked) =>
  Boolean(linked.closeAt && !linked.review && !linked.pending?.close && (!linked.published || linked.published.at < linked.closeAt) && !linked.hold);

export function createCycle(deps: CycleDeps) {
  const { cfg, log, save } = deps;

  /** Modelo con el que se atiende la conversación fuera de la supervisión. */
  const home = (linked: Linked) => (linked.mode === "analisis" && cfg.analysisModel ? cfg.analysisModel : cfg.model);

  /** La decisión de cierre vigente: la última entre lo que dijo en el chat y lo que eligió en la Agenda. */
  function closeDecision(linked: Linked, snap: Snapshot): OwnerDecision | undefined {
    if (!linked.closeAt) return undefined;
    const chat = ownerDecisionAt(snap, linked.closeAt);
    const agenda = linked.decision?.kind === "cierre" && linked.decision.at >= linked.closeAt ? linked.decision : undefined;
    if (agenda && (!chat || agenda.at >= chat.at)) return agenda.value as OwnerDecision;
    return chat?.decision;
  }

  /** Tras «DESPLEGADO» o «SIN DESPLIEGUE»: publica el comentario aprobado si el propietario lo decidió. */
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
    const decision = closeDecision(linked, snap);
    if (decision !== "FINALIZAR" && decision !== "PROGRAMAR")
      return notice("vi tu marca de cierre pero no encuentro el «Finalizar» del propietario, así que no publiqué nada en Redmine. Vuelve a entregarle el cierre con la pregunta (Finalizar, Rechazar, Esperar) y cierra con `Etapa: CIERRE`.");
    if (!approved)
      return notice("no hay un comentario aprobado por el supervisor, así que no publiqué nada. Deja la vista previa del comentario de cierre y cierra con `Etapa: EJECUTADO` para que lo revise.");
    const current = deps.readPreview(issueId, Date.parse(linked.linkedAt));
    if (current && current.hash !== approved.hash && !approved.edited)
      return notice("el comentario de la vista previa cambió después de la supervisión, así que no publiqué nada. Cierra con `Etapa: EJECUTADO` (o `Etapa: RESPUESTA`) para que el supervisor revise el texto nuevo.");
    const kind: ReviewKind = linked.kind ?? "trabajo";
    // «A su hora» y el agente subió antes de tiempo: el comentario espera igual al final del bloque.
    const gate = kind === "trabajo" && decision === "PROGRAMAR" && !linked.releasedAt ? deps.publishGate?.(issueId) : undefined;
    if (gate?.wait) {
      if (!linked.hold) log(`#${issueId}: ${mark} con «A su hora» del propietario; el comentario espera al final del bloque agendado (${gate.until ? new Date(gate.until).toISOString() : "sin hora"})`);
      linked.hold = { mark, until: gate.until, since: linked.hold?.since ?? deps.now() };
      return;
    }
    linked.hold = undefined;
    try {
      const result = await deps.publish(issueId, approved, snap.task.directory, kind);
      linked.published = { hash: approved.hash, at: deps.now(), result };
      linked.pending = { prompt: publishedPrompt(issueId, result) };
      log(`#${issueId}: ${mark} con «${decision === "PROGRAMAR" ? "A su hora" : "Finalizar"}» del propietario → comentario publicado por la API (${result})`);
    } catch (err) {
      linked.pending = { prompt: noticePrompt(issueId, `no pude publicar el comentario en Redmine: ${errorText(err)}. No lo publiques tú; dile al propietario el error tal cual.`) };
      log(`#${issueId}: no se pudo publicar (${errorText(err)})`);
    }
  }

  /** Plan presentado y aún sin agendar: si el propietario ya lo aprobó, se aparta el tiempo. */
  const unscheduled = (linked: Linked) =>
    Boolean(deps.schedule && linked.planAt && linked.agendaSince !== undefined && linked.planAt >= linked.agendaSince && linked.scheduled?.planAt !== linked.planAt);

  async function scheduleIfApproved(issueId: string, linked: Linked, snap: Snapshot | undefined, implied = false) {
    if (!unscheduled(linked)) return;
    const planAt = linked.planAt!;
    const inAgenda = linked.decision?.kind === "plan" && linked.decision.value === "APROBAR" && linked.decision.at >= planAt;
    if (!implied && !inAgenda && linked.planApproved !== planAt && (!snap || planDecision(snap, planAt) !== "APROBAR")) return;
    linked.planApproved = planAt;
    try {
      const summary = await deps.schedule!(issueId, linked);
      linked.scheduled = { planAt, at: deps.now(), summary };
      linked.scheduleRetry = undefined;
      log(`#${issueId}: plan aprobado → ${summary}`);
    } catch (err) {
      if (!linked.scheduleRetry) log(`#${issueId}: plan aprobado pero no pude agendarlo (${errorText(err)}); reintento en cada sondeo`);
      linked.scheduleRetry = true;
    }
  }

  /** ¿Ya llegó el bloque de un plan aprobado cuyo arranque no se ha mandado? */
  const kickReady = (issueId: string, linked: Linked) =>
    Boolean(
      deps.kickoff &&
        linked.scheduled &&
        linked.planApproved === linked.scheduled.planAt &&
        linked.kickedPlan !== linked.scheduled.planAt &&
        !linked.review &&
        !linked.pending &&
        (linked.lastMark === "APROBADO" || linked.lastMark === "PLAN" || linked.lastMark === undefined) &&
        deps.workStarted?.(issueId),
    );

  /** Entrega el mensaje pendiente del vigilante, con el modelo que toca. */
  async function flush(issueId: string, linked: Linked, snap: Snapshot) {
    if (!linked.pending || !linked.taskId) return false;
    if (linked.pending.work) linked.mode = "trabajo";
    const model = home(linked);
    if (model && snap.task.model !== model) {
      await deps.setModel(linked.taskId, model);
      log(`#${issueId}: conversación con ${model}`);
    }
    await deps.send(linked.taskId, linked.pending.prompt);
    if (linked.pending.close) {
      linked.closeAt = deps.now();
      linked.noticedAt = undefined;
      linked.releasedAt = undefined;
      // Una decisión de un cierre anterior no vale para este.
      if (linked.decision?.kind === "cierre") linked.decision = undefined;
    }
    linked.pending = undefined;
    save();
    return true;
  }

  /** Avanza la conversación de una incidencia cuando está en pausa. */
  async function cycle(issueId: string, linked: Linked) {
    if (!linked.taskId) return;
    const taskId = linked.taskId;
    const seen = (await deps.conversations()).get(taskId);
    if (!seen) return;
    if (isBusy(seen.status)) {
      // La aprobación se mira aunque el agente esté ocupado (pudo aprobarse a media respuesta).
      if (unscheduled(linked) && linked.seenBusy !== seen.signature) {
        linked.seenBusy = seen.signature;
        await scheduleIfApproved(issueId, linked, await deps.task(taskId));
        save();
      }
      return;
    }
    // Un cierre en espera se revisa en cada sondeo, pero sin pedir el historial hasta que toque publicar.
    const holdReady = Boolean(linked.hold) && !deps.publishGate?.(issueId).wait;
    const waiting = Boolean(linked.review || linked.pending || linked.outbox?.length || holdReady || kickReady(issueId, linked) || (linked.scheduleRetry && unscheduled(linked)));
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
      const timing = deps.closeTiming?.(issueId);
      if (next === "close") {
        linked.approved = review.preview;
        linked.pending = { prompt: closePrompt(issueId, review.kind, timing), close: true };
      } else if (next === "fix") {
        linked.fixes = (linked.fixes ?? 0) + 1;
        linked.pending = { prompt: fixPrompt(issueId, review.kind) };
      } else {
        // El comentario que hay es el que se le enseña al propietario: él decide si se entrega así (o lo edita).
        linked.approved = review.preview ?? linked.approved;
        linked.pending = { prompt: escalatePrompt(issueId, review.kind, verdict ? "observaciones" : "sin-veredicto", timing), close: true };
      }
      // Lo que dijo el supervisor no son marcas del agente.
      linked.handledAt = deps.now();
      linked.review = undefined;
      save();
      log(`#${issueId}: supervisión terminada (${verdict ?? "sin veredicto"}) → ${next === "close" ? "cierre con Finalizar/A su hora/Rechazar/Esperar" : next === "fix" ? `corrección ${linked.fixes}/${cfg.maxFixes}` : "se sube al propietario"}`);
    }

    // 2. Mensaje del vigilante pendiente: se entrega con el modelo que toca.
    if (await flush(issueId, linked, snap)) return;
    if (linked.outbox?.length) {
      const model = home(linked);
      if (model && snap.task.model !== model) await deps.setModel(taskId, model);
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
    linked.directory = snap.task.directory;
    // Para la Agenda: lo último que dijo el propietario y el «Falta» del último cierre.
    const story = storyOf(snap);
    if (story.ownerSaid) linked.ownerSaid = story.ownerSaid;
    if (story.missing) linked.missing = story.missing;
    linked.storyAt = deps.now();

    // El resumen del plan que aprobó el propietario, para el supervisor y la agenda: el último que presentó el agente.
    const planned = assistants.map((m) => ({ at: m.createdAt, plan: extractPlanSummary(textOf(m)) })).filter((x) => x.plan).pop();
    if (planned) {
      linked.plan = planned.plan;
      linked.planAt = planned.at;
    }
    await scheduleIfApproved(issueId, linked, snap);

    // 3b. Llegó la hora de un cierre programado.
    if (linked.hold && holdReady) {
      const held = linked.hold.mark;
      if (held === "PROGRAMADO") {
        linked.hold = undefined;
        linked.releasedAt = deps.now();
        linked.pending = { prompt: releasePrompt(issueId, linked.kind ?? "trabajo", "hora"), work: true };
        log(`#${issueId}: llegó la hora de su cierre programado → se le pide al agente publicar todo (dev y producción)`);
        await flush(issueId, linked, snap);
      } else {
        await publishIfFinal(issueId, linked, snap, held);
      }
      linked.seenActivity = undefined;
      save();
      return;
    }

    // 4. La marca con la que el agente cerró su último mensaje.
    const since = linked.handledAt ?? Date.parse(linked.linkedAt);
    const fresh = assistants.filter((m) => m.createdAt > since && m.completedAt !== undefined);
    const marked = fresh.map((m) => ({ m, mark: parseStage(textOf(m)) })).filter((x) => x.mark).pop();
    if (!marked) {
      // 4b. Empezó el bloque de un plan aprobado: arranque para el agente, con el modelo de trabajo.
      if (kickReady(issueId, linked)) {
        linked.pending = { prompt: await deps.kickoff!(issueId, linked), work: true };
        linked.kickedPlan = linked.scheduled!.planAt;
        linked.kickedAt = deps.now();
        log(`#${issueId}: empezó su bloque → arranque para el agente${cfg.model ? ` con ${cfg.model}` : ""}`);
        await flush(issueId, linked, snap);
        return;
      }
      // Terminó sin marca: se le recuerda una vez por ciclo, solo si conoce el protocolo.
      if (fresh.length && (linked.protocol ?? 0) >= 2 && !linked.nudged && snap.messages.at(-1)?.role === "assistant") {
        await deps.send(taskId, noticePrompt(issueId, `tu último mensaje no cierra con la línea \`Etapa: <marca>\`, y sin ella no puedo avanzar. Repite solo esa línea con la marca que corresponda a lo que ya dijiste (${MARK_LIST}). No repitas el trabajo.`));
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
    // Una marca nueva deja atrás el cierre que esperaba (p. ej. el propietario lo rechazó después).
    if (!PUBLISHES.has(mark) && mark !== "PROGRAMADO") linked.hold = undefined;
    if (mark !== "EN ESPERA") linked.pausedFrom = undefined;
    // Si el agente ya ejecutó, el plan estaba aprobado aunque no se haya visto la aprobación.
    if (mark === "EJECUTADO") await scheduleIfApproved(issueId, linked, snap, true);

    if (NEEDS_REVIEW.has(mark)) {
      const kind: ReviewKind = mark === "RESPUESTA" ? "respuesta" : "trabajo";
      const preview = deps.readPreview(issueId, Date.parse(linked.linkedAt));
      const timing = deps.closeTiming?.(issueId);
      if (!cfg.reviewModel) {
        linked.kind = kind;
        linked.approved = preview;
        linked.pending = { prompt: closePrompt(issueId, kind, timing), close: true };
      } else if ((linked.reviews ?? 0) >= cfg.maxReviews) {
        linked.approved = preview ?? linked.approved;
        linked.pending = { prompt: escalatePrompt(issueId, kind, "observaciones", timing), close: true };
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
    } else if (mark === "PROGRAMADO") {
      const decision = closeDecision(linked, snap);
      if (decision !== "PROGRAMAR" && decision !== "FINALIZAR") {
        linked.pending = { prompt: noticePrompt(issueId, "cerraste con `Etapa: PROGRAMADO` pero no encuentro que el propietario haya elegido «A su hora». Vuelve a entregarle el cierre con la pregunta y cierra con `Etapa: CIERRE`.") };
        log(`#${issueId}: PROGRAMADO sin decisión del propietario; se le avisó`);
      } else {
        const gate = deps.publishGate?.(issueId);
        if (gate?.wait) {
          linked.hold = { mark: "PROGRAMADO", until: gate.until, since: deps.now() };
          log(`#${issueId}: PROGRAMADO → se publica todo al terminar su bloque (${gate.until ? new Date(gate.until).toISOString() : "sin hora"})`);
        } else {
          // Ya no le queda bloque: es la hora.
          linked.releasedAt = deps.now();
          linked.pending = { prompt: releasePrompt(issueId, linked.kind ?? "trabajo", "hora"), work: true };
          log(`#${issueId}: PROGRAMADO y su bloque ya terminó → se le pide publicar ahora`);
        }
      }
    } else if (mark === "APROBADO") {
      await scheduleIfApproved(issueId, linked, snap);
      log(`#${issueId}: APROBADO${linked.scheduled?.planAt === linked.planAt ? " → espera a que empiece su bloque" : " (aún sin agendar: no encuentro la aprobación del propietario o la agenda falló)"}`);
    } else {
      log(`#${issueId}: ${mark}${mark === "PLAN" ? " → espera la aprobación del propietario" : mark === "CIERRE" ? " → espera la decisión de cierre del propietario" : mark === "NO ES NUESTRO" ? " → detenido; el propietario decide qué se comenta" : ""}`);
    }
    linked.handledAt = marked.m.createdAt;
    linked.lastMark = mark;
    linked.protocol = Math.max(linked.protocol ?? 0, 2);
    linked.nudged = false;
    save();
    // El arranque no espera al siguiente sondeo si el bloque ya empezó.
    if (kickReady(issueId, linked)) {
      linked.pending = { prompt: await deps.kickoff!(issueId, linked), work: true };
      linked.kickedPlan = linked.scheduled!.planAt;
      linked.kickedAt = deps.now();
      log(`#${issueId}: su bloque ya empezó → arranque para el agente${cfg.model ? ` con ${cfg.model}` : ""}`);
      await flush(issueId, linked, snap);
    }
  }

  /**
   * Lo que el propietario decide desde la Agenda, sin escribir en el chat. Deja listo lo que
   * sigue (agendar, pedir la publicación, avisar al agente) y lo dispara si la conversación está
   * en pausa. Lanza `DecisionError` si esa decisión no aplica ahora.
   */
  async function decide(issueId: string, linked: Linked, input: { decision: AgendaDecision; note?: string }): Promise<string> {
    if (!linked.taskId) throw new DecisionError("Esa petición no tiene conversación.");
    const now = deps.now();
    const note = input.note?.trim().slice(0, 2000) || undefined;
    let done: string;
    switch (input.decision) {
      case "aprobar":
      case "ajustar": {
        if (!linked.planAt || linked.scheduled?.planAt === linked.planAt) throw new DecisionError("No hay un plan pendiente de aprobar en esta petición.");
        if (input.decision === "aprobar") {
          linked.decision = { kind: "plan", value: "APROBAR", at: now };
          linked.lastMark = "APROBADO";
          await scheduleIfApproved(issueId, linked, undefined);
          done = linked.scheduled?.planAt === linked.planAt ? `Plan aprobado: ${linked.scheduled.summary}.` : "Plan aprobado. La agenda no respondió: lo aparto en cuanto conteste.";
        } else {
          linked.decision = { kind: "plan", value: "AJUSTAR", at: now, note };
          linked.pending = { prompt: agendaDecisionPrompt(issueId, "ajustar", note) };
          done = "Le pedí a Poo ajustar el plan.";
        }
        break;
      }
      case "finalizar":
      case "programar":
      case "rechazar":
      case "esperar": {
        if (!linked.closeAt || linked.review || (linked.published && linked.published.at >= linked.closeAt)) throw new DecisionError("Esta petición no tiene un cierre esperando tu decisión.");
        const kind: ReviewKind = linked.kind ?? "trabajo";
        const gate = kind === "trabajo" ? deps.publishGate?.(issueId) : undefined;
        if (input.decision === "programar" && gate?.wait) {
          linked.decision = { kind: "cierre", value: "PROGRAMAR", at: now };
          linked.hold = { mark: "PROGRAMADO", until: gate.until, since: now };
          linked.lastMark = "PROGRAMADO";
          linked.pausedFrom = undefined;
          done = "Programado: se publica todo (dev, producción y el comentario) al terminar su bloque.";
        } else if (input.decision === "finalizar" || input.decision === "programar") {
          if (!linked.approved) throw new DecisionError("No hay un comentario de cierre listo para publicar.");
          linked.decision = { kind: "cierre", value: "FINALIZAR", at: now };
          linked.hold = undefined;
          linked.pausedFrom = undefined;
          linked.releasedAt = now;
          if (kind === "respuesta") {
            // Una respuesta no tiene nada que subir: se publica sin pedirle otro turno al agente.
            await publishIfFinal(issueId, linked, await deps.task(linked.taskId), "SIN DESPLIEGUE");
            linked.lastMark = "SIN DESPLIEGUE";
            done = linked.published && linked.published.at >= now ? "Respuesta publicada en Redmine." : "No pude publicar la respuesta; Poo te dice por qué en la conversación.";
          } else {
            linked.pending = { prompt: releasePrompt(issueId, kind, "agenda"), work: true };
            linked.lastMark = "CIERRE";
            done = "Poo publica ahora: merge a dev, promoción a producción, verificación y, al terminar, el comentario.";
          }
        } else if (input.decision === "rechazar") {
          linked.decision = { kind: "cierre", value: "RECHAZAR", at: now, note };
          linked.hold = undefined;
          linked.pausedFrom = undefined;
          resetCycle(linked);
          linked.pending = { prompt: agendaDecisionPrompt(issueId, "rechazar", note) };
          done = "Rechazado: Poo corrige y vuelve a entregarte el cierre.";
        } else {
          linked.decision = { kind: "cierre", value: "ESPERAR", at: now };
          linked.hold = undefined;
          linked.pausedFrom = linked.lastMark === "EN ESPERA" ? linked.pausedFrom : linked.lastMark;
          linked.lastMark = "EN ESPERA";
          done = "En espera: no se publica nada hasta que la retomes.";
        }
        break;
      }
      case "retomar": {
        if (linked.lastMark !== "EN ESPERA" || !linked.closeAt || (linked.published && linked.published.at >= linked.closeAt))
          throw new DecisionError("No hay un cierre en espera que retomar; escríbele a Poo en la conversación.");
        linked.lastMark = linked.pausedFrom && linked.pausedFrom !== "EN ESPERA" ? linked.pausedFrom : "CIERRE";
        linked.pausedFrom = undefined;
        linked.decision = undefined;
        done = "Retomada: el cierre vuelve a esperar tu decisión.";
        break;
      }
      default:
        throw new DecisionError("Decisión desconocida.");
    }
    linked.seenActivity = undefined;
    save();
    log(`#${issueId}: decisión del propietario en la Agenda: ${input.decision}${note ? ` («${note.slice(0, 80)}»)` : ""} → ${done}`);
    await cycle(issueId, linked).catch((err) => log(`#${issueId}: ciclo pendiente (${errorText(err)})`));
    return done;
  }

  return { cycle, resetCycle, decide };
}
