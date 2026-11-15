/**
 * Lo que la Agenda cuenta de cada petición sin mandar al propietario a Redmine: el plan en
 * corto, el recorrido con fecha y hora, a quién se espera y qué falta para cerrarla.
 * Todo sale de lo que ya existe (el resumen del plan, los movimientos de Redmine y la
 * conversación). Puro; lo prueba tests/story.test.ts.
 */
import type { Issue } from "../redmine/api.ts";
import type { Snapshot } from "../redmine/cycle.ts";
import { isWatcherText } from "../redmine/flow.ts";

export interface PlanBrief {
  /** «Catalina pide…», en una línea. */
  brief?: string;
  /** Qué pidieron. */
  asked?: string;
  /** Qué cambiamos nosotros. */
  doing?: string;
  feasible?: "si" | "parcial" | "no";
  feasibleWhy?: string;
  size?: "bajo" | "medio" | "alto";
  sizeWhy?: string;
}

export interface HistoryEvent {
  at: number;
  text: string;
  /** Quedó escrito en Redmine con la cuenta del propietario. */
  pub?: boolean;
}

const clean = (text: string) => text.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

/** Texto de una línea «- **Etiqueta:** valor» del resumen del plan. */
function field(plan: string, label: RegExp): string | undefined {
  const line = plan.split("\n").find((l) => label.test(clean(l)));
  if (!line) return undefined;
  const value = clean(line)
    .replace(/^[-•>\s]+/, "")
    .replace(label, "")
    .replace(/^\s*[:?¿]*\s*/, "")
    .trim();
  return value && !/^…$/.test(value) ? value : undefined;
}

