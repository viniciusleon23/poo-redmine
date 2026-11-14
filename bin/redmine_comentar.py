#!/usr/bin/env python3
"""Publica un comentario (y adjuntos opcionales) en una incidencia de Redmine.

Agrega 🐼 al final del comentario (firma pedida por el propietario). Dos pasos:
  --vista-previa: no publica nada; captura cómo se verá el comentario con la
    previsualización de Redmine y avisa al vigilante, que se lo pasa al supervisor.
  sin --vista-previa: publica, comprueba que Redmine lo guardó y captura el comentario
    publicado. **Solo lo hace el vigilante** (REDMINE_PUBLICA=vigilante), cuando el
    propietario pulsa «Finalizar» y con el texto que aprobó el supervisor. Lleva un
    registro (publicados/<incidencia>.json) y además mira los comentarios que ya hay en
    Redmine: el mismo texto no se publica dos veces.
Las capturas van a --captura-dir (por defecto ./capturas, la carpeta que Poo IA muestra en el chat).
No cambia estado, asignación ni otros campos salvo --estado.
Credenciales: REDMINE_CREDENTIALS (por defecto ~/.config/poo-ia/redmine.env),
con REDMINE_URL y REDMINE_API_KEY o REDMINE_USER/REDMINE_PASSWORD. Nunca las imprime.

Uso:
  redmine_comentar.py 38977 --notas-archivo comentario.md --vista-previa
  redmine_comentar.py 38977 --notas-archivo comentario.md [--adjunto reporte.xlsx]... [--estado "Resuelta"]
"""
import argparse
import base64
import hashlib
import json
import mimetypes
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PANDA = "🐼"
NODE = os.path.expanduser("~/.fnm/aliases/default/bin/node")
CAPTURA = Path(__file__).with_name("redmine_captura.cjs")


