param(
    [string]$Action = "setup"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$Runtime = $env:MAGPIE_BUN
if (-not $Runtime) {
    $BunRoots = @(
        "$env:USERPROFILE\Desktop\data\cache\bun",
        $(if ($env:XDG_CACHE_HOME) { Join-Path $env:XDG_CACHE_HOME "magpie\bun" }),
        "$env:USERPROFILE\.cache\magpie\bun",
        "$env:LOCALAPPDATA\magpie\bun",
        "$env:APPDATA\magpie\bun"
    )
    $BestVer = $null
    foreach ($Root in $BunRoots) {
        if (-not $Root -or -not (Test-Path $Root)) { continue }
        Get-ChildItem -Path $Root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $Exe = Join-Path $_.FullName "magpie-bun.exe"
            if (Test-Path $Exe) {
                try {
                    $Ver = [version]($_.Name -replace '[^0-9.].*$', '')
                    if (-not $BestVer -or $Ver -gt $BestVer) {
                        $BestVer = $Ver
                        $Runtime = $Exe
                    }
                } catch {
                    if (-not $Runtime) { $Runtime = $Exe }
                }
            }
        }
        if ($Runtime) { break }
    }
}

if (-not $Runtime) {
    $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($NodeCmd) {
        $Runtime = $NodeCmd.Source
    }
}

if (-not $Runtime) {
    Write-Error "Cannot find runtime (Node.js or Magpie Bun)."
    exit 1
}

$InstallJs = Join-Path $ScriptDir "install.js"
& $Runtime $InstallJs $Action