/** Separa «valor — por qué» (o con guion, coma, punto o dos puntos). */
function split(value: string): { head: string; why?: string } {
  const m = /^([^—–\-,.:;(]+)[—–\-,.:;(]\s*(.+)$/.exec(value);
  if (!m) return { head: value.trim() };
  return { head: m[1]!.trim(), why: m[2]!.replace(/\)\s*$/, "").trim() || undefined };
}

/** Lo que la tarjeta y la lectura en voz alta toman del resumen del plan. */
export function parsePlanBrief(plan: string): PlanBrief {
  const out: PlanBrief = {};
  out.brief = field(plan, /^[-•>\s]*en una frase\s*:?/i);
  out.asked = field(plan, /^[-•>\s]*qu[eé] pidieron\s*:?/i);
  out.doing = field(plan, /^[-•>\s]*qu[eé] cambiamos nosotros\s*:?/i);
  const can = field(plan, /^[-•>\s]*¿?\s*se puede\??\s*:?/i);
  if (can) {
    const { head, why } = split(can);
    const h = head.toLowerCase();
    out.feasible = /^s[ií](?![a-záéíóúñ])/.test(h) ? "si" : /^parcial/.test(h) ? "parcial" : /^no\b/.test(h) ? "no" : undefined;
    out.feasibleWhy = out.feasible ? why : can;
  }
  const size = field(plan, /^[-•>\s]*tama[ñn]o del cambio\s*:?/i);
  if (size) {
    const { head, why } = split(size);
    const h = head.toLowerCase();
    out.size = /^baj/.test(h) ? "bajo" : /^medi/.test(h) ? "medio" : /^alt/.test(h) ? "alto" : undefined;
    out.sizeWhy = out.size ? why : size;
  }
  return out;
}

/** Primera frase de lo que escribieron, para cuando todavía no hay plan. */
export function firstSentence(description: string | undefined, max = 180): string | undefined {
  const text = (description ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith(">"));
  if (!text) return undefined;
  const end = /[.!?](\s|$)/.exec(text);
  const sentence = end ? text.slice(0, end.index + 1) : text;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** «Falta» del mensaje de cierre del agente (de nuestro lado / de su lado), en texto llano. */
export function extractMissing(text: string): string | undefined {
  const lines = text.replace(/\r/g, "").split("\n");
  const start = lines.findLastIndex((l) => /^[-•>\s]*falta\b/i.test(clean(l)));
  if (start < 0) return undefined;
  const out: string[] = [];
  const first = clean(lines[start]!)
    .replace(/^[-•>\s]*falta\b/i, "")
    .replace(/^\s*(?:\([^)]*\))?\s*[:—–-]?\s*/, "");
  if (first) out.push(first);
  for (const line of lines.slice(start + 1)) {
    const c = clean(line);
    if (/^(?:>\s*)?etapa\s*:/i.test(c) || /^[-•>\s]*hecho\b/i.test(c)) break;
    if (!c) {
      if (out.length) break;
      continue;
    }
    out.push(c.replace(/^[-•]\s*/, ""));
    if (out.length >= 6) break;
  }
  const joined = out.join(" ").trim();
  if (!joined || /^(?:nada|ninguno|ninguna|n\/a)\.?$/i.test(joined)) return undefined;
  return joined.length > 400 ? `${joined.slice(0, 399).trimEnd()}…` : joined;
}

/**
 * ¿El propietario pidió pausarla o no trabajarla todavía? Las conversaciones anteriores a la
 * marca `EN ESPERA` cerraban esas pausas con `BLOQUEADO`; la Agenda las distingue por lo que dijo.
 */
export const ownerPaused = (text: string) =>
  /\b(?:a[uú]n no|todav[ií]a no|no lo vamos a trabajar|no la vamos a trabajar|p[aá]usal[ao]|en pausa|d[eé]jal[ao] en espera|luego lo vemos|despu[eé]s lo vemos)\b/i.test(text);

const textOf = (m: Snapshot["messages"][number]) =>
  m.parts
    .filter((p) => p.kind === "text")
    .map((p) => p.text ?? "")
    .join("\n");

/** Lo último que el propietario le dijo a Poo y el «Falta» del último cierre, leídos de la conversación. */
export function storyOf(snap: Snapshot): { ownerSaid?: { at: number; text: string }; missing?: string } {
  let ownerSaid: { at: number; text: string } | undefined;
  let missing: string | undefined;
  for (const m of snap.messages) {
    const text = textOf(m).trim();
    if (!text) continue;
    if (m.role === "user") {
      if (isWatcherText(text) || /^Recuperación automática de Poo IA/i.test(text)) continue;
      if (!ownerSaid || m.createdAt >= ownerSaid.at) ownerSaid = { at: m.createdAt, text: text.length > 280 ? `${text.slice(0, 279).trimEnd()}…` : text };
    } else if (m.role === "assistant") {
      missing = extractMissing(text) ?? missing;
    }
  }
  return { ownerSaid, missing };
}

type Detail = { property?: string; name?: string; old_value?: string | null; new_value?: string | null };

const excerpt = (notes: string, max = 160) => {
  const text = notes
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith(">") && !/escribi[oó]:\s*$/.test(l.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

export interface IssueStory {
  history: HistoryEvent[];
  /** Cuándo quedó asignada al propietario (último cambio de asignación hacia su cuenta). */
  assignedAt?: number;
  /** Último cambio de estado. */
  statusAt?: number;
  /** El propietario preguntó o pidió algo y nadie ha contestado después. */
  asked?: { at: number; to: string[]; text: string };
}

/** Recorrido de una petición según sus movimientos en Redmine. `issue` debe traer `journals`. */
export function issueStory(issue: Issue, ownerId: number | undefined, statusName: (id: string) => string | undefined): IssueStory {
  const history: HistoryEvent[] = [];
  const created = Date.parse(issue.created_on);
  if (created) history.push({ at: created, text: `${issue.author.name} la pidió.` });
  let assignedAt: number | undefined;
  let statusAt: number | undefined;
  let asked: IssueStory["asked"];
  for (const j of issue.journals ?? []) {
    const at = Date.parse(j.created_on);
    if (!at) continue;
    const mine = ownerId !== undefined && j.user.id === ownerId;
    for (const d of (j.details ?? []) as Detail[]) {
      if (d.name === "assigned_to_id" && ownerId !== undefined && String(d.new_value ?? "") === String(ownerId)) {
        assignedAt = at;
        history.push({ at, text: mine ? "La tomaste." : `${j.user.name} te la asignó.` });
      } else if (d.name === "status_id" && d.new_value) {
        statusAt = at;
        const name = statusName(String(d.new_value));
        if (name) history.push({ at, text: mine ? `Pasó a «${name}».` : `${j.user.name} la pasó a «${name}».` });
      }
    }
    const notes = (j.notes ?? "").trim();
    if (!notes || j.private_notes) continue;
    const short = excerpt(notes);
    if (!short) continue;
    if (mine) {
      history.push({ at, text: `Publicaste: «${short}»`, pub: true });
      const to = [...new Set([...notes.matchAll(/(?:^|\s)@([\w.-]{2,40})/g)].map((m) => m[1]!))];
      asked = to.length || /\?\s*(?:🐼)?\s*$/u.test(notes) ? { at, to, text: short } : undefined;
    } else {
      history.push({ at, text: `${j.user.name} comentó: «${short}»` });
      asked = undefined;
    }
  }
  history.sort((a, b) => a.at - b.at);
  return { history, assignedAt, statusAt, asked };
}
