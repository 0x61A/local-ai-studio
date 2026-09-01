# Motor kurulumu (Windows): fetch-engine.mjs sarmalayicisi.
#
# Isin tamami fetch-engine.mjs'de; bu betigin tek isi calistiracak bir Node
# bulmak. Sistemde Node olmayabilir, o yuzden once tasinabilir olani indiririz.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$node = Join-Path $root "runtime\node\node.exe"

if (-not (Test-Path $node)) {
  $system = Get-Command node -ErrorAction SilentlyContinue
  if ($system) {
    $node = $system.Source
  } else {
    & (Join-Path $PSScriptRoot "fetch-node.ps1")
    $node = Join-Path $root "runtime\node\node.exe"
  }
}

& $node (Join-Path $root "scripts\setup\fetch-engine.mjs") @args
exit $LASTEXITCODE
