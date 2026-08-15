$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $projectRoot "runner\config.local.json"

if (-not (Test-Path -LiteralPath $configPath)) {
  throw "runner/config.local.json tidak ditemukan."
}

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$wslRoot = $config.wsl_project_root.TrimEnd("/")
$pythonPath = "$wslRoot/agent/.venv/bin/python"
$scriptPath = "$wslRoot/scripts/start_diagnostics.py"

& wsl.exe -d $config.wsl_distro --exec $pythonPath $scriptPath
exit $LASTEXITCODE
