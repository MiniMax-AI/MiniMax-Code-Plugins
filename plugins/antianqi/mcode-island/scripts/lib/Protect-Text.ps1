# scripts/lib/Protect-Text.ps1
#
# Redacts secret-shaped substrings from text that is about to be persisted
# or displayed. Exposes one function:
#
#     Protect-SecretText  [-Text] <string>
#
# Returns the text with credential-shaped runs replaced by "<redacted>".
# Returns $null for $null/empty input so callers can pass through blindly.
#
# # Why this exists
#
# Tool input reaches three sinks:
#
#   1. status.json   -- polled by the widget every 400 ms
#   2. island.log    -- append-only, was never size-capped
#   3. the pill      -- always-on-top, so a screen share or a screenshot
#                       captures it
#
# The Computer Use branch of Format-ToolSummary was redacted in round-19 #1
# because keystrokes can be passwords. The Bash branch was not: a command
# like `curl -H "Authorization: Bearer eyJ..."` or
# `export OPENAI_API_KEY=sk-...` was written to all three sinks verbatim,
# and the append-only log kept it indefinitely.
#
# # Why this is a lib and not a helper inside _lib.ps1
#
# There are two independent producers of that text:
#
#   1. the hook path  -- io.minimax.mcode/hooks/scripts/_lib.ps1
#   2. the detector   -- mcode-status-detect.ps1, which re-derives
#                        messages from mcode's own session log rather than
#                        from a hook event
#
# A helper wired into only one of them is a silent half-fix: the pill looks
# clean while the detector keeps writing the raw text to disk. Both
# dot-source this file. scripts/smoke.mjs check 9 asserts BOTH consumers
# actually invoke the function, not merely that it is defined.
#
# # Scope, deliberately
#
# This redacts credential-shaped runs, not whole commands. The command text
# on the pill is a documented feature (`Bash : npm test`), and the pill is
# the reason the plugin exists -- blanking every command would trade a real
# capability for a marginal privacy gain. What is not a feature is a bearer
# token sitting in a log for the next ten years, so that is what goes.
#
# This is a best-effort filter, not a DLP boundary. It is deliberately
# conservative: patterns require an unambiguous credential marker, so a
# false negative leaves the surrounding command readable rather than
# destroying useful signal.

function Protect-SecretText {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Text
    )

    if ([string]::IsNullOrEmpty($Text)) { return $Text }

    $out = $Text

    # 1. JSON Web Tokens. Run before the generic key=value pass, which
    #    would otherwise chew the `token=` half of a JWT query string and
    #    leave the payload segment readable.
    $out = $out -replace '\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{6,}(?:\.[A-Za-z0-9_\-]{6,})?', '<redacted-jwt>'

    # 2. Authorization headers. Covers both the hyphenated header name and
    #    the RFC 6750 `Bearer` scheme, which is how the plugin's own 5h
    #    call authenticates.
    $out = $out -replace '(?i)(authorization\s*[:=]\s*)["'']?\s*bearer\s+\S+', '$1Bearer <redacted>'
    $out = $out -replace '(?i)\bbearer\s+[A-Za-z0-9._\-+/=]{12,}', 'Bearer <redacted>'

    # 3. Vendor-prefixed API keys (sk-..., sk-ant-..., ghp_..., xoxb-...).
    #    The length floor keeps ordinary prose containing "sk-" intact.
    $out = $out -replace '\b(sk|sk-ant|ghp|gho|xoxb|xoxp)[-_][A-Za-z0-9_\-]{8,}', '$1-<redacted>'

    # 4. Credential-shaped assignments, in the two forms that actually show
    #    up in tool input. The quoted-key (JSON) form is listed first: in
    #    `{"token":"..."}` the closing quote sits between the key and the
    #    colon, so a bare `key=value` pattern cannot reach it at all.
    $secretKeyName = 'password|passwd|pwd|token|api[_-]?key|apikey|secret|access[_-]?key|client[_-]?secret|auth'

    # 4a. JSON: "token": "value"  (prefix tolerated: "x-auth-token", "my_secret")
    $out = $out -replace ('(?i)("[\w.-]*(?:' + $secretKeyName + ')"\s*:\s*)"[^"]*"'), '$1"<redacted>"'
    $out = $out -replace ('(?i)("[\w.-]*(?:' + $secretKeyName + ')"\s*:\s*)''[^'']*'''), '$1''<redacted>'''

    # 4b. Bare: token=value, password = value, secret:value. The value may
    #     be quoted, so each form gets its own pass to avoid a bare-value
    #     match swallowing a JSON object that follows.
    $out = $out -replace ('(?i)\b(' + $secretKeyName + ')\b(\s*[:=]\s*)"[^"]*"'), '$1$2"<redacted>"'
    $out = $out -replace ('(?i)\b(' + $secretKeyName + ')\b(\s*[:=]\s*)''[^'']*'''), '$1$2''<redacted>'''
    $out = $out -replace ('(?i)\b(' + $secretKeyName + ')\b(\s*[:=]\s*)[^\s,;)\]}]+'), '$1$2<redacted>'

    # 5. Long CLI flag forms, where the secret is the following token
    #    rather than an `=value` pair.
    $out = $out -replace '(?i)(--password|--passwd|--token|--api[-_]?key|--secret|--access[-_]?key|--client[-_]?secret)(\s+)\S+', '$1$2<redacted>'

    return $out
}
