import { test } from "node:test";
import assert from "node:assert/strict";
import { createCycle, hashOf } from "../src/redmine/cycle.ts";
import type { Approved, ChatMessage, Linked, Part } from "../src/redmine/cycle.ts";

const WORK = "opencode-go/deepseek-v4.1-flash";
const REVIEW = "claude/claude-opus-5-5@medium";
const PLAN = ["**Resumen del plan**", "- **Qué pidieron:** actualizar la cita.", "- **Qué cambiamos nosotros:** el puente.", "- **Servicios afectados:** bridge-api.", "- **Por qué es necesario:** se pierde el cambio."].join("\n");
const answered = (option: string): Part => ({ kind: "tool", tool: "question", status: "completed", output: `User has answered your questions: "¿Finalizo #39015?"="${option}". You can now continue with the user's answers in mind.` });

/** Una conversación simulada y el vigilante sobre ella. */
function scene(
  extra: Partial<Linked> = {},
  cfg: Partial<{ model: string; analysisModel: string | undefined; reviewModel: string | undefined; maxFixes: number; maxReviews: number; reviewTimeoutMs: number }> = {},
  agenda?: { fails?: () => boolean; gate?: () => { wait: boolean; until?: number }; started?: () => boolean; timing?: () => { until: string; now: string } | undefined },
) {
  let clock = 1_000_000;
  const tick = () => (clock += 1000);
  const messages: ChatMessage[] = [];
  const conv = { status: "idle", model: WORK as string, directory: "/conv/x" };
  const linked: Linked = { taskId: "t1", lastJournalId: 1, linkedAt: new Date(clock).toISOString(), protocol: 2, ...extra };
  const sent: string[] = [];
  const models: string[] = [];
  const published: Approved[] = [];
  const logs: string[] = [];
  let fetches = 0;
  let preview: Approved | undefined;
  let publishFails = false;
  const scheduled: string[] = [];
  const kinds: string[] = [];
  const { cycle, decide } = createCycle({
    task: async () => {
      fetches++;
      return { task: { ...conv }, messages: messages.map((m) => ({ ...m })) };
    },
    setModel: async (_id, m) => {
      conv.model = m;
      models.push(m);
    },
    send: async (_id, text) => {
      sent.push(text);
      messages.push({ role: "user", createdAt: tick(), parts: [{ kind: "text", text }] });
    },
    conversations: async () => new Map([["t1", { status: conv.status, signature: `${conv.status}|${messages.length}` }]]),
    request: async () => "#39015 «Actualización en campo de operación»\nQue la cita actualizada se refleje.",
    readPreview: () => preview,
    publish: async (_issue, approved, _directory, kind) => {
      if (publishFails) throw new Error("Redmine PUT respondió HTTP 500");
      published.push(approved);
      kinds.push(kind);
      return "publicado, journal 147400, estado «Terminado por Desarrollo», http://r/issues/39015#change-147400";
    },
    schedule: agenda
      ? async (_issue, l) => {
          if (agenda.fails?.()) throw new Error("No pude conectar con la agenda.");
          scheduled.push(l.plan ?? "");
          return "3 h de trabajo: mar 17 nov, 09:00–12:00";
        }
      : undefined,
    publishGate: agenda?.gate ? () => agenda.gate!() : undefined,
    workStarted: agenda?.started ? () => agenda.started!() : undefined,
    kickoff: agenda?.started ? async (_issue, l) => `Aviso del vigilante: empezó el bloque de #39015 en la agenda.\n${l.plan ?? ""}` : undefined,
    closeTiming: agenda?.timing ? () => agenda.timing!() : undefined,
    save: () => {},
    log: (line) => logs.push(line),
    now: () => tick(),
    cfg: { model: WORK, reviewModel: REVIEW, maxFixes: 1, maxReviews: 2, reviewTimeoutMs: 30 * 60_000, ...cfg },
  });
  return {
    linked, sent, models, published, logs, conv, messages, scheduled, kinds,
    fetches: () => fetches,
    clock: () => clock,
    run: () => cycle("39015", linked),
    decide: (decision: Parameters<typeof decide>[2]["decision"], note?: string) => decide("39015", linked, { decision, note }),
    agent: (text: string, ...parts: Part[]) => messages.push({ role: "assistant", createdAt: tick(), completedAt: tick(), parts: [...parts, { kind: "text", text }] }),
    owner: (text: string) => messages.push({ role: "user", createdAt: tick(), parts: [{ kind: "text", text }] }),
    setPreview: (notes: string | undefined) => {
      preview = notes === undefined ? undefined : { hash: hashOf(notes), notes, attachments: [], at: tick() };
    },
    failPublish: (v: boolean) => (publishFails = v),
    wait: (ms: number) => (clock += ms),
  };
}

