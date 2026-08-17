# No param block: with -File, every token after the script path lands in
# $args as a literal string, so dashes, quotes, parentheses, and percent
# signs survive verbatim.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
$Command = $args[0]
[string[]]$rest = @($args | Select-Object -Skip 1)
if ([string]::IsNullOrWhiteSpace($Command)) {
    [Console]::Error.WriteLine("backend command is missing")
    exit 127
}

try {
    $resolved = Get-Command -Name $Command -CommandType Application, ExternalScript -ErrorAction Stop
    $global:LASTEXITCODE = $null
    & $resolved.Source @rest
    $succeeded = $?
    $nativeExitCode = $LASTEXITCODE
    if ($null -ne $nativeExitCode) { exit [int]$nativeExitCode }
    if (-not $succeeded) { exit 1 }
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 127
}
