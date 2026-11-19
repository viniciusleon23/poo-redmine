/**
 * La agenda para la app y la web. Escucha solo en loopback y pide el token compartido con la
 * pasarela (que es quien comprueba la sesión del propietario y reenvía aquí).
 *
 *   GET  /agenda?desde=YYYY-MM-DD&dias=N        actividades de Poo + lo demás de la agenda, y las peticiones
 *   GET  /agenda/activities/:id/slots?fecha=…   inicios libres de ese día para moverla
 *   POST /agenda/activities/:id/move  {start}   la mueve aquí y en la agenda
 *   POST /agenda/activities/:id/cancel          la quita de aquí y de la agenda
 *   POST /agenda/issues/:id/plan  {hours}       aparta tiempo a mano para una petición
 *   POST /agenda/issues/:id/publish             «Publicar ya»: el cierre no espera al final del bloque
 *   POST /agenda/issues/:id/decision {decision, note?}   lo que decides sin ir al chat: aprobar/ajustar el plan; finalizar, programar, rechazar, esperar o retomar el cierre
 *   POST /agenda/issues/:id/comment  {notes}    tu versión del comentario de cierre: es la que se publica
 *   GET  /agenda/issues/:id/readme              el README para el frontal que dejó Poo, para compartirlo
 *   POST /agenda/sync                           vuelve a leer la agenda ahora
 *   POST /agenda/avisos                         avisos (webhooks) de la agenda, verificados por firma
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CardState, Turn } from "./cards.ts";
import { PlanError } from "./planner.ts";
import type { AgendaItem, Planner } from "./planner.ts";
import { dateKey, dayStart } from "./slots.ts";
import { buildTimeline } from "./timeline.ts";
import type { DayTimeline } from "./timeline.ts";
import type { HistoryEvent, PlanBrief } from "./story.ts";
import type { WorkWeek } from "./slots.ts";

export interface IssueCard {
  /** A quién le toca: al propietario, a Poo o a otra persona (agenda/cards.ts). */
  turn: Turn;
  /** Qué pasa con ella, en una clave que la app convierte en frase. */
  state: CardState;
  /** Quién la tiene cuando ya salió de nuestro lado («Consultoría», «Calidad»…). */
  waitingOn?: string;
  /** Poo corrige lo que observó el supervisor (hay una sola ronda antes de su última pasada). */
  fixing?: boolean;
  issueId: number;
  subject: string;
  url: string;
  taskId?: string;
  status: string;
  priority: string;
  author: string;
  dueDate?: string;
  /** Cuándo se abrió la petición en Redmine. */
  createdAt?: number;
  /** Cuándo la tomó el vigilante (al asignársela al propietario). */
  assignedAt?: number;
  /** Último movimiento de la petición en Redmine. */
  updatedAt?: number;
  /** Última marca `Etapa:` de la conversación. */
  stage?: string;
  estimateMinutes?: number;
  work?: { minutes: number; start: number; end: number };
  startedAt?: number;
  /** Cierre listo que espera al final del bloque. */
  hold?: { until?: number };
  front: { name: string; subtaskId?: number; subtaskUrl?: string; sessions?: number; error?: string }[];
  /** Se le puede apartar tiempo a mano (no tiene bloque). */
  canPlan: boolean;
  /** Lo que piden en una frase: la del plan o, sin plan, la primera de la descripción. */
  brief?: string;
  /** Lo que escribieron en la petición, tal cual. */
  description?: string;
  /** El plan en corto (agenda/story.ts) y cuándo se presentó. */
  plan?: PlanBrief & { at?: number; front?: string[] };
  /** Cuándo se apartó el tiempo (el plan ya estaba aprobado). */
  scheduledAt?: number;
  /** Cuándo cambió de estado por última vez; en las entregadas, cuándo salió de nuestro lado. */
  statusAt?: number;
  /** Lo que falta para cerrarla, según el último cierre del agente. */
  missing?: string;
  /** Lo último que el propietario le dijo a Poo. */
  ownerSaid?: { at: number; text: string };
  /** Pregunta o petición del propietario en Redmine que nadie ha contestado. */
  asked?: { at: number; to: string[]; text: string };
  /** Recorrido con fecha y hora. */
  history: HistoryEvent[];
  /** Lo que puedes decidir ahora mismo desde la Agenda, sin ir al chat. */
  decisions?: IssueDecision[];
  /** El comentario de cierre que se publicará: el que aprobó el supervisor o tu edición. */
  closing?: { notes: string; at: number; edited?: boolean; attachments?: string[] };
  /** Si el trabajo quedó listo antes de tiempo: cuándo termina su bloque. */
  plannedEnd?: number;
  /** README para el frontal que dejó Poo en la conversación. */
  readme?: { name: string; at: number; bytes: number };
  /** Cuándo se le mandó a Poo el arranque del trabajo (empezó su bloque). */
  kickedAt?: number;
  /** Modelo que atiende ahora la conversación fuera de la supervisión: análisis o trabajo. */
  mode?: "analisis" | "trabajo";
  /** Qué quedó publicado en Redmine, en una línea. */
  published?: { at: number; result: string };
}

