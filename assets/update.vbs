' update.vbs -- silent entry point that upgrades the DeepSeek Harness to a
' given version. Triggered by the "update" control injected into the web UI
' (see lib/index.js). Arg 0 = target version, e.g. 0.1.6-alpha.1
'
' Same orphan trick as restart.vbs: WScript.Shell.Run with window style 0 and
' do-not-wait starts PowerShell with no console and detaches it, so the update
' orchestrator is not a live descendant of the node process that stop.ps1 (run
' inside update.ps1) will kill. That is why the update can stop the very dsh
' process that launched it without aborting itself.
'
' NOTE: keep this file pure ASCII. wscript.exe reads .vbs using the system ANSI
' codepage, so non-ASCII comments can mis-decode and silently break shell.Run.
Option Explicit

Dim fso, shell, here, target, cmd

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)

target = ""
If WScript.Arguments.Count > 0 Then target = WScript.Arguments(0)

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass " & _
      "-WindowStyle Hidden -File """ & here & "\scripts\update.ps1"" -Target """ & target & """"

' 0 = hidden window, False = do not wait (wscript exits right away, orphaning update.ps1)
shell.Run cmd, 0, False
