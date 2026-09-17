$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $payload -or [string]::IsNullOrWhiteSpace([string]$payload.command)) {
        throw "invalid PowerShell runner payload: command is required"
    }
    if ($null -ne $payload.stdinText) {
        throw "PowerShell shim fallback does not support backend stdin"
    }
    [string[]]$backendArgs = @()
    if ($null -ne $payload.args) {
        $backendArgs = [string[]]@($payload.args | ForEach-Object { [string]$_ })
    }
    $resolved = Get-Command -Name ([string]$payload.command) `
        -CommandType Application, ExternalScript -ErrorAction Stop
    $backendSource = $resolved.Source
    $extension = [IO.Path]::GetExtension($backendSource)
    if ($extension -ieq ".cmd" -or $extension -ieq ".bat") {
        throw ".cmd/.bat backends must use the native command-processor launcher"
    }
    $global:LASTEXITCODE = $null
    # A backend's stderr and exit semantics are data. Do not leak the runner's
    # fail-fast preference into a PowerShell backend and turn Write-Error into
    # a terminating runner exception.
    $ErrorActionPreference = $previousErrorActionPreference
    & $backendSource @backendArgs
    $scriptSucceeded = $?
    $scriptExitCode = $LASTEXITCODE
    # Reaching this point means the PowerShell script completed normally.
    # LASTEXITCODE may be stale from a native command that the script handled;
    # only use it when the script invocation itself reported failure. An
    # explicit `exit N` produces that pair, while a handled native failure
    # followed by successful script work leaves scriptSucceeded true. `throw`
    # reaches the catch below.
    if (-not $scriptSucceeded -and $null -ne $scriptExitCode) {
        exit [int]$scriptExitCode
    }
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 127
}
