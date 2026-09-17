' restart.vbs -- silent entry point that fully RESTARTS the DeepSeek Harness
' service. It is triggered by the "restart" button injected into the web UI
' (see lib/index.js).
'
' Same reason launcher.vbs exists: WScript.Shell.Run with window style 0 starts
' PowerShell with no console window at all. The real logic lives in
' scripts\launch.ps1; this file only adds three switches:
'
'   -Restart   stop the running service first, then start it fresh
'              (launch.ps1 calls stop.ps1 internally)
'   -NoOpen    after it is up, do NOT open a new browser window -- the window
'              that is already open polls the new service and reconnects itself.
'   -NoSplash  do NOT show the native loading window; the web page already shows
'              its own splash-styled card, so a second popup would be redundant.
'
' Why this process chain is safe against self-kill: node(dsh) -> wscript ->
' powershell. wscript calls Run(..., False) (do not wait) and then exits
' immediately, so the powershell becomes an orphan (its parent is already gone).
' stop.ps1 only kills the node that owns the port plus its *live* descendants,
' so it can never reach this detached powershell -- the restart is not aborted
' by the very stop it triggers.
'
' NOTE: keep this file pure ASCII. wscript.exe reads .vbs using the system ANSI
' codepage, so non-ASCII (e.g. UTF-8 Chinese) comments can mis-decode and merge
' a comment line with the code line below it -- silently disabling shell.Run.
Option Explicit

Dim fso, shell, here, cmd

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass " & _
      "-WindowStyle Hidden -File """ & here & "\scripts\launch.ps1"" -Restart -NoOpen -NoSplash"

' 0 = hidden window, False = do not wait (wscript exits right away, orphaning launch.ps1)
shell.Run cmd, 0, False
