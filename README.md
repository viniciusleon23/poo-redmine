# poo-redmine

Vigilante de Redmine de Poo IA: sondea las incidencias abiertas asignadas a la cuenta
configurada, abre una conversación de Poo IA por cada asignación nueva y la lleva por
etapas hasta publicar el comentario de cierre.

## Estado de este commit

Copia exacta de lo que corre en el servidor (`poo@poo-IA`, unidad `poo-redmine-watcher`)
el 14/11/2026. Los archivos conservan la ruta que tienen en `~/poo-ia-native`, de donde
se ejecutan, y dependen del paquete `@poo/client` de ese repositorio (`poo-ia-ios`):

- `apps/redmine-watcher/src/main.ts`: sondeo de Redmine, toma de la incidencia y enlace con la conversación.
- `apps/redmine-watcher/src/flow.ts`: reglas del flujo, catálogo de acuses, marcas `Etapa:` y prompts.
- `apps/redmine-watcher/src/cycle.ts`: máquina de etapas (supervisor, corrección, cierre y publicación).
- `apps/redmine-watcher/bin/redmine_comentar.py`: vista previa y publicación del comentario (sin duplicados).
- `apps/redmine-watcher/bin/redmine_captura.cjs`: capturas del comentario con Playwright.
- `tests/`: pruebas de las reglas y del ciclo (`npx tsx --test tests/*.test.ts` dentro de `poo-ia-native`).
- `ops/`: unidad systemd de usuario y ejemplo de configuración. Las credenciales nunca van a Git.

Los commits siguientes lo vuelven un servicio independiente y le añaden la agenda.
