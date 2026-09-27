# mcode-island: shared library for io.minimax.mcode Hooks scripts.
# Loaded via dot-source at the top of each event script:
#     . "$PSScriptRoot\_lib.ps1"
# All event scripts under this directory MUST exit 0 (or 2 with a stderr
# reason) — never throw, never block the agent loop on a notification push.

$ErrorActionPreference = 'Stop'

# Resolve the plugin root and the canonical IPC helper. The hook scripts
# live at <plugin>/io.minimax.mcode/hooks/scripts/<event>.ps1, so
# $PSScriptRoot\..\..\.. is the plugin root.
$script:PluginRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$script:NotifyIsland = Join-Path $script:PluginRoot 'notify-island.ps1'

function Set-ConsoleUtf8 {
    # Force UTF-8 so the PowerShell child that mcode spawns reads the
    # stdin JSON cleanly. notify-island.ps1 also does this internally,
    # but doing it here avoids any risk of mojibake in our own logs.
    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $OutputEncoding = [System.Text.Encoding]::UTF8
    } catch {}
}

function Read-HookStdin {
    # mcode delivers the hook event as a JSON object on stdin.
    # Some events arrive with empty stdin (notably SessionEnd on
    # hard-terminate); in that case return $null and let the caller
    # decide what to do.
    try {
        $raw = [Console]::In.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        return $null
    }
}

function Push-Island {
    # Thin wrapper over the canonical IPC. Never throws.
    param(
        [Parameter(Mandatory)]
        [ValidateSet('idle','thinking','working','waiting','done','error')]
        [string]$State,

        [string]$Message = '',
        [int]$Step = -1,
        [int]$Total = -1,
        [string]$Detail = ''
    )
    if (-not (Test-Path -LiteralPath $script:NotifyIsland)) {
        # Widget is not installed yet — silent no-op. The plugin's
        # CLI still has to be runnable on machines where the widget
        # was not started.
        return
    }
    try {
        & $script:NotifyIsland -State $State -Message $Message -Step $Step -Total $Total -Detail $Detail 2>$null | Out-Null
    } catch {
        # Hook must never block the agent on a notification failure.
    }
}

function Test-IsSelfPush {
    # The hook for Pre/PostToolUse fires for every Bash invocation,
    # including the agent's own notify-island.ps1 / wrap-tool.ps1
    # pushes. Pushing `working: bash: notify-island.ps1` immediately
    # followed by the agent's own push of `error: ...` would be
    # misleading on the pill. Filter our own internal calls.
    param($Event)
    if ($null -eq $Event) { return $false }
    if ($Event.tool_name -ne 'Bash') { return $false }

    $cmd = ''
    if ($Event.tool_input) {
        if ($Event.tool_input.command) { $cmd = [string]$Event.tool_input.command }
        elseif ($Event.tool_input.cmd)   { $cmd = [string]$Event.tool_input.cmd }
    }
    if ([string]::IsNullOrEmpty($cmd)) { return $false }

    return ($cmd -match 'notify-island\.ps1|wrap-tool\.ps1|island\\notify|island\\wrap')
}

function Format-ToolSummary {
    # Compact "<ToolName>: <short input summary>" used in pill messages.
    # Truncated to keep the WPF label single-line.
    param($Event)
    $tool = if ($Event.tool_name) { [string]$Event.tool_name } else { 'tool' }
    $detail = ''

    if ($Event.tool_input) {
        switch ($tool) {
            'Bash'          { $detail = [string]$Event.tool_input.command }
            'Read'          { $detail = [string]$Event.tool_input.file_path }
            'Write'         { $detail = [string]$Event.tool_input.file_path }
            'Edit'          { $detail = [string]$Event.tool_input.file_path }
            'Glob'          { $detail = [string]$Event.tool_input.pattern }
            'Grep'          { $detail = [string]$Event.tool_input.pattern }
            'WebFetch'      { $detail = [string]$Event.tool_input.url }
            'WebSearch'     { $detail = [string]$Event.tool_input.query }
            'Task'          { $detail = [string]$Event.tool_input.description }
            'NotebookEdit'  { $detail = [string]$Event.tool_input.notebook_path }
            # mcode-internal: Computer Use 抽 action + coordinate。
            # 例: "mcode-computer-use : click at (1024,768)"
            # 注意：coordinate 是 array,PowerShell 默认 $OFS=' ' 会让
            # "$coord" 渲染成 "(1024 768)" 不是 "(1024,768)"。必须
            # 显式 -join ','。' ' 在 pill 上看起来像数字被截断,
            # 影响用户判断坐标。
            #
            # SECURITY: `tool_input.text` is whatever the user typed. It
            # reaches this function verbatim, and its output is written to
            # status.json, the append-only island.log, and rendered on an
            # always-on-top pill. That surface is shared-screen visible, so
            # any password / token / verification code typed through Computer
            # Use ends up in a screenshot, a screen share, or a screen
            # recording. Never echo the raw text. Report the action and a
            # length only, so the pill still answers "is the agent typing?"
            # without carrying the secret.
            'mcode-computer-use' {
                $act = if ($Event.tool_input.action) { [string]$Event.tool_input.action } else { '' }
                if ($Event.tool_input.coordinate) {
                    $coord = $Event.tool_input.coordinate
                    $coordStr = "($($coord -join ','))"
                    $detail = "$act at $coordStr"
                } elseif ($Event.tool_input.text) {
                    # Length only. No substring, no length bucketing that
                    # could leak content shape, no echo of the value.
                    $len = ([string]$Event.tool_input.text).Length
                    $detail = "$act <$len chars, redacted>"
                } else {
                    $detail = $act
                }
            }
            default         { $detail = '' }
        }
    }
    if ([string]::IsNullOrEmpty($detail)) { return $tool }
    # Collapse newlines, take first 80 chars.
    $detail = ($detail -replace "[\r\n]+", ' ').Trim()
    if ($detail.Length -gt 80) { $detail = $detail.Substring(0, 77) + '...' }
    return "$tool : $detail"
}

Set-ConsoleUtf8
