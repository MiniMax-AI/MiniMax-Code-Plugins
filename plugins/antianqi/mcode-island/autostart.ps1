# mcode-island - 开机自启管理
# 用法：
#   autostart.ps1 -Enable      # 注册到 HKCU\...\Run，开机自动起
#   autostart.ps1 -Disable     # 取消
#   autostart.ps1 -Status      # 看当前状态

param(
  [ValidateSet('Enable','Disable','Status')]
  [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$entryName = 'mcode-island'
$launcher = Join-Path $PSScriptRoot 'start-island.ps1'
$command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""

switch ($Action) {
  'Enable' {
    New-Item -Path $runKey -Force | Out-Null
    Set-ItemProperty -Path $runKey -Name $entryName -Value $command
    Write-Output "ENABLED: 开机自启已注册"
    Write-Output "  Key:    $runKey\$entryName"
    Write-Output "  Value:  $command"
  }
  'Disable' {
    if (Get-ItemProperty -Path $runKey -Name $entryName -ErrorAction SilentlyContinue) {
      Remove-ItemProperty -Path $runKey -Name $entryName
      Write-Output 'DISABLED: 开机自启已取消'
    } else {
      Write-Output 'DISABLED: 本来就没注册'
    }
  }
  'Status' {
    $existing = Get-ItemProperty -Path $runKey -Name $entryName -ErrorAction SilentlyContinue
    if ($existing) {
      Write-Output 'ENABLED'
      Write-Output "  Value: $($existing.$entryName)"
    } else {
      Write-Output 'DISABLED'
    }
  }
}
