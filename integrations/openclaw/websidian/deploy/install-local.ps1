<#
.SYNOPSIS
Install Websidian + the websidian OpenClaw plugin into a native OpenClaw state dir on Windows.

.DESCRIPTION
Copies the Websidian runtime (src, public, package.json, package-lock.json) to <state dir>\plugin-data\websidian\app,
runs `npm ci --omit=dev` inside it, copies the plugin to <state dir>\plugin-data\websidian\plugin, stamps both with
the git revision and boots the runtime once on a throw-away vault to check /_health. It does NOT edit openclaw.json,
register the plugin or restart the Gateway: those commands are printed at the end.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File integrations\openclaw\websidian\deploy\install-local.ps1
#>
param(
  [string]$StateDir = $env:OPENCLAW_STATE_DIR,
  [string]$AppDir = "",
  [string]$PluginDir = "",
  [switch]$NoSmoke,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
if (-not (Test-Path (Join-Path $Repo "src\server.js"))) { throw "src\server.js not found (is this the Websidian checkout?)" }
if (-not $StateDir) { $StateDir = Join-Path $env:USERPROFILE ".openclaw" }
if (-not $AppDir) { $AppDir = Join-Path $StateDir "plugin-data\websidian\app" }
if (-not $PluginDir) { $PluginDir = Join-Path $StateDir "plugin-data\websidian\plugin" }
$Node = if ($env:NODE) { $env:NODE } else { "node" }
if (-not (Get-Command $Node -ErrorAction SilentlyContinue)) { throw "node not found on PATH" }
$Revision = try { (git -C $Repo rev-parse --short HEAD 2>$null) } catch { "unknown" }
if (-not $Revision) { $Revision = "unknown" }
$Now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
function Stamp($component) { @{ revision = $Revision; installed_at = $Now; source = $Repo; component = $component } | ConvertTo-Json -Compress }
function Run([scriptblock]$Action, [string]$Describe) { if ($DryRun) { Write-Host "+ $Describe" } else { & $Action } }

Write-Host "Websidian checkout: $Repo ($Revision)"
Write-Host "State dir:          $StateDir"
Write-Host "Runtime (app_dir):  $AppDir"
Write-Host "Plugin:             $PluginDir"

Run { New-Item -ItemType Directory -Force $AppDir | Out-Null } "mkdir $AppDir"
foreach ($entry in @("src", "public")) { Run { if (Test-Path (Join-Path $AppDir $entry)) { Remove-Item -Recurse -Force (Join-Path $AppDir $entry) } } "rm $AppDir\$entry" }
foreach ($entry in @("src", "public", "package.json", "package-lock.json")) { Run { Copy-Item -Recurse -Force (Join-Path $Repo $entry) (Join-Path $AppDir $entry) } "copy $entry" }
Run { npm --prefix $AppDir ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm ci failed" } } "npm --prefix $AppDir ci --omit=dev"
Run { Set-Content -Path (Join-Path $AppDir "websidian.version") -Value (Stamp "runtime") } "write $AppDir\websidian.version"

Run { if (Test-Path $PluginDir) { Remove-Item -Recurse -Force $PluginDir } } "rm $PluginDir"
Run { New-Item -ItemType Directory -Force (Split-Path $PluginDir) | Out-Null; Copy-Item -Recurse -Force (Join-Path $Repo "integrations\openclaw\websidian") $PluginDir } "copy plugin"
foreach ($drop in @("test", "deploy")) { Run { if (Test-Path (Join-Path $PluginDir $drop)) { Remove-Item -Recurse -Force (Join-Path $PluginDir $drop) } } "rm $PluginDir\$drop" }
Run { Set-Content -Path (Join-Path $PluginDir "websidian.version") -Value (Stamp "plugin") } "write $PluginDir\websidian.version"

if (-not $NoSmoke -and -not $DryRun) {
  $Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("websidian-smoke-" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Force (Join-Path $Tmp "vault") | Out-Null
  Set-Content -Path (Join-Path $Tmp "vault\Smoke.md") -Value "# Smoke"
  $Port = 18500 + (Get-Random -Maximum 400)
  $cfg = @{ host = "127.0.0.1"; port = $Port; warm = $false; cacheDir = (Join-Path $Tmp "cache"); sites = @(@{ slug = "smoke"; root = (Join-Path $Tmp "vault"); untrusted = $true }) } | ConvertTo-Json -Depth 5
  Set-Content -Path (Join-Path $Tmp "config.json") -Value $cfg
  $env:WEBSIDIAN_CONFIG = Join-Path $Tmp "config.json"
  $proc = Start-Process -FilePath $Node -ArgumentList (Join-Path $AppDir "src\server.js") -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Tmp "out.log") -RedirectStandardError (Join-Path $Tmp "err.log")
  $ok = $false
  for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
    Start-Sleep -Milliseconds 500
    try { $h = Invoke-RestMethod "http://127.0.0.1:$Port/_health" -TimeoutSec 2; if ($h.ok) { $ok = $true } } catch {}
  }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  if ($ok) { Write-Host "Smoke test: /_health answered from $AppDir" } else { Get-Content (Join-Path $Tmp "err.log"); Remove-Item -Recurse -Force $Tmp; throw "Smoke test FAILED" }
  Remove-Item -Recurse -Force $Tmp
}

Write-Host ""
Write-Host "Installed. Now, when you are ready for the interruption:"
Write-Host ""
Write-Host "  openclaw plugins install --link `"$PluginDir`""
Write-Host "  # configure plugins.entries.websidian.config.vaults in openclaw.json (see README.md)"
Write-Host "  openclaw gateway restart"
Write-Host ""
Write-Host "Then open http://127.0.0.1:18789/plugins/websidian/ and sign in with the Gateway token."
