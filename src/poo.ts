/**
 * Cliente mínimo de la pasarela de Poo IA (apps/gateway de poo-ia-ios): lo justo para abrir
 * conversaciones, escribir en ellas y leerlas. Sustituye a `@poo/client` para que este
 * servicio no dependa de otro repositorio.
 *
 * La sesión se abre con la frase del propietario y se renueva sola ante un 401. Un 401 lo
 * devuelve la pasarela antes de entregar nada al daemon, así que repetir la operación una
 * vez con la sesión nueva no la duplica.
 */
import { randomUUID } from "node:crypto";

export class PooError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type PooTask = {
  id: string;
  status: string;
  title?: string;
  model?: string | null;
  directory: string;
  updatedAt?: number;
  lastActivityAt?: number;
};
export type PooPart = { kind: string; text?: string; tool?: string; status?: string; output?: string };
export type PooMessage = { role: string; createdAt: number; completedAt?: number; parts: PooPart[] };
export type PooSnapshot = { task: PooTask; messages: PooMessage[] };

export class Poo {
  private token?: string;
  private loggingIn?: Promise<void>;
  private origin: string;
  private passphrase: string;
  private log: (line: string) => void;
  private fetcher: typeof fetch;

  constructor(options: { origin: string; passphrase: string; log?: (line: string) => void; fetch?: typeof fetch }) {
    this.origin = options.origin.replace(/\/+$/, "");
    this.passphrase = options.passphrase;
    this.log = options.log ?? (() => {});
    this.fetcher = options.fetch ?? fetch;
  }

  /** Abre (o renueva) la sesión; las llamadas simultáneas comparten el mismo intento. */
  login(): Promise<void> {
    this.loggingIn ??= this.call<{ token: string; expiresAt: number }>("POST", "/mobile/session", { passphrase: this.passphrase }, false)
      .then((session) => {
        this.token = session.token;
        this.log(`sesión en la pasarela abierta; vence ${new Date(session.expiresAt).toISOString()}`);
      })
      .finally(() => {
        this.loggingIn = undefined;
      });
    return this.loggingIn;
  }

  private async call<T>(method: string, path: string, body: unknown, retry: boolean): Promise<T> {
    const mutation = method !== "GET";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token && path !== "/mobile/session") headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (mutation) headers["X-Request-ID"] = randomUUID();
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(mutation ? 120_000 : 30_000),
      });
    } catch {
      throw new PooError(0, mutation ? "No pude confirmar la operación con Poo IA; puede haberse recibido." : "No pude conectar con Poo IA.");
    }
    if (response.status === 401 && retry && path !== "/mobile/session") {
      await this.login();
      return this.call<T>(method, path, body, false);
    }
    const parsed = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new PooError(response.status, parsed.error ?? `Poo IA respondió HTTP ${response.status}`);
    return parsed as T;
  }

  private get = <T>(path: string) => this.call<T>("GET", path, undefined, true);
  private send = <T>(path: string, body: unknown) => this.call<T>("POST", path, body, true);

  /** Todas las conversaciones (lista ligera): estado y última actividad. */
  tasks = () => this.get<{ data: PooTask[] }>("/api/tasks?all=1").then((r) => r.data);
  /** Una conversación con su historial. */
  task = (id: string) => this.get<{ data: PooSnapshot }>(`/api/tasks/${encodeURIComponent(id)}`).then((r) => r.data);
  createConversation = (model?: string) => this.send<{ data: PooTask }>("/api/conversations", model ? { model } : {}).then((r) => r.data);
  setModel = (id: string, model: string) => this.send<{ ok: true }>(`/api/tasks/${encodeURIComponent(id)}/model`, { model }).then(() => undefined);
  /** Mensaje a la conversación; si hay un turno en marcha, queda en cola. */
  prompt = (id: string, text: string) =>
    this.send<{ data: { queued: boolean } }>(`/api/tasks/${encodeURIComponent(id)}/prompt`, { text, delivery: "queue", attachmentIds: [] }).then(() => undefined);
}
