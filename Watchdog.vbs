' Norse Imperium - watchdog (2026-11-09). Windows Task Scheduler runs this at 5:45 PM every day.
' If the dashboard doesn't answer, it starts the Imperium the same way the Startup shortcut does.
' If the Imperium is already up, it does nothing at all (no window, no sound).
On Error Resume Next
Dim h, up
up = False
Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
h.setTimeouts 3000, 3000, 3000, 3000
h.open "GET", "http://127.0.0.1:7878/api/status", False
h.send
If Err.Number = 0 Then
  If h.status = 200 Then up = True
End If
Err.Clear
If Not up Then CreateObject("WScript.Shell").Run "wscript.exe ""C:\Imperium\Imperium.vbs""", 0, False
