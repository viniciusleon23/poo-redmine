import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACK_CATALOG,
  ANALYSIS_STATUS,
  HANDOFF_STATUS,
  PLAN_SUMMARY,
  START_CATALOG,
  START_STATUS,
  NEEDS_REVIEW,
  PUBLISHES,
  ackComment,
  afterReview,
  agendaDecisionPrompt,
  clarifyRules,
  closePrompt,
  decisionFromQuestion,
  decisionFromText,
  escalatePrompt,
  evidenceRules,
  extractPlanSummary,
  fixPrompt,
  greeting,
  isWatcherText,
  kickoffPrompt,
  mexicoHour,
  normalizeNotes,
  noticePrompt,
  operatingRules,
  parseStage,
  parseVerdict,
  planDecisionFromQuestion,
  planDecisionFromText,
  publishedPrompt,
  releasePrompt,
  reviewPrompt,
  startComment,
  workRules,
} from "../src/redmine/flow.ts";

const TOOL = "/x/redmine_comentar.py";

test("el acuse sale de un catálogo, con el nombre, el saludo de la hora y sin repetir el último", () => {
  assert.ok(ACK_CATALOG.length >= 8);
  const first = ackComment("Hugo Pérez", { random: () => 0, hour: 9 });
  assert.equal(first.index, 0);
  assert.equal(first.text, "Hola Hugo, trabajaré en ello. 🐼");
  // La misma tirada con la anterior ya usada cae en la siguiente frase.
  const second = ackComment("Hugo Pérez", { random: () => 0, hour: 9, last: 0 });
  assert.equal(second.index, 1);
  assert.equal(second.text, "Hola Hugo, buen día. Ya lo tengo; lo analizo y te comento por aquí. 🐼");
  for (let last = 0; last < ACK_CATALOG.length; last++)
    for (const r of [0, 0.37, 0.999999]) assert.notEqual(ackComment("Ana", { random: () => r, last }).index, last);
  // Todas las frases quedan completas: sin marcadores sueltos, con el nombre y la firma.
  for (let i = 0; i < ACK_CATALOG.length; i++) {
    const { text } = ackComment("Ana", { random: () => i / ACK_CATALOG.length, hour: 15 });
    assert.doesNotMatch(text, /[{}]/);
    assert.match(text, /Ana/);
    assert.match(text, /🐼$/);
  }
  assert.match(ackComment("Hugo", { random: () => 3 / ACK_CATALOG.length, hour: 15 }).text, /^Buenas tardes Hugo\. /);
  assert.equal(ackComment("", { random: () => 0, hour: 9 }).text, "Hola, trabajaré en ello. 🐼");
});

test("al pasar a «En curso» el aviso sale de su propio catálogo, también sin repetir el último", () => {
  assert.ok(START_CATALOG.length >= 6);
  assert.equal(startComment("Catalina P.", { random: () => 0, hour: 10 }).text, "Hola Catalina, ya estoy trabajando en ello. 🐼");
  assert.equal(startComment("Catalina P.", { random: () => 0, hour: 16, last: 0 }).text, "Hola Catalina, buenas tardes. Empiezo con esto; te aviso por aquí en cuanto quede. 🐼");
  for (let last = 0; last < START_CATALOG.length; last++)
    for (const r of [0, 0.5, 0.999999]) assert.notEqual(startComment("Ana", { random: () => r, last }).index, last);
  for (let i = 0; i < START_CATALOG.length; i++) {
    const { text } = startComment("Ana", { random: () => i / START_CATALOG.length, hour: 9 });
    assert.doesNotMatch(text, /[{}]/);
    assert.match(text, /Ana/);
    assert.match(text, /🐼$/);
  }
  // Ninguna frase de inicio se confunde con las del acuse.
  for (const text of START_CATALOG) assert.equal((ACK_CATALOG as readonly string[]).includes(text), false);
});

test("los estados siguen el flujo del equipo: análisis, en curso y terminado por desarrollo", () => {
  assert.equal(ANALYSIS_STATUS, "En análisis o en revisión");
  assert.equal(START_STATUS, "En curso");
  assert.equal(HANDOFF_STATUS, "Terminado por Desarrollo");
});

