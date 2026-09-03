# Start the dashboard via WMI so the process is parented to WmiPrvSE instead
# of this console. Child processes die with their console on Windows (CTRL_CLOSE
# kills the whole tree), so anything launched normally from a script, agent, or
# closing terminal takes the server down with it. A WMI-created process has no
# such parent and keeps running.
$repo = Split-Path -Parent $PSScriptRoot
$cmd = Join-Path $repo "scripts\start-dashboard.cmd"
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd.exe /c `"$cmd`"" }
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed with $($r.ReturnValue)" }
Write-Output "Detached start requested: pid $($r.ProcessId) (survives this console closing)"
