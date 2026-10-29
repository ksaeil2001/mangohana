$ErrorActionPreference = "Stop"

$gitBash = "C:\Program Files\Git\bin\bash.exe"
if (-not (Test-Path -LiteralPath $gitBash)) {
  throw "Git Bash was not found at $gitBash. Install Git for Windows or update this script path."
}

$script = @'
set -euo pipefail

ts="$(date +%Y%m%d-%H%M%S)"
backup_root="$HOME/.gstack/backups/finish-official-install-$ts"
mkdir -p "$backup_root"
mkdir -p "$HOME/.gstack/repos"
mkdir -p "$HOME/.codex/skills"

src="$HOME/.codex/skills/gstack"
dst="$HOME/.gstack/repos/gstack"

echo "Backup root: $backup_root"

if [ -e "$dst" ]; then
  echo "Backing up existing $dst"
  mv "$dst" "$backup_root/gstack-repo"
fi

if [ -d "$src/.git" ]; then
  echo "Moving cloned repo from $src to $dst"
  mv "$src" "$dst"
elif [ -d "$dst/.git" ]; then
  echo "Repo already exists at $dst"
else
  echo "No usable clone found. Cloning official gstack to $dst"
  git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git "$dst"
fi

cd "$dst"

echo "Resetting repo to origin/main"
git fetch origin
git reset --hard origin/main

echo "Running setup for Codex from repo location"
./setup --host codex

echo "Version:"
cat VERSION

echo "Update check:"
./bin/gstack-update-check --force || true
cat "$HOME/.gstack/last-update-check" 2>/dev/null || true

echo "Browse files:"
ls -la browse/dist || true

echo "Browse status:"
./browse/dist/browse status

echo "Finished official gstack install."
'@

$tempScript = Join-Path $PSScriptRoot ("finish-gstack-official-install-" + [Guid]::NewGuid().ToString("N") + ".sh")
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
