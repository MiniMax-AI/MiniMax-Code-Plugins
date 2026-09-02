# mcode 灵动岛 v1 - WPF + PowerShell
# 用法：右键 → 用 PowerShell 运行；或通过 start-island.ps1 启动

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 调试日志（写到 %APPDATA%\mcode-island\widget.log，最后 1KB 即可）
$script:dbg = Join-Path $env:APPDATA 'mcode-island\widget.log'
function Dbg($msg) {
  $ts = (Get-Date).ToString('HH:mm:ss.fff')
  "[$ts] $msg" | Add-Content -Path $script:dbg -Encoding UTF8
}
Dbg "PID=$PID APART=$([System.Threading.Thread]::CurrentThread.ApartmentState)"

# WPF 必须在 STA 线程运行。如果当前不是 STA，自动重启。
if ([System.Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
  Dbg 'relaunching in STA'
  $args2 = @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath) + $args
  $psi2 = New-Object System.Diagnostics.ProcessStartInfo
  $psi2.FileName = 'powershell.exe'
  $psi2.Arguments = $args2 -join ' '
  $psi2.UseShellExecute = $false
  $psi2.CreateNoWindow = $true
  [void][System.Diagnostics.Process]::Start($psi2)
  exit
}

# 防御：万一 Start-Process 那层漏了控制台窗口，进来第一件事就藏掉。
# GetConsoleWindow() 在没有控制台时返回 0，ShowWindow 直接 no-op。
Dbg 'hiding any stray console window'
$hideSig = @'
using System;
using System.Runtime.InteropServices;
public class IslandHide {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
'@
if (-not ('IslandHide' -as [type])) { Add-Type $hideSig -ErrorAction SilentlyContinue }
$hwnd = [IslandHide]::GetConsoleWindow()
if ($hwnd -ne [IntPtr]::Zero) {
  [void][IslandHide]::ShowWindow($hwnd, 0)  # SW_HIDE
}

# 加载 WPF
Dbg 'loading WPF assemblies'
try {
  Add-Type -AssemblyName PresentationFramework
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName System.Xaml
  Dbg 'WPF loaded'
} catch {
  Dbg "WPF LOAD FAIL: $($_.Exception.Message)"
  throw
}

# P/Invoke：切回 mcode 窗口
Dbg 'loading WinAPI'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(uint dwProcessId);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public const uint SWP_NOACTIVATE = 0x0010;

