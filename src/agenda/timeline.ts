/**
 * La jornada completa, hora por hora: lo que Poo tiene apartado, lo demás de la agenda, lo que
 * la agenda marca como ocupado (comida, ausencias, festivos) y **los tiempos libres**, para que
 * el propietario vea de un vistazo en qué se va el día y cuánto queda sin ocupar.
 * Puro; lo prueba tests/timeline.test.ts.
 */
import type { Ocupado } from "./api.ts";
import type { CardState, Turn } from "./cards.ts";
import type { ActivityState, AgendaItem } from "./planner.ts";
import { MINUTE, dateKey, dayStart, merge, subtract, workWindows } from "./slots.ts";
import type { Interval, WorkWeek } from "./slots.ts";

export type SegmentKind = "trabajo" | "sesion" | "bloque" | "ocupado" | "libre";

/** En qué va un tramo de trabajo de Poo, dicho para el propietario. */
export type SegmentPhase =
  | "por_empezar" // apartado; aún no llega su hora
  | "en_curso" // es su hora y Poo lo lleva
  | "espera_plan" // falta que apruebes el plan
  | "espera_cierre" // el trabajo está listo: falta tu decisión de cierre
  | "programado" // listo; se publica solo a su hora
  | "pausado" // lo dejaste en espera
  | "bloqueado" // Poo necesita algo de ti
  | "hecho" // el tramo ya pasó
  | "publicado"; // la petición ya se entregó

export interface Segment {
  start: number;
  end: number;
  minutes: number;
  kind: SegmentKind;
  title: string;
  /** De quién es: de Poo, de la agenda del equipo, o nada (libre). */
  source?: "poo" | "agenda";
  itemId?: string;
  activityId?: string;
  issueId?: number;
  taskId?: string;
  state?: ActivityState;
  part?: number;
  parts?: number;
  with?: string[];
  movable?: boolean;
  /** Por qué está ocupado cuando no es una actividad: comida, ausencia, festivo… */
  reason?: string;
  /** ¿Ya pasó, es ahora o viene después? */
  when: "pasado" | "ahora" | "despues";
  /** Solo en tramos de Poo: en qué va. */
  phase?: SegmentPhase;
  /** A quién le toca la petición del tramo. */
  turn?: Turn;
}

export interface DayTimeline {
  date: string;
  /** ¿Es día laborable según la jornada configurada? */
  workday: boolean;
  /** Inicio y fin de la jornada de ese día (aunque no haya nada apartado). */
  start: number;
  end: number;
  segments: Segment[];
  /** Minutos de la jornada: lo de Poo, lo demás ocupado y lo libre. */
  minutes: { jornada: number; poo: number; otros: number; libre: number; libreRestante: number };
}

export interface IssuePhaseInput {
  turn: Turn;
  state: CardState;
  /** La petición ya se entregó (salió de nuestro lado). */
  delivered?: boolean;
}

const REASONS: Record<string, string> = { comida: "Comida", ausencia: "Ausencia", festivo: "Festivo", externo: "Compromiso", sesion: "Sesión", fuera: "Fuera de horario" };

const clip = (i: Interval, w: Interval): Interval | undefined => {
  const out = { start: Math.max(i.start, w.start), end: Math.min(i.end, w.end) };
  return out.end > out.start ? out : undefined;
};
const total = (list: Interval[]) => merge(list).reduce((n, i) => n + Math.round((i.end - i.start) / MINUTE), 0);
const near = (a: Interval, b: Interval) => Math.abs(a.start - b.start) < MINUTE && Math.abs(a.end - b.end) < MINUTE;

/** En qué va un tramo de trabajo, según el reloj y el estado de su petición. */
export function phaseOf(segment: Interval & { state?: ActivityState }, issue: IssuePhaseInput | undefined, now: number): SegmentPhase {
  if (issue?.delivered || issue?.state === "entregada") return "publicado";
  if (issue?.state === "lista") return "programado";
  if (issue?.state === "cierre") return "espera_cierre";
  if (issue?.state === "plan") return "espera_plan";
  if (issue?.state === "pausa" || issue?.state === "correccion") return "pausado";
  if (issue?.state === "bloqueo" || issue?.state === "ajeno") return "bloqueado";
  if (segment.end <= now || segment.state === "terminada") return "hecho";
  if (segment.start <= now) return "en_curso";
  return "por_empezar";
}

