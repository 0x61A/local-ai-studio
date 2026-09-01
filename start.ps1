# Local AI Studio - Windows baslatici. start.bat bunu cagirir.
$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
Set-Location $root

$node = Join-Path $root "runtime\node\node.exe"
$serverJs = Join-Path $root "packages\server\dist\server.cjs"
$webIndex = Join-Path $root "packages\web\dist\index.html"

# 1) Tasinabilir Node -- yoksa indir. Sistem Node'una dokunmayiz.
if (-not (Test-Path $node)) {
  Write-Host "  Ilk calistirma: tasinabilir Node.js kuruluyor..."
  & (Join-Path $root "scripts\setup\fetch-node.ps1")
}

# 2) Derlenmis cikti yoksa (gelistirici kopyasi) burada uret.
if (-not (Test-Path $serverJs) -or -not (Test-Path $webIndex)) {
  if (Test-Path (Join-Path $root "node_modules")) {
    Write-Host "  Derlenmis cikti eksik, build calistiriliyor..."
    $env:PATH = (Join-Path $root "runtime\node") + [IO.Path]::PathSeparator + $env:PATH
    & (Join-Path $root "runtime\node\npm.cmd") run build
    if ($LASTEXITCODE -ne 0) { throw "build basarisiz" }
  } else {
    Write-Error "  [HATA] Derlenmis cikti yok ve bagimliliklar kurulu degil."
    Write-Error "         Gelistirici kopyasindaysaniz: npm install && npm run build"
    exit 1
  }
}

$env:STUDIO_ROOT = $root

# 3) Sunucuyu baslat, STUDIO_URL satirini yakalayip tarayiciyi ac.
#    Surec bu konsolun cocugu: Ctrl+C ikisini birden kapatir, baska surec
#    oldurmeyiz.
$opened = $false
& $node $serverJs 2>&1 | ForEach-Object {
  $line = [string]$_
  if (-not $opened -and $line -match '^STUDIO_URL=(.+)$') {
    $opened = $true
    Start-Process $Matches[1] | Out-Null
  } else {
    Write-Host $line
  }
}

exit $LASTEXITCODE
