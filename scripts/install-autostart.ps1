# Install (or with -Remove, uninstall) a hidden logon autostart entry for the
# sparktop dashboard. Uses the current user's Startup folder, so no admin
# rights are required. At logon, wscript runs scripts\dashboard-launch.vbs,
# which starts the server in a hidden, detached console; output lands in
# server.log at the repo root.
param([switch]$Remove)

$repo = Split-Path -Parent $PSScriptRoot
$vbsSrc = Join-Path $PSScriptRoot "dashboard-launch.vbs"
$startup = [Environment]::GetFolderPath("Startup")
$vbsDst = Join-Path $startup "sparktop-dashboard.vbs"

if ($Remove) {
  if (Test-Path $vbsDst) { Remove-Item $vbsDst -Force; Write-Output "Removed $vbsDst" }
  else { Write-Output "Not installed ($vbsDst missing)" }
  return
}

if (-not (Test-Path $vbsSrc)) { throw "Missing $vbsSrc" }
Copy-Item $vbsSrc $vbsDst -Force
Write-Output "Installed autostart: $vbsDst"
Write-Output "  runs at logon: $(Join-Path $PSScriptRoot 'start-dashboard.cmd') (hidden console)"
