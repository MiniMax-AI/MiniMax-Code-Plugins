# Hook: PermissionRequest
# Event:  io.minimax.mcode / PermissionRequest
# State:  waiting
# Decision: ask
# Note:   This is a DECISION-BEARING event. Per the io.minimax.mcode
#         Hooks spec (MiniMax-Code-Plugins PR #20, section "Decision
#         semantics"), an observer Hook on PermissionRequest MUST return
#         `ask` (or no decision at all) and MUST NOT return `allow` or
#         `deny` unless the Plugin is genuinely the permission owner.
#
#         The 0.2.4 Runtime default for PermissionRequest is fail-closed
#         (`deny`), which would make a pure observer indistinguishable
#         from a denial and break the portable observe-only floor.
#         Returning `ask` opts the Hook out of fail-closed: the pill
#         surfaces the waiting state, the user still sees the TUI
#         prompt, and the runtime's Permission Core remains the
#         permission owner. The user can still approve or deny.
. "$PSScriptRoot\_lib.ps1"
$evt = Read-HookStdin
$tool = if ($evt.tool_name) { [string]$evt.tool_name } else { 'permission' }
Push-Island -State waiting -Message "$tool needs approval"
# Observer opt-in decision. Written to stdout in the shape the
# io.minimax.mcode spec defines for PermissionRequest. Exit 0 = OK.
[Console]::Out.WriteLine('{"decision":"ask","reason":"island-only observer; permission owner remains runtime Permission Core"}')
exit 0
