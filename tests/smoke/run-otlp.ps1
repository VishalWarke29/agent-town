[CmdletBinding()]
param(
  [string]$EnvironmentDirectory,
  [string]$Output
)
$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$dataDirectory = [System.IO.Path]::GetFullPath((Join-Path $projectDirectory '.data'))
if (-not $EnvironmentDirectory) { $EnvironmentDirectory = Join-Path $dataDirectory ('otel-smoke-' + [guid]::NewGuid().ToString()) }
$environmentPath = [System.IO.Path]::GetFullPath($EnvironmentDirectory)
if (-not $environmentPath.StartsWith($dataDirectory + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Choose a fresh smoke environment beneath this project .data directory.' }
if (Test-Path -LiteralPath $environmentPath) { throw 'The smoke environment already exists. Choose a new directory; existing data is never replaced.' }
if (-not $Output) { $Output = Join-Path $environmentPath 'result.json' }
$outputPath = [System.IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $outputPath) { throw 'The output already exists. Choose a new evidence file.' }

function Invoke-SmokeCommand {
  param([string]$Executable, [string[]]$Arguments, [string]$Label)
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Label failed. Existing environments and application data were preserved." }
}

$npmExecutable = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmExecutable) { $npmExecutable = (Get-Command npm -ErrorAction Stop).Source }
$pythonExecutable = (Get-Command python -ErrorAction Stop).Source
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$rootFiles = @((Join-Path $projectDirectory 'package.json'), (Join-Path $projectDirectory 'package-lock.json'))
$before = @($rootFiles | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash })
New-Item -ItemType Directory -Path $environmentPath | Out-Null
$nodeDirectory = Join-Path $environmentPath 'node'
New-Item -ItemType Directory -Path $nodeDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'node\package.json'), (Join-Path $PSScriptRoot 'node\package-lock.json'), (Join-Path $PSScriptRoot 'node\exporter.mjs') -Destination $nodeDirectory
Push-Location $projectDirectory
try {
  Invoke-SmokeCommand $npmExecutable @('ci', '--ignore-scripts', '--no-audit', '--workspaces=false', '--prefix', $nodeDirectory) 'Isolated Node dependency installation'
  $venvDirectory = Join-Path $environmentPath 'python-venv'
  Invoke-SmokeCommand $pythonExecutable @('-m', 'venv', $venvDirectory) 'Isolated Python environment creation'
  $venvPython = Join-Path $venvDirectory 'Scripts\python.exe'
  Invoke-SmokeCommand $venvPython @('-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--only-binary=:all:', '-r', (Join-Path $PSScriptRoot 'python\requirements.txt')) 'Pinned Python dependency installation'
  Invoke-SmokeCommand $venvPython @('-m', 'pip', 'check') 'Python dependency compatibility check'
  Invoke-SmokeCommand $nodeExecutable @('--import', 'tsx', (Join-Path $PSScriptRoot 'otlp-sdk.ts'), '--environment', $environmentPath, '--output', $outputPath) 'Real Node/Python SDK smoke'
  $after = @($rootFiles | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash })
  if (($before -join ',') -ne ($after -join ',')) { throw 'Root application dependency files changed during the smoke run. Review concurrent edits; this runner never updates them.' }
  Write-Output 'Real Node and Python OTLP SDK smoke passed. Root application dependency files are unchanged.'
  Write-Output "Evidence: $outputPath"
  Write-Output "Isolated dependencies and synthetic fixture data retained for review: $environmentPath"
} finally { Pop-Location }
