<#
.SYNOPSIS
Install Websidian + the websidian Hermes plugin into a native Hermes profile on Windows.

.DESCRIPTION
The Windows twin of install-local.sh. It copies the Websidian runtime into app_dir, runs
`npm ci --omit=dev` with app_dir as the npm prefix (so node_modules lands there and not in the
caller's folder), copies the plugin into the profile's plugins folder, checks the layout, and
starts the installed server once against a throw-away vault to confirm /_health answers.

It does NOT edit config.yaml, enable the plugin, or restart the dashboard or the gateway. The
commands for that are printed at the end so you choose when to take the interruption.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File integrations\hermes\websidian\deploy\install-local.ps1
#>
[CmdletBinding()]
param(
  [string]$HermesHome,             # default: $env:HERMES_HOME, else ~\.hermes, else %LOCALAPPDATA%\hermes
  [string]$AppDir,                 # default: <HermesHome>\plugin-data\websidian\app
  [string]$PluginDir,              # default: <HermesHome>\plugins\websidian
  [string]$NodeExe = 'node',
  [switch]$NoSmoke,
  [switch]$RestartRuntime,        # stop the supervised Websidian process so the supervisor starts the new code
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
Set-Location $repo
if (-not (Test-Path (Join-Path $repo 'src\server.js'))) {
  throw "src\server.js not found next to this script (is this the Websidian checkout?)"
}

if (-not $HermesHome) {
  $HermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME }
    elseif (Test-Path (Join-Path $env:USERPROFILE '.hermes')) { Join-Path $env:USERPROFILE '.hermes' }
    elseif ($env:LOCALAPPDATA -and (Test-Path (Join-Path $env:LOCALAPPDATA 'hermes'))) { Join-Path $env:LOCALAPPDATA 'hermes' }
    else { Join-Path $env:USERPROFILE '.hermes' }
}
if (-not $AppDir)    { $AppDir    = Join-Path $HermesHome 'plugin-data\websidian\app' }
if (-not $PluginDir) { $PluginDir = Join-Path $HermesHome 'plugins\websidian' }

if (-not (Get-Command $NodeExe -ErrorAction SilentlyContinue)) {
  throw "node not found on PATH (Node 20 or later is required)."
}
$nodeVersion = (& $NodeExe -v).Trim()
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) {
  throw "Node $nodeVersion is too old: Websidian needs Node 20 or later."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm not found on PATH." }

Write-Host "Repository : $repo"
Write-Host "Hermes home: $HermesHome"
Write-Host "App dir    : $AppDir"
Write-Host "Plugin dir : $PluginDir"
Write-Host "Node       : $nodeVersion"
if ($DryRun) { Write-Host ""; Write-Host "-DryRun: nothing was changed."; exit 0 }
if (-not (Test-Path $HermesHome)) {
  throw "Hermes home $HermesHome does not exist. Run Hermes once, or pass -HermesHome."
}

Write-Host ""
Write-Host "==> Copying the Websidian runtime into $AppDir"
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
# Replace the code directories so files deleted upstream do not linger; keep cache\ and anything else.
foreach ($d in 'src', 'public') {
  $target = Join-Path $AppDir $d
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Copy-Item -Recurse (Join-Path $repo $d) $target
}
Copy-Item (Join-Path $repo 'package.json') $AppDir -Force
Copy-Item (Join-Path $repo 'package-lock.json') $AppDir -Force

Write-Host "==> Installing runtime dependencies in $AppDir (npm ci --omit=dev)"
# --prefix is what puts node_modules in app_dir rather than in the caller's working directory.
& npm --prefix $AppDir ci --omit=dev --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "npm ci failed in $AppDir" }

# The plugin (Python) and the runtime (Node) are separate copies: stamp both so half an upgrade is visible
# in the dashboard's status instead of showing up as odd behaviour.
$rev = (& git -C $repo rev-parse --short HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $rev) { $rev = 'unknown' }
elseif (& git -C $repo status --porcelain --untracked-files=no 2>$null) { $rev = "$rev-dirty" }
$stamp = @{ revision = "$rev".Trim(); installed_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); source = $repo }
function Write-Stamp($path, $component) {
  Set-Content -Path $path -Value (($stamp + @{ component = $component }) | ConvertTo-Json)
}
Write-Stamp (Join-Path $AppDir 'websidian.version') 'runtime'

Write-Host "==> Copying the plugin into $PluginDir"
$src = Join-Path $repo 'integrations\hermes\websidian'
if (Test-Path $PluginDir) { Remove-Item -Recurse -Force $PluginDir }
New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
Copy-Item -Recurse (Join-Path $src '*') $PluginDir
foreach ($junk in 'tests', '__pycache__', 'deploy') {
  # Copy first, then drop the folders the runtime does not need (at any depth).
  Get-ChildItem -Path $PluginDir -Recurse -Force -Directory -Filter $junk |
    Sort-Object { $_.FullName.Length } -Descending | Remove-Item -Recurse -Force
}

Write-Stamp (Join-Path $PluginDir 'websidian.version') 'plugin'

Write-Host "==> Checking the installed layout"
$fail = $false
$checks = @(
  (Join-Path $AppDir 'src\server.js'),
  (Join-Path $AppDir 'package.json'),
  (Join-Path $AppDir 'node_modules'),
  (Join-Path $AppDir 'websidian.version'),
  (Join-Path $PluginDir 'plugin.yaml'),
  (Join-Path $PluginDir 'websidian.version'),
  (Join-Path $PluginDir 'dashboard\manifest.json'),
  (Join-Path $PluginDir 'dashboard\plugin_api.py')
)
foreach ($c in $checks) {
  if (Test-Path $c) { Write-Host "    ok  $c" } else { Write-Host "    MISSING  $c"; $fail = $true }
}
if ($fail) { throw "Installation is incomplete." }
Write-Host "    revision $($stamp.revision)"

