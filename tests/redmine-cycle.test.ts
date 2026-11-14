import { test } from "node:test";
import assert from "node:assert/strict";
import { createCycle, hashOf } from "../apps/redmine-watcher/src/cycle.ts";
import type { Approved, ChatMessage, Linked, Part } from "../apps/redmine-watcher/src/cycle.ts";

const WORK = "opencode-go/deepseek-v4.1-flash";
const REVIEW = "claude/claude-opus-5-5@medium";
const PLAN = ["**Resumen del plan**", "- **Qué pidieron:** actualizar la cita.", "- **Qué cambiamos nosotros:** el puente.", "- **Servicios afectados:** bridge-api.", "- **Por qué es necesario:** se pierde el cambio."].join("\n");
const answered = (option: string): Part => ({ kind: "tool", tool: "question", status: "completed", output: `User has answered your questions: "¿Finalizo #39015?"="${option}". You can now continue with the user's answers in mind.` });

/** Una conversación simulada y el vigilante sobre ella. */
function scene(extra: Partial<Linked> = {}, cfg: Partial<{ model: string; reviewModel: string | undefined; maxFixes: number; maxReviews: number; reviewTimeoutMs: number }> = {}) {
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
  const { cycle } = createCycle({
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
    publish: async (_issue, approved) => {
      if (publishFails) throw new Error("Redmine PUT respondió HTTP 500");
      published.push(approved);
      return "publicado, journal 147400, estado «Espera validación consultoría», http://r/issues/39015#change-147400";
    },
    save: () => {},
    log: (line) => logs.push(line),
    now: () => tick(),
    cfg: { model: WORK, reviewModel: REVIEW, maxFixes: 1, maxReviews: 2, reviewTimeoutMs: 30 * 60_000, ...cfg },
  });
  return {
    linked, sent, models, published, logs, conv, messages,
    fetches: () => fetches,
    run: () => cycle("39015", linked),
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
  assert.equal(s.linked.approved, undefined, "no hay comentario aprobado");

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