  // 找 pid 的第一个可见窗口
  public static IntPtr FindVisibleWindowForPid(uint targetPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == targetPid && IsWindowVisible(h)) {
        int len = GetWindowTextLength(h);
        if (len > 0) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@ -ErrorAction SilentlyContinue
Dbg 'WinAPI loaded'

# 配置目录
$configDir = Join-Path $env:APPDATA 'mcode-island'
if (!(Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
$configFile = Join-Path $configDir 'config.json'
$statusFile = Join-Path $configDir 'status.json'
$logFile    = Join-Path $configDir 'island.log'

# 加载配置（位置等）
$defaultConfig = [PSCustomObject]@{
  x        = -1
  y        = -1
  width    = 320
  height   = 70
  opacity  = 0.95
  autostart = $false
}
if (Test-Path $configFile) {
  try { $cfg = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { $cfg = $defaultConfig }
  foreach ($p in @('x','y','width','height','opacity','autostart')) {
    if (-not (Get-Member -InputObject $cfg -Name $p -ErrorAction SilentlyContinue)) {
      Add-Member -InputObject $cfg -NotePropertyName $p -NotePropertyValue $defaultConfig.$p
    }
  }
} else {
  $cfg = $defaultConfig
  $cfg | ConvertTo-Json | Out-File -FilePath $configFile -Encoding UTF8
}

# XAML —— 灵动岛 pill
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="mcode-island" Width="320" Height="60"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        WindowStartupLocation="Manual" UseLayoutRounding="True" SnapsToDevicePixels="True"
        Focusable="False" ShowActivated="False">
  <Border x:Name="Pill" CornerRadius="30"
          Background="#CC1A1A20" BorderBrush="#33FFFFFF" BorderThickness="1"
          Padding="22,6" Margin="0">
    <Border.Effect>
      <DropShadowEffect Color="Black" Opacity="0.45" BlurRadius="22" ShadowDepth="3"/>
    </Border.Effect>
    <Grid>
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="Auto"/>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="Auto"/>
      </Grid.ColumnDefinitions>

      <Grid Grid.Column="0" Width="22" Height="22" Margin="0,0,14,0">
        <Ellipse x:Name="PulseRing" Width="22" Height="22" Fill="#FF6B7280" Opacity="0.0">
          <Ellipse.RenderTransform>
            <ScaleTransform x:Name="PulseScale" ScaleX="1" ScaleY="1"/>
          </Ellipse.RenderTransform>
          <Ellipse.RenderTransformOrigin>0.5,0.5</Ellipse.RenderTransformOrigin>
        </Ellipse>
        <Ellipse x:Name="StatusDot" Width="12" Height="12"
                 HorizontalAlignment="Center" VerticalAlignment="Center"
                 Fill="#FF6B7280"/>
      </Grid>

      <StackPanel Grid.Column="1" VerticalAlignment="Center">
        <!-- 标题行：左边 state 标签，中间 elapsed，右边 5h 用量（独立小角标）-->
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <TextBlock Grid.Column="0" x:Name="StateText" Text="mcode"
                     Foreground="#FFF5F5F7" FontSize="14" FontWeight="SemiBold"
                     TextTrimming="CharacterEllipsis" VerticalAlignment="Center"/>
          <TextBlock Grid.Column="1" x:Name="ElapsedText" Text=""
                     Foreground="#FF6B7280" FontSize="11"
                     VerticalAlignment="Center" Margin="8,0,0,0"
                     FontFamily="Consolas, Segoe UI"/>
          <!-- 5h 用量：detector 拉 minimax /v1/coding_plan/remains，-1 = 未知 -->
          <TextBlock Grid.Column="2" x:Name="Usage5hText" Text=""
                     Foreground="#FF6B7280" FontSize="11"
                     VerticalAlignment="Center" Margin="8,0,0,0"
                     FontFamily="Consolas, Segoe UI"
                     ToolTip="mmx 5h 用量（来自 coding_plan/remains）"/>
        </Grid>
        <TextBlock x:Name="MessageText" Text="等待任务"
                   Foreground="#FF9A9AA3" FontSize="11" Margin="0,1,0,0"
                   TextTrimming="CharacterEllipsis" MaxWidth="240"/>
        <!-- 进度条：默认隐藏。
             - progress=0..100：determinate，显示 ProgressFill（ScaleX 比例填充，bright cyan 高对比）
             - progress=-1 且 state 是 active：indeterminate，显示 ProgressIndeterminate（半透明满宽 cyan 光带）
             - 其他：隐藏 -->
        <Grid x:Name="ProgressBar" Height="8" Margin="0,2,0,0" Visibility="Collapsed">
          <Border Background="#44FFFFFF" CornerRadius="4"/>
          <Border x:Name="ProgressFill" Background="#FF22D3EE" CornerRadius="4"
                  HorizontalAlignment="Stretch" Visibility="Collapsed">
            <Border.RenderTransform>
              <ScaleTransform x:Name="ProgressScale" ScaleX="0" ScaleY="1"/>
            </Border.RenderTransform>
            <Border.RenderTransformOrigin>0,0.5</Border.RenderTransformOrigin>
          </Border>
          <Grid x:Name="ProgressIndeterminate" Visibility="Collapsed" ClipToBounds="True">
            <Rectangle x:Name="ProgressShimmer" Width="130" HorizontalAlignment="Left"
                       Fill="#FF22D3EE">
              <Rectangle.OpacityMask>
                <LinearGradientBrush StartPoint="0,0.5" EndPoint="1,0.5">
                  <GradientStop Color="#00000000" Offset="0"/>
                  <GradientStop Color="#FF000000" Offset="0.5"/>
                  <GradientStop Color="#00000000" Offset="1"/>
                </LinearGradientBrush>
              </Rectangle.OpacityMask>
              <Rectangle.RenderTransform>
                <TranslateTransform x:Name="ProgressShimmerTransform" X="-130"/>
              </Rectangle.RenderTransform>
            </Rectangle>
          </Grid>
        </Grid>
      </StackPanel>

      <TextBlock Grid.Column="2" x:Name="ActionIcon" Text=""
                 Foreground="#FF9A9AA3" FontSize="13" Margin="14,0,0,0"
                 VerticalAlignment="Center"/>
    </Grid>
  </Border>
</Window>
'@

# 加载 XAML
Dbg 'parsing XAML'
try {
  $reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
  $window = [Windows.Markup.XamlReader]::Load($reader)
  Dbg 'XAML loaded'
} catch {
  Dbg "XAML FAIL: $($_.Exception.Message)"
  throw
}

# 取控件
$statusDot     = $window.FindName('StatusDot')
$pulseRing     = $window.FindName('PulseRing')
$pulseScale    = $window.FindName('PulseScale')
$stateText     = $window.FindName('StateText')
$messageText   = $window.FindName('MessageText')
$actionIcon    = $window.FindName('ActionIcon')
$pill          = $window.FindName('Pill')
$progressBar          = $window.FindName('ProgressBar')
$progressFill         = $window.FindName('ProgressFill')
$progressScale        = $window.FindName('ProgressScale')
$progressIndeterminate = $window.FindName('ProgressIndeterminate')
$progressShimmer      = $window.FindName('ProgressShimmer')
$progressShimmerTransform = $window.FindName('ProgressShimmerTransform')
$elapsedText          = $window.FindName('ElapsedText')
$usage5hText          = $window.FindName('Usage5hText')

# 状态配色
$stateMap = @{
  idle     = @{ dot='#FF6B7280'; ring='#FF6B7280'; label='mcode';             icon='' }
  thinking = @{ dot='#FFEAB308'; ring='#FFEAB308'; label='mcode · 思考中';     icon='' }
  working  = @{ dot='#FF3B82F6'; ring='#FF3B82F6'; label='mcode · 执行中';     icon='⚙' }
  waiting  = @{ dot='#FFF59E0B'; ring='#FFF59E0B'; label='mcode · 等待审批';  icon='?' }
  done     = @{ dot='#FF22C55E'; ring='#FF22C55E'; label='mcode · 已完成';     icon='✓' }
  error    = @{ dot='#FFEF4444'; ring='#FFEF4444'; label='mcode · 出错';       icon='✕' }
}

# 颜色转 brush
function C($hex) { return (New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.ColorConverter]::ConvertFromString($hex))) }

# 脉冲动画
$hasPulse = $false
$storyboard = $null
function Start-Pulse {
  if ($script:hasPulse) { return }
  $script:hasPulse = $true
  $animX = New-Object System.Windows.Media.Animation.DoubleAnimation
  $animX.From = 1.0; $animX.To = 1.9
  $animX.Duration = [TimeSpan]::FromSeconds(1.0)
  $animX.AutoReverse = $true
  $animX.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  [System.Windows.Media.Animation.Storyboard]::SetTarget($animX, $script:pulseScale)
  [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($animX, (New-Object System.Windows.PropertyPath('ScaleX')))
  $animY = New-Object System.Windows.Media.Animation.DoubleAnimation
  $animY.From = 1.0; $animY.To = 1.9
  $animY.Duration = [TimeSpan]::FromSeconds(1.0)
  $animY.AutoReverse = $true
  $animY.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  [System.Windows.Media.Animation.Storyboard]::SetTarget($animY, $script:pulseScale)
  [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($animY, (New-Object System.Windows.PropertyPath('ScaleY')))

  $opacityAnim = New-Object System.Windows.Media.Animation.DoubleAnimation
  $opacityAnim.From = 0.55; $opacityAnim.To = 0.0
  $opacityAnim.Duration = [TimeSpan]::FromSeconds(1.0)
  $opacityAnim.AutoReverse = $true
  $opacityAnim.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  [System.Windows.Media.Animation.Storyboard]::SetTarget($opacityAnim, $script:pulseRing)
  [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($opacityAnim, (New-Object System.Windows.PropertyPath('Opacity')))

  $sb = New-Object System.Windows.Media.Animation.Storyboard
  $sb.Children.Add($animX) | Out-Null
  $sb.Children.Add($animY) | Out-Null
  $sb.Children.Add($opacityAnim) | Out-Null
  $script:storyboard = $sb
  $sb.Begin($window)
}
function Stop-Pulse {
  $script:hasPulse = $false
  if ($script:storyboard) { $script:storyboard.Stop($window) }
  $script:pulseScale.ScaleX = 1.0
  $script:pulseScale.ScaleY = 1.0
  $script:pulseRing.Opacity = 0.0
}

# Elapsed timer：在 active 态（thinking/working/waiting）累积计时，
# 跨 state 切换时自动重置；同 state 内 progress 推多次不重置（"已经忙了多久"的累积感）
$script:elapsedStopwatch = New-Object System.Diagnostics.Stopwatch
$script:elapsedStopwatch.Reset()  # 初始停表
$script:elapsedActive = $false
$script:elapsedLastState = $null

function Format-Elapsed([TimeSpan]$t) {
  if ($t.TotalSeconds -lt 60) {
    return ("{0}s" -f [int]$t.TotalSeconds)
  } elseif ($t.TotalMinutes -lt 60) {
    return ("{0}m {1:D2}s" -f [int]$t.TotalMinutes, $t.Seconds)
  } else {
    return ("{0}h {1:D2}m" -f [int]$t.TotalHours, $t.Minutes)
  }
}

# 5h 倒计时格式化：ms → "4h31m" / "12m"
# 注意：PowerShell 的 [int] cast 是银行家舍入，[int]2.76 → 3 会多算一小时。
# 必须用 [Math]::Floor 或 [Math]::Truncate 做真正的向下取整。
function Format-ResetMs([int]$ms) {
  if ($ms -le 0) { return '0m' }
  $totalSec = [int][Math]::Floor($ms / 1000)
  $h = [int][Math]::Floor($totalSec / 3600)
  $m = [int][Math]::Floor(($totalSec % 3600) / 60)
  if ($h -gt 0) { return ("{0}h{1:D2}m" -f $h, $m) }
  else { return ("{0}m" -f $m) }
}

$script:elapsedTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:elapsedTimer.Interval = [TimeSpan]::FromMilliseconds(500)
$script:elapsedTimer.Add_Tick({
  if (-not $script:elapsedActive) { return }
  $script:elapsedText.Text = Format-Elapsed $script:elapsedStopwatch.Elapsed
})
Dbg 'elapsed timer started (paused)'

# Indeterminate shimmer 动画：一根 130px 渐变条从左滑到右，1.5s 一圈循环
# 终点 240 = StackPanel 内宽估算（320 - 44 padding - 36 left icon - 20 right icon）
$script:shimmerStoryboard = $null
function Start-IndeterminateShimmer {
  if ($script:shimmerStoryboard) { return }  # 已经在跑就别重起
  $anim = New-Object System.Windows.Media.Animation.DoubleAnimation
  $anim.From = -130
  $anim.To = 240
  $anim.Duration = [TimeSpan]::FromSeconds(1.5)
  $anim.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  [System.Windows.Media.Animation.Storyboard]::SetTarget($anim, $script:progressShimmerTransform)
  [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($anim, (New-Object System.Windows.PropertyPath('X')))
  $sb = New-Object System.Windows.Media.Animation.Storyboard
  $sb.Children.Add($anim) | Out-Null
  $script:shimmerStoryboard = $sb
  $sb.Begin()
  Dbg 'shimmer started'
}
function Stop-IndeterminateShimmer {
  if ($script:shimmerStoryboard) {
    $script:shimmerStoryboard.Stop()
    $script:shimmerStoryboard = $null
    Dbg 'shimmer stopped'
  }
  $script:progressShimmerTransform.X = -130  # 重置到起点
}

# 状态更新
# Progress 取值约定（跟 notify-island.ps1 / detector 对齐）：
#   -1     → 没有进度信息，进度条隐藏
#   0..100 → 百分比，0=空条，100=满条；超出范围会被 clamp
# Usage5h：剩余百分比（0..100）；-2 = 未提供
# Usage5hResetMs：距下次 5h 刷新的毫秒数；0 = 未知
# TodoProgress：todowrite 列表的完成百分比（0..100）；-2 = 未提供
#   - 优先级：显式 Progress > TodoProgress > shimmer
#   - 即：agent 直接传 progress 最高；否则如果有 todo 列表就用 todo 完成度；都没就 shimmer 动画
function Update-State {
  param(
    [string]$State,
    [string]$Message,
    [int]$Progress = -1,
    [int]$Usage5h = -2,
    [int]$Usage5hResetMs = 0,
    [int]$TodoProgress = -2
  )
  $s = $script:stateMap[$State]
  if (!$s) { $s = $script:stateMap['idle'] }
  $script:statusDot.Fill = C $s.dot
  $script:pulseRing.Fill = C $s.ring
  $script:stateText.Text = $s.label
  $script:messageText.Text = if ($Message) { $Message } else { '' }
  $script:actionIcon.Text = $s.icon

  if ($State -in @('thinking','working','waiting')) { Start-Pulse } else { Stop-Pulse }

  # 剩余用量：时间 + 剩余 % 拼一起（如 "4h31m 84%"），颜色按"剩余百分比"走
  # 剩余 < 20% 红，20-50% 黄，>= 50% 灰
  $hasTime = $Usage5hResetMs -gt 0
  $hasPct  = $Usage5h -ge 0 -and $Usage5h -le 100
  if ($hasTime -or $hasPct) {
    $parts = @()
    if ($hasTime) { $parts += (Format-ResetMs $Usage5hResetMs) }
    if ($hasPct)  { $parts += ("{0}%" -f [int]$Usage5h) }
    $script:usage5hText.Text = $parts -join ' '
    $col = if ($Usage5h -ge 50) { '#FF6B7280' }       # 剩 >= 50% 灰
           elseif ($Usage5h -ge 20) { '#FFEAB308' }   # 剩 20-50% 黄
           else { '#FFEF4444' }                       # 剩 < 20% 红
    $script:usage5hText.Foreground = C $col
  } else {
    $script:usage5hText.Text = ''
    $script:usage5hText.Foreground = C '#FF6B7280'
  }

  # Elapsed timer：进入 active 启动/跨 state 重置，退出 active 停表并清空文字
  $isActive = $State -in @('thinking','working','waiting')
  if ($isActive) {
    if ($State -ne $script:elapsedLastState) {
      $script:elapsedStopwatch.Restart()
      $script:elapsedLastState = $State
    }
    $script:elapsedActive = $true
    $script:elapsedText.Text = Format-Elapsed $script:elapsedStopwatch.Elapsed
  } else {
    $script:elapsedActive = $false
    $script:elapsedStopwatch.Reset()
    $script:elapsedLastState = $State
    $script:elapsedText.Text = ''
  }

  # 进度条：四分支（按优先级）
  #   - active + 显式 progress 0..100       → determinate 用 Progress
  #   - active + todoProgress 0..100         → determinate 用 TodoProgress
  #   - active + 都没有                       → indeterminate shimmer
  #   - 非 active                            → 隐藏
  $clamped = [Math]::Max(0, [Math]::Min(100, $Progress))
  $todoClamped = [Math]::Max(0, [Math]::Min(100, $TodoProgress))
  $isActive = $State -in @('thinking','working','waiting')
  $explicitProgress = ($Progress -ge 0 -and $Progress -le 100)
  $hasTodoProgress  = ($TodoProgress -ge 0 -and $TodoProgress -le 100)
  if ($isActive -and $explicitProgress) {
    $script:progressBar.Visibility = 'Visible'
    $script:progressFill.Visibility = 'Visible'
    $script:progressIndeterminate.Visibility = 'Collapsed'
    $script:progressScale.ScaleX = $clamped / 100.0
    $script:progressFill.Background = C $s.dot
    Stop-IndeterminateShimmer
  } elseif ($isActive -and $hasTodoProgress) {
    $script:progressBar.Visibility = 'Visible'
    $script:progressFill.Visibility = 'Visible'
    $script:progressIndeterminate.Visibility = 'Collapsed'
    $script:progressScale.ScaleX = $todoClamped / 100.0
    $script:progressFill.Background = C $s.dot
    Stop-IndeterminateShimmer
  } elseif ($isActive) {
    $script:progressBar.Visibility = 'Visible'
    $script:progressFill.Visibility = 'Collapsed'
    $script:progressIndeterminate.Visibility = 'Visible'
    $script:progressShimmer.Fill = C $s.dot
    $script:progressScale.ScaleX = 0
    Start-IndeterminateShimmer
  } else {
    $script:progressBar.Visibility = 'Collapsed'
    $script:progressFill.Visibility = 'Collapsed'
    $script:progressIndeterminate.Visibility = 'Collapsed'
    $script:progressScale.ScaleX = 0
    Stop-IndeterminateShimmer
  }

  # 写入 log
  $ts = (Get-Date).ToString('HH:mm:ss')
  $progTag = if ($Progress -ge 0) { " [$Progress%]" } else { '' }
  "[$ts] $State :: $Message$progTag" | Add-Content -Path $script:logFile -Encoding UTF8
}

# 切回调用方窗口（点击 pill 时调用）
function Focus-CallerWindow {
  $callerFile = Join-Path $env:APPDATA 'mcode-island\caller.json'
  if (!(Test-Path $callerFile)) { Dbg 'FOCUS: no caller file'; return }

  $hwnd = [IntPtr]::Zero
  $targetPid = 0
  $targetExe = ''
  try {
    $data = Get-Content $callerFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $hwnd = [IntPtr]::new([int64]$data.targetHwnd)
    $targetPid = [int]$data.targetPid
    $targetExe = if ($data.targetExe) { [string]$data.targetExe } else { '' }
  } catch {
    Dbg "FOCUS: caller.json parse error"
    return
  }
  if ($targetPid -le 0) { Dbg 'FOCUS: no target'; return }

  # 1) 检查 hwnd 是否还活着
  if ($hwnd -ne [IntPtr]::Zero -and -not [WinAPI]::IsWindow($hwnd)) {
    Dbg "FOCUS: hwnd $hwnd dead, re-resolving"
    $hwnd = [IntPtr]::Zero
  }

  # 2) 进程死了 → 找它的父进程（terminal）兜底
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if (-not $proc) {
    Dbg "FOCUS: target PID $targetPid gone, finding parent (terminal)"
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue
    if ($parent -and $parent.ParentProcessId -and $parent.ParentProcessId -gt 0) {
      $parentProc = Get-Process -Id ([int]$parent.ParentProcessId) -ErrorAction SilentlyContinue
      if ($parentProc) {
        $targetPid = $parentProc.Id
        $targetExe = $parentProc.ProcessName
        # 优先用 MainWindowHandle，失败就用第一个可见窗口
        if ($parentProc.MainWindowHandle -ne [IntPtr]::Zero) {
          $hwnd = $parentProc.MainWindowHandle
        } else {
          $hwnd = [WinAPI]::FindVisibleWindowForPid([uint32]$targetPid)
        }
        Dbg "FOCUS: fall back to parent $($parentProc.ProcessName) PID=$targetPid hwnd=$hwnd"
      }
    }
    if ($hwnd -eq [IntPtr]::Zero) {
      Dbg 'FOCUS: no parent fallback available'
      return
    }
  }
  # 3) 进程还在但 hwnd 死了（被销毁/重建）→ 找进程的第一个可见窗口
  if ($hwnd -eq [IntPtr]::Zero -or -not [WinAPI]::IsWindow($hwnd)) {
    Dbg "FOCUS: hwnd invalid, finding new visible window for PID $targetPid ($targetExe)"
    $hwnd = [WinAPI]::FindVisibleWindowForPid([uint32]$targetPid)
    if ($hwnd -eq [IntPtr]::Zero) {
      Dbg 'FOCUS: no visible window found for target process'
      return
    }
    Dbg "FOCUS: re-resolved to hwnd $hwnd"
  }

  try {
    # 1) 授权目标进程可以切前台（modern Windows 强制）
    [WinAPI]::AllowSetForegroundWindow([uint32]$targetPid) | Out-Null
    # 2) 最小化就还原
    if ([WinAPI]::IsIconic($hwnd)) {
      [WinAPI]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
    }
    # 3) 设顶
    [WinAPI]::SetWindowPos($hwnd, [WinAPI]::HWND_TOPMOST, 0, 0, 0, 0, [WinAPI]::SWP_NOACTIVATE) | Out-Null
    [WinAPI]::SetWindowPos($hwnd, [IntPtr]::new(-2), 0, 0, 0, 0, [WinAPI]::SWP_NOACTIVATE) | Out-Null  # HWND_NOTOPMOST
    # 4) 抢焦点
    [WinAPI]::BringWindowToTop($hwnd) | Out-Null
    [WinAPI]::SetForegroundWindow($hwnd) | Out-Null
    $proc2 = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    Dbg ("FOCUS OK: target=" + $proc2.ProcessName + " PID=" + $targetPid + " hwnd=" + $hwnd)
  } catch {
    Dbg "FOCUS FAIL: $($_.Exception.Message)"
  }
}

# 手动设置焦点目标（右键菜单调用）：把当前前台窗口记为 focus target
function Set-FocusTarget-Current {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FG2 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@ -ErrorAction SilentlyContinue
  $hwnd = [FG2]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { Dbg 'PIN: no foreground'; return }
  $ownerPid = 0
  [FG2]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid) | Out-Null
  $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if (-not $proc) { Dbg 'PIN: target process gone'; return }
  $myPid = [int](Get-Process -Id $PID).Id
  $mySession = (Get-Process -Id $myPid).SessionId
  $callerFile = Join-Path $env:APPDATA 'mcode-island\caller.json'
  $payload = [PSCustomObject]@{
    callerPid = $myPid
    callerSession = $mySession
    targetPid = $proc.Id
    targetHwnd = [int64]$hwnd
    targetTitle = $proc.MainWindowTitle
    targetExe = $proc.ProcessName
    source = 'manual-pin'
    ts = (Get-Date).ToString('o')
  } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($callerFile, $payload, [System.Text.Encoding]::UTF8)
  Dbg ("PIN: target=" + $proc.ProcessName + " PID=" + $proc.Id + " hwnd=" + $hwnd)
}

# 点击高亮（scale 1.0 -> 0.95 -> 1.0）
function Flash-Click {
  $sb = New-Object System.Windows.Media.Animation.Storyboard
  $sx = New-Object System.Windows.Media.Animation.DoubleAnimation
  $sx.From = 1.0; $sx.To = 0.95; $sx.Duration = [TimeSpan]::FromMilliseconds(80)
  $sx.AutoReverse = $true
  [System.Windows.Media.Animation.Storyboard]::SetTarget($sx, $script:pill)
  [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($sx, (New-Object System.Windows.PropertyPath '(UIElement.RenderTransform).(ScaleTransform.ScaleX)'))
  # 用 transient transform
  $sy = New-Object System.Windows.Media.Animation.DoubleAnimation
  $sy.From = 1.0; $sy.To = 0.95; $sy.Duration = [TimeSpan]::FromMilliseconds(80)
  $sy.AutoReverse = $true
  [System.Windows.Media.Animation.Storyboard]::SetTarget($sy, $script:pill)
  [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($sy, (New-Object System.Windows.PropertyPath '(UIElement.RenderTransform).(ScaleTransform.ScaleY)'))
  $sb.Children.Add($sx) | Out-Null
  $sb.Children.Add($sy) | Out-Null
  $sb.Begin($window)
}

# 窗口定位
$screen = [System.Windows.SystemParameters]::WorkArea
if ($cfg.x -lt 0) {
  $window.Left = [Math]::Floor(($screen.Width - $cfg.width) / 2) + $screen.Left
  $window.Top  = $screen.Top + 14
} else {
  $window.Left = $cfg.x
  $window.Top  = $cfg.y
}
$window.Width  = $cfg.width
$window.Height = $cfg.height
$window.Opacity = $cfg.opacity

# 右键被禁用（用 CLI 'mcode-island pin' 替代，更稳）
$window.Add_MouseRightButtonDown({
  $null = $_.Handled
  Dbg 'RIGHT-CLICK ignored, use "mcode-island pin" in mcode terminal'
})

# 点击 vs 拖动
$script:dragStart = $null
$script:didDrag = $false
$script:pill.RenderTransform = New-Object System.Windows.Media.ScaleTransform(1, 1)
$script:pill.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.5)
$window.Add_MouseLeftButtonDown({
  $script:dragStart = $_.GetPosition($window)
  $script:didDrag = $false
})
$window.Add_MouseMove({
  if ($script:dragStart -and -not $script:didDrag) {
    $cur = $_.GetPosition($window)
    $dx = [Math]::Abs($cur.X - $script:dragStart.X)
    $dy = [Math]::Abs($cur.Y - $script:dragStart.Y)
    if ($dx + $dy -gt 5) {
      $script:didDrag = $true
      try { $window.DragMove() } catch {}
    }
  }
})
$window.Add_MouseLeftButtonUp({
  try {
    if ($script:dragStart -and -not $script:didDrag) {
      Dbg 'CLICK detected'
      Flash-Click
      Focus-CallerWindow
    }
  } catch {
    Dbg "CLICK FAIL: $($_.Exception.Message)"
  }
  $script:dragStart = $null
  $script:didDrag = $false
})


# FileSystemWatcher 监听 status.json（轮询版本，FSW 在 WPF 应用里经常抽风）
$script:lastStatusMtime = $null
$script:lastStatusSig = $null
$showSignalFile = Join-Path $configDir 'show.signal'
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(400)
$timer.Add_Tick({
  # 1) 处理 "show" 信号（"mcode-island show" 创建这个文件）
  if (Test-Path $showSignalFile) {
    try { Remove-Item $showSignalFile -Force -ErrorAction SilentlyContinue } catch {}
    $window.Dispatcher.Invoke([Action]{
      $window.Show()
      $window.WindowState = [System.Windows.WindowState]::Normal
      $window.Activate()
      Dbg 'SHOWN via signal file'
    })
  }
  # 2) 处理 status.json
  if (!(Test-Path $statusFile)) { return }
  try {
    $fi = Get-Item $statusFile
    $mtime = $fi.LastWriteTimeUtc.Ticks
    if ($mtime -eq $script:lastStatusMtime) { return }
    $script:lastStatusMtime = $mtime
    $data = Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
    # progress 也要进 sig，否则 agent 连续推 working+相同 message+不同 progress 会被去重
    $prog = if ($data.PSObject.Properties['progress']) { [int]$data.progress } else { -1 }
    $usage = $null
    $resetMs = 0
    $todoP = -2
    if ($data.PSObject.Properties['usage5h'] -and $null -ne $data.usage5h) { $usage = [int]$data.usage5h }
    if ($data.PSObject.Properties['usage5hResetMs'] -and $null -ne $data.usage5hResetMs) { $resetMs = [int]$data.usage5hResetMs }
    if ($data.PSObject.Properties['todoProgress'] -and $null -ne $data.todoProgress) { $todoP = [int]$data.todoProgress }
    $sig = "$($data.state)|$($data.message)|$prog|$usage|$resetMs|$todoP|$($data.ts)"
    if ($sig -eq $script:lastStatusSig) { return }
    $script:lastStatusSig = $sig
    Dbg "POLL: $($data.state) :: $($data.message) (progress=$prog usage5h=$usage resetMs=$resetMs todoProgress=$todoP)"
    Update-State -State $data.state -Message $data.message -Progress $prog -Usage5h $usage -Usage5hResetMs $resetMs -TodoProgress $todoP
  } catch {
    Dbg "POLL ERR: $($_.Exception.Message)"
  }
})
$timer.Start()
$script:elapsedTimer.Start()
Dbg 'poll timer + elapsed timer started'

# 启动时读一次 status.json（如果存在）
if (Test-Path $statusFile) {
  try {
    $init = Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $initProg = if ($init.PSObject.Properties['progress']) { [int]$init.progress } else { -1 }
    $initUsage = $null
    $initReset = 0
    $initTodo = -2
    if ($init.PSObject.Properties['usage5h'] -and $null -ne $init.usage5h) { $initUsage = [int]$init.usage5h }
    if ($init.PSObject.Properties['usage5hResetMs'] -and $null -ne $init.usage5hResetMs) { $initReset = [int]$init.usage5hResetMs }
    if ($init.PSObject.Properties['todoProgress'] -and $null -ne $init.todoProgress) { $initTodo = [int]$init.todoProgress }
    $script:lastStatusSig = "$($init.state)|$($init.message)|$initProg|$initUsage|$initReset|$initTodo|$($init.ts)"
    $script:lastStatusMtime = (Get-Item $statusFile).LastWriteTimeUtc.Ticks
    Update-State -State $init.state -Message $init.message -Progress $initProg -Usage5h $initUsage -Usage5hResetMs $initReset -TodoProgress $initTodo
  } catch {}
} else {
  Update-State -State 'idle' -Message ''
}
Dbg 'initial state set'


# 关闭事件：保存位置 + 隐藏窗口（不真关进程）
$script:realQuit = $false
$window.Add_Closing({
  $args[1].Cancel = $true
  Dbg 'Closing event -> hide'
  try {
    $cur = Get-Content $script:configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $cur.x = $window.Left
    $cur.y = $window.Top
    $cur | ConvertTo-Json | Out-File -Path $script:configFile -Encoding UTF8
  } catch {}
  $window.Hide()
})
# 用 Application.Run 启动消息循环（同时支持 Show + Hide + 重新 Show）
Dbg 'starting Application.Run'
$app = New-Object System.Windows.Application
$app.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown   # 别自己关
$app.Run($window) | Out-Null
Dbg 'Application.Run returned'

# 保持进程运行：Application.Run 在 pump 消息，窗口 hide 不会让 Run 返回
# 真退出时由 mcode-island stop 强杀进程，或显式调 app.Shutdown()

Dbg 'realQuit set, exiting'
