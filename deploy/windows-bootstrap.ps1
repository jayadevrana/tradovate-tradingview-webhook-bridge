# ============================================================================
#  TradingView -> Tradovate Bridge  ::  Windows Server one-shot installer
#  Run ONCE, in an ELEVATED PowerShell (Run as Administrator), on the server.
#
#    cd C:\bridge\deploy
#    powershell -ExecutionPolicy Bypass -File .\windows-bootstrap.ps1
#
#  It will: install Node (if missing), install deps, install + start a Windows
#  service (NSSM) that auto-starts on boot & restarts on crash, and open port 80.
# ============================================================================
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
Write-Host "== Tradovate Bridge :: Windows bootstrap ==" -ForegroundColor Cyan

$proj = Split-Path -Parent $PSScriptRoot          # project root (deploy\..)
Set-Location $proj
Write-Host "Project folder: $proj"

# --- 1. Node.js LTS --------------------------------------------------------
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Node.js LTS..." -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  } else {
    Write-Host "winget not found; downloading Node MSI..."
    $msi = "$env:TEMP\node-lts.msi"
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi" -OutFile $msi
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
  }
  Refresh-Path
}
node -v; npm -v

# --- 2. .env ---------------------------------------------------------------
if (-not (Test-Path "$proj\.env")) {
  Copy-Item "$proj\.env.example" "$proj\.env"
  Write-Warning "Created .env from template. EDIT IT (credentials + WEBHOOK_SECRET) before going live."
}

# --- 3. dependencies -------------------------------------------------------
Write-Host "Installing npm dependencies..." -ForegroundColor Yellow
npm install --omit=dev

# --- 4. NSSM (service manager) --------------------------------------------
$nssm = "$PSScriptRoot\nssm.exe"
if (-not (Test-Path $nssm)) {
  Write-Host "Downloading NSSM..." -ForegroundColor Yellow
  try {
    $zip = "$env:TEMP\nssm.zip"; $dst = "$env:TEMP\nssm_extract"
    Invoke-WebRequest -UseBasicParsing -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $zip
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    Expand-Archive $zip $dst -Force
    Copy-Item "$dst\nssm-2.24\win64\nssm.exe" $nssm
  } catch {
    throw "Could not download NSSM. Manually download https://nssm.cc/download and place win64\nssm.exe at $nssm, then re-run."
  }
}

# --- 5. port 80 conflict check --------------------------------------------
$busy = Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Warning "Port 80 is already in use by PID(s): $($busy.OwningProcess -join ',')."
  if (Get-Service W3SVC -ErrorAction SilentlyContinue) {
    Write-Warning "Looks like IIS may be running. To free port 80:  Stop-Service W3SVC; Set-Service W3SVC -StartupType Disabled"
  }
}

# --- 6. install / (re)configure the service -------------------------------
$svc  = "TradovateBridge"
$node = (Get-Command node).Source
$entry = "$proj\src\index.js"
New-Item -ItemType Directory -Force -Path "$proj\logs" | Out-Null

if (& $nssm status $svc 2>$null) { & $nssm stop $svc 2>$null; & $nssm remove $svc confirm 2>$null }
& $nssm install $svc "$node" "$entry"
& $nssm set $svc AppDirectory "$proj"
& $nssm set $svc Start SERVICE_AUTO_START
& $nssm set $svc AppStdout "$proj\logs\service-out.log"
& $nssm set $svc AppStderr "$proj\logs\service-err.log"
& $nssm set $svc AppExit Default Restart
& $nssm set $svc AppRestartDelay 3000
& $nssm set $svc DisplayName "Tradovate TradingView Bridge"
& $nssm start $svc

# --- 7. firewall: inbound TCP 80 ------------------------------------------
if (-not (Get-NetFirewallRule -DisplayName "Tradovate Webhook HTTP 80" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "Tradovate Webhook HTTP 80" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80 -Profile Any | Out-Null
  Write-Host "Opened inbound TCP port 80."
}

Start-Sleep -Seconds 4
Write-Host ""
Write-Host "== Done ==" -ForegroundColor Green
Write-Host "Service status : " -NoNewline; & $nssm status $svc
Write-Host "Local health   : http://localhost/health"
try { (Invoke-WebRequest -UseBasicParsing http://localhost/health).Content } catch { Write-Warning "Health check failed - check logs\service-err.log and that .env is filled in." }
Write-Host ""
Write-Host "Manage:  $nssm restart $svc  |  $nssm stop $svc  |  logs in $proj\logs\"
