# Hook: SessionStart
# Event:  io.minimax.mcode / SessionStart
# State:  idle
# Note:   Fires when the runtime starts a session. We push idle to
#         confirm the pill is alive; the widget may have been started
#         before the session was open.
. "$PSScriptRoot\_lib.ps1"
$evt = Read-HookStdin
$sid = if ($evt.session_id) { $evt.session_id.Substring(0, 8) } else { '?' }
Push-Island -State idle -Message "session $sid"
exit 0