if (-not $NoSmoke) {
  Write-Host "==> Smoke test: starting the installed Websidian on a throw-away vault"
  $smoke = Join-Path ([System.IO.Path]::GetTempPath()) ("websidian-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path (Join-Path $smoke 'vault') | Out-Null
  Set-Content -Path (Join-Path $smoke 'vault\Hello.md') -Value "# Hello`r`n`r`nInstalled."
  $port = Get-Random -Minimum 18000 -Maximum 20000
  $json = Join-Path $smoke 'config.json'
  $cfg = @{
    port = $port; host = '127.0.0.1'; cacheDir = (Join-Path $smoke 'cache'); warm = $false
    sites = @(@{ slug = 'smoke'; title = 'Smoke'; root = (Join-Path $smoke 'vault'); untrusted = $true })
  }
  Set-Content -Path $json -Value ($cfg | ConvertTo-Json -Depth 5)
  $log = Join-Path $smoke 'server.log'
  $env:WEBSIDIAN_CONFIG = $json
  $proc = Start-Process -FilePath $NodeExe -ArgumentList (Join-Path $AppDir 'src\server.js') `
    -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  Remove-Item Env:\WEBSIDIAN_CONFIG
  $body = $null
  foreach ($i in 1..40) {
    try { $body = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/_health" -TimeoutSec 2).Content; break }
    catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  if ($body) {
    Write-Host "    ok  GET /_health -> $body"
    Remove-Item -Recurse -Force $smoke -ErrorAction SilentlyContinue
  } else {
    Write-Host "    FAILED: /_health did not answer. Server log:"
    Get-Content $log, "$log.err" -ErrorAction SilentlyContinue | Select-Object -First 40 | Write-Host
    throw "Smoke test failed (logs kept in $smoke)."
  }
}

$pidFile = Join-Path $HermesHome 'plugin-data\websidian\server.pid'
$restarted = 'no'
if ($RestartRuntime) {
  Write-Host "==> Restarting the supervised Websidian process (that process only)"
  $running = if (Test-Path $pidFile) { (Get-Content $pidFile -Raw).Trim() } else { '' }
  if (-not $running) {
    Write-Host "    no ${pidFile}: nothing is running, and the dashboard starts the new code when it needs it"
  } else {
    # A stale PID file can name an unrelated process; never stop one we cannot identify.
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$running" -ErrorAction SilentlyContinue).CommandLine
    if ($cmd -and $cmd -match 'server\.js') {
      Stop-Process -Id ([int]$running) -Force -ErrorAction SilentlyContinue
      Write-Host "    stopped $running; the dashboard's supervisor starts the new code within ~15 s"
      $restarted = 'yes'
    } else {
      Write-Host "    PID $running is not a Websidian process (stale $pidFile): left alone"
    }
  }
}

$appJson = $AppDir -replace '\\', '/'
$homeJson = $env:USERPROFILE -replace '\\', '/'
Write-Host @"

Done. Nothing was enabled and config.yaml was not touched. The dashboard and the gateway were not restarted.

Next steps (yours to run, in this order):

  1. Enable the plugin. Decline the "replace built-in tools" prompt: this plugin works through hooks and
     its own websidian_links tool and does not need --allow-tool-override.
       hermes plugins enable websidian
       hermes plugins list --plain          # expect: websidian ... enabled

  2. Point it at your vaults and the dashboard tab (JSON literals; only these keys are written):
       hermes config set plugins.entries.websidian.settings.dashboard '{"port": 8095, "app_dir": "$appJson", "node": "node", "public_base": "http://localhost:9119"}'
       hermes config set plugins.entries.websidian.settings.link_style dashboard
       hermes config set plugins.entries.websidian.settings.vaults '[{"path": "$homeJson/Documents/Obsidian Vault", "slug": "brain", "title": "Second Brain"}]'
     Vaults are untrusted unless you set "untrusted": false, which you should not for anything an agent
     writes to. Browser editing is off unless you add "edit": true to a vault — and then every signed-in
     dashboard user can rewrite it, so turn it on only for a vault you chose deliberately.

  3. Restart what holds the old code in memory. Enabled is not the same as active, and copying files
     updates nothing that is already running:
       - the supervised Websidian process, for changes under src/ or public/ (-RestartRuntime does this
         for you; restarted now: $restarted);
       - the dashboard, for dashboard/*.py or dist/ — its plugin routes mount only at start-up;
       - the gateway, for the write guard, links, /brain and the skill.
       hermes dashboard --status
     Then open http://localhost:9119/websidian.

  4. Check it in the browser, signed in. The tab's routes live under /api/plugins/, behind the dashboard's
     auth gate: an ungated local dashboard shows /websidian and still answers 401 there. Both of these must
     load through your session:
       /api/plugins/websidian/status
       /api/plugins/websidian/w/<slug>/
     If they 401, put the dashboard in its gated mode (basic auth on a LAN/VPN, OAuth if it faces the
     internet). Never weaken or remove dashboard authentication to make the tab work.

Files it generates: $HermesHome\plugin-data\websidian\{websidian.config.json,secrets.json,server.log,server.pid,cache\}
"@