test("el plan pide tiempo estimado y dependencia frontal, y su aprobación se lee del botón o del texto", () => {
  assert.match(PLAN_SUMMARY, /\*\*Tiempo estimado:\*\*/);
  assert.match(PLAN_SUMMARY, /\*\*Dependencia frontal:\*\*/);
  const rules = workRules(39030, "Catalina P.", TOOL);
  assert.match(rules, /Tiempo estimado/);
  assert.match(rules, /ninguna/);
  assert.match(operatingRules(), /Redmine avanza con mi agenda/);
  assert.equal(planDecisionFromQuestion('User has answered your questions: "¿Apruebo el plan?"="Aprobar". You can now continue.'), "APROBAR");
  assert.equal(planDecisionFromQuestion('User has answered your questions: "¿Apruebo el plan?"="Ajustar".'), "AJUSTAR");
  assert.equal(planDecisionFromQuestion('User has answered your questions: "¿Finalizo #1?"="Finalizar".'), undefined);
  assert.equal(planDecisionFromText("sí, dale"), "APROBAR");
  assert.equal(planDecisionFromText("aprobado"), "APROBAR");
  assert.equal(planDecisionFromText("ajusta el tiempo, son 2 horas"), "AJUSTAR");
  assert.equal(planDecisionFromText("¿cuánto tarda?"), undefined);
  assert.equal(planDecisionFromText("revisa también la tabla de citas"), undefined);
});

test("el saludo sigue la hora de México", () => {
  assert.equal(greeting(5), "buen día");
  assert.equal(greeting(11), "buen día");
  assert.equal(greeting(12), "buenas tardes");
  assert.equal(greeting(18), "buenas tardes");
  assert.equal(greeting(19), "buenas noches");
  assert.equal(greeting(2), "buenas noches");
  assert.equal(mexicoHour(new Date("2026-11-13T03:30:00Z")), 21);
  assert.equal(mexicoHour(new Date("2026-11-12T15:05:00Z")), 9);
});

test("la marca de etapa es la última línea «Etapa:» y no cualquier mención", () => {
  assert.equal(parseStage("Diagnóstico…\n\n**Resumen del plan**\n- …\n\nEtapa: PLAN"), "PLAN");
  assert.equal(parseStage("Etapa: PLAN\n…aprobado, hecho…\n`Etapa: EJECUTADO`"), "EJECUTADO");
  assert.equal(parseStage("**Etapa:** no es nuestro"), "NO ES NUESTRO");
  assert.equal(parseStage("> Etapa: sin despliegue"), "SIN DESPLIEGUE");
  assert.equal(parseStage("Etapa: EN ESPERA"), "EN ESPERA");
  assert.equal(parseStage("Etapa: SIN RESPUESTA"), "SIN RESPUESTA");
  assert.equal(parseStage("Etapa: CERRADO"), "CERRADO");
  assert.equal(parseStage("En la etapa: plan vimos que…"), undefined);
  assert.equal(parseStage("Avance: pruebas — 14/14 en verde"), undefined);
  assert.equal(parseStage("Etapa: LISTA"), undefined);
  assert.ok(NEEDS_REVIEW.has("EJECUTADO") && NEEDS_REVIEW.has("RESPUESTA") && !NEEDS_REVIEW.has("PLAN"));
  assert.ok(PUBLISHES.has("DESPLEGADO") && PUBLISHES.has("SIN DESPLIEGUE") && !PUBLISHES.has("EJECUTADO"));
});

test("el trabajo inicial pide el plan con su resumen y que lo apruebe el propietario", () => {
  const rules = workRules(39015, "Hugo Pérez", TOOL);
  for (const piece of [
    "Qué pidieron", "Qué cambiamos nosotros", "Servicios afectados", "Por qué es necesario",
    "¿Apruebo el plan?", "Etapa: APROBADO", "no empieces a implementar", "README-front-<tema>.md", "Etapa: PLAN", "Etapa: NO ES NUESTRO", "Etapa: EJECUTADO",
    "pruebas de punta a punta del workflow", `python3 ${TOOL} 39015 --notas-archivo <archivo>`, "--vista-previa", "dirigido a Hugo",
  ]) assert.ok(rules.includes(piece), piece);
  assert.match(rules, /No implementes todavía/);
  assert.match(rules, /No uses la herramienta `question`/, "una pregunta con herramienta deja el turno colgado sin que el propietario lo vea");
  assert.match(rules, /Nunca menciones el README/);
  assert.match(rules, /se compartirá la documentación/);
  const ops = operatingRules();
  assert.match(ops, /Sin mi aprobación del plan no implementas/);
  assert.match(ops, /El comentario en Redmine no lo publicas tú/);
  assert.match(ops, /Sé conciso/);
});