export type IssueDecision = "aprobar" | "ajustar" | "finalizar" | "programar" | "rechazar" | "esperar" | "retomar";
const DECISIONS: readonly IssueDecision[] = ["aprobar", "ajustar", "finalizar", "programar", "rechazar", "esperar", "retomar"];

export interface AgendaView {
  zone: string;
  now: number;
  today: string;
  from: string;
  days: number;
  workday: { start: number; end: number; days: number[] };
  syncedAt?: number;
  syncError?: string;
  /** El vigilante de Redmine: cuándo leyó Redmine por última vez y cada cuánto lo hace. */
  watch?: WatchBeat;
  items: AgendaItem[];
  /** La jornada completa de cada día, con sus tiempos libres (agenda/timeline.ts). */
  timeline: DayTimeline[];
  issues: IssueCard[];
}

export interface WatchBeat {
  /** Última lectura de Redmine que terminó bien. */
  checkedAt?: number;
  everyMs: number;
  /** Por qué falló la última lectura, si falló. */
  error?: string;
}

export interface AgendaHttpOptions {
  port: number;
  host?: string;
  token: string;
  webhookSecret?: string;
  planner: Planner;
  week: WorkWeek;
  now(): number;
  log(line: string): void;
  issues(): IssueCard[];
  watch?(): WatchBeat;
  publishNow(issueId: number): Promise<void>;
  plan(issueId: number, minutes: number): Promise<void>;
  /** Decisión del propietario desde la Agenda; devuelve qué pasó, en una línea. */
  decide?(issueId: number, decision: IssueDecision, note?: string): Promise<string>;
  /** El propietario edita el comentario de cierre. */
  setComment?(issueId: number, notes: string): Promise<void>;
  /** README para el frontal de esa petición. */
  readme?(issueId: number): Promise<{ name: string; text: string } | undefined>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Firma de un aviso de la agenda: HMAC-SHA256(secreto, "<t>." + cuerpo crudo), con `t` de menos de 5 minutos. */
export function validWebhook(secret: string, header: string, raw: string, nowSeconds: number) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(nowSeconds - t) > 300 || !parts.v1) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return parts.v1.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