test("camino completo: plan, aprobación, supervisor, Finalizar y publicación única por la API", async () => {
  const s = scene();
  s.agent(`Diagnóstico con evidencia.\n\n${PLAN}\n\nEtapa: PLAN`);
  await s.run();
  assert.equal(s.sent.length, 0, "con el plan presentado el vigilante no hace nada: decide el propietario");
  assert.equal(s.linked.lastMark, "PLAN");
  assert.match(s.linked.plan!, /Qué pidieron/);

  // El propietario aprueba con el botón; el agente ejecuta y deja la vista previa.
  s.setPreview("Hola Hugo, ya quedó la actualización. 🐼");
  s.agent("Hecho: rama, 14/14 pruebas en verde.\n\nEtapa: EJECUTADO", answered("Aprobar"));
  await s.run();
  assert.deepEqual(s.models, [REVIEW]);
  assert.match(s.sent[0]!, /^Supervisión independiente \(Redmine #39015\)/);
  assert.match(s.sent[0]!, /Que la cita actualizada se refleje/);
  assert.match(s.sent[0]!, /Qué cambiamos nosotros/);
  assert.match(s.sent[0]!, /Hola Hugo, ya quedó la actualización/);
  assert.equal(s.linked.reviews, 1);

  // Mientras el supervisor no responde, nada.
  await s.run();
  assert.equal(s.sent.length, 1);

  s.agent("Veredicto: CUMPLE\nComprobé el diff y corrí las pruebas.");
  await s.run();
  assert.deepEqual(s.models, [REVIEW, WORK], "vuelve al modelo de trabajo");
  assert.match(s.sent[1]!, /^El supervisor confirmó/);
  assert.match(s.sent[1]!, /«Finalizar», «Rechazar» y «Esperar»/);
  assert.equal(s.linked.approved?.notes, "Hola Hugo, ya quedó la actualización. 🐼");
  assert.ok(s.linked.closeAt);
  assert.equal(s.published.length, 0, "sin Finalizar no se publica");

  // Finalizar con el botón: el agente sube a main y el vigilante publica.
  s.agent("Subí a main (SHA abc1234).\n\nEtapa: DESPLEGADO", answered("Finalizar"));
  await s.run();
  assert.equal(s.published.length, 1);
  assert.equal(s.published[0]!.notes, "Hola Hugo, ya quedó la actualización. 🐼");
  await s.run();
  assert.match(s.sent[2]!, /^Aviso del vigilante: el comentario de #39015 ya quedó publicado/);

  s.agent("Listo: http://r/issues/39015#change-147400\n\nEtapa: CERRADO");
  await s.run();
  await s.run();
  assert.equal(s.published.length, 1, "no se publica dos veces");
  assert.equal(s.sent.length, 3);
  // Sin cambios en la conversación no se vuelve a pedir su historial.
  const before = s.fetches();
  await s.run();
  await s.run();
  assert.equal(s.fetches(), before);
});

test("observaciones: una ronda de corrección, segunda pasada y, si sigue, se le sube al propietario", async () => {
  const s = scene();
  s.setPreview("Hola Hugo, quedó. 🐼");
  s.agent("Hecho.\n\nEtapa: EJECUTADO");
  await s.run();
  s.agent("Veredicto: OBSERVACIONES\n1. La afirmación sobre operaciones no tiene fuente.");
  await s.run();
  assert.match(s.sent[1]!, /^El supervisor revisó tu trabajo/);
  assert.equal(s.linked.fixes, 1);
  assert.equal(s.linked.closeAt, undefined);

  s.agent("Corregido, con su fuente.\n\nEtapa: EJECUTADO");
  await s.run();
  assert.match(s.sent[2]!, /segunda y última pasada/);
  assert.equal(s.linked.reviews, 2);

  s.agent("Veredicto: OBSERVACIONES\n1. Sigue sin probar el caso de la agencia 134.");
  await s.run();
  assert.match(s.sent[3]!, /^El supervisor sigue con observaciones/);
  assert.ok(s.linked.closeAt, "el propietario decide con los mismos botones");
  assert.equal(s.linked.approved?.notes, "Hola Hugo, quedó. 🐼", "el comentario que hay es el que el propietario decide entregar así o editar");

  // El propietario rechaza; no se publica nada aunque el agente marque un cierre por error.
  s.agent("Entendido, ¿qué corrijo?\n\nEtapa: RECHAZADO", answered("Rechazar"));
  await s.run();
  assert.equal(s.published.length, 0);
  assert.equal(s.linked.lastMark, "RECHAZADO");

  // Su siguiente mensaje abre un ciclo nuevo: el supervisor puede volver a entrar.
  s.owner("corrige el caso de la 134 y vuelve a probar");
  s.agent("Probado con la 134.\n\nEtapa: EJECUTADO");
  await s.run();
  assert.equal(s.linked.reviews, 1);
  assert.match(s.sent.at(-1)!, /^Supervisión independiente/);
  assert.match(s.sent.at(-1)!, /Entras una sola vez/);
});

test("sin el Finalizar del propietario no se publica, y se avisa una sola vez", async () => {
  const s = scene();
  s.setPreview("Hola Hugo. 🐼");
  s.agent("Hecho.\n\nEtapa: EJECUTADO");
  await s.run();
  s.agent("Veredicto: CUMPLE");
  await s.run();

  // El agente marca el cierre sin que el propietario haya respondido.
  s.agent("Subí a main.\n\nEtapa: DESPLEGADO");
  await s.run();
  await s.run();
  assert.equal(s.published.length, 0);
  assert.match(s.sent.at(-1)!, /no encuentro el «Finalizar» del propietario/);
  const notices = s.sent.length;

  // Un «no, espera» tampoco publica, y no se repite el aviso.
  s.owner("no, espera, todavía no lo mandes");
  s.agent("De acuerdo.\n\nEtapa: SIN DESPLIEGUE");
  await s.run();
  await s.run();
  assert.equal(s.published.length, 0);
  assert.equal(s.sent.length, notices);

  // Cuando sí lo pide por escrito, se publica.
  s.owner("Ya, mándalo");
  s.agent("Nada que subir.\n\nEtapa: SIN DESPLIEGUE");
  await s.run();
  assert.equal(s.published.length, 1);
});

test("si el comentario cambió después de la supervisión, no se publica el texto sin revisar", async () => {
  const s = scene();
  s.setPreview("Hola Hugo, versión revisada. 🐼");
  s.agent("Hecho.\n\nEtapa: EJECUTADO");
  await s.run();
  s.agent("Veredicto: CUMPLE");
  await s.run();
  s.setPreview("Hola Hugo, versión cambiada a última hora. 🐼");
  s.agent("Listo.\n\nEtapa: SIN DESPLIEGUE", answered("Finalizar"));
  await s.run();
  assert.equal(s.published.length, 0);
  await s.run();
  assert.match(s.sent.at(-1)!, /cambió después de la supervisión/);
});

test("un fallo al publicar se dice en el hilo y no se da por publicado", async () => {
  const s = scene();
  s.setPreview("Hola Hugo. 🐼");
  s.agent("Hecho.\n\nEtapa: EJECUTADO");
  await s.run();
  s.agent("Veredicto: CUMPLE");
  await s.run();
  s.failPublish(true);
  s.agent("Nada que subir.\n\nEtapa: SIN DESPLIEGUE", answered("Finalizar"));
  await s.run();
  await s.run();
  assert.equal(s.linked.published, undefined);
  assert.match(s.sent.at(-1)!, /no pude publicar el comentario en Redmine: Redmine PUT respondió HTTP 500/);
});

test("respuesta a un comentario: supervisor sin plan ni pruebas, y cierre sin despliegue", async () => {
  const s = scene({ kind: "respuesta", clarify: "- Hugo: ¿por qué no trae operación?" });
  s.setPreview("Hola Hugo, esas citas llegaron sin operación desde origen. 🐼");
  s.agent("Piden una aclaración; la respuesta está en vista previa.\n\nEtapa: RESPUESTA");
  await s.run();
  assert.match(s.sent[0]!, /respuesta a un comentario/);
  assert.doesNotMatch(s.sent[0]!, /Corre tú las pruebas/);
  s.agent("Veredicto: CUMPLE");
  await s.run();
  assert.doesNotMatch(s.sent[1]!, /Etapa: DESPLEGADO/);

  const t = scene({ kind: "respuesta" });
  t.agent("Solo acusa recibo: no se responde.\n\nEtapa: SIN RESPUESTA");
  await t.run();
  assert.equal(t.sent.length, 0);
  assert.equal(t.models.length, 0);
});

test("alcance ajeno y plan en espera no gastan al supervisor", async () => {
  const s = scene();
  s.agent("Es del frontal (`capnet-next-frontend/src/x.tsx:10`).\n\nEtapa: NO ES NUESTRO");
  await s.run();
  assert.equal(s.sent.length, 0);
  assert.equal(s.models.length, 0);
  assert.match(s.logs.at(-1)!, /NO ES NUESTRO → detenido/);
});

test("un mensaje sin marca se recuerda una vez, y nunca a las conversaciones del flujo anterior", async () => {
  const s = scene();
  s.agent("Ya revisé todo y está bien.");
  await s.run();
  assert.match(s.sent[0]!, /no cierra con la línea `Etapa: <marca>`/);
  s.agent("Sigo sin poner la marca.");
  await s.run();
  assert.equal(s.sent.length, 1, "un solo recordatorio por ciclo");

  const old = scene({ protocol: 1 });
  old.agent("Respuesta de una conversación anterior al flujo nuevo.");
  await old.run();
  assert.equal(old.sent.length, 0);
});

test("con un turno en marcha no hace nada, y un supervisor que no responde se le sube al propietario", async () => {
  const s = scene();
  s.agent("Hecho.\n\nEtapa: EJECUTADO");
  s.conv.status = "running";
  await s.run();
  assert.equal(s.sent.length, 0);
  assert.equal(s.fetches(), 0);

  s.conv.status = "idle";
  await s.run();
  assert.match(s.sent[0]!, /No hay vista previa del comentario/);
  s.wait(31 * 60_000);
  await s.run();
  assert.match(s.sent[1]!, /no dejó un veredicto legible/);
});

test("un comentario de Redmine que llegó durante la supervisión se entrega después, con el modelo de trabajo", async () => {
  const s = scene();
  s.agent("Hecho.\n\nEtapa: EJECUTADO");
  await s.run();
  s.linked.outbox = ["Comentario nuevo en Redmine #39015 «x»"];
  s.agent("Veredicto: CUMPLE");
  await s.run();
  assert.match(s.sent.at(-1)!, /^El supervisor confirmó/);
  await s.run();
  assert.equal(s.sent.at(-1), "Comentario nuevo en Redmine #39015 «x»");
  assert.equal(s.conv.model, WORK);
  assert.deepEqual(s.linked.outbox, []);
});

const PLAN_WITH_TIME = `${PLAN}\n- **Tiempo estimado:** 3 h\n- **Dependencia frontal:** ninguna`;

test("plan aprobado: se agenda una sola vez, aunque el agente ya esté ejecutando", async () => {
  const s = scene({ agendaSince: 0 }, {}, {});
  s.agent(`Diagnóstico.\n\n${PLAN_WITH_TIME}\n\nEtapa: PLAN`);
  await s.run();
  assert.equal(s.scheduled.length, 0, "sin aprobación no se aparta nada");
  assert.match(s.linked.plan!, /Tiempo estimado/);

  // El propietario escribe «sí» y el agente arranca: la conversación queda ocupada.
  s.owner("sí, dale");
  s.conv.status = "running";
  await s.run();
  assert.equal(s.scheduled.length, 1, "la aprobación se ve con el turno en marcha");
  assert.match(s.scheduled[0]!, /Tiempo estimado:\*\* 3 h/);
  assert.match(s.logs.join("\n"), /plan aprobado → 3 h de trabajo/);
  const fetched = s.fetches();
  await s.run();
  await s.run();
  assert.equal(s.fetches(), fetched, "ya agendado, no se vuelve a pedir el historial mientras trabaja");
  assert.equal(s.scheduled.length, 1);

  // Termina de ejecutar: no se agenda otra vez.
  s.conv.status = "idle";
  s.setPreview("Listo. 🐼");
  s.agent("Hecho.\n\nEtapa: EJECUTADO");
  await s.run();
  assert.equal(s.scheduled.length, 1);
});

test("un plan ajustado no se agenda hasta que se aprueba el nuevo, y un plan anterior al flujo con agenda nunca", async () => {
  const s = scene({ agendaSince: 0 }, {}, {});
  s.agent(`${PLAN_WITH_TIME}\n\nEtapa: PLAN`);
  await s.run();
  s.agent(`Plan corregido.\n\n${PLAN_WITH_TIME.replace("3 h", "5 h")}\n\nEtapa: PLAN`, { kind: "tool", tool: "question", status: "completed", output: 'User has answered your questions: "¿Apruebo el plan?"="Ajustar".' });
  await s.run();
  assert.equal(s.scheduled.length, 0, "«Ajustar» no aparta tiempo");
  s.owner("aprobado");
  s.conv.status = "running";
  await s.run();
  assert.equal(s.scheduled.length, 1);
  assert.match(s.scheduled[0]!, /5 h/);

  // Conversación que ya tenía su plan aprobado antes de que existiera la agenda.
  const old = scene({ agendaSince: 9_000_000_000 }, {}, {});
  old.agent(`${PLAN_WITH_TIME}\n\nEtapa: PLAN`);
  old.owner("sí");
  await old.run();
  old.setPreview("Listo. 🐼");
  old.agent("Hecho.\n\nEtapa: EJECUTADO");
  await old.run();
  assert.equal(old.scheduled.length, 0);
});

test("si el agente ejecutó sin que se viera el botón, el plan se da por aprobado; y un fallo de la agenda se reintenta", async () => {
  let down = true;
  const s = scene({ agendaSince: 0 }, {}, { fails: () => down });
  s.agent(`${PLAN_WITH_TIME}\n\nEtapa: PLAN`);
  await s.run();
  s.setPreview("Listo. 🐼");
  s.agent("Hecho, 14/14.\n\nEtapa: EJECUTADO");
  await s.run();
  assert.equal(s.scheduled.length, 0);
  assert.equal(s.linked.scheduleRetry, true);
  assert.equal(s.logs.filter((l) => /no pude agendarlo/.test(l)).length, 1);
  // El supervisor sigue su curso; la agenda vuelve y se agenda sin repetir el aviso.
  down = false;
  s.agent("Veredicto: CUMPLE");
  await s.run();
  await s.run();
  assert.equal(s.scheduled.length, 1);
  assert.equal(s.linked.scheduleRetry, undefined);
  assert.equal(s.logs.filter((l) => /no pude agendarlo/.test(l)).length, 1);
});

test("«Finalizar» publica en cuanto el agente sube; «A su hora» espera al final del bloque y entonces se pide publicar todo", async () => {
  // Finalizar: aunque le quede bloque, se publica ya (lo decidió el propietario con el recordatorio delante).
  const now = scene({ agendaSince: 0, kind: "trabajo" }, {}, { gate: () => ({ wait: true, until: 2_000_000 }), timing: () => ({ until: "15:00", now: "11:05" }) });
  now.setPreview("Hola Hugo, ya quedó. 🐼");
  now.agent("Hecho.\n\nEtapa: EJECUTADO");
  await now.run();
  now.agent("Veredicto: CUMPLE");
  await now.run();
  assert.match(now.sent.at(-1)!, /estaba planificada para terminar a las 15:00 y son las 11:05/);
  assert.match(now.sent.at(-1)!, /«A su hora» \(publicar a las 15:00\)/);
  now.agent("Cierre entregado. ¿Finalizo #39015?\n\nEtapa: CIERRE");
  await now.run();
  assert.equal(now.linked.lastMark, "CIERRE");
  now.owner("finaliza");
  now.agent("Dev abc1234, producción def5678, verificado.\n\nEtapa: DESPLEGADO");
  await now.run();
  assert.equal(now.published.length, 1, "el propietario eligió publicar ya");
  assert.equal(now.linked.hold, undefined);

  // A su hora: nada sube hasta que termina el bloque.
  let wait = true;
  const s = scene({ agendaSince: 0, kind: "trabajo" }, {}, { gate: () => ({ wait, until: 2_000_000 }), timing: () => ({ until: "15:00", now: "11:05" }) });
  s.setPreview("Hola Hugo, ya quedó. 🐼");
  s.agent("Hecho.\n\nEtapa: EJECUTADO");
  await s.run();
  s.agent("Veredicto: CUMPLE");
  await s.run();
  s.agent("Cierre entregado.\n\nEtapa: CIERRE");
  await s.run();
  s.owner("a su hora");
  s.agent("Queda programado para las 15:00.\n\nEtapa: PROGRAMADO");
  await s.run();
  assert.equal(s.linked.hold?.mark, "PROGRAMADO");
  assert.equal(s.linked.hold?.until, 2_000_000);
  assert.equal(s.published.length, 0);
  assert.equal(s.sent.filter((t) => /Aviso del vigilante/.test(t)).length, 0, "esperar no es un problema: no se avisa en el hilo");
  await s.run();
  const fetched = s.fetches();
  await s.run();
  await s.run();
  assert.equal(s.fetches(), fetched, "mientras espera no se vuelve a pedir el historial");

  // Termina el bloque (o «Publicar ya» en la Agenda): se le pide al agente publicar todo, y al cerrar se publica el comentario.
  wait = false;
  await s.run();
  assert.match(s.sent.at(-1)!, /^Aviso del vigilante: llegó la hora de publicar #39015/);
  assert.match(s.sent.at(-1)!, /Producción/);
  assert.equal(s.linked.hold, undefined);
  assert.equal(s.published.length, 0, "el comentario sale cuando ya subió a los dos ambientes");
  s.agent("Dev abc1234, producción def5678, verificado.\n\nEtapa: DESPLEGADO");
  await s.run();
  assert.equal(s.published.length, 1);
  assert.deepEqual(s.kinds, ["trabajo"]);
  await s.run();
  assert.match(s.sent.at(-1)!, /^Aviso del vigilante: el comentario de #39015 ya quedó publicado/);
  await s.run();
  assert.equal(s.published.length, 1);

  // Respuesta a un comentario: aunque quede tiempo agendado, se publica al finalizar.
  const r = scene({ agendaSince: 0, kind: "respuesta" }, {}, { gate: () => ({ wait: true, until: 9 }) });
  r.setPreview("Hola Hugo, sí aplica. 🐼");
  r.agent("Respondo.\n\nEtapa: RESPUESTA");
  await r.run();
  r.agent("Veredicto: CUMPLE");
  await r.run();
  r.agent("Sin nada que subir.\n\nEtapa: SIN DESPLIEGUE", answered("Finalizar"));
  await r.run();
  assert.equal(r.published.length, 1);
  assert.deepEqual(r.kinds, ["respuesta"]);
});

test("un cierre programado se descarta si el propietario lo rechaza después", async () => {
  const s = scene({ agendaSince: 0, kind: "trabajo" }, {}, { gate: () => ({ wait: true, until: 5 }) });
  s.setPreview("Hola Hugo, ya quedó. 🐼");
  s.agent("Hecho.\n\nEtapa: EJECUTADO");
  await s.run();
  s.agent("Veredicto: CUMPLE");
  await s.run();
  s.agent("Queda para su hora.\n\nEtapa: PROGRAMADO", answered("A su hora"));
  await s.run();
  assert.ok(s.linked.hold);
  s.owner("rechaza, falta el caso de las citas canceladas");
  s.agent("Entendido, lo corrijo.\n\nEtapa: RECHAZADO");
  await s.run();
  assert.equal(s.linked.hold, undefined);
  assert.equal(s.published.length, 0);
});

test("aprobar no ejecuta: el arranque llega cuando empieza el bloque, con el modelo de trabajo", async () => {
  const ANALYSIS = "claude/claude-opus-5-5@medium";
  let started = false;
  const s = scene({ agendaSince: 0, kind: "trabajo", mode: "analisis", protocol: 3 }, { analysisModel: ANALYSIS }, { started: () => started });
  s.conv.model = ANALYSIS;
  s.agent(`${PLAN_WITH_TIME}\n\n¿Apruebo el plan?\n\nEtapa: PLAN`);
  await s.run();
  assert.equal(s.scheduled.length, 0);
  s.owner("sí, dale");
  s.agent("Aprobado; espero el aviso de mi bloque.\n\nEtapa: APROBADO");
  await s.run();
  assert.equal(s.scheduled.length, 1, "al aprobar se aparta el tiempo");
  assert.equal(s.linked.lastMark, "APROBADO");
  assert.equal(s.sent.length, 0, "todavía no es su hora: no se le manda nada");
  await s.run();
  assert.equal(s.sent.length, 0);

  started = true;
  await s.run();
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0]!, /^Aviso del vigilante: empezó el bloque de #39015/);
  assert.deepEqual(s.models, [WORK], "el trabajo lo toma el modelo de trabajo");
  assert.equal(s.linked.mode, "trabajo");
  await s.run();
  await s.run();
  assert.equal(s.sent.length, 1, "el arranque se manda una sola vez");

  // El supervisor entra y la conversación vuelve al modelo de trabajo, no al de análisis.
  s.setPreview("Hola Hugo, ya quedó. 🐼");
  s.agent("Hecho.\n\nEtapa: EJECUTADO");
  await s.run();
  s.agent("Veredicto: CUMPLE");
  await s.run();
  assert.deepEqual(s.models, [WORK, REVIEW, WORK]);
});

test("desde la Agenda: aprobar agenda sin pasar por el chat, y el arranque sale si el bloque ya empezó", async () => {
  const s = scene({ agendaSince: 0, kind: "trabajo", protocol: 3 }, {}, { started: () => true });
  await assert.rejects(() => s.decide("aprobar"), /No hay un plan pendiente/);
  s.agent(`${PLAN_WITH_TIME}\n\n¿Apruebo el plan?\n\nEtapa: PLAN`);
  await s.run();
  const done = await s.decide("aprobar");
  assert.match(done, /^Plan aprobado: 3 h de trabajo/);
  assert.equal(s.scheduled.length, 1);
  assert.equal(s.linked.planApproved, s.linked.planAt);
  assert.match(s.sent.at(-1)!, /^Aviso del vigilante: empezó el bloque/);
  await assert.rejects(() => s.decide("aprobar"), /No hay un plan pendiente/, "no se aprueba dos veces");

  // Ajustar: se le dice al agente lo que pidió el propietario.
  const a = scene({ agendaSince: 0, kind: "trabajo", protocol: 3 }, {}, { started: () => false });
  a.agent(`${PLAN_WITH_TIME}\n\nEtapa: PLAN`);
  await a.run();
  await a.decide("ajustar", "que no toque el reporte");
  assert.match(a.sent.at(-1)!, /pidió ajustar el plan de #39015 desde la Agenda/);
  assert.match(a.sent.at(-1)!, /que no toque el reporte/);
  assert.equal(a.scheduled.length, 0);
});

test("desde la Agenda: finalizar pide publicar todo, programar espera a su hora, esperar y retomar no gastan turnos", async () => {
  let wait = true;
  const s = scene({ agendaSince: 0, kind: "trabajo" }, {}, { gate: () => ({ wait, until: 2_000_000 }), timing: () => ({ until: "15:00", now: "11:05" }) });
  await assert.rejects(() => s.decide("finalizar"), /no tiene un cierre esperando/);
  s.setPreview("Hola Hugo, ya quedó. 🐼");
  s.agent("Hecho.\n\nEtapa: EJECUTADO");
  await s.run();
  s.agent("Veredicto: CUMPLE");
  await s.run();
  s.agent("Cierre entregado.\n\nEtapa: CIERRE");
  await s.run();
  const before = s.sent.length;

  // Esperar y retomar: solo cambia la etapa.
  await s.decide("esperar");
  assert.equal(s.linked.lastMark, "EN ESPERA");
  await s.decide("retomar");
  assert.equal(s.linked.lastMark, "CIERRE");
  assert.equal(s.sent.length, before);

  // Programar: queda en espera de su hora, sin turno del agente.
  await s.decide("programar");
  assert.equal(s.linked.hold?.mark, "PROGRAMADO");
  assert.equal(s.sent.length, before);
  wait = false;
  await s.run();
  assert.match(s.sent.at(-1)!, /llegó la hora de publicar #39015/);
  s.agent("Dev abc, producción def.\n\nEtapa: DESPLEGADO");
  await s.run();
  assert.equal(s.published.length, 1);

  // Finalizar: se le pide al agente publicar ahora; el comentario sale con su DESPLEGADO.
  const f = scene({ agendaSince: 0, kind: "trabajo" }, {}, { gate: () => ({ wait: true, until: 2_000_000 }) });
  f.setPreview("Hola Hugo, ya quedó. 🐼");
  f.agent("Hecho.\n\nEtapa: EJECUTADO");
  await f.run();
  f.agent("Veredicto: CUMPLE");
  await f.run();
  f.agent("Cierre entregado.\n\nEtapa: CIERRE");
  await f.run();
  await f.decide("finalizar");
  assert.match(f.sent.at(-1)!, /el propietario eligió «Finalizar» para #39015 desde la Agenda/);
  assert.match(f.sent.at(-1)!, /PR `main`→`production`/);
  assert.equal(f.published.length, 0);
  f.agent("Dev abc, producción def.\n\nEtapa: DESPLEGADO");
  await f.run();
  assert.equal(f.published.length, 1, "aunque le quede bloque: el propietario eligió publicar ya");

  // Rechazar: nada se publica y se abre un ciclo nuevo.
  const r = scene({ agendaSince: 0, kind: "trabajo" });
  r.setPreview("Hola Hugo, ya quedó. 🐼");
  r.agent("Hecho.\n\nEtapa: EJECUTADO");
  await r.run();
  r.agent("Veredicto: CUMPLE");
  await r.run();
  r.agent("Cierre entregado.\n\nEtapa: CIERRE");
  await r.run();
  await r.decide("rechazar", "falta el caso de la 134");
  assert.match(r.sent.at(-1)!, /rechazó el cierre de #39015 desde la Agenda/);
  assert.match(r.sent.at(-1)!, /falta el caso de la 134/);
  assert.equal(r.linked.reviews, 0);

  // Respuesta a un comentario: finalizar la publica sin otro turno del agente.
  const c = scene({ agendaSince: 0, kind: "respuesta" });
  c.setPreview("Hola Hugo, sí aplica. 🐼");
  c.agent("Respondo.\n\nEtapa: RESPUESTA");
  await c.run();
  c.agent("Veredicto: CUMPLE");
  await c.run();
  c.agent("Cierre entregado.\n\nEtapa: CIERRE");
  await c.run();
  const sentBefore = c.sent.length;
  assert.match(await c.decide("finalizar"), /Respuesta publicada/);
  assert.equal(c.published.length, 1);
  assert.deepEqual(c.kinds, ["respuesta"]);
  assert.match(c.sent[sentBefore]!, /ya quedó publicado/);
});

test("el comentario que edita el propietario es el que se publica, aunque la vista previa del agente diga otra cosa", async () => {
  const s = scene({ agendaSince: 0, kind: "trabajo" });
  s.setPreview("Hola Hugo, ya quedó. 🐼");
  s.agent("Hecho.\n\nEtapa: EJECUTADO");
  await s.run();
  s.agent("Veredicto: CUMPLE");
  await s.run();
  s.agent("Cierre entregado.\n\nEtapa: CIERRE");
  await s.run();
  // Lo que hace main.ts al guardar la edición del propietario.
  const mine = "Hola Hugo, ya está listo; avísame si ves algo raro. 🐼";
  s.linked.approved = { hash: hashOf(mine), notes: mine, attachments: [], at: s.clock(), edited: true };
  await s.decide("finalizar");
  s.agent("Dev abc, producción def.\n\nEtapa: DESPLEGADO");
  await s.run();
  assert.equal(s.published.length, 1);
  assert.equal(s.published[0]!.notes, mine);
});
