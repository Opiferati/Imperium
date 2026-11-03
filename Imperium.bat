@echo off
title Norse Imperium
color 0E
rem One-click launcher (2026-11-01). Runs start-imperium.sh inside WSL.
rem Close this window or press Ctrl+C to stop everything.
wsl.exe -e bash -lic "bash /mnt/c/Imperium/start-imperium.sh"
echo.
echo  The Imperium has stopped. Press any key to close.
pause >nul
