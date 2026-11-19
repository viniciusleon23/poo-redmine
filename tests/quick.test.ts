import { test } from "node:test";
import assert from "node:assert/strict";
import { QuickError, addDays, parseQuick } from "../src/agenda/quick.ts";
import { zonedMs } from "../src/agenda/slots.ts";

const MX = "America/Mexico_City";
// Miércoles 18 de noviembre de 2026, 20:15.
const NOW = zonedMs(2026, 11, 18, 20, 15, MX);
const p = (text: string, now = NOW) => parseQuick(text, now, MX);
const hm = (m?: number) => (m === undefined ? undefined : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

test("la frase del propietario: junta mañana con Gigdem de 9 a 11 con su título", () => {
  const r = p("haz una junta para mañana con gigdem de 9 a 11 con el titulo de ver configurador de usuarios");
  assert.equal(r.date, "2026-11-19");
  assert.equal(r.dateSaid, true);
  assert.equal(hm(r.startMinute), "09:00");
  assert.equal(hm(r.endMinute), "11:00");
  assert.deepEqual(r.people, ["gigdem"]);
  assert.equal(r.title, "Ver configurador de usuarios");
  assert.equal(r.noun, "junta");
  assert.deepEqual(r.notes, []);
});

test("horas: tarde por defecto de 1 a 7, a. m./p. m., medias, rango con guion y una sola hora", () => {
  assert.deepEqual([hm(p("junta mañana de 4 a 5").startMinute), hm(p("junta mañana de 4 a 5").endMinute)], ["16:00", "17:00"]);
  assert.deepEqual([hm(p("mañana de 4:30 a 6 pm con Daniel").startMinute), hm(p("mañana de 4:30 a 6 pm con Daniel").endMinute)], ["16:30", "18:00"]);
  assert.deepEqual([hm(p("mañana de 11 a 1").startMinute), hm(p("mañana de 11 a 1").endMinute)], ["11:00", "13:00"]);
  assert.deepEqual([hm(p("el viernes de 9 y media a 11").startMinute), hm(p("el viernes de 9 y media a 11").endMinute)], ["09:30", "11:00"]);
  assert.deepEqual([hm(p("reserva mañana 9-11").startMinute), hm(p("reserva mañana 9-11").endMinute)], ["09:00", "11:00"]);
  assert.deepEqual([hm(p("entre las 10 y las 12 mañana").startMinute), hm(p("entre las 10 y las 12 mañana").endMinute)], ["10:00", "12:00"]);
  const single = p("llamada mañana a las 10 con Daniel");
  assert.equal(hm(single.startMinute), "10:00");
  assert.equal(single.endMinute, undefined);
  assert.match(single.notes.join(" "), /puse 1 hora/);
  assert.equal(hm(p("mañana a las 3 de la tarde").startMinute), "15:00");
  assert.equal(hm(p("mañana a las 8 de la mañana").startMinute), "08:00");
  assert.equal(hm(p("mañana 9am con Daniel").startMinute), "09:00");
  assert.equal(hm(p("mañana al mediodía").startMinute), "12:00");
  assert.throws(() => p("mañana de 11 a 9 am"), QuickError);
});

test("duración sin horas: se busca hueco después", () => {
  const r = p("resérvame 2 horas mañana para revisar el reporte de ventas");
  assert.equal(r.minutes, 120);
  assert.equal(r.startMinute, undefined);
  assert.equal(r.title, "Revisar el reporte de ventas");
  assert.deepEqual(r.people, []);
  assert.equal(p("aparta media hora hoy").minutes, 30);
  assert.equal(p("aparta 1 hora y media el viernes").minutes, 90);
  assert.equal(p("bloquea 45 minutos mañana").minutes, 45);
});

test("día: hoy, mañana, pasado mañana, día de la semana, día del mes y fecha completa", () => {
  assert.equal(p("junta pasado mañana a las 10").date, "2026-11-20");
  assert.equal(p("junta el viernes a las 10").date, "2026-11-20");
  assert.equal(p("junta el lunes a las 10").date, "2026-11-23");
  assert.equal(p("junta el miércoles a las 10").date, "2026-11-25", "el mismo día de la semana es el de la semana siguiente");
  assert.equal(p("junta el 20 a las 10").date, "2026-11-20");
  assert.equal(p("junta el 5 a las 10").date, "2026-12-05", "un día que ya pasó es del mes siguiente");
  assert.equal(p("junta el 3 de diciembre a las 10").date, "2026-12-03");
  assert.equal(p("junta 20/11 de 9 a 10").date, "2026-11-20");
  assert.equal(p("junta a las 10 de la mañana").dateSaid, false);
  // «de la mañana» no es «mañana».
  const morning = p("junta hoy a las 10 de la mañana", zonedMs(2026, 11, 18, 8, 0, MX));
  assert.equal(morning.date, "2026-11-18");
  // Sin día: hoy si la hora no ha pasado; si ya pasó, mañana, y se dice.
  const late = p("junta a las 10 con Daniel");
  assert.equal(late.date, "2026-11-19");
  assert.match(late.notes.join(" "), /ya pasó hoy/);
  const early = p("junta a las 4 con Daniel", zonedMs(2026, 11, 18, 9, 0, MX));
  assert.equal(early.date, "2026-11-18");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("con quién: uno o varios, sin confundir «con el título»", () => {
  assert.deepEqual(p("junta mañana a las 10 con Daniel y Gigdem").people, ["Daniel", "Gigdem"]);
  assert.deepEqual(p("junta mañana a las 10 con Daniel, Gigdem y Yair").people, ["Daniel", "Gigdem", "Yair"]);
  assert.deepEqual(p("junta mañana a las 10 con el título de revisión").people, []);
  assert.deepEqual(p("junta con Daniel Mondragón mañana a las 10").people, ["Daniel Mondragón"]);
});

test("título: con su marca, entre comillas, tras «para» o «sobre», o ninguno", () => {
  assert.equal(p("junta mañana a las 10 con Daniel titulada cierre de sprint").title, "Cierre de sprint");
  assert.equal(p("junta con el título: revisión de pendientes, mañana de 9 a 10 con Gigdem").title, "Revisión de pendientes");
  assert.equal(p("junta «Plan de noviembre» mañana a las 10").title, "Plan de noviembre");
  assert.equal(p("junta mañana a las 10 con Daniel sobre el configurador").title, "El configurador");
  assert.equal(p("junta mañana a las 10 con Daniel").title, undefined);
  const tailTime = p("agenda una sesión con el título de ver configurador de usuarios mañana de 9 a 11 con gigdem");
  assert.equal(tailTime.title, "Ver configurador de usuarios");
  assert.equal(hm(tailTime.startMinute), "09:00");
  assert.deepEqual(tailTime.people, ["gigdem"]);
});

test("la frase que falló el 18/11: dos renglones, la hora dicha dos veces y «con el motivo de…»", () => {
  const r = p("Haz una junta mañana a las 9 am\nDe 9 a 11 con el motivo de hacer o revisar los user de honda con Gigdem");
  assert.equal(r.date, "2026-11-19");
  assert.deepEqual([hm(r.startMinute), hm(r.endMinute)], ["09:00", "11:00"]);
  assert.deepEqual(r.people, ["Gigdem"]);
  assert.equal(r.title, "Hacer o revisar los user de honda");
  assert.deepEqual(r.notes, []);
  assert.equal(p("junta mañana a las 10 con Daniel, asunto: cierre de mes").title, "Cierre de mes");
  assert.deepEqual(p("junta mañana a las 10 con Daniel, asunto: cierre de mes").people, ["Daniel"]);
});

test("lo que no se entiende se dice", () => {
  assert.throws(() => p("hola"), QuickError);
  assert.throws(() => p(""), QuickError);
});
