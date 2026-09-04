# Hook: SessionEnd
# Event:  io.minimax.mcode / SessionEnd
# State:  idle
# Note:   Fires when the runtime terminates a session. We push idle
#         so the pill returns to a known resting color. The widget
#         itself stays alive — only its state is reset.
. "$PSScriptRoot\_lib.ps1"
Push-Island -State idle -Message "session ended"
exit 0
