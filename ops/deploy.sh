#!/usr/bin/env bash
# Despliega la revisión confirmada (HEAD) al servidor de Poo IA. Se ejecuta desde la Mac.
#   ops/deploy.sh [--dry-run]
# Cada revisión va a ~/poo-redmine.releases/<rev> y ~/poo-redmine pasa a ser un enlace a la
# actual. Instala dependencias y corre las pruebas en el servidor antes de cambiar el enlace;
# si el servicio no queda activo, vuelve a la revisión anterior. El estado
# (~/.local/state/poo-redmine-watcher) y las credenciales (~/.config) no se tocan.
set -euo pipefail
HOST="${POO_HOST:-poo@192.168.1.81}"
UNIT=poo-redmine-watcher
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1
cd "$(dirname "$0")/.."
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Hay cambios sin confirmar: se despliega lo que está en Git." >&2
  exit 1
fi
REV="$(git rev-parse --short HEAD)"
echo "Revisión $REV → $HOST"
if (( DRY )); then
  ssh -o BatchMode=yes "$HOST" "readlink ~/poo-redmine || echo '(sin desplegar)'; ls ~/poo-redmine.releases 2>/dev/null; systemctl --user is-active $UNIT; systemctl --user show $UNIT -p WorkingDirectory -p NRestarts"
  exit 0
fi
git archive --format=tar HEAD | ssh -o BatchMode=yes "$HOST" "set -e; d=\$HOME/poo-redmine.releases/$REV.nuevo; rm -rf \"\$d\"; mkdir -p \"\$d\"; tar -x -C \"\$d\"; echo $REV > \"\$d/REVISION\""
ssh -o BatchMode=yes "$HOST" REV="$REV" UNIT="$UNIT" bash -s <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.fnm/aliases/default/bin:$PATH"
releases="$HOME/poo-redmine.releases"
new="$releases/$REV"
cd "$new.nuevo"
npm ci --no-audit --no-fund >/dev/null
npm test 2>&1 | grep -E '^# (tests|pass|fail)'
npm test >/dev/null 2>&1 || { echo "Las pruebas fallan en el servidor: no se despliega." >&2; exit 1; }
previous="$(readlink "$HOME/poo-redmine" 2>/dev/null || true)"
rm -rf "$new"
mv "$new.nuevo" "$new"
unit="$HOME/.config/systemd/user/$UNIT.service"
if ! cmp -s "$new/ops/$UNIT.service" "$unit"; then
  cp -p "$unit" "$HOME/poo-ia-backups/$UNIT.service.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  install -m 644 "$new/ops/$UNIT.service" "$unit"
  systemctl --user daemon-reload
  echo "unidad systemd actualizada"
fi
ln -sfn "$new" "$HOME/poo-redmine"
systemctl --user restart "$UNIT"
sleep 12
if ! systemctl --user is-active --quiet "$UNIT"; then
  echo "El servicio no quedó activo:" >&2
  journalctl --user -u "$UNIT" -n 20 --no-pager -o cat >&2
  if [[ -n "$previous" && -d "$previous" ]]; then
    ln -sfn "$previous" "$HOME/poo-redmine"
    systemctl --user restart "$UNIT" || true
    echo "Se volvió a $previous." >&2
  fi
  exit 1
fi
# Se conservan la actual y las dos anteriores.
ls -1dt "$releases"/*/ | tail -n +4 | while read -r old; do
  [[ "$(readlink -f "$HOME/poo-redmine")" == "$(readlink -f "$old")" ]] || rm -rf "$old"
done
echo "activo en $(readlink "$HOME/poo-redmine")"
journalctl --user -u "$UNIT" -n 8 --no-pager -o cat
REMOTE
