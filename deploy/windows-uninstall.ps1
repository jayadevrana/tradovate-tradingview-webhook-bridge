# Stop & remove the Windows service. Run as Administrator.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'SilentlyContinue'
$nssm = "$PSScriptRoot\nssm.exe"
$svc  = "TradovateBridge"
if (Test-Path $nssm) {
  & $nssm stop $svc
  & $nssm remove $svc confirm
  Write-Host "Removed service $svc"
} else {
  Write-Warning "nssm.exe not found next to this script."
}
Remove-NetFirewallRule -DisplayName "Tradovate Webhook HTTP 80" -ErrorAction SilentlyContinue