def load_env(path):
    env = {}
    for line in Path(path).expanduser().read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("issue", type=int)
    ap.add_argument("--notas-archivo", required=True)
    ap.add_argument("--adjunto", action="append", default=[])
    ap.add_argument("--estado", help="Nombre exacto del estado; solo si el propietario lo pidió")
    ap.add_argument("--captura-dir", default="capturas", help="Carpeta de capturas de la conversación")
    ap.add_argument("--vista-previa", action="store_true", help="Solo captura la previsualización; no publica")
    a = ap.parse_args()

    env = load_env(os.environ.get("REDMINE_CREDENTIALS", "~/.config/poo-ia/redmine.env"))
    base = env["REDMINE_URL"].rstrip("/")
    headers = {"Accept": "application/json"}
    if env.get("REDMINE_API_KEY"):
        headers["X-Redmine-API-Key"] = env["REDMINE_API_KEY"]
    else:
        token = base64.b64encode(f"{env['REDMINE_USER']}:{env['REDMINE_PASSWORD']}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"

    def call(method, path, body=None, content_type="application/json"):
        req = urllib.request.Request(f"{base}{path}", data=body, method=method, headers={**headers, "Content-Type": content_type})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return r.status, json.loads(raw) if raw.strip() else None
        except urllib.error.HTTPError as e:
            sys.exit(f"Redmine {method} {path.split('?')[0]} respondió HTTP {e.code}: {e.read()[:300].decode(errors='replace')}")

    notes = Path(a.notas_archivo).read_text().strip().replace("\r\n", "\n")
    if not notes:
        sys.exit("El comentario está vacío.")
    if not notes.endswith(PANDA):
        notes = f"{notes} {PANDA}"

    shots = Path(a.captura_dir)
    shots.mkdir(parents=True, exist_ok=True)
    cred_env = {**os.environ, **{k: v for k, v in env.items() if k.startswith("REDMINE_")}}

    def capture(mode, ref, name):
        n = len(list(shots.glob("*.png"))) + 1
        out = shots.resolve() / f"{n:02d}-redmine-{a.issue}-{name}.png"
        r = subprocess.run([NODE, str(CAPTURA), mode, str(a.issue), str(ref), str(out)],
                           env=cred_env, capture_output=True, text=True, timeout=120)
        return out if r.returncode == 0 else None, r.stderr.strip()[-300:]

    estado_dir = Path(os.environ.get("WATCHER_STATE_DIR", "~/.local/state/poo-redmine-watcher")).expanduser()
    huella = hashlib.sha256(notes.encode()).hexdigest()

    if not a.vista_previa and os.environ.get("REDMINE_PUBLICA") != "vigilante":
        sys.exit("No se publicó nada: el comentario en Redmine lo publica el vigilante por la API cuando el "
                 "propietario pulsa «Finalizar». Deja la vista previa (--vista-previa), muestra el texto y cierra tu "
                 "mensaje con `Etapa: EJECUTADO` (o `Etapa: RESPUESTA` si respondes a un comentario) para que entre "
                 "el supervisor.")

    if a.vista_previa:
        tmp = shots.resolve() / f".previa-{a.issue}.txt"
        tmp.write_text(notes)
        try:
            out, err = capture("previa", tmp, "vista-previa-comentario")
        finally:
            tmp.unlink(missing_ok=True)
        # Marca para el vigilante: dispara la validación final con el modelo revisor.
        marks = Path(os.environ.get("REDMINE_PREVIEW_DIR", str(estado_dir / "previas"))).expanduser()
        marks.mkdir(parents=True, exist_ok=True)
        (marks / f"{a.issue}.json").write_text(json.dumps({
            "at": int(time.time() * 1000), "notes": notes, "capture": str(out) if out else None,
            "attachments": [str(Path(f).resolve()) for f in a.adjunto]}, ensure_ascii=False))
        print("VISTA PREVIA (no se publicó nada). Texto que se enviaría:\n" + notes)
        if a.adjunto:
            print("Adjuntos que se subirían: " + ", ".join(Path(f).name for f in a.adjunto))
        print(f"Captura: {out}" if out else f"No se pudo tomar la captura de la vista previa: {err}")
        return

    # Sin duplicados: el registro propio y, por si se publicó por otra vía, los comentarios de Redmine.
    norm = lambda t: (t or "").replace("\r\n", "\n").strip()
    registro = estado_dir / "publicados" / f"{a.issue}.json"
    previos = json.loads(registro.read_text()) if registro.exists() else []

    def anotar(journal, estado, duplicado):
        if not any(p["huella"] == huella for p in previos):
            previos.append({"huella": huella, "journal": journal, "at": int(time.time() * 1000)})
            registro.parent.mkdir(parents=True, exist_ok=True)
            registro.write_text(json.dumps(previos, ensure_ascii=False, indent=1))
        print(f"RESULTADO: {'ya estaba publicado' if duplicado else 'publicado'}, journal {journal}, estado «{estado}», "
              f"{base}/issues/{a.issue}#change-{journal}")

    _, before = call("GET", f"/issues/{a.issue}.json?include=journals")
    ya = next((p for p in previos if p["huella"] == huella), None)
    igual = [j for j in before["issue"].get("journals", []) if norm(j.get("notes")) in (notes, notes[: -len(PANDA)].rstrip())]
    if ya or igual:
        journal = igual[-1]["id"] if igual else ya["journal"]
        print(f"Ese comentario ya está publicado en #{a.issue} (journal {journal}); no se repite.")
        anotar(journal, before["issue"]["status"]["name"], True)
        return

    uploads = []
    for f in a.adjunto:
        p = Path(f)
        _, r = call("POST", f"/uploads.json?filename={urllib.request.quote(p.name)}", p.read_bytes(), "application/octet-stream")
        uploads.append({"token": r["upload"]["token"], "filename": p.name,
                        "content_type": mimetypes.guess_type(p.name)[0] or "application/octet-stream"})

    issue = {"notes": notes}
    if uploads:
        issue["uploads"] = uploads
    if a.estado:
        _, st = call("GET", "/issue_statuses.json")
        match = [s["id"] for s in st["issue_statuses"] if s["name"].strip().lower() == a.estado.strip().lower()]
        if not match:
            sys.exit(f"No existe el estado «{a.estado}».")
        issue["status_id"] = match[0]

    last = max([j["id"] for j in before["issue"].get("journals", [])] or [0])
    call("PUT", f"/issues/{a.issue}.json", json.dumps({"issue": issue}).encode())
    _, after = call("GET", f"/issues/{a.issue}.json?include=journals,attachments")
    mine = [j for j in after["issue"].get("journals", []) if j["id"] > last and norm(j.get("notes"))]
    if not mine:
        sys.exit("Redmine aceptó la petición pero no encuentro el comentario nuevo; revísalo a mano.")
    j = mine[-1]
    print(f"Comentario publicado en #{a.issue} (journal {j['id']}, {j['created_on']}); "
          f"estado: {after['issue']['status']['name']}; adjuntos subidos: {len(uploads)}")
    if norm(j["notes"]) != notes:
        print("AVISO: el texto guardado difiere del enviado"
              + (" (Redmine no conservó el emoji 🐼)" if norm(j["notes"]) == notes[: -len(PANDA)].rstrip() else "")
              + "; revísalo en la captura.")
    print(f"{base}/issues/{a.issue}#change-{j['id']}")
    anotar(j["id"], after["issue"]["status"]["name"], False)

    out, err = capture("publicado", j["id"], "comentario-publicado")
    print(f"Captura: {out}" if out else f"No se pudo tomar la captura: {err}")


if __name__ == "__main__":
    main()
