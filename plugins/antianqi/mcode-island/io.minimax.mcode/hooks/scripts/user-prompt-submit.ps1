# Hook: UserPromptSubmit
# Event:  io.minimax.mcode / UserPromptSubmit
# State:  thinking
# Note:   Fires right after the user presses Enter on a new turn,
#         before the agent starts reasoning. Pushing thinking here
#         avoids the gap where the pill would otherwise sit in idle
#         (yellow pulse = "I heard you, working on it").
. "$PSScriptRoot\_lib.ps1"
Push-Island -State thinking -Message "reasoning"
exit 0
