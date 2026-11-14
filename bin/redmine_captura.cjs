#!/usr/bin/env node
/**
 * Capturas de comentarios de Redmine con la cuenta del vigilante. Nunca recorta
 * la descripción de la incidencia, que puede traer datos de clientes.
 *
 *   publicado <issue> <journal_id> <salida.png>
 *     Recorta el comentario ya publicado (#change-<journal>).
 *   previa <issue> <archivo_notas> <salida.png>
 *     Abre el formulario de edición, escribe las notas y usa «Previsualizar» de
 *     Redmine para mostrar cómo se verá el comentario. No envía el formulario:
 *     no se guarda nada.
 *
 * Credenciales por entorno (REDMINE_URL, REDMINE_USER, REDMINE_PASSWORD); nunca se imprimen.
 */
const { readFileSync } = require("node:fs");
const { chromium } = require(process.env.PW_CORE ?? `${process.env.HOME}/.local/share/poo-redmine-watcher/pw/node_modules/playwright-core`);

const [mode, issue, arg, out] = process.argv.slice(2);
if (!["publicado", "previa"].includes(mode) || !issue || !arg || !out) {
  console.error("Uso: redmine_captura.cjs publicado <issue> <journal_id> <salida.png> | previa <issue> <archivo_notas> <salida.png>");
  process.exit(2);
}
const base = process.env.REDMINE_URL.replace(/\/+$/, "");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "es-ES" });
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.fill("#username", process.env.REDMINE_USER);
    await page.fill("#password", process.env.REDMINE_PASSWORD);
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.click("#login-submit")]);
    if (page.url().includes("/login")) throw new Error("no se pudo iniciar sesión en Redmine");

    if (mode === "publicado") {
      await page.goto(`${base}/issues/${issue}#change-${arg}`, { waitUntil: "networkidle", timeout: 30000 });
      const note = page.locator(`#change-${arg}`);
      await note.waitFor({ timeout: 15000 });
      await note.scrollIntoViewIfNeeded();
      await note.screenshot({ path: out });
    } else {
      await page.goto(`${base}/issues/${issue}/edit`, { waitUntil: "networkidle", timeout: 30000 });
      const notes = page.locator("#issue_notes");
      await notes.waitFor({ timeout: 15000 });
      await notes.fill(readFileSync(arg, "utf8"));
      const block = page.locator("fieldset", { has: notes });
      await block.locator("a.tab-preview").click();
      await block.locator(".wiki-preview").waitFor({ state: "visible", timeout: 15000 });
      await page.waitForLoadState("networkidle");
      await block.scrollIntoViewIfNeeded();
      await block.screenshot({ path: out });
    }
    console.log(out);
  } finally {
    // Se cierra sin enviar el formulario: en modo «previa» nada llega a guardarse.
    await browser.close();
  }
})().catch((err) => {
  console.error(`captura fallida: ${err.message}`);
  process.exit(1);
});
