import { test } from "node:test";
import assert from "node:assert/strict";
import { AgendaError } from "../src/agenda/api.ts";
import type { Agenda, Bloque, Ocupado, Sesion } from "../src/agenda/api.ts";
import { buildView, validWebhook } from "../src/agenda/http.ts";
import { PlanError, createPlanner, emptyState, parseEstimate, parseFront, sessionMinutes } from "../src/agenda/planner.ts";
import { MINUTE, isoZoned, zonedMs, zonedParts } from "../src/agenda/slots.ts";
import type { WorkWeek } from "../src/agenda/slots.ts";
import { createHmac } from "node:crypto";

const MX = "America/Mexico_City";
const WEEK: WorkWeek = { timeZone: MX, startMinute: 540, endMinute: 1080, days: [1, 2, 3, 4, 5] };
const ME = "jose.leon@capnet.com.mx";
const DANIEL = { name: "Daniel", email: "daniel.mondragon@capnet.com.mx" };
const at = (day: number, hour: number, minute = 0) => zonedMs(2026, 11, day, hour, minute, MX);
const hm = (t: number) => {
  const p = zonedParts(t, MX);
  return `${p.day} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};
const spans = (list: { start: number; end: number }[]) => list.map((s) => `${hm(s.start)}–${hm(s.end)}`);

/** Una agenda simulada: comida de 15 a 16, festivo el lunes 16, y lo que se vaya apartando. */
function scene(startAt = at(14, 17)) {
  let clock = startAt;
  let ids = 100;
  const bloques: Bloque[] = [];
  const sesiones: Sesion[] = [];
  const extra: Record<string, Ocupado[]> = {};
  const calls: string[] = [];
  let peticionRejected = false;
  let down = false;
  const lunch = (who: string): Ocupado[] =>
    [16, 17, 18, 19, 20, 23, 24].map((d) => ({ tipo: "comida", inicio: isoZoned(at(d, who === ME ? 15 : 17), MX), fin: isoZoned(at(d, who === ME ? 16 : 18), MX) }));
  const holiday: Ocupado = { tipo: "festivo", inicio: isoZoned(at(16, 0), MX), fin: isoZoned(at(17, 0), MX), titulo: "Día de la Revolución" };
  const clash = (who: string, start: number, end: number) =>
    [...bloques.filter((b) => b.activo && b.persona === who), ...sesiones.filter((s) => s.estado === "activa" && s.asistentes.some((a) => a.correo === who))].some(
      (x) => Date.parse(x.inicio) < end && start < Date.parse(x.fin),
    );
  const agenda: Agenda = {
    user: ME,
    personas: async () => [],
    disponibilidad: async (personas) => {
      if (down) throw new AgendaError(0, "sin_conexion", "No pude conectar con la agenda.");
      calls.push(`disponibilidad ${personas.join(",")}`);
      return personas.map((correo) => ({
        correo,
        nombre: correo,
        ocupado: [
          holiday,
          ...lunch(correo),
          ...(extra[correo] ?? []),
          ...bloques.filter((b) => b.activo && b.persona === correo).map((b) => ({ tipo: "externo", inicio: b.inicio, fin: b.fin })),
          ...sesiones.filter((s) => s.estado === "activa" && s.asistentes.some((a) => a.correo === correo)).map((s) => ({ tipo: "sesion", inicio: s.inicio, fin: s.fin, sesion_id: s.id })),
        ],
      }));
    },
    miAgenda: async () => {
      if (down) throw new AgendaError(0, "sin_conexion", "No pude conectar con la agenda.");
      return { sesiones: sesiones.map((s) => ({ ...s })), bloques: bloques.filter((b) => b.activo).map((b) => ({ ...b })) };
    },
    crearSesion: async (input) => {
      const start = Date.parse(input.inicio);
      const end = start + input.duracion_minutos * MINUTE;
      for (const who of [ME, ...input.invitados]) if (clash(who, start, end)) throw new AgendaError(409, "horario_ocupado", "El horario choca con la agenda.", [{ who }]);
      const s: Sesion = {
        id: `ses-${ids++}`,
        titulo: input.titulo,
        descripcion: input.descripcion,
        inicio: input.inicio,
        fin: isoZoned(end, MX),
        estado: "activa",
        organizador: ME,
        asistentes: [ME, ...input.invitados].map((correo) => ({ correo, nombre: correo, obligatorio: true, respuesta: "pendiente" })),
      };
      sesiones.push(s);
      calls.push(`sesion ${hm(start)} ${input.duracion_minutos}`);
      return s;
    },
    moverSesion: async (id, changes) => {
      const s = sesiones.find((x) => x.id === id)!;
      const start = Date.parse(changes.inicio!);
      const length = Date.parse(s.fin) - Date.parse(s.inicio);
      s.inicio = changes.inicio!;
      s.fin = isoZoned(start + length, MX);
      calls.push(`mover sesion ${hm(start)}`);
      return s;
    },
    cancelarSesion: async (id) => {
      const s = sesiones.find((x) => x.id === id);
      if (!s) throw new AgendaError(404, "sesion_no_encontrada", "No existe.");
      s.estado = "cancelada";
    },
    apartarPeticion: async (redmineId, inicio, minutos) => {
      if (peticionRejected) throw new AgendaError(403, "sin_permiso", "La persona no es la asignada.");
      const start = Date.parse(inicio);
      if (clash(ME, start, start + minutos * MINUTE)) throw new AgendaError(409, "horario_ocupado", "El horario choca con la agenda.", [{}]);
      const b: Bloque = { id: ids++, titulo: `Petición #${redmineId}`, inicio, fin: isoZoned(start + minutos * MINUTE, MX), origen: "api", persona: ME, activo: true, redmine_id: redmineId, enlace: null };
      bloques.push(b);
      calls.push(`peticion ${redmineId} ${hm(start)} ${minutos}`);
      return b;
    },
    apartarLibre: async (input) => {
      const start = Date.parse(input.inicio);
      if (clash(ME, start, start + input.duracion_minutos * MINUTE)) throw new AgendaError(409, "horario_ocupado", "El horario choca con la agenda.", [{}]);
      const b: Bloque = { id: ids++, titulo: input.titulo, inicio: input.inicio, fin: isoZoned(start + input.duracion_minutos * MINUTE, MX), origen: "api", persona: ME, activo: true, redmine_id: null, enlace: input.enlace ?? null };
      bloques.push(b);
      calls.push(`libre ${hm(start)} ${input.duracion_minutos}`);
      return b;
    },
    bloques: async () => bloques.filter((b) => b.activo),
    quitarBloque: async (id) => {
      const b = bloques.find((x) => x.id === id && x.activo);
      if (!b) throw new AgendaError(404, "bloque_no_encontrado", "No existe.");
      b.activo = false;
      calls.push(`quitar ${id}`);
    },
  };
  const state = emptyState();
  const logs: string[] = [];
  let saves = 0;
  let n = 0;
  const planner = createPlanner({
    agenda,
    week: WEEK,
    state,
    now: () => clock,
    save: () => void saves++,
    log: (l) => logs.push(l),
    uuid: () => `${String(n++).padStart(8, "0")}-x`,
    issueUrl: (id) => `http://redmine/issues/${id}`,
  });
  return {
    planner, state, bloques, sesiones, calls, logs, extra,
    saves: () => saves,
    goto: (t: number) => (clock = t),
    rejectPeticion: (v: boolean) => (peticionRejected = v),
    down: (v: boolean) => (down = v),
  };
}

