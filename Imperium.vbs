' Norse Imperium - silent starter (2026-11-01). Runs the app launcher with no console window.
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Imperium\Launch-Imperium.ps1""", 0, False
