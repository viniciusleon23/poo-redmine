import { test } from "node:test";
import assert from "node:assert/strict";
import { MINUTE, allocate, dateKey, dayStart, isoZoned, merge, parseClock, startsFor, subtract, workWindows, zonedMs, zonedParts } from "../src/agenda/slots.ts";
import type { WorkWeek } from "../src/agenda/slots.ts";

const MX = "America/Mexico_City";
const WEEK: WorkWeek = { timeZone: MX, startMinute: 540, endMinute: 1080, days: [1, 2, 3, 4, 5] };
const at = (day: number, hour: number, minute = 0) => zonedMs(2026, 11, day, hour, minute, MX);
const H = 60 * MINUTE;
const hm = (t: number) => {
  const p = zonedParts(t, MX);
  return `${p.day} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

test("las horas se calculan en la zona del equipo y viajan a la agenda con su desfase", () => {
  assert.equal(new Date(at(17, 9)).toISOString(), "2026-11-17T15:00:00.000Z");
  assert.equal(isoZoned(at(17, 9, 30), MX), "2026-11-17T09:30:00-06:00");
  assert.equal(dateKey(Date.parse("2026-11-18T03:30:00Z"), MX), "2026-11-17", "las 21:30 de México siguen siendo el día 17");
  assert.equal(dayStart("2026-11-17", MX), at(17, 0));
  assert.equal(zonedParts(at(14, 12), MX).weekday, 6, "el 14/11/2026 es sábado");
  // Una zona con horario de verano: el desfase cambia y el instante sigue siendo el correcto.
  assert.equal(new Date(zonedMs(2026, 7, 1, 9, 0, "America/New_York")).toISOString(), "2026-07-01T13:00:00.000Z");
  assert.equal(new Date(zonedMs(2026, 12, 1, 9, 0, "America/New_York")).toISOString(), "2026-12-01T14:00:00.000Z");
  assert.equal(parseClock("9:30", 0), 570);
  assert.equal(parseClock("18", 0), 1080);
  assert.equal(parseClock("tarde", 540), 540);
});

test("la jornada es de 9 a 18 de lunes a viernes, recortada al rango pedido", () => {
  // Del sábado 14 al miércoles 18: lunes y martes completos.
  const windows = workWindows(at(14, 10), at(18, 0), WEEK);
  assert.deepEqual(windows.map((w) => `${hm(w.start)}–${hm(w.end)}`), ["16 09:00–16 18:00", "17 09:00–17 18:00"]);
  // Empezando a media mañana, el primer día arranca en ese momento.
  const late = workWindows(at(17, 11, 20), at(18, 12), WEEK);
  assert.deepEqual(late.map((w) => `${hm(w.start)}–${hm(w.end)}`), ["17 11:20–17 18:00", "18 09:00–18 12:00"]);
  assert.deepEqual(workWindows(at(14, 0), at(16, 0), WEEK), [], "fin de semana: nada");
});

test("lo ocupado se resta de la jornada: comida, sesiones y festivos", () => {
  const day = workWindows(at(17, 0), at(18, 0), WEEK);
  const free = subtract(day, [
    { start: at(17, 15), end: at(17, 16) }, // comida
    { start: at(17, 10), end: at(17, 11) }, // sesión
    { start: at(17, 10, 30), end: at(17, 11, 30) }, // otra que se encima con la anterior
  ]);
  assert.deepEqual(free.map((w) => `${hm(w.start)}–${hm(w.end)}`), ["17 09:00–17 10:00", "17 11:30–17 15:00", "17 16:00–17 18:00"]);
  // Un festivo ocupa el día entero.
  assert.deepEqual(subtract(workWindows(at(16, 0), at(17, 0), WEEK), [{ start: at(16, 0), end: at(17, 0) }]), []);
  assert.deepEqual(merge([{ start: 5, end: 9 }, { start: 1, end: 5 }, { start: 20, end: 30 }]), [{ start: 1, end: 9 }, { start: 20, end: 30 }]);
});

test("el trabajo va al primer hueco; si no cabe hoy, se parte entre hoy y mañana", () => {
  const work = { step: 30, minChunk: 60, maxChunk: 480 };
  const tuesday = subtract(workWindows(at(17, 0), at(19, 0), WEEK), [
    { start: at(17, 15), end: at(17, 16) },
    { start: at(18, 15), end: at(18, 16) },
  ]);
  // 3 h el martes a primera hora: un solo tramo.
  assert.deepEqual(allocate(tuesday, 180, work)!.map((s) => `${hm(s.start)}–${hm(s.end)}`), ["17 09:00–17 12:00"]);
  // 4 h pedidas a las 16:10 del martes: 1:30 hoy (16:30–18:00) y 2:30 mañana.
  const late = subtract(workWindows(at(17, 16, 10), at(19, 0), WEEK), [{ start: at(18, 15), end: at(18, 16) }]);
  assert.deepEqual(allocate(late, 240, work)!.map((s) => `${hm(s.start)}–${hm(s.end)}`), ["17 16:30–17 18:00", "18 09:00–18 11:30"]);
  // Un resto de 20 minutos al final del día no se usa para empezar: todo pasa a mañana.
  const tail = subtract(workWindows(at(17, 17, 40), at(19, 0), WEEK), []);
  assert.deepEqual(allocate(tail, 120, work)!.map((s) => `${hm(s.start)}–${hm(s.end)}`), ["18 09:00–18 11:00"]);
  // La comida parte un trabajo largo en el mismo día.
  assert.deepEqual(allocate(tuesday, 420, work)!.map((s) => `${hm(s.start)}–${hm(s.end)}`), ["17 09:00–17 15:00", "17 16:00–17 17:00"]);
  // Si los huecos no alcanzan, no se inventa nada.
  assert.equal(allocate(tuesday, 40 * 60, work), undefined);
});

test("una sesión usa las duraciones de la agenda: 2:30 es 2 h + 30 min, 4 h son dos de 2 h", () => {
  const session = { step: 30, minChunk: 30, maxChunk: 120, sizes: [120, 90, 60, 45, 30] };
  const morning = [{ start: at(17, 9), end: at(17, 15) }];
  assert.deepEqual(allocate(morning, 150, session)!.map((s) => `${hm(s.start)}–${hm(s.end)}`), ["17 09:00–17 11:00", "17 11:00–17 11:30"]);
  assert.deepEqual(allocate(morning, 240, session)!.map((s) => `${hm(s.start)}–${hm(s.end)}`), ["17 09:00–17 11:00", "17 11:00–17 13:00"]);
  // Tarde: 2 h hoy y 2 h mañana.
  const split = [{ start: at(17, 16), end: at(17, 18) }, { start: at(18, 9), end: at(18, 15) }];
  assert.deepEqual(allocate(split, 240, session)!.map((s) => `${hm(s.start)}–${hm(s.end)}`), ["17 16:00–17 18:00", "18 09:00–18 11:00"]);
  // Un hueco de 50 minutos: no se toma una sesión de 45 que dejaría 15 minutos sin colocar, sino 30 y 30.
  const tight = [{ start: at(17, 9), end: at(17, 9, 50) }, { start: at(17, 12), end: at(17, 13) }];
  assert.deepEqual(allocate(tight, 60, session)!.map((s) => `${hm(s.start)}–${hm(s.end)}`), ["17 09:00–17 09:30", "17 12:00–17 12:30"]);
});

test("los inicios para mover una actividad van cada 30 minutos y caben enteros en el hueco", () => {
  const free = [{ start: at(17, 9, 10), end: at(17, 11) }, { start: at(17, 16), end: at(17, 18) }];
  assert.deepEqual(startsFor(free, 60, 30).map(hm), ["17 09:30", "17 10:00", "17 16:00", "17 16:30", "17 17:00"]);
  assert.deepEqual(startsFor(free, 180, 30), []);
  assert.equal(at(17, 10) - at(17, 9), H);
});
