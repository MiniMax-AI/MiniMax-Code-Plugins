# mcode-island - 开机自启管理
# 用法：
#   autostart.ps1 -Enable      # 注册 widget + detector 两个 Run 项，开机自动起
#   autostart.ps1 -Disable     # 取消全部
#   autostart.ps1 -Status      # 看当前状态
#
# 设计：以前只注册 widget（start-island.ps1），detector 不会自启——结果用户开机后
# widget 卡在最后一次推送的状态上，得手动跑 detect-on。修成两条独立的 Run key：
#   HKCU\...\Run\mcode-island          → start-island.ps1
#   HKCU\...\Run\mcode-island-detect   → start-detect-island.ps1
# 两条相互独立，可以单独禁用其中之一（比如有人只想用 widget 不想用 detector）。

param(
  [ValidateSet('Enable','Disable','Status')]
  [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

# 用 ordered hashtable 固定顺序：先 detector 再 widget（Windows 实际不保证顺序，但人读起来顺眼）
$entries = [ordered]@{
  'mcode-island-detect' = (Join-Path $PSScriptRoot 'start-detect-island.ps1')
  'mcode-island'        = (Join-Path $PSScriptRoot 'start-island.ps1')
}

function Build-Command([string]$Launcher) {
  return "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`""
}

switch ($Action) {
  'Enable' {
    # 只在 Run 键不存在时创建它。
    #
    # 之前这里是无条件 New-Item -Path $runKey -Force：对一个已经存在的
    # HKCU\...\Run 键，-Force 会重建这个键，于是把用户注册在它下面的
    # 其它开机自启项（Everything / OneDrive / 各种代理客户端 …）一起清掉。
    # 现在只在键缺失时创建，并且用 New-ItemProperty 只写自己的那一个值，
    # 绝不碰同键下的其它值。
    if (-not (Test-Path $runKey)) {
      New-Item -Path $runKey -Force | Out-Null
    }

    # 记录同键下的其它值，写完再核对一遍，确保一个都没少。
    $othersBefore = @((Get-Item -Path $runKey -ErrorAction SilentlyContinue).GetValueNames() |
      Where-Object { $entries.Keys -notcontains $_ })

    foreach ($name in $entries.Keys) {
      $cmd = Build-Command $entries[$name]
      # -Force 只影响这一个具名值：不存在则建，存在则覆盖。
      New-ItemProperty -Path $runKey -Name $name -Value $cmd -PropertyType String -Force | Out-Null
      Write-Output "ENABLED: $runKey\$name"
      Write-Output "  Value: $cmd"
    }

    $othersAfter = @((Get-Item -Path $runKey -ErrorAction SilentlyContinue).GetValueNames() |
      Where-Object { $entries.Keys -notcontains $_ })
    $lost = @($othersBefore | Where-Object { $othersAfter -notcontains $_ })
    if ($lost.Count -gt 0) {
      Write-Output "ERROR: unrelated Run entries disappeared: $($lost -join ', ')"
      exit 1
    }
    if ($othersAfter.Count -gt 0) {
      Write-Output "  (kept $($othersAfter.Count) unrelated Run entr(y|ies))"
    }
  }
  'Disable' {
    $any = $false
    foreach ($name in $entries.Keys) {
      if (Get-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $runKey -Name $name
        Write-Output "DISABLED: $name"
        $any = $true
      }
    }
    if (-not $any) { Write-Output 'DISABLED: 本来就没注册' }
  }
  'Status' {
    $any = $false
    foreach ($name in $entries.Keys) {
      $existing = Get-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue
      if ($existing) {
        Write-Output "ENABLED: $name"
        Write-Output "  Value: $($existing.$name)"
        $any = $true
      } else {
        Write-Output "DISABLED: $name"
      }
    }
    if (-not $any) { Write-Output '' ; Write-Output '(no mcode-island entries registered)' }
  }
}
