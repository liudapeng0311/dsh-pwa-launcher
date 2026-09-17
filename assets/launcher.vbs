' launcher.vbs -- silent entry point for the DeepSeek Harness desktop icon.
'
' The desktop / Start Menu shortcut points at
'     wscript.exe "<installDir>\launcher.vbs"
' and this file exists for exactly one reason: a shortcut that calls
' powershell.exe directly always flashes a console window for a few frames,
' while WScript.Shell.Run with window style 0 starts PowerShell with no window
' at all.
'
' All real logic lives in scripts\launch.ps1. If VBScript is ever removed from
' Windows, repoint the shortcut at:
'     powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "<installDir>\scripts\launch.ps1"
Option Explicit

Dim fso, shell, here, cmd

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass " & _
      "-WindowStyle Hidden -File """ & here & "\scripts\launch.ps1"""

' 0 = hidden, False = do not wait (the launcher opens the window and exits)
shell.Run cmd, 0, False
