# Norse Imperium - app launcher (2026-11-01)
# Starts the Imperium inside WSL with no console window, opens the dashboard as its own app
# window (Edge app mode, own profile, Imperium icon), and shuts everything down when that
# window closes. For logs and troubleshooting, use "Imperium (console).bat" instead.
$ErrorActionPreference = 'SilentlyContinue'
$Url      = 'http://127.0.0.1:7878'   # IPv4 on purpose: 'localhost' tries IPv6 first and the dashboard listens on IPv4
$AppProfile  = Join-Path $env:LOCALAPPDATA 'NorseImperium\app-window'
$LogDir   = 'C:\Imperium\logs'

function Test-Up { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "$Url/api/status").StatusCode -eq 200 } catch { $false } }
function Say($msg) { (New-Object -ComObject WScript.Shell).Popup($msg, 0, 'Norse Imperium', 48) | Out-Null }

# Already running? Just open (or re-open) the window.
$alreadyUp = Test-Up
if (-not $alreadyUp) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Set-Content -Path "$LogDir\launcher.log" -Value '' -Encoding ascii
  # One pre-quoted string: Windows PowerShell does not quote array arguments that contain spaces.
  $backend = Start-Process -FilePath 'wsl.exe' -WindowStyle Hidden -PassThru `
    -ArgumentList '-e bash -lc "IMPERIUM_NO_BROWSER=1 bash /mnt/c/Imperium/start-imperium.sh > /mnt/c/Imperium/logs/launcher.log 2>&1"'
  # Wait for the dashboard to answer. Don't trust wsl.exe's own process: newer WSL hands off and exits
  # at once. Fail early only if the startup log says so; otherwise give preflight up to 2 minutes.
  $deadline = (Get-Date).AddSeconds(120)
  while (-not (Test-Up)) {
    $log = Get-Content "$LogDir\launcher.log" -Raw
    $failed = $log -match '\[FAIL\]|didn.t start|not found inside WSL'
    if ($failed -or (Get-Date) -gt $deadline) {
      $tail = (Get-Content "$LogDir\launcher.log" -Tail 8) -join "`n"
      Say("The Imperium didn't start.`n`n$tail`n`nRun 'Norse Imperium (console)' to see the full story.")
      & wsl.exe -e bash -lc "pkill -TERM -f '/mnt/c/Imperium/[w]arden.js'; pkill -TERM -f '/mnt/c/Imperium/[i]mperium-terminal.js'; true" | Out-Null
      exit 1
    }
    Start-Sleep -Milliseconds 800
  }
}

# Find Edge
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
          "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { Start-Process $Url; exit 0 }

$firstRun = -not (Test-Path $AppProfile)
$edgeArgs = @("--app=$Url", "--user-data-dir=`"$AppProfile`"", '--no-first-run', '--no-default-browser-check',
              '--disable-features=Translate,msEdgeSidebarV2,msHubApps,msUndersideButton,EdgeCollections',
              '--disable-pinch', '--overscroll-history-navigation=0', '--disable-background-mode')
if ($firstRun) { $edgeArgs += '--window-size=1480,940'; $edgeArgs += '--window-position=120,60' }
Start-Process -FilePath $edge -ArgumentList $edgeArgs | Out-Null

# Stay alive while the app window's browser is open (matched by its own profile folder).
Start-Sleep -Seconds 4
$marker = 'NorseImperium\app-window'
while ($true) {
  $alive = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
           Where-Object { $_.CommandLine -and $_.CommandLine.Contains($marker) }
  if (-not $alive) { break }
  Start-Sleep -Seconds 2
}

# Window closed -> stand the Imperium down (only if this launcher started it).
if (-not $alreadyUp) {
  # [w]/[i] brackets: the pattern matches the node processes but not this shell's own command line.
  & wsl.exe -e bash -lc "pkill -TERM -f '/mnt/c/Imperium/[w]arden.js'; sleep 2; pkill -TERM -f '/mnt/c/Imperium/[i]mperium-terminal.js'; true" | Out-Null
}