test("la regla de evidencia exige fuente y buscar antes de negar", () => {
  const rules = evidenceRules();
  assert.match(rules, /archivo:línea/);
  assert.match(rules, /«no existe», «no está»/);
  assert.match(rules, /el código .* los datos .* y el Brain/s);
  assert.match(rules, /«No tengo acceso» o «no pude comprobarlo» no son respuestas/);
  assert.ok(clarifyRules(1, TOOL).includes(rules));
});

test("el resumen del plan se extrae del mensaje del agente", () => {
  const text = [
    "Diagnóstico: el puente no reenvía la actualización (`src/bridge.ts:120`).",
    "",
    "**Resumen del plan**",
    "- **Qué pidieron:** que la cita actualizada se refleje.",
    "- **Qué cambiamos nosotros:** el puente compara y actualiza.",
    "- **Servicios afectados:** capnet-next-bridge-api.",
    "- **Por qué es necesario:** hoy se pierde el cambio.",
    "",
    "Etapa: PLAN",
  ].join("\n");
  const plan = extractPlanSummary(text)!;
  assert.equal(plan.split("\n").length, 4);
  assert.match(plan, /^- \*\*Qué pidieron:\*\*/);
  assert.doesNotMatch(plan, /Etapa/);
  assert.equal(extractPlanSummary("sin plan aquí"), undefined);
});

test("el veredicto del supervisor se lee de su línea y decide el siguiente paso", () => {
  assert.equal(parseVerdict("Veredicto: CUMPLE\nTodo comprobado."), "CUMPLE");
  assert.equal(parseVerdict("**Veredicto:** OBSERVACIONES\n1. …"), "OBSERVACIONES");
  assert.equal(parseVerdict("Veredicto: NO CUMPLE"), "OBSERVACIONES");
  assert.equal(parseVerdict("Veredicto: CUMPLE CON OBSERVACIONES"), "OBSERVACIONES");
  assert.equal(parseVerdict("El trabajo cumple en general."), undefined);
  // La línea de plantilla «CUMPLE | OBSERVACIONES» no es un veredicto.
  assert.equal(parseVerdict("Veredicto: OBSERVACIONES\n…\nVeredicto: CUMPLE"), "CUMPLE");

  assert.equal(afterReview("CUMPLE", 0, 1), "close");
  assert.equal(afterReview("CUMPLE", 1, 1), "close");
  assert.equal(afterReview("OBSERVACIONES", 0, 1), "fix");
  assert.equal(afterReview("OBSERVACIONES", 1, 1), "escalate");
  assert.equal(afterReview(undefined, 0, 1), "escalate");
});

test("el supervisor compara contra la solicitud y el plan aprobado, y revisa la evidencia", () => {
  const p = reviewPrompt({ issueId: 39015, kind: "trabajo", request: "Actualizar el campo de operación", plan: "- **Qué pidieron:** X", preview: { notes: "Hola Hugo, ya quedó. 🐼", capture: "/c/01.png" } });
  assert.ok(isWatcherText(p));
  for (const piece of ["<<<SOLICITUD", "Actualizar el campo de operación", "<<<PLAN", "- **Qué pidieron:** X", "Abre tú la fuente", "Corre tú las pruebas de punta a punta", "<<<COMENTARIO", "Hola Hugo, ya quedó. 🐼", "Veredicto: CUMPLE | OBSERVACIONES", "Entras una sola vez"])
    assert.ok(p.includes(piece), piece);
  const again = reviewPrompt({ issueId: 39015, kind: "trabajo", request: "x", second: true });
  assert.match(again, /segunda y última pasada/);
  assert.match(again, /No hay vista previa del comentario/);
  const answer = reviewPrompt({ issueId: 39015, kind: "respuesta", request: "x", plan: "no debe salir", preview: { notes: "n" } });
  assert.match(answer, /respuesta a un comentario/);
  assert.doesNotMatch(answer, /Corre tú las pruebas/);
});

