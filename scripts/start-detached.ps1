# Start the dashboard fully detached AND windowless.
#
# Two failure modes this avoids:
#  - Parented to a console: closing that console (or the terminal/agent that
#    owns it) makes Windows kill the whole child tree. WMI
#    (Win32_Process.Create) parents the new process to WmiPrvSE instead, so it
#    survives the caller going away.
#  - Visible console window: a console app created via WMI still gets a real,
#    visible console window, and someone closing that window kills the server.
#    So the WMI process is wscript hosting scripts\dashboard-launch.vbs, which
#    starts the cmd with window style 0 — hidden, nothing to close.
$repo = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot "dashboard-launch.vbs"
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "wscript.exe `"$vbs`"" }
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed with $($r.ReturnValue)" }
Write-Output "Detached start requested (wscript pid $($r.ProcessId)); server runs in a hidden console."
