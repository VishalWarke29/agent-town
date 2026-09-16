[CmdletBinding()]
param(
    [Alias('Environment')]
    [ValidateSet('demo', 'development', 'production', 'prod')]
    [string]$Mode,
    [switch]$Dev,
    [switch]$Check,
    [switch]$NoBuild,
    [switch]$Doctor,
    [string]$Backup,
    [string]$Restore,
    [string]$RestoreTo,
    [string]$GitHubClientId,
    [ValidateRange(1024, 65535)]
    [int]$Port = 4310,
    [ValidateRange(1024, 65535)]
    [int]$WebPort = 5173
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$previousNodeEnv = $env:NODE_ENV
$previousPort = $env:AGENT_TOWN_PORT
$previousWebPort = $env:AGENT_TOWN_WEB_PORT
$previousGitHubClientId = $env:AGENT_TOWN_GITHUB_CLIENT_ID
$previousAppMode = $env:AGENT_TOWN_MODE
$failed = $false

function Invoke-NpmStep {
    param([string[]]$NpmArguments)
    & npm.cmd @NpmArguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($NpmArguments -join ' ') failed (exit $LASTEXITCODE). See the output above."
    }
}

function Test-AvailablePort {
    param([int]$LocalPort)
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $LocalPort)
    try {
        $listener.Start()
    }
    catch {
        throw "Port $LocalPort is already in use. If Agent Town is running there, press Ctrl+C in its existing terminal, rerun this command, then refresh the browser. Changing -Port does not release its shared data lock; a second Agent Town instance also needs a separate AGENT_TOWN_DATA_DIR. Check http://127.0.0.1:$LocalPort if another application owns the port. No process was stopped."
    }
    finally {
        $listener.Stop()
    }
}

function Test-DependencyFilesAvailable {
    # Windows keeps loaded native modules locked even when another app instance
    # uses a different port. Check before npm ci can remove installed packages.
    $workspacePrefix = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
    $blockingProcesses = [System.Collections.Generic.List[int]]::new()
    $uninspectedProcesses = [System.Collections.Generic.List[int]]::new()
    foreach ($nodeProcess in @(Get-Process -Name node -ErrorAction SilentlyContinue)) {
        try {
            foreach ($loadedModule in $nodeProcess.Modules) {
                $modulePath = [System.IO.Path]::GetFullPath($loadedModule.FileName)
                $extension = [System.IO.Path]::GetExtension($modulePath)
                if ($modulePath.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase) -and ($extension -ieq '.node' -or $extension -ieq '.dll')) {
                    $blockingProcesses.Add($nodeProcess.Id)
                    break
                }
            }
        }
        catch {
            # A process that exited during inspection cannot retain a file lock.
            if (-not $nodeProcess.HasExited) { $uninspectedProcesses.Add($nodeProcess.Id) }
        }
        finally { $nodeProcess.Dispose() }
    }
    if ($blockingProcesses.Count -gt 0) {
        $processIds = ($blockingProcesses | Sort-Object -Unique) -join ', '
        throw "Dependency refresh is blocked: Node process IDs $processIds have native modules loaded from this Agent Town folder. Stop those owning app/test processes first, then rerun this command. Changing the port does not release their file locks. No packages were removed and no process was stopped."
    }
    if ($uninspectedProcesses.Count -gt 0) {
        $processIds = ($uninspectedProcesses | Sort-Object -Unique) -join ', '
        throw "Dependency refresh cannot safely inspect Node process IDs $processIds. Close the relevant processes from their owning Windows session, then retry. No packages were removed and no process was stopped."
    }
}