test("el cierre ofrece Finalizar, Rechazar o Esperar, publica en dev y producción y deja el comentario al vigilante", () => {
  for (const p of [closePrompt(7, "trabajo"), escalatePrompt(7, "trabajo", "observaciones"), closePrompt(7, "respuesta")]) {
    assert.ok(isWatcherText(p));
    assert.match(p, /«Finalizar», «Rechazar» y «Esperar»/);
    assert.match(p, /No uses la herramienta `question`/);
    assert.match(p, /Etapa: CIERRE/);
    assert.match(p, /No publiques el comentario ni cambies el estado/);
    assert.ok(p.includes(HANDOFF_STATUS));
    for (const mark of ["Etapa: RECHAZADO", "Etapa: EN ESPERA", "Etapa: SIN DESPLIEGUE"]) assert.ok(p.includes(mark), mark);
  }
  const work = closePrompt(7, "trabajo");
  assert.match(work, /Etapa: DESPLEGADO/);
  assert.match(work, /PR `main`→`production`/, "finalizar es subir a los dos ambientes");
  assert.match(work, /Qué falta en producción además del código/);
  assert.match(work, /README frontal/);
  assert.doesNotMatch(work, /A su hora/, "sin bloque por delante no se ofrece esperar a su hora");
  assert.doesNotMatch(closePrompt(7, "respuesta"), /Etapa: DESPLEGADO/);
  assert.match(escalatePrompt(7, "trabajo", "sin-veredicto"), /no dejó un veredicto legible/);
  assert.match(fixPrompt(7, "trabajo"), /Etapa: EJECUTADO/);
  assert.match(fixPrompt(7, "respuesta"), /Etapa: RESPUESTA/);

  // Listo antes de tiempo: se le recuerda la hora planificada y se ofrece publicar a su hora.
  const early = closePrompt(7, "trabajo", { until: "15:00", now: "11:05" });
  assert.match(early, /#7 estaba planificada para terminar a las 15:00 y son las 11:05\. ¿La publico ya o espero a las 15:00\?/);
  assert.match(early, /«Finalizar» \(publicar ya\), «A su hora» \(publicar a las 15:00\), «Rechazar» y «Esperar»/);
  assert.match(early, /Etapa: PROGRAMADO/);
  assert.doesNotMatch(closePrompt(7, "respuesta", { until: "15:00", now: "11:05" }), /A su hora/, "una respuesta no espera bloque");

  // El aviso de que llegó la hora y el de la Agenda piden lo mismo: los dos ambientes.
  for (const p of [releasePrompt(7, "trabajo", "hora"), releasePrompt(7, "trabajo", "agenda")]) {
    assert.ok(isWatcherText(p));
    assert.match(p, /Dev\*\*: push y PR de cada rama a `main`/);
    assert.match(p, /Producción\*\*: promueve/);
    assert.match(p, /no termines el turno esperando un despliegue/);
    assert.match(p, /Etapa: BLOQUEADO/);
  }
  assert.ok(isWatcherText(agendaDecisionPrompt(7, "rechazar", "falta X")));

  // El arranque del bloque lleva el plan y las reglas completas (puede atenderlo otro modelo).
  const kick = kickoffPrompt({ issueId: 7, author: "Hugo Pérez", commentTool: TOOL, plan: "- **Tiempo estimado:** 2 h", until: "15:00" });
  assert.ok(isWatcherText(kick));
  for (const piece of ["empezó el bloque de #7", "termina 15:00", "Tiempo estimado", "README-front-<tema>.md", "--vista-previa", "Etapa: EJECUTADO", "Avance:"]) assert.ok(kick.includes(piece), piece);
});

test("las marcas nuevas se leen y la decisión «a su hora» se distingue de esperar", () => {
  assert.equal(parseStage("ok\n\nEtapa: APROBADO"), "APROBADO");
  assert.equal(parseStage("ok\n\nEtapa: CIERRE"), "CIERRE");
  assert.equal(parseStage("ok\n\nEtapa: PROGRAMADO"), "PROGRAMADO");
  assert.equal(parseStage("ok\n\nEtapa: PLAN"), "PLAN");
  assert.equal(decisionFromText("a su hora"), "PROGRAMAR");
  assert.equal(decisionFromText("publícalo a las 3"), "PROGRAMAR");
  assert.equal(decisionFromText("espera hasta las 15:00"), "PROGRAMAR");
  assert.equal(decisionFromText("espera"), "ESPERAR");
  assert.equal(decisionFromText("finaliza"), "FINALIZAR");
  assert.equal(decisionFromQuestion('"¿Finalizo #7?"="A su hora (15:00)"'), "PROGRAMAR");
  assert.equal(decisionFromQuestion('"¿Finalizo #7?"="Finalizar"'), "FINALIZAR");
});

test("los textos del vigilante y del daemon no se confunden con los del propietario", () => {
  for (const text of [
    "Nueva tarea asignada en Redmine: #1 «x».",
    "Comentario nuevo en Redmine #1 «x»",
    fixPrompt(1, "trabajo"),
    publishedPrompt(1, "publicado, journal 5"),
    noticePrompt(1, "falta la marca"),
    "Recuperación automática de Poo IA: el turno anterior se cortó…",
    "Validación independiente (Redmine #1).",
  ]) assert.ok(isWatcherText(text), text.slice(0, 40));
  for (const text of ["Finalizar", "sí, dale", "Ya, publícalo", "El supervisor se equivocó, corrige"]) assert.equal(isWatcherText(text), false, text);
  assert.match(publishedPrompt(1, "publicado, journal 5"), /Etapa: CERRADO/);
});

test("la decisión del cierre se lee del botón o de lo que escribe el propietario", () => {
  const answered = (a: string) => `User has answered your questions: "¿Finalizo #39015?"="${a}". You can now continue with the user's answers in mind.`;
  assert.equal(decisionFromQuestion(answered("Finalizar")), "FINALIZAR");
  assert.equal(decisionFromQuestion(answered("Rechazar")), "RECHAZAR");
  assert.equal(decisionFromQuestion(answered("Esperar")), "ESPERAR");
  assert.equal(decisionFromQuestion(answered("Unanswered")), undefined);
  assert.equal(decisionFromQuestion(answered("Aprobar")), undefined);
  // Lo último respondido manda.
  assert.equal(decisionFromQuestion(`"¿Apruebo?"="Aprobar", "¿Finalizo #1?"="Esperar"`), "ESPERAR");

  for (const yes of ["Finalizar", "finalízalo", "sí", "Si dale", "Ya ponlo", "Hazlo", "Mándalo y reenvía", "publícalo", "va", "adelante", "súbelo ya"])
    assert.equal(decisionFromText(yes), "FINALIZAR", yes);
  for (const [text, want] of [
    ["Rechazar", "RECHAZAR"], ["lo rechazo, cambia el saludo", "RECHAZAR"], ["Esperar", "ESPERAR"], ["espérame tantito", "ESPERAR"],
  ] as const) assert.equal(decisionFromText(text), want, text);
  // Sin un sí claro no hay Finalizar: una duda, un no o una corrección no publican nada.
  for (const other of ["¿Pero ya lo enviaste?", "no, todavía no", "no lo mandes", "cambia la segunda línea y dale", "aún no lo publiques", "", "mmm"])
    assert.notEqual(decisionFromText(other), "FINALIZAR", other);
});

test("la huella del comentario ignora los saltos de Windows y los espacios de los extremos", () => {
  assert.equal(normalizeNotes("  Hola Hugo,\r\nya quedó. 🐼\n"), "Hola Hugo,\nya quedó. 🐼");
});

test("agenda: lo que Consultoría regresa a «Pendiente por proceso» vuelve a nuestro lado, no es una entrega", async () => {
  const { oursOnAgenda, OURS_STATUSES } = await import("../src/redmine/flow.ts");
  assert.equal(oursOnAgenda("Pendiente por proceso"), true);
  assert.equal(oursOnAgenda(" pendiente por proceso "), true);
  assert.equal(oursOnAgenda("Comentarios o no aprobado"), true);
  assert.equal(oursOnAgenda("Espera validación consultoría"), false);
  assert.equal(oursOnAgenda("Terminado por Desarrollo"), false);
  // El vigilante no mueve el estado de Redmine desde un estado regresado.
  assert.equal(OURS_STATUSES.includes("Pendiente por proceso"), false);
});