const issue = (id: number, priority = "Medio") => ({ issueId: id, subject: `Petición ${id}`, priority, taskId: `tsk_${id}` });

test("el trabajo se aparta en el primer hueco libre: sábado por la tarde y lunes festivo → martes a las 9", async () => {
  const s = scene();
  const work = await s.planner.scheduleWork({ ...issue(39030), minutes: 180 });
  assert.deepEqual(spans(work), ["17 09:00–17 12:00"]);
  assert.equal(work[0]!.remote?.type, "bloque");
  assert.equal(s.bloques[0]!.redmine_id, 39030, "va ligado a la petición en la agenda");
  assert.deepEqual(s.planner.workPlan(39030), { minutes: 180, start: at(17, 9), end: at(17, 12) });
});

test("dos peticiones nunca se trabajan a la vez: la segunda va después de la primera", async () => {
  const s = scene();
  await s.planner.scheduleWork({ ...issue(1), minutes: 240 });
  const second = await s.planner.scheduleWork({ ...issue(2), minutes: 240 });
  // Primera 9–13; a la segunda le quedan 13–15 antes de la comida y 2 h después.
  assert.deepEqual(spans(second), ["17 13:00–17 15:00", "17 16:00–17 18:00"]);
  assert.equal(second[0]!.parts, 2);
  const third = await s.planner.scheduleWork({ ...issue(3), minutes: 60 });
  assert.deepEqual(spans(third), ["18 09:00–18 10:00"], "el martes ya está lleno");
});

