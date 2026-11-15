import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../src/agenda/cards.ts";
import { extractMissing, firstSentence, issueStory, ownerPaused, parsePlanBrief, storyOf } from "../src/agenda/story.ts";
import type { Issue } from "../src/redmine/api.ts";
import type { Snapshot } from "../src/redmine/cycle.ts";
import { PLAN_SUMMARY, extractPlanSummary } from "../src/redmine/flow.ts";

const PLAN = [
  "Diagnóstico: el bot es nuestro.",
  "",
  "**Resumen del plan**",
  "- **En una frase:** Catalina pide un documento en Word con lo que hace hoy el chatbot.",
  "- **Qué pidieron:** documentación funcional del chatbot, con ejemplos.",
  "- **Qué cambiamos nosotros:** nada de código; se escribe el documento desde lo desplegado.",
  "- **Servicios afectados:** ninguno.",
  "- **Por qué es necesario:** el cliente lo va a revisar.",
  "- **Se puede:** sí — todo está en producción.",
  "- **Tamaño del cambio:** bajo — no se toca código.",
  "- **Tiempo estimado:** 3 h",
  "- **Dependencia frontal:** ninguna",
  "",
  "Etapa: PLAN",
].join("\n");

test("el resumen del plan pide la frase, si se puede y el tamaño, y cabe entero en lo que se guarda", () => {
  assert.match(PLAN_SUMMARY, /\*\*En una frase:\*\*/);
  assert.match(PLAN_SUMMARY, /\*\*Se puede:\*\*/);
  assert.match(PLAN_SUMMARY, /\*\*Tamaño del cambio:\*\*/);
  const kept = extractPlanSummary(PLAN)!;
  assert.match(kept, /En una frase/);
  assert.match(kept, /Dependencia frontal/);
});

test("del plan salen la frase, lo pedido, lo que haremos, si se puede y el tamaño", () => {
  const brief = parsePlanBrief(extractPlanSummary(PLAN)!);
  assert.equal(brief.brief, "Catalina pide un documento en Word con lo que hace hoy el chatbot.");
  assert.equal(brief.asked, "documentación funcional del chatbot, con ejemplos.");
  assert.match(brief.doing!, /^nada de código/);
  assert.equal(brief.feasible, "si");
  assert.equal(brief.feasibleWhy, "todo está en producción.");
  assert.equal(brief.size, "bajo");
  assert.equal(brief.sizeWhy, "no se toca código.");
});

test("un plan viejo, sin las líneas nuevas, no inventa nada", () => {
  const brief = parsePlanBrief("- **Qué pidieron:** un reporte\n- **Tiempo estimado:** 2 h");
  assert.equal(brief.asked, "un reporte");
  assert.equal(brief.brief, undefined);
  assert.equal(brief.feasible, undefined);
  assert.equal(brief.size, undefined);
});

test("«parcial» y «no» se reconocen, y un valor raro se deja como explicación", () => {
  assert.equal(parsePlanBrief("- **Se puede:** parcial, falta el acceso a prod").feasible, "parcial");
  assert.equal(parsePlanBrief("- **Se puede:** no: el servicio no es nuestro").feasible, "no");
  const odd = parsePlanBrief("- **Tamaño del cambio:** depende del cliente");
  assert.equal(odd.size, undefined);
  assert.equal(odd.sizeWhy, "depende del cliente");
});

test("sin plan, la frase es la primera de la descripción", () => {
  assert.equal(firstSentence("Quisiera su apoyo con un documento (en Word). La idea es…\n\nOtro párrafo"), "Quisiera su apoyo con un documento (en Word).");
  assert.equal(firstSentence("> cita\n\nAgradezco su ayuda configurando el CDN"), "Agradezco su ayuda configurando el CDN");
  assert.equal(firstSentence(""), undefined);
  assert.equal(firstSentence("x".repeat(300))!.length, 180);
});

test("«Falta» del cierre: se toma el bloque y se ignora cuando no falta nada", () => {
  const closing = ["**Hecho:** quedó el reporte y se probó.", "", "**Falta**", "- De nuestro lado: nada.", "- De su lado: que el frontal conecte el botón.", "", "Etapa: EJECUTADO"].join("\n");
  assert.equal(extractMissing(closing), "De nuestro lado: nada. De su lado: que el frontal conecte el botón.");
  assert.equal(extractMissing("**Falta:** nada.\n\nEtapa: EJECUTADO"), undefined);
  assert.equal(extractMissing("Sin sección de pendientes.\n\nEtapa: EJECUTADO"), undefined);
});

const msg = (role: string, createdAt: number, text: string) => ({ role, createdAt, completedAt: createdAt + 1, parts: [{ kind: "text", text }] });

