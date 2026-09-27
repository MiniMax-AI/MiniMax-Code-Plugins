# Hook: PostToolUse
# Event:  io.minimax.mcode / PostToolUse
# State:  done / error
# Note:   Fires after every tool call returns. Heuristic: if the
#         tool_result is empty or matches an error pattern, push
#         error; otherwise push done. Self-push calls are filtered.
#         Per-tool summary (Format-ToolSummary) is split into
#         Message="<tool> ok|failed" and Detail=<the rest>, so the pill
#         renders "Bash ok · ls -la /tmp" instead of just "Bash ok".
. "$PSScriptRoot\_lib.ps1"
$evt = Read-HookStdin
if (Test-IsSelfPush $evt) { exit 0 }

$tool  = if ($evt.tool_name) { [string]$evt.tool_name } else { 'tool' }
$result = $evt.tool_result
$isError = $false

if ($null -eq $result) {
    $isError = $true
} else {
    $s = [string]$result
    if ([string]::IsNullOrEmpty($s)) { $isError = $true }
    elseif ($s -match '^\s*(Error|ERROR|✕|Error:|\[ERROR\])') { $isError = $true }
}

# Format-ToolSummary 抽 detail,但要剥掉 "tool : " 前缀,只留后半段
$summary = Format-ToolSummary $evt
$detail = ''
if ($summary -and $summary.StartsWith("$tool : ")) {
    $detail = $summary.Substring($tool.Length + 3)
} elseif ($summary -and $summary -ne $tool) {
    $detail = $summary
}

# Build-DisplayMessage 只在 Step > 0 时才用 detail（Step<=0 直接返回
# Message），所以只传 -Detail 的话 detail 永远不显示
#（round-19 review hetaoBackend #4）。这里给一个确定的 Step/Total，
# 渲染成 "step 1/1 · <detail>"。
# PostToolUse 是单次工具结果，不参与多步序列，所以用 1/1 而不是
# 猜一个更大的分母——猜错会让 pill 显示 "step 1/0"。
$step  = 1
$total = 1

if ($isError) {
    Push-Island -State error -Message "$tool failed" -Detail $detail -Step $step -Total $total
} else {
    Push-Island -State done -Message "$tool ok" -Detail $detail -Step $step -Total $total
}
exit 0
