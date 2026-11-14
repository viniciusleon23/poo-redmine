/**
 * Cálculo de huecos, sin red ni reloj propios: jornada laboral en la zona del equipo, resta
 * de lo ocupado y reparto de un tiempo en uno o varios tramos («2 horas hoy y 2 mañana»).
 * tests/slots.test.ts lo prueba.
 */

export type Interval = { start: number; end: number };

export interface WorkWeek {
  timeZone: string;
  /** Minuto del día en que empieza y termina la jornada (9:00 → 540, 18:00 → 1080). */
  startMinute: number;
  endMinute: number;
  /** Días laborables, 1 = lunes … 7 = domingo. */
  days: number[];
}

export const MINUTE = 60_000;
const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}
const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Fecha y hora de un instante vistas en una zona horaria. */
export function zonedParts(ms: number, timeZone: string) {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? "Mon"] ?? 1,
  };
}

/** Desfase de la zona respecto a UTC en ese instante (ms; negativo al oeste). */
export function zoneOffset(ms: number, timeZone: string) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Instante de una fecha y hora locales de la zona. */
export function zonedMs(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffset(guess, timeZone);
  const second = guess - zoneOffset(first, timeZone);
  return second;
}

/** Día local (YYYY-MM-DD) de un instante. */
export function dateKey(ms: number, timeZone: string) {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** ISO 8601 con el desfase de la zona, como lo espera la agenda: 2026-11-20T10:00:00-06:00. */
export function isoZoned(ms: number, timeZone: string) {
  const p = zonedParts(ms, timeZone);
  const offset = Math.round(zoneOffset(ms, timeZone) / MINUTE);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}:${two(p.second)}${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

/** Inicio (00:00 local) del día `key` (YYYY-MM-DD). */
export function dayStart(key: string, timeZone: string) {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return zonedMs(y, m, d, 0, 0, timeZone);
}

/** «9:30», «09:30» o «9» → minuto del día. */
export function parseClock(value: string, fallback: number) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(value);
  if (!m) return fallback;
  const minutes = Number(m[1]) * 60 + Number(m[2] ?? 0);
  return minutes >= 0 && minutes <= 1440 ? minutes : fallback;
}

/** Jornadas (una por día laborable) que tocan el rango [from, to). */
export function workWindows(from: number, to: number, week: WorkWeek): Interval[] {
  const out: Interval[] = [];
  // Se recorre por días locales: se parte de las 12:00 para que un cambio de hora no salte un día.
  const first = zonedParts(from, week.timeZone);
  let noon = zonedMs(first.year, first.month, first.day, 12, 0, week.timeZone);
  for (; noon - 12 * 3_600_000 < to; noon += DAY) {
    const p = zonedParts(noon, week.timeZone);
    if (!week.days.includes(p.weekday)) continue;
    const start = zonedMs(p.year, p.month, p.day, 0, 0, week.timeZone) + week.startMinute * MINUTE;
    const end = zonedMs(p.year, p.month, p.day, 0, 0, week.timeZone) + week.endMinute * MINUTE;
    const clipped = { start: Math.max(start, from), end: Math.min(end, to) };
    if (clipped.end > clipped.start) out.push(clipped);
  }
  return out;
}

/** Une intervalos que se tocan o se enciman. */
export function merge(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** Lo que queda de `windows` al quitar `busy`. */
export function subtract(windows: Interval[], busy: Interval[]): Interval[] {
  const blocked = merge(busy);
  const out: Interval[] = [];
  for (const w of merge(windows)) {
    let cursor = w.start;
    for (const b of blocked) {
      if (b.end <= cursor) continue;
      if (b.start >= w.end) break;
      if (b.start > cursor) out.push({ start: cursor, end: b.start });
      cursor = Math.max(cursor, b.end);
    }
    if (cursor < w.end) out.push({ start: cursor, end: w.end });
  }
  return out;
}

export const alignUp = (ms: number, stepMinutes: number) => Math.ceil(ms / (stepMinutes * MINUTE)) * stepMinutes * MINUTE;

export interface AllocateOptions {
  /** Los inicios caen en múltiplos de estos minutos. */
  step: number;
  /** Un tramo no baja de esto, salvo que sea lo último que falta. */
  minChunk: number;
  /** Tope de un tramo. */
  maxChunk: number;
  /** Duraciones admitidas (sesiones de la agenda); sin lista, cualquier múltiplo de `step`. */
  sizes?: readonly number[];
}

/**
 * Reparte `minutes` en los huecos libres, del más próximo al más lejano. Si hoy no cabe todo,
 * llena lo que cabe y sigue en el siguiente hueco. Devuelve los tramos, o nada si los huecos
 * no alcanzan.
 */
export function allocate(free: Interval[], minutes: number, options: AllocateOptions): Interval[] | undefined {
  const out: Interval[] = [];
  let remaining = minutes;
  for (const gap of merge(free)) {
    let cursor = alignUp(gap.start, options.step);
    while (remaining > 0) {
      const room = Math.floor((gap.end - cursor) / MINUTE);
      let take = Math.min(remaining, room, options.maxChunk);
      // Con duraciones fijas no se deja un resto que ya no quepa en ninguna (p. ej. 15 minutos sueltos).
      const smallest = options.sizes ? Math.min(...options.sizes) : 0;
      take = options.sizes
        ? (options.sizes.find((s) => s <= take && (remaining - s === 0 || remaining - s >= smallest)) ?? 0)
        : Math.floor(take / options.step) * options.step;
      if (take <= 0 || take < Math.min(options.minChunk, remaining)) break;
      out.push({ start: cursor, end: cursor + take * MINUTE });
      cursor += take * MINUTE;
      remaining -= take;
    }
    if (remaining <= 0) return out;
  }
  return undefined;
}

/** Inicios posibles (cada `step` minutos) para un tramo de `minutes` dentro de los huecos. */
export function startsFor(free: Interval[], minutes: number, step: number): number[] {
  const out: number[] = [];
  for (const gap of merge(free))
    for (let t = alignUp(gap.start, step); t + minutes * MINUTE <= gap.end; t += step * MINUTE) out.push(t);
  return out;
}

export const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;
