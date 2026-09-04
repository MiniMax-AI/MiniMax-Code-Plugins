# Hook: Notification
# Event:  io.minimax.mcode / Notification
# State:  idle
# Note:   Fires when the runtime emits a system notification (e.g.
#         "session timed out", "rate limited"). We push idle rather
#         than working/error because a notification is a passive
#         informational event, not an agent action. The notification
#         text is surfaced in the pill so the user can read it.
. "$PSScriptRoot\_lib.ps1"
$evt = Read-HookStdin
$text = ''
if ($evt.message) { $text = [string]$evt.message }
elseif ($evt.notification) { $text = [string]$evt.notification }
if ($text.Length -gt 80) { $text = $text.Substring(0, 77) + '...' }
Push-Island -State idle -Message $text
exit 0
