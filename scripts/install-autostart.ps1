# Install (or with -Remove, uninstall) a hidden logon autostart entry for the
# sparktop dashboard. Uses the current user's Startup folder, so no admin
# rights are required. The entry runs scripts\start-dashboard.cmd window-less
# at logon; output lands in server.log at the repo root.
param([switch]$Remove)

$repo = Split-Path -Parent $PSScriptRoot
$cmd = Join-Path $repo "scripts\start-dashboard.cmd"
$startup = [Environment]::GetFolderPath("Startup")
$vbs = Join-Path $startup "sparktop-dashboard.vbs"

if ($Remove) {
  if (Test-Path $vbs) { Remove-Item $vbs -Force; Write-Output "Removed $vbs" }
  else { Write-Output "Not installed ($vbs missing)" }
  return
}

if (-not (Test-Path $cmd)) { throw "Missing $cmd" }

# wscript hosts this so the cmd runs with no visible console window.
$template = @'
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c ""<CMD>""", 0, False
'@
Set-Content -Path $vbs -Value $template.Replace("<CMD>", $cmd) -Encoding ASCII
Write-Output "Installed autostart: $vbs"
Write-Output "  runs at logon: $cmd"
