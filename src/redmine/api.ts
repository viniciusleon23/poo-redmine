/**
 * API REST de Redmine con la cuenta del vigilante. Lecturas, el cambio de estado con su nota
 * y la creación de subtareas. La publicación del comentario de cierre sigue en
 * bin/redmine_comentar.py, que lleva el registro para no duplicarlo.
 */

export type Named = { id: number; name: string };
export type Journal = { id: number; user: Named; notes?: string; created_on: string; private_notes?: boolean; details?: unknown[] };
export type Issue = {
  id: number;
  subject: string;
  description?: string;
  project: Named;
  tracker: Named;
  status: Named;
  priority: Named;
  author: Named;
  assigned_to?: Named;
  parent?: { id: number };
  created_on: string;
  updated_on: string;
  start_date?: string | null;
  due_date?: string | null;
  estimated_hours?: number | null;
  custom_fields?: { name: string; value: unknown }[];
  attachments?: { id: number; filename: string; content_type?: string; filesize: number; content_url: string }[];
  journals?: Journal[];
  allowed_statuses?: Named[];
};
export type Status = Named & { is_closed?: boolean | number };

export class RedmineError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RedmineConfig {
  url: string;
  apiKey?: string;
  user?: string;
  password?: string;
  fetch?: typeof fetch;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function createRedmine(config: RedmineConfig) {
  const base = config.url.replace(/\/+$/, "");
  const fetcher = config.fetch ?? fetch;

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (config.apiKey) headers["X-Redmine-API-Key"] = config.apiKey;
    else headers.Authorization = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`;
    return headers;
  }

  async function get<T>(path: string): Promise<T> {
    const r = await fetcher(`${base}${path}`, { headers: authHeaders(), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new RedmineError(r.status, `Redmine ${path.split("?")[0]} respondió HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  async function write<T>(method: "PUT" | "POST", path: string, body: unknown): Promise<T | undefined> {
    const r = await fetcher(`${base}${path}`, {
      method,
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    if (!r.ok) throw new RedmineError(r.status, `Redmine ${method} ${path.split("?")[0]} respondió HTTP ${r.status}: ${text.slice(0, 300)}`);
    return text.trim() ? (JSON.parse(text) as T) : undefined;
  }

  let statuses: Status[] | undefined;
  let trackers: Named[] | undefined;
  const members = new Map<number, Named[]>();

  const api = {
    base,
    issueUrl: (id: number | string) => `${base}/issues/${id}`,

    me: () => get<{ user: { id: number; login: string } }>("/users/current.json").then((r) => r.user),

    async statuses(): Promise<Status[]> {
      statuses ??= (await get<{ issue_statuses: Status[] }>("/issue_statuses.json")).issue_statuses;
      return statuses;
    },
    /** Id del estado con ese nombre; error si Redmine no lo tiene. */
    async statusId(name: string): Promise<number> {
      const found = (await api.statuses()).find((s) => same(s.name, name));
      if (!found) throw new RedmineError(404, `No existe el estado «${name}» en Redmine.`);
      return found.id;
    },
    /** Ids de los estados cerrados («Resuelta», «Cerrada»…), según el propio Redmine. */
    closedStatuses: async () => new Set((await api.statuses()).filter((s) => Boolean(s.is_closed)).map((s) => s.id)),

    async assignedOpen(): Promise<Issue[]> {
      const out: Issue[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await get<{ issues: Issue[]; total_count: number }>(
          `/issues.json?assigned_to_id=me&status_id=open&sort=updated_on:desc&limit=100&offset=${offset}`,
        );
        out.push(...page.issues);
        if (out.length >= page.total_count || page.issues.length === 0) return out;
      }
    },

    detail: (id: number) =>
      get<{ issue: Issue }>(`/issues/${id}.json?include=journals,attachments,allowed_statuses`).then((r) => r.issue),

    /** Cambia campos de la incidencia (estado, nota, fechas). Redmine responde 204 sin cuerpo. */
    update: (id: number, changes: Record<string, unknown>) => write<void>("PUT", `/issues/${id}.json`, { issue: changes }).then(() => undefined),

    async trackerId(name: string): Promise<number | undefined> {
      trackers ??= (await get<{ trackers: Named[] }>("/trackers.json")).trackers;
      return trackers.find((t) => same(t.name, name))?.id;
    },

    /** Personas del proyecto (sin grupos), para resolver a quién se asigna una subtarea. */
    async projectMembers(projectId: number): Promise<Named[]> {
      const cached = members.get(projectId);
      if (cached) return cached;
      const out = new Map<number, Named>();
      for (let offset = 0; ; offset += 100) {
        const page = await get<{ memberships: { user?: Named }[]; total_count: number }>(
          `/projects/${projectId}/memberships.json?limit=100&offset=${offset}`,
        );
        for (const m of page.memberships) if (m.user) out.set(m.user.id, m.user);
        if (offset + 100 >= page.total_count || page.memberships.length === 0) break;
      }
      const list = [...out.values()];
      members.set(projectId, list);
      return list;
    },

    /** Subtarea de `parent`, en su mismo proyecto y con su prioridad. Devuelve la incidencia creada. */
    async createSubtask(parent: Issue, input: { subject: string; description: string; assigneeId?: number; trackerId?: number }): Promise<Issue> {
      const created = await write<{ issue: Issue }>("POST", "/issues.json", {
        issue: {
          project_id: parent.project.id,
          parent_issue_id: parent.id,
          tracker_id: input.trackerId ?? parent.tracker.id,
          priority_id: parent.priority.id,
          subject: input.subject.slice(0, 250),
          description: input.description,
          ...(input.assigneeId ? { assigned_to_id: input.assigneeId } : {}),
        },
      });
      if (!created?.issue) throw new RedmineError(502, "Redmine aceptó la subtarea pero no devolvió la incidencia creada.");
      return created.issue;
    },
  };
  return api;
}

export type Redmine = ReturnType<typeof createRedmine>;

/** Comentarios con texto escritos por alguien distinto de `userId`, posteriores a `afterId`. */
export const notesFromOthers = (issue: Issue, afterId: number, userId?: number) =>
  (issue.journals ?? []).filter((j) => j.id > afterId && j.user.id !== userId && (j.notes ?? "").trim());

export const lastJournalId = (issue: Issue) => Math.max(0, ...(issue.journals ?? []).map((j) => j.id));

export const fieldValue = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));
