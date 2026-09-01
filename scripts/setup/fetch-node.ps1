# Tasinabilir Node.js calisma zamanini runtime\node altina indirir (Windows).
# Sisteme hicbir sey kurmaz. Indirilen arsiv SHA256 ile dogrulanir.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$target = Join-Path $root "runtime\node"
$fallbackVersion = "v24.20.0"

if (Test-Path (Join-Path $target "node.exe")) {
  Write-Host "  [node] zaten kurulu: $(& (Join-Path $target 'node.exe') -v)"
  exit 0
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }

Write-Host "  [node] guncel LTS surumu sorgulaniyor..."
$version = $fallbackVersion
try {
  $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -TimeoutSec 20
  $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
  if ($lts) { $version = $lts.version }
} catch {
  Write-Host "  [node] surum listesi alinamadi, bilinen surume dusuluyor."
}
Write-Host "  [node] surum: $version (win-$arch)"

$archive = "node-$version-win-$arch.zip"
$base = "https://nodejs.org/dist/$version"
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("studio-node-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
  Write-Host "  [node] indiriliyor: $archive"
  Invoke-WebRequest -Uri "$base/$archive" -OutFile (Join-Path $work $archive)

  Write-Host "  [node] SHA256 dogrulaniyor..."
  $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt").Content -split "`n"
  $line = $sums | Where-Object { $_.Trim().EndsWith(" $archive") } | Select-Object -First 1
  $expected = if ($line) { ($line -split "\s+")[0] } else { $null }
  $actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $work $archive)).Hash.ToLower()
  if (-not $expected -or $actual -ne $expected.ToLower()) {
    throw "SHA256 UYUSMUYOR. Beklenen $expected, bulunan $actual"
  }

  # Arsivin icinde tek bir node-vX-win-<arch>\ klasoru var; duzlestiriyoruz.
  Expand-Archive -Path (Join-Path $work $archive) -DestinationPath $work -Force
  $extracted = Join-Path $work "node-$version-win-$arch"
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Copy-Item -Path (Join-Path $extracted "*") -Destination $target -Recurse -Force
} finally {
  Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "  [node] hazir: $(& (Join-Path $target 'node.exe') -v)"
