# poo-redmine

Vigilante de Redmine de Poo IA. Toma cada petición asignada, la lleva por el flujo del equipo
y planifica el trabajo en la agenda de Capital Network, para que Redmine y la agenda digan lo
mismo que de verdad está pasando.

## El flujo

| Paso | Qué pasa | Estado en Redmine |
|---|---|---|
| 1. Llega la asignación | Acuse con una frase de catálogo («Hola Catalina, trabajaré en ello 🐼») y se abre la conversación de Poo IA | **En análisis o en revisión** |
| 2. Análisis y plan | El agente decide el alcance y presenta el plan con su **tiempo estimado** y su **dependencia frontal**. Lo aprueba el propietario | En análisis o en revisión |
| 3. Plan aprobado | Se aparta el tiempo en la agenda del propietario: primer hueco libre de su jornada, nunca encimado con otra petición; si hoy no cabe, se parte. Con dependencia frontal: subtarea en Redmine y sesión con esa persona | En análisis o en revisión |
| 4. Empieza el bloque | Aviso de catálogo («ya estoy trabajando en ello 🐼»), con **fecha fin** y **tiempo estimado** | **En curso** |
| 5. Supervisor y cierre | Un modelo más fuerte revisa; el propietario decide Finalizar, Rechazar o Esperar | En curso |
| 6. Termina el bloque | Con «Finalizar», se publica el comentario aprobado (una sola vez) | **Terminado por Desarrollo** |

El agente puede dejar el trabajo listo antes de la hora agendada: no se publica hasta que
termina el bloque, salvo que el propietario pulse «Publicar ya» en la Agenda de la app.
Después siguen Calidad, Consultoría y el cliente; si regresa como «Comentarios o no aprobado»,
el comentario nuevo llega a la misma conversación.

El vigilante solo mueve el estado de lo que está asignado a su cuenta («cada quien mueve lo
que tiene asignado»): si la petición ya es de otra persona, publica el comentario y nada más.

### Dependencia con el frontal

Si el plan nombra a alguien del frontal (`FRONT_PEOPLE`), al aprobarlo se crea su subtarea
(tipo «Subtarea», hija de la petición) y se agenda la sesión cuando los dos están libres,
después del bloque de trabajo. Duración según la prioridad de la petición: baja 1 h, media
2:30 h, alta 4 h, en sesiones de hasta 2 h; si ya es tarde, parte hoy y parte mañana.

### La agenda manda en los dos sentidos

- Mover una actividad en la app la mueve en la agenda (bloque: se quita y se aparta de nuevo;
  sesión: `PATCH`). Un horario ocupado o fuera de jornada se rechaza y nada cambia.
- Mover o quitar el bloque en la agenda se refleja aquí en el siguiente sondeo (60 s).
- La agenda aplica sus propias reglas (comida, festivos, ausencias): los huecos se calculan
  con su disponibilidad dentro de la jornada configurada.

## Piezas

```
src/main.ts              arranque: sondeo de Redmine, reloj de la agenda y API local
src/redmine/api.ts       API REST de Redmine (lecturas, cambio de estado, subtareas)
src/redmine/flow.ts      reglas del flujo, catálogos de frases, marcas `Etapa:` y prompts
src/redmine/cycle.ts     máquina de etapas: plan aprobado → agenda, supervisor, cierre y publicación
src/agenda/api.ts        API de la Agenda (disponibilidad, bloques, sesiones)
src/agenda/slots.ts      jornada, huecos y reparto en tramos (puro)
src/agenda/planner.ts    actividades: apartar, mover, sincronizar, esperar para publicar
src/agenda/http.ts       la agenda para la app y la web (loopback)
src/poo.ts               cliente mínimo de la pasarela de Poo IA
bin/redmine_comentar.py  vista previa y publicación del comentario, sin duplicados
bin/redmine_captura.cjs  capturas del comentario con Playwright
```

El agente no escribe en Redmine: solo deja la vista previa del comentario. El vigilante avanza
por la línea `Etapa: <marca>` con la que el agente cierra cada mensaje.

## La agenda para la app y la web

`src/agenda/http.ts` escucha en `127.0.0.1:4197` y pide el token de
`~/.config/poo-redmine/http-token` (se crea solo). La pasarela móvil (`poo-ia-ios`,
`apps/gateway`) lo publica como `/mobile/agenda/*` con la sesión del propietario; la app de
iOS y la web lo consumen desde ahí. La llave de la agenda nunca sale del servidor.

| Ruta | Qué hace |
|---|---|
| `GET /agenda?desde=YYYY-MM-DD&dias=N` | Actividades de Poo, lo demás de la agenda y las peticiones abiertas |
| `GET /agenda/activities/:id/slots?fecha=…` | Inicios libres de ese día para mover la actividad |
| `POST /agenda/activities/:id/move {start}` | La mueve aquí y en la agenda |
| `POST /agenda/activities/:id/cancel` | La quita de aquí y de la agenda |
| `POST /agenda/issues/:id/plan {hours}` | Aparta tiempo a mano para una petición sin bloque |
| `POST /agenda/issues/:id/publish` | «Publicar ya»: el cierre no espera al final del bloque |
| `POST /agenda/sync` | Vuelve a leer la agenda ahora |
| `POST /agenda/avisos` | Avisos (webhooks) de la agenda, verificados por firma |

Los avisos de la agenda necesitan una URL HTTPS pública; mientras el servidor solo sea visible
en la red privada, el sondeo cada minuto hace lo mismo.

## Configuración

- `~/.config/poo-redmine-watcher/watcher.env`: Redmine y Poo IA (`ops/redmine-watcher.env.example`).
- `~/.config/poo-redmine/agenda.env`: agenda, jornada y frontal (`ops/agenda.env.example`).
- Estado en `~/.local/state/poo-redmine-watcher/`: `issues.json` (peticiones y su etapa),
  `agenda.json` (actividades), `previas/` y `publicados/` (comentarios).

Las credenciales nunca van a Git.

## Desarrollo y despliegue

```sh
npm ci
npm run check        # tsc + pruebas (reglas, ciclo, huecos y planificador contra una agenda simulada)
ops/deploy.sh        # desde la Mac: sube HEAD, prueba en el servidor y reinicia poo-redmine-watcher
```

`ops/deploy.sh --dry-run` solo muestra la revisión actual y el estado del servicio.
