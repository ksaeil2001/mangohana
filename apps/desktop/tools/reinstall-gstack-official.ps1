$ErrorActionPreference = "Stop"

$gitBash = "C:\Program Files\Git\bin\bash.exe"
if (-not (Test-Path -LiteralPath $gitBash)) {
  throw "Git Bash was not found at $gitBash. Install Git for Windows or update this script path."
}

$script = @'
set -euo pipefail

ts="$(date +%Y%m%d-%H%M%S)"
backup_root="$HOME/.gstack/backups/official-reinstall-$ts"
mkdir -p "$backup_root"

echo "Backup root: $backup_root"

backup_path() {
  local path="$1"
  if [ -e "$path" ]; then
    local base
    base="$(basename "$path")"
    echo "Backing up $path"
    mv "$path" "$backup_root/$base"
  fi
}

backup_path "$HOME/.codex/skills/gstack"

if [ -d "$HOME/.codex/skills" ]; then
  shopt -s nullglob
  for path in "$HOME"/.codex/skills/gstack-*; do
    backup_path "$path"
  done
  shopt -u nullglob
fi

backup_path "$HOME/.gstack/repos/gstack"

echo "Cloning official gstack..."
mkdir -p "$HOME/.codex/skills"
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git "$HOME/.codex/skills/gstack"

echo "Running setup for Codex..."
cd "$HOME/.codex/skills/gstack"
./setup --host codex

echo "Version:"
cat VERSION

echo "Update check:"
./bin/gstack-update-check --force || true
cat "$HOME/.gstack/last-update-check" 2>/dev/null || true

echo "Browse status:"
./browse/dist/browse status

echo "Official reinstall finished."
'@

$tempScript = Join-Path $PSScriptRoot ("reinstall-gstack-official-" + [Guid]::NewGuid().ToString("N") + ".sh")
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tempScript, $script, $utf8NoBom)
$bashTempScript = $tempScript -replace '\\', '/'
$bashTempScript = $bashTempScript -replace '^C:', '/c'
try {
  & $gitBash -lc "bash '$bashTempScript'"
}
finally {
  Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
}
