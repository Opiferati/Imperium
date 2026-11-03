@echo off
rem Desktop shortcuts for the Norse Imperium (2026-11-01). Run once.
rem   "Norse Imperium"            - the app: its own window, no console. Closing it stops the Imperium.
rem   "Norse Imperium (console)"  - the old way, with the live log window, for troubleshooting.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$d=[Environment]::GetFolderPath('Desktop'); $w=New-Object -ComObject WScript.Shell;" ^
 "$s=$w.CreateShortcut($d+'\Norse Imperium.lnk'); $s.TargetPath=$env:WINDIR+'\System32\wscript.exe'; $s.Arguments='\"C:\Imperium\Imperium.vbs\"'; $s.WorkingDirectory='C:\Imperium'; $s.IconLocation='C:\Imperium\Imperium.ico'; $s.Description='Norse Imperium'; $s.Save();" ^
 "$c=$w.CreateShortcut($d+'\Norse Imperium (console).lnk'); $c.TargetPath='C:\Imperium\Imperium (console).bat'; $c.WorkingDirectory='C:\Imperium'; $c.IconLocation='C:\Imperium\Imperium.ico'; $c.Save()"
echo Shortcuts made: "Norse Imperium" (app) and "Norse Imperium (console)" are on your Desktop.
pause
