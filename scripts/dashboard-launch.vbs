' Runs the sparktop dashboard with no visible console window.
'
' A console app spawned directly (shell, Start-Process, even WMI) gets a real
' console window; closing that window makes Windows terminate the entire
' process tree — the server included. Window style 0 means there is no window
' to close by accident. Launch this VBS from the Startup folder or from
' scripts\start-detached.ps1.
Dim fso, repo, q, sh
Set fso = CreateObject("Scripting.FileSystemObject")
repo = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
q = Chr(34)
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c " & q & repo & "\scripts\start-dashboard.cmd" & q, 0, False
