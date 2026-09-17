# Hook: PreToolUse
# Event:  io.minimax.mcode / PreToolUse
# State:  working
# Note:   Fires before every tool call. We push working with a short
#         tool-name + input summary. Self-push calls (the agent's
#         own notify-island / wrap-tool invocations through Bash) are
#         filtered to avoid recursive state churn.
. "$PSScriptRoot\_lib.ps1"
$evt = Read-HookStdin
if (Test-IsSelfPush $evt) { exit 0 }
Push-Island -State working -Message (Format-ToolSummary $evt)
exit 0