Push-Location -LiteralPath $PSScriptRoot
try {
    Write-Host ''
    Write-Host '  AGENT TOWN' -ForegroundColor Green
    Write-Host '  Local application | Economy defaults'
    Write-Host ''

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Install Node.js 24 LTS (24.14 or later in the 24.x series), then reopen PowerShell.'
    }
    $operationCount = [int][bool]$Doctor + [int][bool]$Backup + [int][bool]$Restore
    if ($operationCount -gt 1 -or ($RestoreTo -and -not $Restore) -or ($Restore -and -not $RestoreTo) -or ($operationCount -gt 0 -and $Dev)) {
        throw 'Choose one startup or recovery action: normal startup, -Dev, -Doctor, -Backup NEW_DIRECTORY, or -Restore BACKUP_DIRECTORY -RestoreTo NEW_DIRECTORY.'
    }
    if ($PSBoundParameters.ContainsKey('WebPort') -and -not $Dev) { throw '-WebPort applies only with -Dev. The built app serves its website and API together on -Port.' }
    if ($Dev -and $Port -eq $WebPort) { throw 'Development service and web ports must be different. Choose distinct -Port and -WebPort values.' }
    $env:AGENT_TOWN_PORT = [string]$Port
    if ($PSBoundParameters.ContainsKey('GitHubClientId') -and [string]::IsNullOrWhiteSpace($GitHubClientId)) {
        throw '-GitHubClientId cannot be empty. Omit the option to use the saved configuration, or pass a nonempty public Client ID.'
    }
    if ($GitHubClientId) { $env:AGENT_TOWN_GITHUB_CLIENT_ID = $GitHubClientId }
    if ($PSBoundParameters.ContainsKey('Mode')) { $env:AGENT_TOWN_MODE = $Mode }
    $modeJson = & node scripts/resolve-mode.mjs
    if ($LASTEXITCODE -ne 0) { throw 'The application mode or public configuration is invalid. See the configuration message above and check the configuration example.' }
    $resolvedMode = $modeJson | ConvertFrom-Json
    $env:AGENT_TOWN_MODE = [string]$resolvedMode.mode
    if ($Dev -and $resolvedMode.mode -eq 'production') { throw '-Dev enables hot reload and cannot be combined with production mode. Use -Mode development -Dev or omit -Dev.' }
    if (($Backup -or $Restore) -and $resolvedMode.mode -eq 'demo') { throw 'Demo mode has no private workspace backups. Select development or production for recovery operations.' }
    Write-Host "Application mode: $($resolvedMode.mode)" -ForegroundColor Cyan
    if ($resolvedMode.mode -eq 'demo') { Write-Host 'Sample data only. Real connections, repository access, and paid work are disabled.' }
    elseif ($resolvedMode.mode -eq 'production') { Write-Host 'Separate production data; loopback only. This setting does not enable hosted deployment.' }
    $githubSource = if ($PSBoundParameters.ContainsKey('GitHubClientId')) { '-GitHubClientId option' }
        elseif ($resolvedMode.githubSource -eq 'environment') { 'AGENT_TOWN_GITHUB_CLIENT_ID environment variable' }
        elseif ($resolvedMode.githubSource -eq 'configuration') { 'agent-town.config.json' }
        else { 'no public Client ID configured' }
    if ($resolvedMode.mode -eq 'demo') { Write-Host 'GitHub sign-in: disabled in demo mode. Configured IDs are not used.' }
    elseif ($resolvedMode.githubConfigured) { Write-Host "GitHub sign-in: public Client ID loaded from $githubSource. Authorization has not been tested." }
    else { Write-Host "GitHub sign-in: no usable public Client ID ($githubSource). Add githubClientId to agent-town.config.json to enable sign-in." }
    if ($resolvedMode.mode -ne 'demo') { Write-Host 'If GitHub is not configured yet, saving its public Client ID enables sign-in automatically. Changing an existing ID or application mode still requires Ctrl+C, a restart, and a browser refresh.' }
    if ($Doctor) {
        & node scripts/doctor.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Doctor found a required environment check to fix. See the sanitized results above.' }
        return
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd is missing. Repair the Node.js installation, then reopen PowerShell.' }
    $nodeVersion = [version](& node -p 'process.versions.node')
    if ($nodeVersion.Major -ne 24 -or $nodeVersion -lt [version]'24.14.0') {
        throw "Found Node $nodeVersion. This project requires Node 24.14 or newer in the 24.x series."
    }
    if ($operationCount -eq 0) { Test-AvailablePort -LocalPort $Port }
    if ($Dev) { Test-AvailablePort -LocalPort $WebPort }

    $lockHash = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash
    $stampPath = Join-Path $PSScriptRoot 'node_modules/.agent-town-lock'
    $needsInstall = -not (Test-Path -LiteralPath 'node_modules/.package-lock.json') -or -not (Test-Path -LiteralPath $stampPath)
    if ((Test-Path -LiteralPath $stampPath) -and (Get-Content -LiteralPath $stampPath -Raw).Trim() -ne $lockHash) { $needsInstall = $true }
    if ($needsInstall) {
        Test-DependencyFilesAvailable
        Write-Host 'Installing locked project dependencies...' -ForegroundColor Cyan
        # npm 11 misapplies overrides through workspace links. Use a pinned
        # project install CLI without changing the machine-wide npm version.
        Invoke-NpmStep -NpmArguments @('exec', '--yes', '--package=npm@12.0.2', '--', 'npm', 'ci')
    }
    & node scripts/check-runtime.mjs
    if ($LASTEXITCODE -ne 0) { throw 'The installed dependencies could not load. Run npm.cmd exec --yes --package=npm@12.0.2 -- npm ci in this folder, then try again.' }
    Set-Content -LiteralPath $stampPath -Value $lockHash -Encoding ascii

    if ($Check) {
        Write-Host 'Checking types and running service tests...' -ForegroundColor Cyan
        Invoke-NpmStep -NpmArguments @('run', 'check')
        Invoke-NpmStep -NpmArguments @('test')
    }

    if ($Backup -or $Restore) {
        $operationArguments = if ($Backup) { @('--backup', $Backup) } else { @('--restore', $Restore, '--to', $RestoreTo) }
        & node --import tsx apps/service/src/ops/cli.ts @operationArguments
        if ($LASTEXITCODE -ne 0) { throw 'Recovery operation did not complete. See the sanitized result above; existing data was not replaced.' }
        return
    }

    $env:AGENT_TOWN_PORT = [string]$Port
    if ($GitHubClientId) { $env:AGENT_TOWN_GITHUB_CLIENT_ID = $GitHubClientId }
    if ($Dev) {
        $env:NODE_ENV = 'development'
        $env:AGENT_TOWN_WEB_PORT = [string]$WebPort
        Write-Host "Opening the development website at http://127.0.0.1:$WebPort" -ForegroundColor Green
        Write-Host "Development API: http://127.0.0.1:$Port"
        Write-Host 'Open the address in your browser. Press Ctrl+C to stop both servers.'
        & node scripts/dev.mjs
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1073741510 -and $LASTEXITCODE -ne 130) { throw "The development servers exited with code $LASTEXITCODE." }
    }
    else {
        Write-Host 'Built application mode. Use .\run.ps1 -Dev for automatic source refresh while developing.'
        if (-not $NoBuild -or -not (Test-Path -LiteralPath 'apps/web/dist/index.html') -or -not (Test-Path -LiteralPath 'apps/service/dist/index.js')) {
            Write-Host 'Building the web app and local service...' -ForegroundColor Cyan
            Invoke-NpmStep -NpmArguments @('run', 'build')
        }
        $env:NODE_ENV = 'production'
        Write-Host "Starting http://127.0.0.1:$Port" -ForegroundColor Green
        Write-Host 'Open the address in your browser. Press Ctrl+C to stop everything.'
        & node apps/service/dist/index.js
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1073741510 -and $LASTEXITCODE -ne 130) { throw "The local service exited with code $LASTEXITCODE." }
    }
}
catch {
    $failed = $true
    Write-Host ''
    Write-Host "Agent Town could not start: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    $env:NODE_ENV = $previousNodeEnv
    $env:AGENT_TOWN_PORT = $previousPort
    $env:AGENT_TOWN_WEB_PORT = $previousWebPort
    $env:AGENT_TOWN_GITHUB_CLIENT_ID = $previousGitHubClientId
    $env:AGENT_TOWN_MODE = $previousAppMode
    Pop-Location
}
if ($failed) { exit 1 }
