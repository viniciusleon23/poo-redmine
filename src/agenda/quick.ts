/**
 * «Reservar tiempo» con una frase: «haz una junta para mañana con Gigdem de 9 a 11 con el título
 * de ver configurador de usuarios». Aquí solo se entiende la frase (día, horas, duración, con
 * quién y título); a quién corresponde cada nombre y si el horario está libre lo resuelve quien
 * llama. Sin red ni reloj propios; lo prueba tests/quick.test.ts.
 */
import { dateKey, zonedParts } from "./slots.ts";

export interface QuickParse {
  /** Título dicho en la frase; sin él, quien llama pone uno («Junta con Gigdem»). */
  title?: string;
  /** Cómo le llamó: junta, reunión, sesión, llamada, cita… (para el título por defecto). */
  noun?: string;
  /** Día local, YYYY-MM-DD. */
  date: string;
  /** ¿Dijo el día, o se supuso? */
  dateSaid: boolean;
  /** Minuto del día de inicio y fin, si dijo horas. */
  startMinute?: number;
  endMinute?: number;
  /** Duración, si la dijo sin rango («por 2 horas»). */
  minutes?: number;
  /** Con quién, tal como lo escribió. */
  people: string[];
  /** Lo que se supuso, para decírselo antes de reservar. */
  notes: string[];
}

export class QuickError extends Error {}

const WORDS: Record<string, number> = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };
const NUM = "(\\d{1,2}|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)";
const MIN = "(?:[:.](\\d{2})|\\s+y\\s+(media|cuarto))?";
const MER = "(?:\\s*(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?|hrs?\\.?|h)(?![\\p{L}]))?";
const PART = "(?:\\s+(?:de|por|en)\\s+la\\s+(mañana|tarde|noche))?";
const L = "(?<![\\p{L}\\d])";
const R = "(?![\\p{L}\\d])";
const WEEKDAYS: Record<string, number> = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 7 };
const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const NOUNS = ["junta", "reunión", "reunion", "sesión", "sesion", "llamada", "cita", "videollamada", "call"];
/** Palabras que no son el nombre de nadie después de «con». */
const STOP =
  "el|la|los|las|un|una|de|del|a|al|para|por|sobre|tema|hoy|mañana|pasado|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|en|desde|entre|que|t[ií]tulo|titulad[ao]|llamad[ao]|nombre|motivo|asunto|mi|y|e|duraci[oó]n";
const SENTINEL = "\u0001";

const plain = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : (WORDS[plain(s)] ?? NaN));
const two = (n: number) => String(n).padStart(2, "0");

/** Suma días de calendario a un día local. */
export function addDays(date: string, days: number) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days, 12));
  return `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`;
}

type Clock = { hour: number; minute: number; meridiem?: "am" | "pm" };

function clock(h: string, mm: string | undefined, frac: string | undefined, mer: string | undefined, part: string | undefined): Clock | undefined {
  const hour = num(h);
  const minute = mm ? Number(mm) : frac === "media" ? 30 : frac === "cuarto" ? 15 : 0;
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute < 60)) return undefined;
  const m = plain(mer ?? "").replace(/[.\s]/g, "");
  const meridiem = m === "am" ? "am" : m === "pm" ? "pm" : part ? (plain(part) === "manana" ? "am" : "pm") : undefined;
  return { hour, minute, meridiem };
}

/** Hora de 24 h: con a. m./p. m. se respeta; sin ellos, de 1 a 7 es de la tarde (nadie se reúne a las 3 de la madrugada). */
function minuteOf(c: Clock, fallback?: "am" | "pm") {
  let hour = c.hour;
  const mer = c.meridiem ?? fallback;
  if (hour <= 12) {
    if (mer === "pm" && hour < 12) hour += 12;
    else if (mer === "am" && hour === 12) hour = 0;
    else if (!mer && hour >= 1 && hour <= 7) hour += 12;
  }
  return hour * 60 + c.minute;
}

/**
 * Entiende la frase. Lanza `QuickError` si no hay nada que reservar o algo no cuadra (una hora
 * imposible, un fin antes del inicio).
 */