test("si la agenda no reconoce la petición, el tiempo se aparta como bloque libre con su enlace; un choque no se disfraza", async () => {
  const s = scene();
  s.rejectPeticion(true);
  const work = await s.planner.scheduleWork({ ...issue(39031), minutes: 90 });
  assert.equal(work[0]!.remote?.type === "bloque" && work[0]!.remote.libre, true);
  assert.equal(s.bloques[0]!.titulo, "#39031 Petición 39031");
  assert.equal(s.bloques[0]!.enlace, "http://redmine/issues/39031");
  assert.match(s.logs.join("\n"), /va como bloque libre/);
  // Sin hueco en 14 días: se dice, no se inventa.
  await assert.rejects(s.planner.scheduleWork({ ...issue(5), minutes: 100 * 60 }), (err: unknown) => err instanceof PlanError && err.code === "sin_hueco");
  // La agenda caída es un error de agenda, y no queda nada a medias.
  s.down(true);
  await assert.rejects(s.planner.scheduleWork({ ...issue(6), minutes: 60 }), (err: unknown) => err instanceof PlanError && err.code === "agenda");
  assert.equal(s.planner.activitiesOf(6).length, 0);
});

test("un plan reaprobado con otro tiempo sustituye lo que no había empezado", async () => {
  const s = scene();
  const first = await s.planner.scheduleWork({ ...issue(7), minutes: 120 });
  const again = await s.planner.scheduleWork({ ...issue(7), minutes: 300 });
  assert.equal(s.state.activities.find((a) => a.id === first[0]!.id)!.state, "cancelada");
  assert.deepEqual(spans(again), ["17 09:00–17 14:00"]);
  assert.equal(s.bloques.filter((b) => b.activo).length, 1, "en la agenda queda un solo bloque");
});