function sameToken(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: IncomingMessage, limit = 256 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new PlanError("datos", "El cuerpo es demasiado grande.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const STATUS: Record<PlanError["code"], number> = { sin_hueco: 409, ocupado: 409, no_movible: 409, no_encontrada: 404, datos: 400, agenda: 502, no_aplica: 409 };

/** Construye la vista de `days` días a partir de `from` (YYYY-MM-DD local). */
export function buildView(options: Pick<AgendaHttpOptions, "planner" | "week" | "now" | "issues" | "watch">, from: string | undefined, days: number): AgendaView {
  const { planner, week } = options;
  const now = options.now();
  const today = dateKey(now, week.timeZone);
  const first = from && DATE.test(from) ? from : today;
  const span = Math.min(31, Math.max(1, Math.floor(days) || 7));
  const start = dayStart(first, week.timeZone);
  const items = planner.view(start, start + span * 86_400_000);
  const issues = options.issues();
  return {
    zone: week.timeZone,
    now,
    today,
    from: first,
    days: span,
    workday: { start: week.startMinute, end: week.endMinute, days: week.days },
    syncedAt: planner.state.syncedAt,
    syncError: planner.state.syncError,
    watch: options.watch?.(),
    items,
    timeline: buildTimeline({
      items,
      busy: planner.state.busy ?? [],
      week,
      from: start,
      days: span,
      now,
      issues: new Map(issues.map((c) => [c.issueId, { turn: c.turn, state: c.state }])),
    }),
    issues,
  };
}

export function startAgendaHttp(options: AgendaHttpOptions) {
  const { planner, log } = options;
  const seenWebhooks = new Set<string>();

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://agenda.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "POST" && path === "/agenda/avisos") {
      const raw = await readBody(req);
      if (!options.webhookSecret || !validWebhook(options.webhookSecret, String(req.headers["x-agenda-firma"] ?? ""), raw, options.now() / 1000))
        return send(401, { error: "firma inválida" });
      const id = String(req.headers["x-agenda-id"] ?? "");
      if (id && seenWebhooks.has(id)) return send(200, { recibido: true, repetido: true });
      if (id) {
        seenWebhooks.add(id);
        if (seenWebhooks.size > 500) seenWebhooks.delete(seenWebhooks.values().next().value!);
      }
      // El aviso solo adelanta la lectura: lo que cambió se toma de la propia agenda.
      void planner.sync();
      return send(200, { recibido: true });
    }

    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith("Bearer ") || !sameToken(auth.slice(7), options.token)) return send(401, { error: "No autorizado." });

    if (req.method === "GET" && path === "/agenda")
      return send(200, { data: buildView(options, url.searchParams.get("desde") ?? undefined, Number(url.searchParams.get("dias") ?? 7)) });

    const activity = /^\/agenda\/activities\/([\w-]+)\/(slots|move|cancel)$/.exec(path);
    if (activity) {
      const [, id, action] = activity as unknown as [string, string, string];
      if (req.method === "GET" && action === "slots") {
        const date = url.searchParams.get("fecha") ?? "";
        if (!DATE.test(date)) throw new PlanError("datos", "Falta la fecha (YYYY-MM-DD).");
        return send(200, { data: { date, starts: await planner.slots(id, date) } });
      }
      if (req.method === "POST" && action === "move") {
        const body = JSON.parse((await readBody(req)) || "{}") as { start?: unknown };
        const start = typeof body.start === "number" ? body.start : typeof body.start === "string" ? Date.parse(body.start) : NaN;
        if (!Number.isFinite(start)) throw new PlanError("datos", "Falta el inicio nuevo.");
        return send(200, { data: await planner.move(id, start) });
      }
      if (req.method === "POST" && action === "cancel") return send(200, { data: await planner.cancel(id) });
    }

    const readme = /^\/agenda\/issues\/(\d{1,9})\/readme$/.exec(path);
    if (readme && req.method === "GET") {
      const found = await options.readme?.(Number(readme[1]));
      if (!found) throw new PlanError("no_encontrada", "Esa petición no tiene README para el frontal.");
      return send(200, { data: found });
    }

    const issue = /^\/agenda\/issues\/(\d{1,9})\/(plan|publish|decision|comment)$/.exec(path);
    if (issue && req.method === "POST") {
      const id = Number(issue[1]);
      if (issue[2] === "decision") {
        const body = JSON.parse((await readBody(req)) || "{}") as { decision?: unknown; note?: unknown };
        const decision = DECISIONS.find((d) => d === body.decision);
        if (!decision || !options.decide) throw new PlanError("datos", "Falta la decisión.");
        const done = await options.decide(id, decision, typeof body.note === "string" ? body.note : undefined);
        return send(200, { data: { ok: true, done } });
      }
      if (issue[2] === "comment") {
        const body = JSON.parse((await readBody(req)) || "{}") as { notes?: unknown };
        const notes = typeof body.notes === "string" ? body.notes.trim() : "";
        if (!notes || notes.length > 8000 || !options.setComment) throw new PlanError("datos", "El comentario va de 1 a 8000 caracteres.");
        await options.setComment(id, notes);
        return send(200, { data: { ok: true } });
      }
      if (issue[2] === "publish") {
        await options.publishNow(id);
        return send(200, { data: { ok: true } });
      }
      const body = JSON.parse((await readBody(req)) || "{}") as { hours?: unknown };
      const hours = Number(body.hours);
      if (!(hours >= 0.5 && hours <= 40)) throw new PlanError("datos", "Las horas deben estar entre 0.5 y 40.");
      await options.plan(id, Math.round(hours * 60));
      return send(200, { data: { ok: true } });
    }

    if (req.method === "POST" && path === "/agenda/sync") {
      await planner.sync();
      planner.tick();
      return send(planner.state.syncError ? 502 : 200, planner.state.syncError ? { error: planner.state.syncError } : { data: { syncedAt: planner.state.syncedAt } });
    }

    return send(404, { error: "Ruta no encontrada." });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      const known = err instanceof PlanError;
      if (!known && !(err instanceof SyntaxError)) log(`agenda http: ${err instanceof Error ? err.message : String(err)}`);
      if (res.headersSent) return res.end();
      res.writeHead(known ? STATUS[err.code] : err instanceof SyntaxError ? 400 : 500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(known ? { error: err.message, code: err.code, conflicts: err.conflicts } : { error: err instanceof SyntaxError ? "JSON inválido." : "La agenda no pudo completar la operación." }));
    });
  });
  server.listen(options.port, options.host ?? "127.0.0.1");
  return server;
}