export function parseQuick(text: string, now: number, timeZone: string): QuickParse {
  const raw = text.replace(/\s+/g, " ").trim();
  if (raw.length < 3) throw new QuickError("Dime qué reservo: por ejemplo «junta mañana con Gigdem de 9 a 11, título: ver configurador de usuarios».");
  const notes: string[] = [];
  const today = dateKey(now, timeZone);
  const nowParts = zonedParts(now, timeZone);

  // El título, si lo dijo con su marca, es todo lo que sigue («con el título de …», «titulada …»).
  let head = raw;
  let tail: string | undefined;
  const marker = new RegExp(`[,;]?\\s*${L}(?:(?:con|y|de|por)\\s+)?(?:el\\s+)?(?:t[ií]tulo|titulad[ao]|nombre|motivo|asunto)${R}\\s*(?:de|que\\s+diga|es|sea|ser[aá])?\\s*:?\\s*`, "iu").exec(raw);
  if (marker) {
    head = raw.slice(0, marker.index);
    tail = raw.slice(marker.index + marker[0].length);
  }
  let quoted: string | undefined;
  if (!marker) {
    const q = /["«“]([^"»”]{2,})["»”]/u.exec(head);
    if (q) {
      quoted = q[1]!.trim();
      head = head.replace(q[0], SENTINEL);
    }
  }

  let startMinute: number | undefined;
  let endMinute: number | undefined;
  let minutes: number | undefined;
  let date: string | undefined;
  let people: string[] = [];

  /** Busca en `s` lo que aún falta y lo marca como ya leído. */
  const scan = (input: string) => {
    let s = input;
    const take = (re: RegExp) => {
      const m = re.exec(s);
      if (m) s = s.slice(0, m.index) + SENTINEL + s.slice(m.index + m[0].length);
      return m;
    };

    // Horas: «de 9 a 11», «entre las 9 y las 11», «9-11», «a las 10», «9 am», «al mediodía».
    if (startMinute === undefined) {
      const range =
        take(new RegExp(`${L}(?:de|desde|entre)\\s+(?:las?\\s+)?${NUM}${MIN}${MER}${PART}\\s*(?:a|hasta|y|-|–)\\s*(?:las?\\s+)?${NUM}${MIN}${MER}${PART}${R}`, "iu")) ??
        (() => {
          // «9-11» es un rango solo si lo parece; «20-11» es una fecha.
          const m = new RegExp(`${L}${NUM}${MIN}${MER}\\s*[-–]\\s*${NUM}${MIN}${MER}${R}`, "iu").exec(s);
          if (!m) return null;
          const a = clock(m[1]!, m[2], m[3], m[4], undefined);
          const b = clock(m[5]!, m[6], m[7], m[8], undefined);
          if (!a || !b || a.hour > 23 || (!m[2] && !m[4] && !m[6] && !m[8] && (a.hour > 12 || minuteOf(b, a.meridiem) <= minuteOf(a, b.meridiem)))) return null;
          s = s.slice(0, m.index) + SENTINEL + s.slice(m.index + m[0].length);
          return [m[0], m[1], m[2], m[3], m[4], undefined, m[5], m[6], m[7], m[8], undefined] as unknown as RegExpExecArray;
        })();
      if (range) {
        const a = clock(range[1]!, range[2], range[3], range[4], range[5]);
        const b = clock(range[6]!, range[7], range[8], range[9], range[10]);
        if (!a || !b) throw new QuickError("No entendí el horario. Dímelo como «de 9 a 11» o «de 4:30 a 6 pm».");
        // «de 4 a 5 pm»: el «pm» vale para los dos si así el inicio queda antes del fin.
        let end = minuteOf(b);
        let start = minuteOf(a, b.meridiem && !a.meridiem && a.hour <= b.hour ? b.meridiem : undefined);
        if (end <= start && !b.meridiem && b.hour <= 12) end += 12 * 60;
        if (end <= start && !a.meridiem && a.hour >= 13 === false && start >= 12 * 60 && a.hour <= 7) start -= 12 * 60;
        if (end <= start || end > 24 * 60) throw new QuickError("El fin queda antes del inicio. Dímelo como «de 9 a 11».");
        startMinute = start;
        endMinute = end;
      } else {
        const noon = take(new RegExp(`${L}(?:al?\\s+)?medio\\s?d[ií]a${R}`, "iu"));
        const one = noon
          ? undefined
          : (take(new RegExp(`${L}(?:a|desde|tipo|como\\s+a)\\s+las?\\s+${NUM}${MIN}${MER}${PART}${R}`, "iu")) ??
            take(new RegExp(`${L}${NUM}${MIN}\\s*(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)${R}${PART}`, "iu")));
        if (noon) startMinute = 12 * 60;
        else if (one) {
          const c = clock(one[1]!, one[2], one[3], one[4], one[5]);
          if (!c) throw new QuickError("No entendí la hora. Dímela como «a las 10» o «a las 4:30 pm».");
          startMinute = minuteOf(c);
        }
      }
    }

    // Duración: «por 2 horas», «1 hora y media», «45 minutos», «media hora».
    if (minutes === undefined && endMinute === undefined) {
      const half = take(new RegExp(`${L}(?:(?:por|durante|de)\\s+)?media\\s+hora${R}`, "iu"));
      const d = half ? undefined : take(new RegExp(`${L}(?:(?:por|durante|de)\\s+)?(\\d+(?:[.,]\\d+)?|una|un|dos|tres|cuatro|cinco|seis)\\s*(horas?|hrs?\\.?|h|minutos?|min\\.?)${R}(\\s+y\\s+media)?`, "iu"));
      if (half) minutes = 30;
      else if (d) {
        const n = /^\d/.test(d[1]!) ? Number(d[1]!.replace(",", ".")) : num(d[1]!);
        minutes = /^m/i.test(d[2]!) ? Math.round(n) : Math.round(n * 60) + (d[3] ? 30 : 0);
        if (!(minutes >= 15 && minutes <= 12 * 60)) throw new QuickError("La duración va de 15 minutos a 12 horas.");
      }
    }

    // Día: hoy, mañana, pasado mañana, el viernes, el 20, 20 de noviembre, 20/11.
    if (date === undefined) {
      if (take(new RegExp(`${L}pasado\\s+mañana${R}`, "iu"))) date = addDays(today, 2);
      else if (take(new RegExp(`(?<!(?:de|por|en)\\s+la\\s+)${L}mañana${R}`, "iu"))) date = addDays(today, 1);
      else if (take(new RegExp(`${L}hoy${R}`, "iu"))) date = today;
      else {
        const full = take(new RegExp(`${L}(?:el\\s+)?(?:d[ií]a\\s+)?(\\d{1,2})\\s+de\\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\\s+(?:de|del)\\s+(\\d{4}))?${R}`, "iu"));
        const slash = full ? undefined : take(new RegExp(`${L}(?:el\\s+)?(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2,4}))?${R}`, "iu"));
        const wd = full || slash ? undefined : take(new RegExp(`${L}(?:(?:el|este|pr[oó]ximo|para\\s+el)\\s+)?(?:pr[oó]ximo\\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)(\\s+(?:que\\s+viene|pr[oó]ximo|de\\s+la\\s+pr[oó]xima\\s+semana))?${R}`, "iu"));
        const dom = full || slash || wd ? undefined : take(new RegExp(`${L}(?:el|para\\s+el)\\s+(?:d[ií]a\\s+)?(\\d{1,2})(?![\\d:/.-])${R}`, "iu"));
        if (full || slash) {
          const day = Number((full ?? slash)![1]);
          const month = full ? MONTHS[plain(full[2]!)]! : Number(slash![2]);
          let year = Number((full ?? slash)![3] ?? nowParts.year);
          if (year < 100) year += 2000;
          if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) throw new QuickError("No entendí la fecha. Dímela como «el 20 de noviembre» o «mañana».");
          let key = `${year}-${two(month)}-${two(day)}`;
          // Sin año y ya pasó: es la del año que viene.
          if (!(full ?? slash)![3] && key < today) key = `${year + 1}-${two(month)}-${two(day)}`;
          date = key;
        } else if (wd) {
          const target = WEEKDAYS[plain(wd[1]!)]!;
          let ahead = (target - nowParts.weekday + 7) % 7;
          if (ahead === 0) ahead = 7;
          if (wd[2] && ahead < 7 && /semana/i.test(wd[2])) ahead += 7;
          date = addDays(today, ahead);
        } else if (dom) {
          const day = Number(dom[1]);
          if (!(day >= 1 && day <= 31)) throw new QuickError("No entendí el día del mes.");
          let key = `${nowParts.year}-${two(nowParts.month)}-${two(day)}`;
          if (key < today) key = nowParts.month === 12 ? `${nowParts.year + 1}-01-${two(day)}` : `${nowParts.year}-${two(nowParts.month + 1)}-${two(day)}`;
          date = key;
        }
      }
    }

    // Con quién: «con Gigdem», «con Daniel y Gigdem».
    if (!people.length) {
      const name = `(?!(?:${STOP})${R})[\\p{L}][\\p{L}.'-]*`;
      const m = take(new RegExp(`${L}(?:junto\\s+)?con\\s+(${name}(?:\\s+${name})?(?:\\s*(?:,|\\sy\\s|\\se\\s)\\s*${name}(?:\\s+${name})?)*)`, "iu"));
      if (m)
        people = m[1]!
          .split(/\s*,\s*|\s+y\s+|\s+e\s+/iu)
          .map((p) => p.trim())
          .filter(Boolean);
    }
    return s;
  };

  const maskedHead = scan(head);
  const maskedTail = tail === undefined ? undefined : scan(tail);

  // El título: lo que sigue a su marca, lo entrecomillado, o lo que va tras «para» / «sobre».
  const tidy = (s: string) => {
    const best = s
      .split(SENTINEL)
      .map((p) => p.replace(/^[\s,;:.«"“-]+|[\s,;:.»"”-]+$/gu, "").replace(/\s+(?:y|para|el|de|con|a|en)$/iu, ""))
      .filter((p) => p.length >= 2)
      .sort((a, b) => b.length - a.length)[0];
    return best ? best[0]!.toUpperCase() + best.slice(1) : undefined;
  };
  let title = maskedTail !== undefined ? tidy(maskedTail) : quoted ? quoted[0]!.toUpperCase() + quoted.slice(1) : undefined;
  if (!title) {
    const about = new RegExp(`${L}(?:para|sobre|tema(?:\\s+de)?|acerca\\s+de)\\s+((?!${SENTINEL})[^${SENTINEL}]{3,})`, "iu").exec(maskedHead);
    if (about) title = tidy(about[1]!.replace(new RegExp(`^(?:ver|revisar|hablar\\s+de|platicar\\s+de)${R}`, "iu"), (m) => m));
  }
  const noun = NOUNS.find((n) => new RegExp(`${L}${n}${R}`, "iu").test(raw));

  if (startMinute === undefined && minutes === undefined && !people.length && !title && date === undefined)
    throw new QuickError("No entendí qué reservar. Prueba con «junta mañana con Gigdem de 9 a 11, título: ver configurador de usuarios».");

  const dateSaid = date !== undefined;
  if (date === undefined) {
    const nowMinute = nowParts.hour * 60 + nowParts.minute;
    if (startMinute !== undefined && startMinute <= nowMinute) {
      date = addDays(today, 1);
      notes.push("Esa hora ya pasó hoy: lo puse para mañana.");
    } else {
      date = today;
      notes.push("No dijiste el día: lo puse para hoy.");
    }
  }
  if (startMinute !== undefined && endMinute === undefined && minutes === undefined) notes.push("No dijiste cuánto dura: puse 1 hora.");
  return { title, noun: noun ? plain(noun).replace("reunion", "reunión").replace("sesion", "sesión") : undefined, date, dateSaid, startMinute, endMinute, minutes, people, notes };
}