test("la sesión con el frontal va después del trabajo, cuando los dos están libres, partida si hace falta", async () => {
  const s = scene();
  const work = await s.planner.scheduleWork({ ...issue(39032, "Alto"), minutes: 360 }); // martes 9–15
  // Daniel tiene otra reunión el martes de 16 a 17 y come de 17 a 18: no queda hueco común el martes.
  s.extra[DANIEL.email] = [{ tipo: "sesion", inicio: isoZoned(at(17, 16), MX), fin: isoZoned(at(17, 17), MX) }];
  const sessions = await s.planner.scheduleSession({ ...issue(39032, "Alto"), person: DANIEL, minutes: sessionMinutes("Alto"), after: Math.max(...work.map((a) => a.end)), detail: "Pantalla de citas" });
  assert.deepEqual(spans(sessions), ["18 09:00–18 11:00", "18 11:00–18 13:00"]);
  assert.equal(s.sesiones.length, 2);
  assert.match(s.sesiones[0]!.titulo, /^#39032 · Frontal: /);
  assert.match(s.sesiones[0]!.descripcion ?? "", /Pantalla de citas/);
  assert.match(s.sesiones[0]!.descripcion ?? "", /Parte 1 de 2/);
  assert.deepEqual(s.sesiones[0]!.asistentes.map((a) => a.correo), [ME, DANIEL.email]);
  // Prioridad media: 2:30 → una sesión de 2 h y otra de 30 min.
  const medium = await s.planner.scheduleSession({ ...issue(39033), person: DANIEL, minutes: sessionMinutes("Medio"), after: at(18, 13) });
  assert.deepEqual(medium.map((a) => (a.end - a.start) / MINUTE), [120, 30]);
});

test("mover una actividad la mueve también en la agenda; un horario ocupado se rechaza y nada cambia", async () => {
  const s = scene();
  const [a] = await s.planner.scheduleWork({ ...issue(39034), minutes: 120 }); // martes 9–11
  const [b] = await s.planner.scheduleWork({ ...issue(39035), minutes: 60 }); // martes 11–12
  const starts = await s.planner.slots(a!.id, "2026-11-18");
  assert.equal(hm(starts[0]!), "18 09:00");
  assert.equal(starts.map(hm).includes("18 14:00"), false, "no cabe antes de la comida");
  await s.planner.move(a!.id, at(18, 10));
  assert.deepEqual(spans([a!]), ["18 10:00–18 12:00"]);
  assert.equal(a!.note, "movida por ti");
  const live = s.bloques.filter((x) => x.activo);
  assert.deepEqual(live.map((x) => hm(Date.parse(x.inicio))).sort(), ["17 11:00", "18 10:00"]);
  // Encima de la otra petición, fuera de jornada o en el pasado: no.
  await assert.rejects(s.planner.move(a!.id, at(17, 10, 30)), (err: unknown) => err instanceof PlanError && err.code === "ocupado");
  await assert.rejects(s.planner.move(a!.id, at(18, 17)), (err: unknown) => err instanceof PlanError && err.code === "ocupado");
  await assert.rejects(s.planner.move(a!.id, at(14, 9)), (err: unknown) => err instanceof PlanError && err.code === "datos");
  assert.deepEqual(spans([a!]), ["18 10:00–18 12:00"]);
  assert.equal(s.bloques.filter((x) => x.activo).length, 2);
  // Dentro de su propio horario sí puede recorrerse (su propio bloque no le estorba).
  await s.planner.move(b!.id, at(17, 11, 30));
  assert.deepEqual(spans([b!]), ["17 11:30–17 12:30"]);
  // Una sesión se mueve con PATCH, sin cancelarla.
  const [ses] = await s.planner.scheduleSession({ ...issue(39034), person: DANIEL, minutes: 60, after: at(19, 9) });
  await s.planner.move(ses!.id, at(19, 12));
  assert.equal(s.sesiones[0]!.estado, "activa");
  assert.equal(hm(Date.parse(s.sesiones[0]!.inicio)), "19 12:00");
});

test("lo que se mueve o se quita en la agenda se refleja aquí en el siguiente sondeo", async () => {
  const s = scene();
  const [a] = await s.planner.scheduleWork({ ...issue(39036), minutes: 120 });
  const [b] = await s.planner.scheduleWork({ ...issue(39037), minutes: 60 });
  // Alguien recorre el primer bloque a las 16:00 y quita el segundo desde la agenda.
  const first = s.bloques.find((x) => x.id === (a!.remote as { id: number }).id)!;
  first.inicio = isoZoned(at(17, 16), MX);
  first.fin = isoZoned(at(17, 18), MX);
  s.bloques.find((x) => x.id === (b!.remote as { id: number }).id)!.activo = false;
  await s.planner.sync();
  assert.deepEqual(spans([a!]), ["17 16:00–17 18:00"]);
  assert.equal(a!.note, "movida desde la agenda");
  assert.equal(b!.state, "cancelada");
  assert.equal(b!.note, "quitada desde la agenda");
  assert.ok(s.state.syncedAt);
  // Con la agenda caída se conserva lo último y se dice el error.
  s.down(true);
  await s.planner.sync();
  assert.match(s.state.syncError ?? "", /No pude conectar/);
  assert.deepEqual(spans([a!]), ["17 16:00–17 18:00"]);
});

test("el reloj manda: «En curso» al empezar el bloque y la publicación espera a que termine", async () => {
  const s = scene();
  await s.planner.scheduleWork({ ...issue(39038), minutes: 240 }); // martes 9–13
  assert.equal(s.planner.workStarted(39038), false);
  assert.deepEqual(s.planner.gate(39038), { wait: true, until: at(17, 13) });
  s.goto(at(17, 9, 1));
  assert.deepEqual(s.planner.tick().map((a) => a.state), ["en_curso"]);
  assert.equal(s.planner.workStarted(39038), true);
  assert.equal(s.planner.gate(39038).wait, true, "aunque el trabajo esté listo, el bloque no ha terminado");
  // «Publicar ya» adelanta el cierre.
  s.planner.release(39038);
  assert.equal(s.planner.gate(39038).wait, false);
  // Sin adelantarlo, al terminar el bloque deja de esperar.
  await s.planner.scheduleWork({ ...issue(39039), minutes: 60 }); // martes 13–14
  assert.equal(s.planner.gate(39039).wait, true);
  s.goto(at(17, 14, 1));
  s.planner.tick();
  assert.equal(s.planner.gate(39039).wait, false);
  assert.equal(s.planner.activitiesOf(39039)[0]!.state, "terminada");
  // Una petición sin nada agendado nunca espera.
  assert.deepEqual(s.planner.gate(1), { wait: false });
});

test("al cerrarse la petición antes de tiempo, lo que no había empezado se libera de la agenda", async () => {
  const s = scene(at(17, 16, 5));
  const work = await s.planner.scheduleWork({ ...issue(39040), minutes: 240 }); // martes 16:30–18 y miércoles 9–11:30
  assert.deepEqual(spans(work), ["17 16:30–17 18:00", "18 09:00–18 11:30"]);
  s.goto(at(17, 17));
  s.planner.tick();
  await s.planner.finish(39040);
  assert.deepEqual(work.map((a) => a.state), ["terminada", "cancelada"]);
  assert.equal(s.bloques.filter((b) => b.activo).length, 1, "el bloque de mañana se quitó de la agenda");
});

test("la vista junta lo de Poo con lo demás de la agenda, sin repetir, y la app puede moverlo", async () => {
  const s = scene();
  await s.planner.scheduleWork({ ...issue(39041, "Alto"), minutes: 120 });
  s.sesiones.push({ id: "ext-1", titulo: "API Agenda", inicio: isoZoned(at(17, 16), MX), fin: isoZoned(at(17, 16, 30), MX), estado: "activa", organizador: "yair.mendoza@capnet.com.mx", asistentes: [
    { correo: "yair.mendoza@capnet.com.mx", nombre: "Yair Mendoza", obligatorio: true, respuesta: "acepta" },
    { correo: ME, nombre: "José", obligatorio: true, respuesta: "pendiente" },
  ] });
  await s.planner.sync();
  const view = buildView({ planner: s.planner, week: WEEK, now: () => at(14, 17), issues: () => [] }, "2026-11-16", 5);
  assert.equal(view.today, "2026-11-14");
  assert.equal(view.zone, MX);
  assert.deepEqual(view.workday, { start: 540, end: 1080, days: [1, 2, 3, 4, 5] });
  assert.deepEqual(view.items.map((i) => `${i.source}:${i.kind}:${hm(i.start)}`), ["poo:trabajo:17 09:00", "agenda:sesion:17 16:00"]);
  const [mine, other] = view.items;
  assert.equal(mine!.movable, true);
  assert.equal(mine!.title, "#39041 Petición 39041");
  assert.equal(mine!.issueUrl, "http://redmine/issues/39041");
  assert.equal(other!.movable, false);
  assert.equal(other!.organizer, "Yair Mendoza");
  assert.deepEqual(other!.with, ["Yair Mendoza"]);
  // Fuera del rango pedido no sale nada.
  assert.equal(buildView({ planner: s.planner, week: WEEK, now: () => at(14, 17), issues: () => [] }, "2026-11-23", 5).items.length, 0);
});

test("del plan se leen el tiempo estimado y la dependencia frontal", () => {
  const plan = (time: string, front: string) => ["- **Qué pidieron:** …", `- **Tiempo estimado:** ${time}`, `- **Dependencia frontal:** ${front}`].join("\n");
  assert.equal(parseEstimate(plan("3 h", "ninguna")), 180);
  assert.equal(parseEstimate(plan("2.5 horas (incluye pruebas)", "ninguna")), 150);
  assert.equal(parseEstimate(plan("1,5 h", "ninguna")), 90);
  assert.equal(parseEstimate(plan("2:30", "ninguna")), 150);
  assert.equal(parseEstimate(plan("45 min", "ninguna")), 60, "se redondea hacia arriba a media hora");
  assert.equal(parseEstimate(plan("1 h 20 min", "ninguna")), 90);
  assert.equal(parseEstimate(plan("N h", "ninguna")), undefined);
  assert.equal(parseEstimate("- **Qué pidieron:** tardó 3 h en cargar"), undefined, "solo cuenta la línea del tiempo estimado");
  assert.equal(parseEstimate(plan("200 h", "ninguna")), 2400, "tope de 40 h");

  const people = [{ key: "daniel", name: "Daniel" }, { key: "gigdem", name: "Gigdem" }];
  assert.deepEqual(parseFront(plan("3 h", "ninguna"), people), { people: [], detail: "" });
  assert.deepEqual(parseFront(plan("3 h", "No aplica"), people), { people: [], detail: "" });
  assert.deepEqual(parseFront("sin línea de frontal", people), { people: [], detail: "" });
  const one = parseFront(plan("3 h", "Daniel — mostrar el campo nuevo en la pantalla de citas"), people);
  assert.deepEqual(one.people.map((p) => p.key), ["daniel"]);
  assert.equal(one.detail, "mostrar el campo nuevo en la pantalla de citas");
  assert.deepEqual(parseFront(plan("3 h", "Gigdem y Daniel: consumir el endpoint nuevo"), people).people.map((p) => p.key), ["daniel", "gigdem"]);
  assert.deepEqual(parseFront(plan("3 h", "el frontal de Danielle ya lo tiene"), people).people, [], "un nombre parecido no cuenta");

  assert.equal(sessionMinutes("Bajo"), 60);
  assert.equal(sessionMinutes("Extra Bajo"), 60);
  assert.equal(sessionMinutes("Medio"), 150);
  assert.equal(sessionMinutes("Alto "), 240);
  assert.equal(sessionMinutes("Crítico"), 240);
});

test("un aviso de la agenda solo vale con su firma y dentro de cinco minutos", () => {
  const secret = "whsec_prueba";
  const body = JSON.stringify({ id: "b2d0", evento: "bloque.actualizado" });
  const t = 1_794_700_000;
  const sign = (ts: number, raw = body) => `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`;
  assert.equal(validWebhook(secret, sign(t), body, t + 10), true);
  assert.equal(validWebhook(secret, sign(t), body, t + 301), false, "vencido");
  assert.equal(validWebhook(secret, sign(t), `${body} `, t), false, "cuerpo alterado");
  assert.equal(validWebhook("otro", sign(t), body, t), false);
  assert.equal(validWebhook(secret, "t=abc", body, t), false);
  assert.equal(validWebhook(secret, "", body, t), false);
});
