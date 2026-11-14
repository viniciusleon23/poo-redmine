/**
 * API de la Agenda de Capital Network («API de la Agenda», guía del 14/11/2026).
 * Base https://wscapnet.com.mx:9444/api/v1 · llave de la aplicación por `Authorization: Bearer`
 * y `X-Agenda-Usuario` con el correo a nombre de quien se actúa. La llave vive solo en el
 * servidor: nunca viaja a la app ni a la web.
 *
 * La agenda aplica sus reglas (jornada, comida, festivos, empalmes): si algo choca responde
 * 409 con `conflictos`. Lo que se crea aquí avisa a los invitados por Slack.
 */

export type Ocupado = {
  tipo: "sesion" | "externo" | "ausencia" | "comida" | "fuera" | "festivo" | string;
  inicio: string;
  fin: string;
  confirmado?: boolean;
  titulo?: string | null;
  sesion_id?: string | null;
};
export type Persona = { correo: string; nombre: string; area?: string; zona_horaria?: string; pais?: string };
export type Disponibilidad = Persona & { ocupado: Ocupado[] };
export type Asistente = { correo: string; nombre: string; obligatorio: boolean; respuesta: string };
export type Sesion = {
  id: string;
  titulo: string;
  descripcion?: string | null;
  inicio: string;
  fin: string;
  estado: string;
  plataforma?: string;
  enlace_zoom?: string | null;
  organizador: string;
  asistentes: Asistente[];
  slack_canal_id?: string | null;
};
export type Bloque = {
  id: number;
  titulo: string;
  inicio: string;
  fin: string;
  origen: string;
  persona: string;
  activo: boolean;
  redmine_id: number | null;
  enlace: string | null;
};

export class AgendaError extends Error {
  constructor(
    public status: number,
    public codigo: string,
    message: string,
    public conflictos?: unknown[],
    public campo?: string,
  ) {
    super(message);
  }
}

export interface AgendaConfig {
  url: string;
  key: string;
  /** Correo a nombre de quien se actúa (el propietario). */
  user: string;
  fetch?: typeof fetch;
}

/** Duraciones que admite una sesión, de mayor a menor. */
export const SESSION_MINUTES = [120, 90, 60, 45, 30, 15] as const;

export function createAgenda(config: AgendaConfig) {
  const base = config.url.replace(/\/+$/, "");
  const fetcher = config.fetch ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetcher(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.key}`,
          "X-Agenda-Usuario": config.user,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new AgendaError(0, "sin_conexion", "No pude conectar con la agenda.");
    }
    const text = await r.text();
    let parsed: { error?: { codigo?: string; mensaje?: string; conflictos?: unknown[]; campo?: string } } & Record<string, unknown> = {};
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
      /* respuesta sin JSON: se informa por estado */
    }
    if (!r.ok)
      throw new AgendaError(
        r.status,
        parsed.error?.codigo ?? `http_${r.status}`,
        parsed.error?.mensaje ?? `La agenda respondió HTTP ${r.status}.`,
        parsed.error?.conflictos,
        parsed.error?.campo,
      );
    return parsed as T;
  }

  const q = (params: Record<string, string | number | undefined>) =>
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");

  return {
    user: config.user,
    personas: (buscar?: string) => call<{ personas: Persona[] }>("GET", `/personas?${q({ buscar })}`).then((r) => r.personas),
    /** Bloques ocupados de hasta 20 personas en un rango de hasta 14 días. */
    disponibilidad: (personas: string[], desde: string, hasta: string) =>
      call<{ personas: Disponibilidad[] }>("GET", `/disponibilidad?${q({ personas: personas.join(","), desde, hasta })}`).then((r) => r.personas),
    /** Sesiones y bloques del propietario en un rango de hasta 31 días. */
    miAgenda: (desde: string, hasta: string) =>
      call<{ sesiones: Sesion[]; bloques: Bloque[] }>("GET", `/mi-agenda?${q({ desde, hasta })}`),
    crearSesion: (input: { titulo: string; descripcion?: string; inicio: string; duracion_minutos: number; invitados: string[]; opcionales?: string[] }) =>
      call<{ sesion: Sesion }>("POST", "/sesiones", { plataforma: "slack", tipo_canal: "grupo_directo", slack_canal_id: "", externos: [], opcionales: [], ...input }).then((r) => r.sesion),
    moverSesion: (id: string, changes: { inicio?: string; duracion_minutos?: number }) =>
      call<{ sesion: Sesion }>("PATCH", `/sesiones/${encodeURIComponent(id)}`, changes).then((r) => r.sesion),
    cancelarSesion: (id: string) => call<unknown>("DELETE", `/sesiones/${encodeURIComponent(id)}`).then(() => undefined),
    /** Tiempo apartado para una petición de Redmine: la agenda lo liga a la petición. */
    apartarPeticion: (redmineId: number, inicio: string, minutos: number) =>
      call<{ bloque: Bloque }>("POST", "/bloques", { redmine_id: redmineId, inicio, duracion_minutos: minutos }).then((r) => r.bloque),
    /** Bloque libre. Con `referencia`, repetirlo lo actualiza en vez de duplicarlo. */
    apartarLibre: (input: { titulo: string; inicio: string; duracion_minutos: number; enlace?: string; referencia?: string }) =>
      call<{ bloque: Bloque }>("POST", "/bloques", input).then((r) => r.bloque),
    bloques: () => call<{ bloques: Bloque[] }>("GET", "/bloques").then((r) => r.bloques),
    quitarBloque: (id: number) => call<unknown>("DELETE", `/bloques/${id}`).then(() => undefined),
  };
}

export type Agenda = ReturnType<typeof createAgenda>;
