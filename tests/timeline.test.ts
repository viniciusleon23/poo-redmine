import { test } from "node:test";
import assert from "node:assert/strict";
import type { Ocupado } from "../src/agenda/api.ts";
import type { AgendaItem } from "../src/agenda/planner.ts";
import { isoZoned, zonedMs, zonedParts } from "../src/agenda/slots.ts";
import type { WorkWeek } from "../src/agenda/slots.ts";
import { buildTimeline, phaseOf } from "../src/agenda/timeline.ts";

const MX = "America/Mexico_City";
const WEEK: WorkWeek = { timeZone: MX, startMinute: 540, endMinute: 1080, days: [1, 2, 3, 4, 5] };
const at = (day: number, hour: number, minute = 0) => zonedMs(2026, 11, day, hour, minute, MX);
const hm = (t: number) => {
  const p = zonedParts(t, MX);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};
const work = (id: string, issueId: number, start: number, end: number, state: AgendaItem["state"] = "planificada"): AgendaItem => ({
  id, source: "poo", kind: "trabajo", title: `#${issueId} Algo`, start, end, state, activityId: id, issueId, movable: state === "planificada",
});
const lunch = (day: number): Ocupado => ({ tipo: "comida", inicio: isoZoned(at(day, 15), MX), fin: isoZoned(at(day, 16), MX) });

test("la jornada se ve completa: lo de Poo, lo demás, la comida y los tiempos libres", () => {
  // Miércoles 18: trabajo 12:30–15:00 y 16:00–16:30, una sesión del equipo 10:00–11:00, comida 15–16. Son las 13:00.
  const items: AgendaItem[] = [
    work("a1", 39064, at(18, 12, 30), at(18, 15)),
    work("a2", 39064, at(18, 16), at(18, 16, 30)),
    { id: "sesion:x", source: "agenda", kind: "sesion", title: "Daily", start: at(18, 10), end: at(18, 11), movable: false },
  ];
  const [day] = buildTimeline({ items, busy: [lunch(18)], week: WEEK, from: at(18, 0), days: 1, now: at(18, 13) });
  assert.equal(day!.date, "2026-11-18");
  assert.equal(day!.workday, true);
  assert.equal(hm(day!.start), "09:00");
  assert.equal(hm(day!.end), "18:00");
  assert.deepEqual(
    day!.segments.map((s) => `${hm(s.start)}-${hm(s.end)} ${s.kind}${s.reason ? `:${s.reason}` : ""} ${s.when}`),
    [
      "09:00-10:00 libre pasado",
      "10:00-11:00 sesion pasado",
      "11:00-12:30 libre pasado",
      "12:30-15:00 trabajo ahora",
      "15:00-16:00 ocupado:Comida despues",
      "16:00-16:30 trabajo despues",
      "16:30-18:00 libre despues",
    ],
  );
  assert.deepEqual(day!.minutes, { jornada: 540, poo: 180, otros: 120, libre: 240, libreRestante: 90 });
  // Los tramos de Poo dicen en qué van.
  assert.equal(day!.segments[3]!.phase, "en_curso");
  assert.equal(day!.segments[5]!.phase, "por_empezar");
});

test("un día sin nada apartado es todo libre, y el fin de semana no tiene jornada", () => {
  const days = buildTimeline({ items: [], busy: [], week: WEEK, from: at(20, 0), days: 2, now: at(18, 13) });
  assert.deepEqual(days.map((d) => [d.date, d.workday, d.segments.length, d.minutes.libre]), [
    ["2026-11-20", true, 1, 540],
    ["2026-11-21", false, 0, 0],
  ]);
  assert.equal(days[0]!.segments[0]!.kind, "libre");
});

test("lo cancelado no ocupa, lo de fuera de jornada se muestra en su hora y un festivo llena el día", () => {
  const items: AgendaItem[] = [
    work("c1", 1, at(19, 9), at(19, 11), "cancelada"),
    { id: "sesion:n", source: "agenda", kind: "sesion", title: "Guardia", start: at(19, 19), end: at(19, 20), movable: false },
  ];
  const holiday: Ocupado = { tipo: "festivo", inicio: isoZoned(at(19, 0), MX), fin: isoZoned(at(20, 0), MX), titulo: "Asueto" };
  const [day] = buildTimeline({ items, busy: [holiday], week: WEEK, from: at(19, 0), days: 1, now: at(18, 13) });
  assert.deepEqual(day!.segments.map((s) => `${hm(s.start)}-${hm(s.end)} ${s.kind} ${s.title}`), ["09:00-18:00 ocupado Asueto", "19:00-20:00 sesion Guardia"]);
  assert.equal(day!.minutes.libre, 0);
  assert.equal(day!.minutes.otros, 540);
});

test("la etapa de un tramo sigue a su petición: plan, cierre, programado, pausa y publicado", () => {
  const span = { start: at(18, 12), end: at(18, 14) };
  const now = at(18, 13);
  assert.equal(phaseOf(span, undefined, now), "en_curso");
  assert.equal(phaseOf(span, { turn: "tu", state: "plan" }, now), "espera_plan");
  assert.equal(phaseOf(span, { turn: "tu", state: "cierre" }, now), "espera_cierre");
  assert.equal(phaseOf(span, { turn: "poo", state: "lista" }, now), "programado");
  assert.equal(phaseOf(span, { turn: "tu", state: "pausa" }, now), "pausado");
  assert.equal(phaseOf(span, { turn: "tu", state: "bloqueo" }, now), "bloqueado");
  assert.equal(phaseOf(span, { turn: "otros", state: "entregada" }, now), "publicado");
  assert.equal(phaseOf(span, undefined, at(18, 15)), "hecho");
  assert.equal(phaseOf(span, undefined, at(18, 9)), "por_empezar");
});