test("de la conversación sale lo último que dijo el propietario, no lo que escribió el vigilante", () => {
  const snap: Snapshot = {
    task: { status: "idle", directory: "/tmp" },
    messages: [
      msg("user", 1, "Nueva tarea asignada en Redmine: #1 «x»."),
      msg("assistant", 2, "Avance.\n\n**Falta:** que confirmes el formato.\n\nEtapa: BLOQUEADO"),
      msg("user", 3, "Aún no lo vamos a trabajar"),
      msg("user", 4, "Recuperación automática de Poo IA: el turno anterior se cortó."),
    ],
  };
  const story = storyOf(snap);
  assert.deepEqual(story.ownerSaid, { at: 3, text: "Aún no lo vamos a trabajar" });
  assert.equal(story.missing, "que confirmes el formato.");
});

const issue = (journals: Issue["journals"]): Issue => ({
  id: 38549,
  subject: "CONFIGURACION CDN V5",
  project: { id: 50, name: "CRM V5" },
  tracker: { id: 1, name: "Desarrollo" },
  status: { id: 4, name: "Comentarios o no aprobado" },
  priority: { id: 2, name: "Medio" },
  author: { id: 7, name: "Catalina P." },
  created_on: "2026-09-10T00:11:57Z",
  updated_on: "2026-11-12T20:30:36Z",
  journals,
});
const names = (id: string) => ({ "2": "En curso", "4": "Comentarios o no aprobado", "10": "Espera validación consultoría" })[id];

test("el recorrido sale de los movimientos de Redmine, con quién y cuándo", () => {
  const story = issueStory(
    issue([
      { id: 1, user: { id: 3, name: "Yair S." }, created_on: "2026-11-11T07:15:38Z", notes: "cual es el estatus?", details: [{ property: "attr", name: "status_id", old_value: "1", new_value: "4" }, { property: "attr", name: "assigned_to_id", old_value: null, new_value: "95" }] },
      { id: 2, user: { id: 95, name: "Vinicius L." }, created_on: "2026-11-11T13:16:38Z", notes: "Hola Catalina, ya quedó cargado el histórico." },
      { id: 3, user: { id: 95, name: "Vinicius L." }, created_on: "2026-11-12T20:30:36Z", notes: "@eliu @victor @Yairm ¿Me apoyan para pasarla a la v2? 🐼" },
    ]),
    95,
    names,
  );
  assert.deepEqual(
    story.history.map((h) => h.text),
    [
      "Catalina P. la pidió.",
      "Yair S. la pasó a «Comentarios o no aprobado».",
      "Yair S. te la asignó.",
      "Yair S. comentó: «cual es el estatus?»",
      "Publicaste: «Hola Catalina, ya quedó cargado el histórico.»",
      "Publicaste: «@eliu @victor @Yairm ¿Me apoyan para pasarla a la v2? 🐼»",
    ],
  );
  assert.equal(story.assignedAt, Date.parse("2026-11-11T07:15:38Z"));
  assert.equal(story.history.filter((h) => h.pub).length, 2);
  assert.deepEqual(story.asked, { at: Date.parse("2026-11-12T20:30:36Z"), to: ["eliu", "victor", "Yairm"], text: "@eliu @victor @Yairm ¿Me apoyan para pasarla a la v2? 🐼" });
});

test("si alguien contesta después, ya no esperas respuesta; y un aviso tuyo sin pregunta tampoco cuenta", () => {
  const answered = issueStory(
    issue([
      { id: 1, user: { id: 95, name: "Vinicius L." }, created_on: "2026-11-12T20:30:36Z", notes: "@eliu ¿me apoyas?" },
      { id: 2, user: { id: 8, name: "Eliu" }, created_on: "2026-11-13T15:00:00Z", notes: "Listo, ya quedó." },
    ]),
    95,
    names,
  );
  assert.equal(answered.asked, undefined);
  const notice = issueStory(issue([{ id: 1, user: { id: 95, name: "Vinicius L." }, created_on: "2026-11-11T13:16:38Z", notes: "Hola Catalina, ya quedó cargado. 🐼" }]), 95, names);
  assert.equal(notice.asked, undefined);
});

test("una petición nuestra sin avance pero con pregunta tuya pendiente espera a otros", () => {
  const base = { status: "Comentarios o no aprobado", ours: true, hasConversation: true, busy: false, reviewing: false, awaitingClose: false, hold: false, now: 1 };
  assert.deepEqual(classify({ ...base, asked: true }), { turn: "otros", state: "respuesta" });
  assert.deepEqual(classify(base), { turn: "tu", state: "sin_avance" });
  // Lo que pide tu decisión gana siempre.
  assert.equal(classify({ ...base, asked: true, stage: "PLAN" }).state, "plan");
});

test("una pausa pedida por el propietario se reconoce por lo que dijo", () => {
  assert.equal(ownerPaused("Aún no lo vamos a trabajar cambia el estatus a analizando"), true);
  assert.equal(ownerPaused("todavía no, déjala en espera"), true);
  assert.equal(ownerPaused("sí, dale"), false);
  assert.equal(ownerPaused("No me queda claro el alcance"), false);
});
