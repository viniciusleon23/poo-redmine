/**
 * Planificador: lleva las actividades de las peticiones de Redmine a la agenda del equipo y
 * las mantiene iguales en los dos lados.
 *
 *  - Trabajo de una petición → tiempo apartado en la agenda del propietario, en el primer
 *    hueco libre de su jornada y nunca encimado con otra cosa. Si hoy no cabe, se parte.
 *  - Dependencia con el frontal → sesión con esa persona, cuando los dos están libres.
 *  - Mover una actividad aquí la mueve en la agenda; moverla o quitarla en la agenda se
 *    refleja aquí en el siguiente sondeo (`sync`).
 *
 * Sin red ni reloj propios: todo entra por `deps` (tests/planner.test.ts).
 */
import { AgendaError, SESSION_MINUTES } from "./api.ts";
import type { Agenda, Bloque, Ocupado, Sesion } from "./api.ts";
import { MINUTE, allocate, dateKey, dayStart, isoZoned, overlaps, startsFor, subtract, workWindows } from "./slots.ts";
import type { Interval, WorkWeek } from "./slots.ts";

export type ActivityKind = "trabajo" | "sesion";
export type ActivityState = "planificada" | "en_curso" | "terminada" | "cancelada";
export type Person = { name: string; email: string };

export interface Activity {
  id: string;
  kind: ActivityKind;
  issueId: number;
  subject: string;
  priority: string;
  /** Conversación de Poo IA de la petición. */
  taskId?: string;
  start: number;
  end: number;
  /** Tramo 1 de 2, cuando el tiempo se partió. */
  part: number;
  parts: number;
  /** Con quién es la sesión. */
  with?: Person[];
  remote?: { type: "bloque"; id: number; libre: boolean } | { type: "sesion"; id: string };
  state: ActivityState;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlannerState {
  activities: Activity[];
  /** Peticiones cuyo cierre se adelantó con «Publicar ya». */
  released: Record<string, number>;
  /** Última foto de la agenda del propietario (lo que no es de Poo también se muestra). */
  remote?: { sesiones: Sesion[]; bloques: Bloque[] };
  syncedAt?: number;
  syncError?: string;
}

export const emptyState = (): PlannerState => ({ activities: [], released: {} });

export class PlanError extends Error {
  constructor(
    public code: "sin_hueco" | "no_encontrada" | "no_movible" | "ocupado" | "agenda" | "datos",
    message: string,
    public conflicts?: unknown[],
  ) {
    super(message);
  }
}

export interface PlannerDeps {
  agenda: Agenda;
  week: WorkWeek;
  state: PlannerState;
  now(): number;
  save(): void;
  log(line: string): void;
  uuid(): string;
  issueUrl(issueId: number): string;
  /** Días hacia delante en los que se busca hueco (la agenda da hasta 14 por consulta). */
  horizonDays?: number;
  /** Margen entre «ahora» y el primer inicio posible. */
  leadMinutes?: number;
}

/** Elemento de la vista: una actividad de Poo o algo que ya estaba en la agenda. */
export interface AgendaItem {
  id: string;
  source: "poo" | "agenda";
  kind: "trabajo" | "sesion" | "bloque";
  title: string;
  start: number;
  end: number;
  state?: ActivityState;
  activityId?: string;
  issueId?: number;
  issueUrl?: string;
  taskId?: string;
  priority?: string;
  part?: number;
  parts?: number;
  with?: string[];
  organizer?: string;
  movable: boolean;
  note?: string;
}

const STEP = 30;
const active = (a: Activity) => a.state === "planificada" || a.state === "en_curso";
const ms = (iso: string) => Date.parse(iso);
const busyOf = (ocupado: Ocupado[]): Interval[] => ocupado.map((o) => ({ start: ms(o.inicio), end: ms(o.fin) }));
const sameSpan = (a: Interval, b: Interval) => Math.abs(a.start - b.start) < MINUTE && Math.abs(a.end - b.end) < MINUTE;

export function createPlanner(deps: PlannerDeps) {
  const { agenda, week, state, log } = deps;
  const horizon = Math.min(deps.horizonDays ?? 14, 14);
  const lead = deps.leadMinutes ?? 5;
  const iso = (t: number) => isoZoned(t, week.timeZone);
  const touch = (a: Activity) => (a.updatedAt = deps.now());

  // Las operaciones que escriben van de una en una: dos a la vez verían los mismos huecos.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  /** Huecos comunes de esas personas dentro de la jornada, entre `from` y `to`. */
  async function free(emails: string[], from: number, to: number, ignore: Interval[] = []): Promise<Interval[]> {
    const people = await agenda.disponibilidad(emails, iso(from), iso(to));
    const busy = people.flatMap((p) => busyOf(p.ocupado)).filter((b) => !ignore.some((i) => sameSpan(i, b)));
    return subtract(workWindows(from, to, week), busy);
  }

  const earliest = () => deps.now() + lead * MINUTE;

  async function removeRemote(a: Activity) {
    if (!a.remote) return;
    try {
      if (a.remote.type === "bloque") await agenda.quitarBloque(a.remote.id);
      else await agenda.cancelarSesion(a.remote.id);
    } catch (err) {
      // Ya no estaba: es lo que se quería.
      if (!(err instanceof AgendaError && err.status === 404)) throw err;
    }
  }

  /** Aparta un tramo: ligado a la petición si la agenda lo permite; si no, bloque libre con su enlace. */
  async function block(a: Pick<Activity, "id" | "issueId" | "subject">, span: Interval, libre: boolean) {
    const minutes = Math.round((span.end - span.start) / MINUTE);
    if (!libre) {
      try {
        const b = await agenda.apartarPeticion(a.issueId, iso(span.start), minutes);
        return { type: "bloque" as const, id: b.id, libre: false };
      } catch (err) {
        // 409 es un choque de horario: no se disfraza de bloque libre. Lo demás (la agenda no
        // reconoce la petición o a la persona) cae al bloque libre.
        if (!(err instanceof AgendaError) || err.status === 409 || err.status === 0 || err.status >= 500) throw err;
        log(`#${a.issueId}: la agenda no ligó el bloque a la petición (${err.codigo}: ${err.message}); va como bloque libre`);
      }
    }
    const b = await agenda.apartarLibre({
      titulo: `#${a.issueId} ${a.subject}`.slice(0, 120),
      inicio: iso(span.start),
      duracion_minutos: minutes,
      enlace: deps.issueUrl(a.issueId),
      referencia: `poo-${a.id}`,
    });
    return { type: "bloque" as const, id: b.id, libre: true };
  }

  const asPlanError = (err: unknown) =>
    err instanceof PlanError
      ? err
      : err instanceof AgendaError
        ? new PlanError(err.status === 409 ? "ocupado" : "agenda", err.message, err.conflictos)
        : new PlanError("agenda", err instanceof Error ? err.message : String(err));

  const planner = {
    state,

    activitiesOf: (issueId: number | string) => state.activities.filter((a) => a.issueId === Number(issueId)),

    /**
     * Aparta `minutes` de trabajo para la petición en los primeros huecos libres. Si ya tenía
     * tramos sin empezar, los sustituye (plan reaprobado con otro tiempo).
     */
    scheduleWork: (input: { issueId: number; subject: string; priority: string; taskId?: string; minutes: number }) =>
      exclusive(async () => {
        const minutes = Math.max(STEP, Math.ceil(input.minutes / STEP) * STEP);
        try {
          for (const old of state.activities.filter((a) => a.issueId === input.issueId && a.kind === "trabajo" && a.state === "planificada")) {
            await removeRemote(old);
            old.state = "cancelada";
            old.note = "sustituida por un plan nuevo";
            touch(old);
          }
          const from = earliest();
          const gaps = await free([agenda.user], from, from + horizon * 86_400_000);
          const spans = allocate(gaps, minutes, { step: STEP, minChunk: 60, maxChunk: 480 });
          if (!spans) throw new PlanError("sin_hueco", `No hay ${minutes} minutos libres en tu agenda en los próximos ${horizon} días.`);
          const created: Activity[] = [];
          let libre = false;
          for (const [i, span] of spans.entries()) {
            const a: Activity = {
              id: `act_${deps.uuid().slice(0, 8)}`,
              kind: "trabajo",
              issueId: input.issueId,
              subject: input.subject,
              priority: input.priority,
              taskId: input.taskId,
              start: span.start,
              end: span.end,
              part: i + 1,
              parts: spans.length,
              state: "planificada",
              createdAt: deps.now(),
              updatedAt: deps.now(),
            };
            a.remote = await block(a, span, libre);
            libre = a.remote.type === "bloque" && a.remote.libre;
            state.activities.push(a);
            created.push(a);
            deps.save();
          }
          delete state.released[String(input.issueId)];
          deps.save();
          return created;
        } catch (err) {
          deps.save();
          throw asPlanError(err);
        }
      }),

    /** Sesión con alguien del frontal: tramos de hasta 2 h, cuando los dos están libres, a partir de `after`. */
    scheduleSession: (input: { issueId: number; subject: string; priority: string; taskId?: string; person: Person; minutes: number; after?: number; detail?: string }) =>
      exclusive(async () => {
        const minutes = Math.max(STEP, Math.ceil(input.minutes / STEP) * STEP);
        try {
          const from = Math.max(earliest(), input.after ?? 0);
          const gaps = await free([agenda.user, input.person.email], from, from + horizon * 86_400_000);
          const spans = allocate(gaps, minutes, { step: STEP, minChunk: STEP, maxChunk: 120, sizes: SESSION_MINUTES.filter((s) => s >= STEP) });
          if (!spans) throw new PlanError("sin_hueco", `No hay ${minutes} minutos en común con ${input.person.name} en los próximos ${horizon} días.`);
          const created: Activity[] = [];
          for (const [i, span] of spans.entries()) {
            const sesion = await agenda.crearSesion({
              titulo: `#${input.issueId} · Frontal: ${input.subject}`.slice(0, 120),
              descripcion: [input.detail?.trim(), deps.issueUrl(input.issueId), spans.length > 1 ? `Parte ${i + 1} de ${spans.length}.` : ""].filter(Boolean).join("\n"),
              inicio: iso(span.start),
              duracion_minutos: Math.round((span.end - span.start) / MINUTE),
              invitados: [input.person.email],
            });
            const a: Activity = {
              id: `act_${deps.uuid().slice(0, 8)}`,
              kind: "sesion",
              issueId: input.issueId,
              subject: input.subject,
              priority: input.priority,
              taskId: input.taskId,
              start: span.start,
              end: span.end,
              part: i + 1,
              parts: spans.length,
              with: [input.person],
              remote: { type: "sesion", id: sesion.id },
              state: "planificada",
              createdAt: deps.now(),
              updatedAt: deps.now(),
            };
            state.activities.push(a);
            created.push(a);
            deps.save();
          }
          return created;
        } catch (err) {
          deps.save();
          throw asPlanError(err);
        }
      }),

    /** Inicios libres de un día para mover esa actividad (cada 30 minutos). */
    async slots(activityId: string, date: string): Promise<number[]> {
      const a = state.activities.find((x) => x.id === activityId);
      if (!a) throw new PlanError("no_encontrada", "Esa actividad ya no existe.");
      const from = Math.max(dayStart(date, week.timeZone), earliest());
      const to = dayStart(date, week.timeZone) + 86_400_000;
      if (to <= from) return [];
      try {
        const gaps = await free([agenda.user, ...(a.with ?? []).map((p) => p.email)], from, to, [{ start: a.start, end: a.end }]);
        return startsFor(gaps, Math.round((a.end - a.start) / MINUTE), STEP).filter((t) => t !== a.start);
      } catch (err) {
        throw asPlanError(err);
      }
    },

    /** Mueve una actividad sin empezar a otro inicio, aquí y en la agenda. */
    move: (activityId: string, start: number) =>
      exclusive(async () => {
        const a = state.activities.find((x) => x.id === activityId);
        if (!a) throw new PlanError("no_encontrada", "Esa actividad ya no existe.");
        if (a.state !== "planificada") throw new PlanError("no_movible", "Solo se mueve lo que aún no empieza.");
        if (!Number.isFinite(start) || start < deps.now()) throw new PlanError("datos", "El horario nuevo ya pasó.");
        const span = { start, end: start + (a.end - a.start) };
        if (sameSpan(span, a)) return a;
        try {
          const day = dayStart(dateKey(start, week.timeZone), week.timeZone);
          const gaps = await free([agenda.user, ...(a.with ?? []).map((p) => p.email)], day, day + 86_400_000, [{ start: a.start, end: a.end }]);
          if (!gaps.some((g) => g.start <= span.start && span.end <= g.end))
            throw new PlanError("ocupado", "Ese horario no está libre o queda fuera de la jornada.");
          // Tampoco se encima con otra actividad de Poo que la agenda aún no refleje.
          if (state.activities.some((o) => o.id !== a.id && active(o) && overlaps(o, span)))
            throw new PlanError("ocupado", "Ese horario choca con otra actividad planificada.");
          if (a.remote?.type === "sesion") {
            await agenda.moverSesion(a.remote.id, { inicio: iso(span.start) });
          } else if (a.remote?.type === "bloque") {
            // La agenda no tiene «mover bloque»: se quita y se aparta de nuevo; si el nuevo no entra, se repone el anterior.
            const previous = { start: a.start, end: a.end };
            const libre = a.remote.libre;
            await removeRemote(a);
            try {
              a.remote = await block(a, span, libre);
            } catch (err) {
              a.remote = await block(a, previous, libre).catch(() => undefined);
              if (!a.remote) {
                a.note = "no se pudo reponer en la agenda; vuelve a moverla";
                touch(a);
                deps.save();
              }
              throw err;
            }
          }
          a.start = span.start;
          a.end = span.end;
          a.note = "movida por ti";
          touch(a);
          deps.save();
          log(`#${a.issueId}: ${a.kind} movido a ${iso(a.start)}`);
          return a;
        } catch (err) {
          throw asPlanError(err);
        }
      }),

    /** Quita una actividad sin empezar de aquí y de la agenda. */
    cancel: (activityId: string, note = "cancelada por ti") =>
      exclusive(async () => {
        const a = state.activities.find((x) => x.id === activityId);
        if (!a) throw new PlanError("no_encontrada", "Esa actividad ya no existe.");
        if (!active(a)) return a;
        try {
          if (a.state === "planificada") await removeRemote(a);
          a.state = "cancelada";
          a.note = note;
          touch(a);
          deps.save();
          return a;
        } catch (err) {
          throw asPlanError(err);
        }
      }),

    /** ¿Hay que esperar para publicar el cierre? Sí mientras quede tiempo agendado y no se haya adelantado. */
    gate(issueId: number | string): { wait: boolean; until?: number } {
      if (state.released[String(issueId)]) return { wait: false };
      const pending = planner.activitiesOf(issueId).filter((a) => a.kind === "trabajo" && active(a) && a.end > deps.now());
      if (!pending.length) return { wait: false };
      return { wait: true, until: Math.max(...pending.map((a) => a.end)) };
    },

    /** «Publicar ya»: el cierre deja de esperar al final del bloque. */
    release(issueId: number | string) {
      state.released[String(issueId)] = deps.now();
      deps.save();
    },

    /** ¿Ya llegó la hora de empezar la petición? (primer tramo de trabajo alcanzado). */
    workStarted(issueId: number | string) {
      return planner.activitiesOf(issueId).some((a) => a.kind === "trabajo" && a.state !== "cancelada" && a.start <= deps.now());
    },

    /** Tiempo de trabajo agendado para la petición (lo no cancelado) y cuándo termina. */
    workPlan(issueId: number | string) {
      const work = planner.activitiesOf(issueId).filter((a) => a.kind === "trabajo" && a.state !== "cancelada");
      if (!work.length) return undefined;
      return {
        minutes: work.reduce((n, a) => n + Math.round((a.end - a.start) / MINUTE), 0),
        start: Math.min(...work.map((a) => a.start)),
        end: Math.max(...work.map((a) => a.end)),
      };
    },

    /** Tras publicar el cierre: lo que no había empezado se libera de la agenda y lo demás queda terminado. */
    finish: (issueId: number | string) =>
      exclusive(async () => {
        for (const a of planner.activitiesOf(issueId).filter(active)) {
          if (a.kind === "trabajo" && a.state === "planificada" && a.start > deps.now()) {
            await removeRemote(a).catch((err) => log(`#${issueId}: no pude liberar el bloque de la agenda (${err instanceof Error ? err.message : err})`));
            a.state = "cancelada";
            a.note = "liberada: la petición se cerró antes";
          } else if (a.kind === "trabajo") {
            a.state = "terminada";
          }
          touch(a);
        }
        deps.save();
      }),

    /** Avanza los estados según el reloj. Devuelve lo que cambió. */
    tick() {
      const now = deps.now();
      const changed: Activity[] = [];
      for (const a of state.activities) {
        const next: ActivityState | undefined = !active(a) ? undefined : a.end <= now ? "terminada" : a.start <= now ? "en_curso" : undefined;
        if (next && next !== a.state) {
          a.state = next;
          touch(a);
          changed.push(a);
        }
      }
      // Lo terminado o cancelado hace más de 60 días ya no se guarda.
      const keep = state.activities.filter((a) => active(a) || a.end > now - 60 * 86_400_000);
      const pruned = keep.length !== state.activities.length;
      if (pruned) state.activities.splice(0, state.activities.length, ...keep);
      if (changed.length || pruned) deps.save();
      return changed;
    },

    /** Lee la agenda y refleja aquí lo que se movió o se quitó allá. */
    sync: () =>
      exclusive(async () => {
        const now = deps.now();
        const from = now - 86_400_000;
        const to = now + 21 * 86_400_000;
        try {
          const remote = await agenda.miAgenda(iso(from), iso(to));
          state.remote = remote;
          const bloques = new Map(remote.bloques.map((b) => [b.id, b]));
          const sesiones = new Map(remote.sesiones.map((s) => [s.id, s]));
          for (const a of state.activities) {
            if (a.state !== "planificada" || !a.remote || a.start < from || a.start > to) continue;
            const found = a.remote.type === "bloque" ? bloques.get(a.remote.id) : sesiones.get(a.remote.id);
            const gone = !found || ("activo" in found ? !found.activo : found.estado === "cancelada");
            if (gone) {
              a.state = "cancelada";
              a.note = "quitada desde la agenda";
              touch(a);
              log(`#${a.issueId}: ${a.kind} quitado desde la agenda`);
              continue;
            }
            const span = { start: ms(found.inicio), end: ms(found.fin) };
            if (!sameSpan(span, a)) {
              a.start = span.start;
              a.end = span.end;
              a.note = "movida desde la agenda";
              touch(a);
              log(`#${a.issueId}: ${a.kind} movido desde la agenda a ${iso(a.start)}`);
            }
          }
          state.syncedAt = now;
          state.syncError = undefined;
        } catch (err) {
          state.syncError = err instanceof Error ? err.message : String(err);
        }
        deps.save();
      }),

    /** Lo que se muestra en la app: actividades de Poo y lo demás de la agenda, entre dos días. */
    view(from: number, to: number): AgendaItem[] {
      const items: AgendaItem[] = [];
      const mine = new Set<string>();
      for (const a of state.activities) {
        if (a.remote) mine.add(`${a.remote.type}:${a.remote.id}`);
        if (a.end <= from || a.start >= to || (a.state === "cancelada" && !a.note?.includes("agenda"))) continue;
        items.push({
          id: a.id,
          source: "poo",
          kind: a.kind,
          title: a.kind === "sesion" ? `Sesión con ${(a.with ?? []).map((p) => p.name).join(" y ")} · #${a.issueId}` : `#${a.issueId} ${a.subject}`,
          start: a.start,
          end: a.end,
          state: a.state,
          activityId: a.id,
          issueId: a.issueId,
          issueUrl: deps.issueUrl(a.issueId),
          taskId: a.taskId,
          priority: a.priority,
          part: a.part,
          parts: a.parts,
          with: a.with?.map((p) => p.name),
          movable: a.state === "planificada",
          note: a.note,
        });
      }
      for (const s of state.remote?.sesiones ?? []) {
        const span = { start: ms(s.inicio), end: ms(s.fin) };
        if (mine.has(`sesion:${s.id}`) || s.estado === "cancelada" || span.end <= from || span.start >= to) continue;
        items.push({
          id: `sesion:${s.id}`,
          source: "agenda",
          kind: "sesion",
          title: s.titulo,
          ...span,
          with: s.asistentes.filter((p) => p.correo !== agenda.user).map((p) => p.nombre),
          organizer: s.asistentes.find((p) => p.correo === s.organizador)?.nombre ?? s.organizador,
          movable: false,
        });
      }
      for (const b of state.remote?.bloques ?? []) {
        const span = { start: ms(b.inicio), end: ms(b.fin) };
        if (mine.has(`bloque:${b.id}`) || !b.activo || span.end <= from || span.start >= to) continue;
        items.push({
          id: `bloque:${b.id}`,
          source: "agenda",
          kind: "bloque",
          title: b.titulo,
          ...span,
          issueId: b.redmine_id ?? undefined,
          issueUrl: b.redmine_id ? deps.issueUrl(b.redmine_id) : undefined,
          movable: false,
        });
      }
      return items.sort((a, b) => a.start - b.start || a.end - b.end);
    },
  };
  return planner;
}

export type Planner = ReturnType<typeof createPlanner>;

// ---------- lo que el plan dice sobre tiempo y frontal ----------

/**
 * Horas de trabajo que el agente estimó en su plan («Tiempo estimado: 3 h», «2.5 horas»,
 * «2:30», «90 min»). Devuelve minutos, redondeados hacia arriba a media hora.
 */
export function parseEstimate(plan: string): number | undefined {
  const line = plan.split("\n").find((l) => /tiempo\s+estimado/i.test(l));
  if (!line) return undefined;
  const text = line.replace(/[*_`]/g, "").replace(/^.*?tiempo\s+estimado\s*:?/i, "");
  let minutes: number | undefined;
  const clock = /(\d{1,2}):(\d{2})/.exec(text);
  const hours = /(\d+(?:[.,]\d+)?)\s*(?:h\b|hrs?\b|horas?\b)/i.exec(text);
  const mins = /(\d+)\s*(?:min\b|minutos?\b)/i.exec(text);
  if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2]);
  else if (hours || mins) minutes = Math.round(Number((hours?.[1] ?? "0").replace(",", ".")) * 60) + Number(mins?.[1] ?? 0);
  if (!minutes || !Number.isFinite(minutes)) return undefined;
  return Math.min(40 * 60, Math.max(30, Math.ceil(minutes / 30) * 30));
}

/**
 * A quién del frontal involucra el plan («Dependencia frontal: Daniel — pantalla X») y qué
 * tiene que hacer. «ninguna», «no» o la línea ausente: nadie.
 */
export function parseFront<T extends { key: string; name: string }>(plan: string, people: readonly T[]): { people: T[]; detail: string } {
  const line = plan.split("\n").find((l) => /dependencia\s+(?:del\s+|con\s+el\s+)?frontal/i.test(l));
  if (!line) return { people: [], detail: "" };
  const text = line.replace(/[*_`]/g, "").replace(/^.*?frontal\s*:?/i, "").trim();
  if (!text || /^(?:ninguna|ninguno|no\b|n\/a|sin\b|—|-)\s*\.?$/i.test(text) || /^(?:ninguna|ninguno|no hay|no aplica|sin dependencia)/i.test(text))
    return { people: [], detail: "" };
  const found = people.filter((p) => new RegExp(`(?<![\\p{L}])${p.key}(?![\\p{L}])`, "iu").test(text));
  const detail = text.replace(/^[^—:–-]*[—:–-]\s*/, "").trim();
  return { people: found, detail: found.length ? detail : "" };
}

/** Duración de la sesión con el frontal según la prioridad de Redmine: baja 1 h, media 2:30, alta 4 h. */
export function sessionMinutes(priority: string): number {
  const p = priority.trim().toLowerCase();
  if (/alt|cr[ií]tic|urgent|inmediat/.test(p)) return 240;
  if (/medi|normal/.test(p)) return 150;
  return 60;
}