/**
 * La jornada de cada día entre `from` y `to` (inicios de día locales), en tramos consecutivos.
 * Lo que cae fuera de la jornada (una sesión a las 19:00) se muestra igual, en su hora.
 */
export function buildTimeline(input: {
  items: AgendaItem[];
  busy: Ocupado[];
  week: WorkWeek;
  from: number;
  days: number;
  now: number;
  issues?: Map<number, IssuePhaseInput>;
}): DayTimeline[] {
  const { week, now } = input;
  const out: DayTimeline[] = [];
  const live = input.items.filter((i) => i.state !== "cancelada");
  const firstKey = dateKey(input.from, week.timeZone);
  const [y, m, d] = firstKey.split("-").map(Number) as [number, number, number];
  for (let n = 0; n < input.days; n++) {
    // Días locales por calendario: sumar 24 h fallaría en un cambio de hora.
    const noon = new Date(Date.UTC(y, m - 1, d + n, 12));
    const key = `${noon.getUTCFullYear()}-${String(noon.getUTCMonth() + 1).padStart(2, "0")}-${String(noon.getUTCDate()).padStart(2, "0")}`;
    const day = { start: dayStart(key, week.timeZone), end: 0 };
    const next = new Date(Date.UTC(y, m - 1, d + n + 1, 12));
    day.end = dayStart(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`, week.timeZone);
    const window = workWindows(day.start, day.end, week)[0];
    const shift: Interval = window ?? { start: day.start + week.startMinute * MINUTE, end: day.start + week.endMinute * MINUTE };

    const segments: Segment[] = [];
    const when = (i: Interval): Segment["when"] => (i.end <= now ? "pasado" : i.start <= now ? "ahora" : "despues");
    const push = (s: Omit<Segment, "minutes" | "when">) => segments.push({ ...s, minutes: Math.round((s.end - s.start) / MINUTE), when: when(s) });

    const dayItems = live.filter((i) => i.end > day.start && i.start < day.end);
    for (const i of dayItems) {
      const span = clip(i, day)!;
      const issue = i.issueId !== undefined ? input.issues?.get(i.issueId) : undefined;
      push({
        ...span,
        kind: i.kind,
        title: i.title,
        source: i.source,
        itemId: i.id,
        activityId: i.activityId,
        issueId: i.issueId,
        taskId: i.taskId,
        state: i.state,
        part: i.part,
        parts: i.parts,
        with: i.with,
        movable: i.movable,
        ...(i.source === "poo" && i.kind === "trabajo" ? { phase: phaseOf({ ...span, state: i.state }, issue, now) } : {}),
        ...(issue ? { turn: issue.turn } : {}),
      });
    }

    // Lo que la agenda da por ocupado y no es una actividad ya listada: comida, ausencias, festivos.
    const others: (Interval & { reason: string; title: string })[] = [];
    for (const o of input.busy) {
      const span = clip({ start: Date.parse(o.inicio), end: Date.parse(o.fin) }, window ?? day);
      if (!span || o.tipo === "fuera") continue;
      if (dayItems.some((i) => near(i, { start: Date.parse(o.inicio), end: Date.parse(o.fin) }) || (i.start <= span.start && span.end <= i.end))) continue;
      const reason = REASONS[o.tipo] ?? "Ocupado";
      others.push({ ...span, reason, title: o.titulo?.trim() || reason });
    }
    for (const o of others) push({ start: o.start, end: o.end, kind: "ocupado", title: o.title, source: "agenda", reason: o.reason });

    const occupied = [...dayItems.map((i) => clip(i, day)!), ...others];
    const free = window ? subtract([window], occupied) : [];
    for (const f of free) push({ ...f, kind: "libre", title: "Libre" });

    segments.sort((a, b) => a.start - b.start || a.end - b.end);
    const inShift = (list: Interval[]) => (window ? total(list.map((i) => clip(i, window)).filter((i): i is Interval => Boolean(i))) : 0);
    const poo = inShift(dayItems.filter((i) => i.source === "poo"));
    const busyAll = inShift(occupied);
    out.push({
      date: key,
      workday: Boolean(window),
      start: shift.start,
      end: shift.end,
      segments,
      minutes: {
        jornada: window ? Math.round((window.end - window.start) / MINUTE) : 0,
        poo,
        otros: Math.max(0, busyAll - poo),
        libre: total(free),
        libreRestante: total(free.map((f) => clip(f, { start: now, end: Infinity })).filter((i): i is Interval => Boolean(i))),
      },
    });
  }
  return out;
}
