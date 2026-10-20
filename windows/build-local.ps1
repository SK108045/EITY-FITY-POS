# Build Oraforge POS (portable folder, ZIP and installer) on this PC.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File windows\build-local.ps1
param([switch]$SkipInstaller)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Need($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name was not found. $hint" }
}
function Step($label, [scriptblock]$action) {
  Write-Host "`n==> $label" -ForegroundColor Cyan
  $global:LASTEXITCODE = 0
  & $action
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit code $LASTEXITCODE)" }
}

Need node   'Install Node.js 20 or newer from nodejs.org.'
Need npm    'Install Node.js 20 or newer from nodejs.org.'
Need python 'Install 64-bit Python 3.12 and tick "Add python.exe to PATH".'
Need go     'Install Go 1.24 or newer from go.dev/dl, then open a new PowerShell window.'

# Use a clean Python environment so the helper EXE does not pick up unrelated packages.
$venv = Join-Path $root '.venv-build'
if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) { Step 'Create clean Python build environment' { python -m venv $venv } }
$env:VIRTUAL_ENV = $venv
$env:PATH = (Join-Path $venv 'Scripts') + ';' + $env:PATH

Get-Process OraforgePOS, OraforgeEtims, node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*dist\windows\OraforgePOS*" } | Stop-Process -Force -ErrorAction SilentlyContinue

if (-not (Test-Path (Join-Path $root 'capacitor\node_modules'))) {
  Step 'Install JavaScript packages' { npm ci --prefix capacitor }
}
Step 'Build app, Node runtime and launcher' { python windows\build.py }
Step 'Install Python build packages' { python -m pip install --disable-pip-version-check pyinstaller==6.16.0 -r windows\etims-helper\requirements.txt }
Step 'Build eTIMS helper EXE' { powershell -NoProfile -ExecutionPolicy Bypass -File windows\build-etims-helper.ps1 }

$stage = Join-Path $root 'dist\windows\OraforgePOS'
$must = @('OraforgePOS.exe', 'pos.sqlite3', 'data\pos.sqlite3', 'runtime\node.exe', 'app\capacitor\etims-windows.js',
          'runtime\etims\OraforgeEtims\OraforgeEtims.exe')
foreach ($file in $must) {
  if (-not (Test-Path -LiteralPath (Join-Path $stage $file))) { throw "Missing in package: $file" }
}
if (-not (Get-ChildItem $stage -Recurse -Filter EtimsFastInvoiceGenerator.exe)) { throw 'Fast invoice engine is missing from the package.' }
if (Get-ChildItem $stage -Recurse -Filter etims-keys.json) { throw 'Developer keys (etims-keys.json) are inside the package. Stop.' }

$zip = Join-Path $root 'dist\windows\OraforgePOS-Windows-x64.zip'
Write-Host "`n==> Create portable ZIP" -ForegroundColor Cyan
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal -Force
$sha = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
Set-Content -Path ($zip + '.sha256') -Value "$sha  $(Split-Path $zip -Leaf)`n" -NoNewline
Write-Host "ZIP: $zip" -ForegroundColor Green

if (-not $SkipInstaller) {
  $iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
            "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($iscc) {
    $out = Join-Path $root 'dist\windows\installer'
    New-Item -ItemType Directory -Path $out -Force | Out-Null
    $version = '1.0.' + (Get-Date -Format 'yyMMdd')
    Step 'Build installer' { & $iscc "/DSourceDir=$stage" "/DOutputDir=$out" "/DAppVersion=$version" (Join-Path $root 'windows\OraforgePOS.iss') }
    Write-Host "Installer: $out\OraforgePOS-Setup-Windows-x64.exe" -ForegroundColor Green
  } else {
    Write-Host "`nInno Setup not found, so no installer was made. The ZIP is ready." -ForegroundColor Yellow
    Write-Host 'To make the installer too:  winget install JRSoftware.InnoSetup   then run this script again.' -ForegroundColor Yellow
  }
}
Write-Host "`nDONE." -ForegroundColor Green
