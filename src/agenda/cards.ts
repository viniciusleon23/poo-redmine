/**
 * De quién es el turno en cada petición asignada al propietario, dicho sin jerga de Redmine.
 * El propietario no entra a Redmine: la Agenda le dice qué le toca a él, qué lleva Poo y qué
 * espera a otra persona. Puro; lo prueba tests/cards.test.ts.
 */
import type { StageMark } from "../redmine/flow.ts";

/** A quién le toca mover la petición. */
export type Turn = "tu" | "poo" | "otros";

/** Qué pasa con la petición, en una clave que la app convierte en frase. */
export type CardState =
  // Te toca a ti
  | "plan" // aprobar el plan
  | "cierre" // finalizar, rechazar o esperar
  | "bloqueo" // Poo necesita algo de ti
  | "ajeno" // Poo cree que no es nuestra
  | "pausa" // la dejaste en espera
  | "correccion" // la rechazaste: falta decir qué corregir
  | "sin_avance" // nadie la está moviendo
  // La lleva Poo
  | "analisis"
  | "trabajando"
  | "agendada"
  | "en_bloque"
  | "supervision"
  | "lista" // cierre listo, espera su hora para publicarse
  | "publicando" // ya lo autorizaste: Poo sube a dev y a producción y después publica el comentario
  // Espera a otra persona
  | "respuesta" // preguntaste algo en Redmine y nadie ha contestado
  | "entregada";

export interface CardInput {
  /** Estado de Redmine, por nombre. */
  status: string;
  /** ¿Sigue de nuestro lado (nueva, en análisis, en curso, regresada con comentarios)? */
  ours: boolean;
  hasConversation: boolean;
  /** La conversación tiene un turno en marcha. */
  busy: boolean;
  /** Última marca `Etapa:` de la conversación. */
  stage?: StageMark;
  /** El supervisor está revisando. */
  reviewing: boolean;
  /** Ya se pidió el cierre y falta la decisión del propietario. */
  awaitingClose: boolean;
  /** Cierre listo que espera al final de su bloque. */
  hold: boolean;
  /** El propietario ya autorizó el cierre y Poo está publicando (dev, producción, comentario). */
  releasing?: boolean;
  work?: { start: number; end: number };
  /** El último comentario de Redmine es una pregunta o petición tuya sin respuesta. */
  asked?: boolean;
  now: number;
}

/**
 * ¿Poo está corrigiendo lo que observó el supervisor? Va de que termina una pasada con
 * observaciones a que vuelve a entrar el supervisor o se pide el cierre. No cambia el turno ni el
 * estado de la tarjeta: es un dato aparte para quien quiera mostrar la ronda de corrección.
 */
export function fixing(input: { fixes?: number; reviewing: boolean; closing: boolean }): boolean {
  return (input.fixes ?? 0) > 0 && !input.reviewing && !input.closing;
}

/** Quién tiene la petición cuando ya salió de nuestro lado, según su estado en Redmine. */
export function waitingOn(status: string): string {
  const s = status.trim().toLowerCase();
  if (s.includes("calidad") || s.includes("terminado por desarrollo")) return "Calidad";
  if (s.includes("cliente")) return "el cliente";
  if (s.includes("consultor")) return "Consultoría";
  if (s.includes("acceso")) return "quien da los accesos";
  if (s.includes("ejemplo") || s.includes("evidencia")) return "quien manda los ejemplos";
  return status.trim();
}

/**
 * Turno y estado de una petición. Lo que pide una decisión del propietario gana siempre; lo
 * que ya salió de nuestro lado espera a otros; lo demás lo lleva Poo, y si nadie lo mueve
 * vuelve a ser del propietario.
 */
export function classify(input: CardInput): { turn: Turn; state: CardState; waitingOn?: string } {
  const { stage } = input;
  if (input.hold) return { turn: "poo", state: "lista" };
  if (input.releasing && stage !== "BLOQUEADO") return { turn: "poo", state: "publicando" };
  if (input.reviewing) return { turn: "poo", state: "supervision" };
  if (input.awaitingClose) return { turn: "tu", state: "cierre" };
  if (stage === "PLAN") return { turn: "tu", state: "plan" };
  if (stage === "BLOQUEADO") return { turn: "tu", state: "bloqueo" };
  if (stage === "NO ES NUESTRO") return { turn: "tu", state: "ajeno" };
  if (stage === "EN ESPERA") return { turn: "tu", state: "pausa" };
  if (stage === "RECHAZADO") return { turn: "tu", state: "correccion" };
  if (!input.ours) return { turn: "otros", state: "entregada", waitingOn: waitingOn(input.status) };
  if (input.work && input.work.start <= input.now && input.now < input.work.end) return { turn: "poo", state: "en_bloque" };
  if (input.busy) return { turn: "poo", state: stage ? "trabajando" : "analisis" };
  if (input.work && input.work.start > input.now) return { turn: "poo", state: "agendada" };
  if (input.asked) return { turn: "otros", state: "respuesta" };
  return { turn: "tu", state: "sin_avance" };
}

const ORDER: Record<Turn, number> = { tu: 0, poo: 1, otros: 2 };

/** Primero lo que te toca, luego lo de Poo (por hora de su bloque) y al final lo que espera a otros. */
export function byTurn<T extends { turn: Turn; issueId: number; work?: { start: number } }>(a: T, b: T) {
  return ORDER[a.turn] - ORDER[b.turn] || (a.work?.start ?? Infinity) - (b.work?.start ?? Infinity) || a.issueId - b.issueId;
}
