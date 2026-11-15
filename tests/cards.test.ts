import { test } from "node:test";
import assert from "node:assert/strict";
import { byTurn, classify, waitingOn } from "../src/agenda/cards.ts";
import type { CardInput } from "../src/agenda/cards.ts";

const NOW = 1_000_000;
const card = (over: Partial<CardInput> = {}): CardInput => ({
  status: "En análisis o en revisión",
  ours: true,
  hasConversation: true,
  busy: false,
  reviewing: false,
  awaitingClose: false,
  hold: false,
  now: NOW,
  ...over,
});

test("lo que pide una decisión del propietario es su turno, diga lo que diga Redmine", () => {
  assert.deepEqual(classify(card({ stage: "PLAN" })), { turn: "tu", state: "plan" });
  assert.deepEqual(classify(card({ stage: "EJECUTADO", awaitingClose: true })), { turn: "tu", state: "cierre" });
  assert.deepEqual(classify(card({ stage: "BLOQUEADO" })), { turn: "tu", state: "bloqueo" });
  assert.deepEqual(classify(card({ stage: "NO ES NUESTRO" })), { turn: "tu", state: "ajeno" });
  assert.deepEqual(classify(card({ stage: "EN ESPERA" })), { turn: "tu", state: "pausa" });
  assert.deepEqual(classify(card({ stage: "RECHAZADO" })), { turn: "tu", state: "correccion" });
  // Una respuesta a un comentario en una petición que ya está en Consultoría sigue esperando su «Finalizar».
  assert.deepEqual(classify(card({ status: "Espera validación consultoría", ours: false, stage: "RESPUESTA", awaitingClose: true })), { turn: "tu", state: "cierre" });
});

test("lo que lleva Poo: analizando, trabajando, agendada, en su bloque, en supervisión y lista para publicarse", () => {
  assert.deepEqual(classify(card({ busy: true })), { turn: "poo", state: "analisis" });
  assert.deepEqual(classify(card({ busy: true, stage: "EJECUTADO" })), { turn: "poo", state: "trabajando" });
  assert.deepEqual(classify(card({ stage: "EJECUTADO", reviewing: true, busy: true })), { turn: "poo", state: "supervision" });
  assert.deepEqual(classify(card({ work: { start: NOW + 10, end: NOW + 20 } })), { turn: "poo", state: "agendada" });
  assert.deepEqual(classify(card({ work: { start: NOW - 10, end: NOW + 20 } })), { turn: "poo", state: "en_bloque" });
  assert.deepEqual(classify(card({ stage: "DESPLEGADO", hold: true, work: { start: NOW - 10, end: NOW + 20 } })), { turn: "poo", state: "lista" });
  // El plan por aprobar gana aunque ya tenga tiempo apartado a mano.
  assert.deepEqual(classify(card({ stage: "PLAN", work: { start: NOW + 10, end: NOW + 20 } })), { turn: "tu", state: "plan" });
});

test("lo que nadie mueve vuelve a ser del propietario, y lo ya entregado espera a quien lo tiene", () => {
  assert.deepEqual(classify(card({ status: "Comentarios o no aprobado" })), { turn: "tu", state: "sin_avance" });
  assert.deepEqual(classify(card({ hasConversation: false })), { turn: "tu", state: "sin_avance" });
  assert.deepEqual(classify(card({ work: { start: NOW - 30, end: NOW - 10 } })), { turn: "tu", state: "sin_avance" }, "su bloque ya pasó y no hay cierre");
  assert.deepEqual(classify(card({ status: "Espera validación consultoría", ours: false })), { turn: "otros", state: "entregada", waitingOn: "Consultoría" });
  assert.deepEqual(classify(card({ status: "Terminado por Desarrollo", ours: false, stage: "CERRADO" })), { turn: "otros", state: "entregada", waitingOn: "Calidad" });
  assert.equal(waitingOn("Espera validacion calidad"), "Calidad");
  assert.equal(waitingOn("Espera validación cliente"), "el cliente");
  assert.equal(waitingOn("Aprobado Consultoría"), "Consultoría");
  assert.equal(waitingOn("Espera de accesos"), "quien da los accesos");
  assert.equal(waitingOn("Espera de ejemplos/evidencias"), "quien manda los ejemplos");
  assert.equal(waitingOn("Pendiente por proceso"), "Pendiente por proceso");
});

test("el orden: primero lo que te toca, luego lo de Poo por hora de su bloque, al final lo que espera a otros", () => {
  const list = [
    { turn: "otros" as const, issueId: 1 },
    { turn: "poo" as const, issueId: 2, work: { start: 50 } },
    { turn: "tu" as const, issueId: 9 },
    { turn: "poo" as const, issueId: 3, work: { start: 10 } },
    { turn: "tu" as const, issueId: 4 },
    { turn: "poo" as const, issueId: 5 },
  ];
  assert.deepEqual(list.sort(byTurn).map((c) => c.issueId), [4, 9, 3, 2, 5, 1]);
});
