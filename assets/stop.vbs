' stop.vbs -- silent entry point for stopping the DeepSeek Harness service.
'
' Same reason as launcher.vbs: run PowerShell with no console window.
' Logic lives in scripts\stop.ps1.
Option Explicit

Dim fso, shell, here, cmd

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass " & _
      "-WindowStyle Hidden -File """ & here & "\scripts\stop.ps1"""

shell.Run cmd, 0, False
