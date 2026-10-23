# mcode 灵动岛 v1 - WPF + PowerShell
# 用法：右键 → 用 PowerShell 运行；或通过 start-island.ps1 启动

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 调试日志（写到 %APPDATA%\mcode-island\widget.log，上限 1MB）
#
# 2026-08-22 起这个函数一直是裸 Add-Content，头注释写的"最后 1KB 即可"
# 从来没有被实现过：38 天累积到 37MB，活跃使用时约 3.6MB/天（POLL 行）。
# 现在真的实现这个上限。
#
# 检查不每次调用都做。Add-Content 是 O(1) 追加，先用计数器累计到 1/4
# 阈值才 stat 一次文件，避免在 400ms 轮询路径上反复摸磁盘。
$script:dbg         = Join-Path $env:APPDATA 'mcode-island\widget.log'
$script:dbgMaxBytes = 1MB
$script:dbgKeepLines = 300
$script:dbgPending  = 0
function Dbg($msg) {
  $ts = (Get-Date).ToString('HH:mm:ss.fff')
  $line = "[$ts] $msg"
  Add-Content -Path $script:dbg -Value $line -Encoding UTF8
  $script:dbgPending += $line.Length + 2
  if ($script:dbgPending -ge [int]($script:dbgMaxBytes / 4)) {
    $script:dbgPending = 0
    try {
      $fi = Get-Item -LiteralPath $script:dbg -ErrorAction Stop
      if ($fi.Length -gt $script:dbgMaxBytes) {
        $keep = @(Get-Content -LiteralPath $script:dbg -Tail $script:dbgKeepLines -Encoding UTF8)
        [System.IO.File]::WriteAllLines(
          $script:dbg, $keep, (New-Object System.Text.UTF8Encoding($false)))
      }
    } catch {
      # 截断失败不能让 widget 挂掉；下一个阈值周期会再试。
    }
  }
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
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint dwFlags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFO lpmi);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_TOP = new IntPtr(0);
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint MONITOR_DEFAULTTONEAREST = 0x00000002;
  public const uint SWP_SHOWWINDOW = 0x0040;

  // True when a window owned by another process sits on top of the pill's centre
  // pixel. Menus / tooltips / tray balloons are exempt so we never fight
  // transient UI that is supposed to be above the pill anyway.
  public static bool IsPillCovered(IntPtr self) {
    RECT r;
    if (!GetWindowRect(self, out r)) return false;
    var pt = new POINT { X = (r.Left + r.Right) / 2, Y = (r.Top + r.Bottom) / 2 };
    IntPtr hit = WindowFromPoint(pt);
    if (hit == IntPtr.Zero || hit == self) return false;
    var sb = new System.Text.StringBuilder(256);
    GetClassNameW(hit, sb, 256);
    string cls = sb.ToString();
    if (cls.StartsWith("#32768")) return false;           // menu / tooltip
    if (cls == "NotifyIconTooltipWindow") return false;  // tray balloon
    if (cls == "Windows.UI.Core.CoreWindow") return false;
    uint p;
    GetWindowThreadProcessId(hit, out p);
    return p != (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
  }

  // 取窗口所在 monitor 的 work area。如果失败返回 (-1,-1)-(-1,-1) 表示无效。
  public static RECT GetWorkAreaForWindow(IntPtr hWnd) {
    var bad = new RECT { Left = -1, Top = -1, Right = -1, Bottom = -1 };
    IntPtr hMon = MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST);
    if (hMon == IntPtr.Zero) return bad;
    var mi = new MONITORINFO();
    mi.cbSize = System.Runtime.InteropServices.Marshal.SizeOf(mi);
    if (!GetMonitorInfoW(hMon, ref mi)) return bad;
    return mi.rcWork;
  }

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
  <Grid>
    <Grid.RowDefinitions>
      <!-- row 0 是药丸本体，高度在运行时按 config 的 height 设置（默认 70） -->
      <RowDefinition x:Name="PillRow" Height="70"/>
      <!-- row 1 是 session 列表，收起时高度为 0 -->
      <RowDefinition x:Name="SessionListRow" Height="0"/>
    </Grid.RowDefinitions>
  <Border x:Name="Pill" Grid.Row="0" CornerRadius="30"
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

  <!--
    session 列表。画在 pill 自己的窗口里，不另开一个 HWND：
    独立窗口方案实测过 —— 窗口能创建、能命中（WindowFromPoint 返回它），
    却不画出来（1053 个采样点里只有 39 个是面板色），被前台窗口整个盖住。
    同一个窗口就没有这个问题：置顶、合成、命中测试全都走 pill 已经
    验证过的那一套。

    代价是窗口要变高。row 0 的高度锁死为药丸高度，所以展开时药丸本身
    一动不动，列表在它下面长出来。
  -->
  <Border x:Name="SessionPanel" Grid.Row="1" Visibility="Collapsed"
          CornerRadius="12" Background="#F21A1A20" BorderBrush="#33FFFFFF"
          BorderThickness="1" Padding="10,6" Margin="0,14,0,0">
    <StackPanel x:Name="SessionRows"/>
  </Border>
  </Grid>
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
# 多 session 列表（画在 pill 自己的窗口里）
$script:sessionRowsPanel = $window.FindName('SessionPanel')
$script:sessionRows      = $window.FindName('SessionRows')
$script:sessionListRow  = $window.FindName('SessionListRow')
$script:pillHeight      = 70
$script:listHideTimer   = $null

# 状态配色
$stateMap = @{
  idle     = @{ dot='#FF6B7280'; ring='#FF6B7280'; label='mcode';             icon='' }
  thinking = @{ dot='#FFEAB308'; ring='#FFEAB308'; label='mcode · 思考中';     icon='' }
  working  = @{ dot='#FF3B82F6'; ring='#FF3B82F6'; label='mcode · 执行中';     icon='⚙' }
  waiting  = @{ dot='#FFF59E0B'; ring='#FFF59E0B'; label='mcode · 等待审批';  icon='?' }
  done     = @{ dot='#FF22C55E'; ring='#FF22C55E'; label='mcode · 已完成';     icon='✓' }
  error    = @{ dot='#FFEF4444'; ring='#FFEF4444'; label='mcode · 出错';       icon='✕' }
}

# ---------------------------------------------------------------------------
# 多 session 列表（v0.5.0）
#
# 鼠标停在灵动岛上时弹出一个列表：每个 session 一行，状态点 + 首条提问 +
# 运行中/待回复。点一行 = 消掉它（写 ack.signal，detector 收走）并把这个
# session 切过去（mcode --session <id>）。
#
# 为什么是独立窗口而不是 WPF Popup：
#   - Popup 是独立 HWND，不继承 owner 的 always-on-top。这个 pill 靠
#     Assert-Topmost 维持置顶，Popup 不在那套机制里，会被别的置顶窗口盖住。
#   - 独立窗口可以自己 Topmost=True / ShowActivated=False，接管完全在我们手里。
#   - pill 本体的 XAML 一个字都不用动 —— 它的视觉被反复调过，动它风险最大。
#
# 代价：鼠标从 pill 移到列表窗口会离开 pill（两个 HWND），所以收起有一个
# 宽限期，鼠标进列表窗口就取消。
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 多 session 列表（v0.5.0）
#
# 鼠标停在灵动岛上时，在药丸下方展开一个列表：每个 session 一行，状态点 +
# 首条提问 + 运行中/待回复。点一行 = 消掉它（写 ack.signal，detector 收走）
# 并把这个 session 切过去（mcode --session <id>）。
#
# 为什么画在 pill 自己的窗口里，而不是另开一个窗口：
#   独立窗口方案实测过 —— 窗口能创建、位置正确、能被命中
#   （WindowFromPoint 返回它），却一个像素都不画：它自己矩形里 1053 个
#   采样点只有 39 个是面板色，其余全是它背后的东西。隔离环境里同样的
#   代码却能画出来，所以问题出在 widget 的上下文里。
#   同一个窗口就没有这个问题：置顶、合成、命中测试全都走 pill 已经验证
#   过的��一套。
#
# 代价是窗口要变高。row 0 的高度锁死为药丸高度，所以展开时药丸本身一动
# 不动，列表在它下面长出来。鼠标从药丸移到列表不用离开窗口，也没有那个
# "两个窗口之间的空档"。
# ---------------------------------------------------------------------------

function Read-SessionsFile {
  $file = Join-Path $configDir 'sessions.json'
  if (!(Test-Path -LiteralPath $file)) { return @() }
  try {
    $raw = [System.IO.File]::ReadAllText($file)
    $j = $raw | ConvertFrom-Json
    return @($j.sessions)
  } catch {
    return @()
  }
}

function Clear-SessionRows {
  if (-not $script:sessionRows) { return }
  $script:sessionRows.Children.Clear()
}

# 列表里每一项的高度（含内边距和分隔线）。
#
# 两行（标题 + 摘要）加上下各 7px 的内边距，约 48px。写成一个常量，
# 是因为 Show-SessionList 要用它算窗口高度，而这里的内容一改就得重算。
# 实测校准：标题 12.5px 行高约 17 + 摘要 11px 行高约 15 + 行距 2
#           + 上下内边距 14 + 分隔线 1 = 49。留一点余量取 48。
$script:sessionRowHeight = 48

# 相对时间：近的给"多久之前"，远的给钟点。
#
# 和小红书那种消息列表一个路子：60 分钟以内说"3 分钟前"（精确到分钟就
# 够了），再早就给 HH:mm（"3 小时前"不如"13:09"精确）。
function Format-RelativeTime([int64]$tsMs) {
  if ($tsMs -le 0) { return '' }
  $diff = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $tsMs
  if ($diff -lt 0) { $diff = 0 }
  if ($diff -lt 60000) { return '刚刚' }
  if ($diff -lt 3600000) { return ([int][math]::Floor($diff / 60000)).ToString() + ' 分钟前' }
  $t = [DateTimeOffset]::FromUnixTimeMilliseconds($tsMs).ToLocalTime()
  return $t.ToString('HH:mm')
}

# 列表的一行。
#
# 布局参考小红书的展开态：左边一个状态点，中间两行字（标题 + 摘要），
# 右边时间戳。
#
# 摘要那行是它比原来多出来的东西：光看首条提问，分不清"正在跑"和"卡在
# 某个工具上"；看最后一句才知道它现在在说什么、要不要我回。
#
#   [●]  标题…………………………          3 分钟前
#        摘要…………………………          运行中
#
# 状态点跨两行、垂直居中；标题和摘要都在中间列，所以天然左对齐。
function Add-SessionRow([string]$id, [string]$title, [string]$phase, [string]$preview, [string]$lastTool, [int64]$lastAtMs, [bool]$isLast) {
  if (-not $script:sessionRows) { return }
  # 状态 -> 文案 + 颜色。
  #
  # 用的是 pill 那套状态词表（working/thinking/waiting/idle/done/error），
  # 颜色也跟着 pill 走：同一个状态在两个地方就是同一个颜色、同一句话。
  # 之前这里自己写了一套 running/waiting/stopped，于是同一个会话在 pill
  # 上显示"等用户"、在列表里显示"运行中"，pill 有的"已完成"列表里更是
  # 根本没有。
  #
  # "running" 是旧词表的值，留着当兼容：过渡期里 sessions.json 可能还是
  # 旧的。
  $stateTextMap = @{
    'working'  = @{ text = '运行中';   dot = '#FF3B82F6' }
    'thinking' = @{ text = '思考中';   dot = '#FFEAB308' }
    'waiting'  = @{ text = '等待审批'; dot = '#FFF59E0B' }
    'idle'     = @{ text = '待回复';   dot = '#FF6B7280' }
    'done'     = @{ text = '已完成';   dot = '#FF22C55E' }
    'error'    = @{ text = '出错';     dot = '#FFEF4444' }
    'stopped'  = @{ text = '已停止';   dot = '#FF4B5563' }
    'running'  = @{ text = '运行中';   dot = '#FF3B82F6' }
  }
  $stateInfo = $stateTextMap[[string]$phase]
  if (-not $stateInfo) { $stateInfo = $stateTextMap['idle'] }
  $dotHex = $stateInfo.dot
  $phaseText = $stateInfo.text

  # 第二行：正文优先。没有正文（最后一条恰好是 toolCall）就退到"正在
  # 调用的工具名"，总比空着强。
  $subText = ''
  if ($preview) { $subText = $preview }
  elseif ($lastTool) { $subText = '执行 ' + $lastTool }
  if ($subText.Length -gt 48) { $subText = $subText.Substring(0, 48) + '…' }

  $grid = New-Object System.Windows.Controls.Grid
  $grid.Cursor = [System.Windows.Input.Cursor]::Hand

  # 三列：状态点(自适应) | 文字(占满剩余) | 右侧时间(自适应)。
  #
  # 中间列必须是 * 才能被裁剪（TextTrimming 只在有有限宽度时才生效）。
  $colDot = New-Object System.Windows.Controls.ColumnDefinition
  $colDot.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Auto)
  $colTitle = New-Object System.Windows.Controls.ColumnDefinition
  $colTitle.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
  $colTag = New-Object System.Windows.Controls.ColumnDefinition
  $colTag.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Auto)
  $grid.ColumnDefinitions.Add($colDot) | Out-Null
  $grid.ColumnDefinitions.Add($colTitle) | Out-Null
  $grid.ColumnDefinitions.Add($colTag) | Out-Null

  # 两行：标题 / 摘要。
  $rowTop = New-Object System.Windows.Controls.RowDefinition
  $rowTop.Height = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Auto)
  $rowBot = New-Object System.Windows.Controls.RowDefinition
  $rowBot.Height = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Auto)
  $grid.RowDefinitions.Add($rowTop) | Out-Null
  $grid.RowDefinitions.Add($rowBot) | Out-Null

  $dot = New-Object System.Windows.Shapes.Ellipse
  $dot.Width = 7; $dot.Height = 7
  $dot.Fill = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($dotHex)))
  $dot.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
  $dot.Margin = New-Object System.Windows.Thickness(0,0,9,0)

  $txt = New-Object System.Windows.Controls.TextBlock
  $txt.Text = if ($title) { $title } else { $id }
  $txt.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#FFF5F5F7')))
  $txt.FontSize = 12.5
  $txt.TextTrimming = [System.Windows.TextTrimming]::CharacterEllipsis
  $txt.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

  $sub = New-Object System.Windows.Controls.TextBlock
  $sub.Text = $subText
  $sub.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#FF8B93A1')))
  $sub.FontSize = 11
  $sub.TextTrimming = [System.Windows.TextTrimming]::CharacterEllipsis
  $sub.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
  $sub.Margin = New-Object System.Windows.Thickness(0,2,0,0)

  # 右列：时间戳 + 状态文字，整块垂直居中于两行（和小红书那个时间戳的
  # 位置一样）。
  $right = New-Object System.Windows.Controls.StackPanel
  $right.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
  $right.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Right
  $right.Margin = New-Object System.Windows.Thickness(8,0,0,0)

  $time = New-Object System.Windows.Controls.TextBlock
  $time.Text = (Format-RelativeTime $lastAtMs)
  $time.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#FF9CA3AF')))
  $time.FontSize = 10
  $time.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Right

  $tag = New-Object System.Windows.Controls.TextBlock
  $tag.Text = $phaseText
  $tag.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($dotHex)))
  $tag.FontSize = 10
  $tag.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Right

  $right.Children.Add($time) | Out-Null
  $right.Children.Add($tag) | Out-Null

  $grid.Children.Add($dot)   | Out-Null
  $grid.Children.Add($txt)   | Out-Null
  $grid.Children.Add($right) | Out-Null
  $grid.Children.Add($sub)   | Out-Null
  [System.Windows.Controls.Grid]::SetColumn($dot, 0)
  [System.Windows.Controls.Grid]::SetColumn($txt, 1)
  [System.Windows.Controls.Grid]::SetColumn($right, 2)
  [System.Windows.Controls.Grid]::SetColumn($sub, 1)
  [System.Windows.Controls.Grid]::SetRow($dot, 0)
  [System.Windows.Controls.Grid]::SetRow($txt, 0)
  [System.Windows.Controls.Grid]::SetRow($right, 0)
  [System.Windows.Controls.Grid]::SetRow($sub, 1)
  # 状态点和右列各跨两行：状态点在整块左边居中，时间戳在整块右边居中。
  $dot.SetValue([System.Windows.Controls.Grid]::RowSpanProperty, 2)
  $right.SetValue([System.Windows.Controls.Grid]::RowSpanProperty, 2)

  # 项之间的分隔线。最后一项不带线（下面就是面板底边）。
  $border = New-Object System.Windows.Controls.Border
  $border.BorderBrush = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#1FFFFFFF')))
  $border.BorderThickness = $(if ($isLast) { New-Object System.Windows.Thickness(0) } else { New-Object System.Windows.Thickness(0,0,0,1) })
  $border.Padding = New-Object System.Windows.Thickness(0,7,0,7)
  $border.Child = $grid

  # 提示框：标题 + 摘要 + 状态 + 时间，一次说全。
  $tip = if ($title) { $title } else { $id }
  if ($subText) { $tip = $tip + "`n" + $subText }
  $rel = Format-RelativeTime $lastAtMs
  if ($rel) { $tip = $tip + "`n" + $phaseText + ' · ' + $rel } else { $tip = $tip + "`n" + $phaseText }
  $border.ToolTip = $tip

  # 点击挂在最外层的 Border 上，子元素不再挂：
  #
  # MouseLeftButtonDown 会冒泡。挂子元素时，Border + Grid + TextBlock 各挂
  # 一份就会一次点击触发多次消掉。现在只有最外层一个 handler，点整行任何
  # 位置都算点这一行。
  #
  # Handled=true 是必须的：窗口上挂了拖拽处理器（MouseLeftButtonDown），
  # 列表在同一个窗口里，不拦住的话点一行会被当成"开始拖药丸"。
  $border.Add_MouseLeftButtonDown({
    $args[1].Handled = $true
    Invoke-SessionClick $id
  }.GetNewClosure())

  $script:sessionRows.Children.Add($border) | Out-Null
}

function Show-SessionList {
  if (-not $script:sessionRows) { return }
  # 取消待收起的定时器。
  #
  # 这一步不能只放在 MouseEnter 里：展开有三个入口（MouseEnter、
  # MouseMove 兜底、手动调用），少一个就可能出现"展开后 300ms 立刻收起"
  # 的闪烁 —— 展开把窗口撑高，收起又把高度改回去，窗口反复跳。
  if ($script:listHideTimer) {
    try { $script:listHideTimer.Stop() } catch {}
    $script:listHideTimer = $null
  }
  $items = Read-SessionsFile
  if (-not $items -or $items.Count -eq 0) { Hide-SessionList; return }
  Clear-SessionRows
  # 运行中的排前面，其余按"最后一次动静"倒序。
  #
  # 排序用 lastAtMs（最后活动时间），不是 sinceMs（进列表的时间）：
  # 进列表的时间只说明"我什么时候看见它"，说明不了"它现在有多活跃"。
  #
  # 顺序：在跑的排最前，然后是等你的、再是等完了的，停了的排最后。
  $stateOrder = @{
    'working' = 0; 'thinking' = 0; 'waiting' = 1; 'idle' = 2
    'done' = 3; 'error' = 4; 'stopped' = 5; 'running' = 0
  }
  $sorted = @($items | Sort-Object @{ Expression = { $k = [string]$_.phase; if ($stateOrder.ContainsKey($k)) { $stateOrder[$k] } else { 2 } } }, @{ Expression = { if ($_.lastAtMs) { [int64]$_.lastAtMs } else { [int64]$_.sinceMs } }; Descending = $true })
  $i = 0
  foreach ($s in $sorted) {
    Add-SessionRow ([string]$s.id) ([string]$s.title) ([string]$s.phase) ([string]$s.preview) ([string]$s.lastTool) ([int64]$s.lastAtMs) ($i -lt ($sorted.Count - 1))
    $i++
  }
  # 列表高度 = 行数 * 行高 + 上下 padding；再给药丸的投影留一点余量。
  # 行高是两项（标题 + 摘要）加内边距，不是原来单行的那 24。
  $listH = ($sorted.Count * $script:sessionRowHeight) + 12
  $script:sessionRowsPanel.Visibility = [System.Windows.Visibility]::Visible
  $script:sessionListRow.Height = New-Object System.Windows.GridLength($listH)
  $window.Height = $script:pillHeight + $listH + 14
  Dbg ("session list shown: " + $sorted.Count + " winH=" + $window.Height + " listH=" + $listH)
}

function Hide-SessionList {
  if ($script:listHideTimer) {
    try { $script:listHideTimer.Stop() } catch {}
    $script:listHideTimer = $null
  }
  if ($script:sessionRowsPanel) {
    $script:sessionRowsPanel.Visibility = [System.Windows.Visibility]::Collapsed
  }
  if ($script:sessionListRow) {
    $script:sessionListRow.Height = New-Object System.Windows.GridLength(0)
  }
  if ($window) { $window.Height = $script:pillHeight }
}

# 宽限期之后才收起。鼠标从药丸移到列表会经过一段"两个窗口都不是"的地带，
# 没有宽限期列表会在鼠标到达之前就消失。
function Schedule-SessionListHide {
  if (-not $script:sessionRowsPanel) { return }
  if ($script:listHideTimer) { try { $script:listHideTimer.Stop() } catch {} }
  $script:listHideTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:listHideTimer.Interval = [TimeSpan]::FromMilliseconds(300)
  $script:listHideTimer.Add_Tick({
    try { $script:listHideTimer.Stop() } catch {}
    Hide-SessionList
  })
  $script:listHideTimer.Start()
}

# 点一行：消掉它 + 切过去。
function Invoke-SessionClick([string]$id) {
  if (-not $id) { return }
  # 消掉：写 ack.signal，detector 收走（它会从列表里删掉这一条，并且
  # 在这个 session 跑完下一轮之前不再把它收回来）。
  try {
    $ackFile = Join-Path $configDir 'ack.signal'
    [System.IO.File]::WriteAllText($ackFile, $id, [System.Text.Encoding]::UTF8)
    Dbg "session ack written: $id"
  } catch {
    Dbg "SESSION ACK FAIL: $($_.Exception.Message)"
  }
  Hide-SessionList
  Start-SessionTerminal $id
}

# 切到这个 session：mcode --session <id>
#
# 优先 Windows Terminal（wt.exe）；它不在 PATH 时退回 conhost 的 start。
# mcode 是个 .ps1 包装器，cmd 认不出来，所以两条路都经由 powershell 跑。
function Start-SessionTerminal([string]$id) {
  $inner = "mcode --session $id"
  try {
    $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
    if ($wt) {
      Start-Process -FilePath $wt.Source -ArgumentList @(
        '-w', '0', 'new-tab', '--title', 'mcode',
        'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner)
    } else {
      Start-Process -FilePath 'cmd.exe' -ArgumentList @(
        '/c', 'start', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner)
    }
    Dbg "session jumped: $id"
  } catch {
    Dbg "SESSION JUMP FAIL: $($_.Exception.Message)"
  }
}

# 工具家族配色：working 态下用 family 色盖掉 state 色，一眼分辨"在读"和"在改"。
# 只覆盖 dot/ring（视觉识别），不动 stateText 文案。
# family 名与 detector 的 $TOOL_FAMILIES 值一一对应；缺 family 时回落到 state 色。
#
# 色相分布刻意拉开：绿(shell) / 蓝(read) / 黄(write) / 紫(search) / 青(task) /
# 粉(web) / 灰蓝(plan)。plan 早先用的是 #8B5CF6，和 search 的 #A855F7 在深色
# pill 上几乎分不开，换成去饱和的灰蓝。
$familyMap = @{
  shell  = '#FF22C55E'   # bash / shell  → 绿
  read   = '#FF3B82F6'   # read         → 蓝
  write  = '#FFEAB308'   # edit / write → 黄
  search = '#FFA855F7'   # grep / glob  → 紫
  task   = '#FF06B6D4'   # task         → 青
  web    = '#FFEC4899'   # web_search/fetch → 粉
  plan   = '#FF94A3B8'   # todowrite    → 灰蓝
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

# Sub-step 渲染（"step N[/M] · detail"）：
#   Step > 0 + Total > 0   → "step 3/12 · fill username"
#   Step > 0 + Total <= 0  → "step 3 · fill username"
#   Step > 0 + Detail 空  → "step 3/12"
#   Step <= 0               → 原 Message 字段
# 这样 message 字段保持"工具名"("Bash ok"),detail 字段填具体动作,
# 渲染时拼成 "step 3/12 · Bash ok · fill username" 或者更精确的
# "step 3/12 · fill username"(detail 存在时优先覆盖 message)。
# 注意：detail 非空时**完全替换** message,避免双重信息("Bash ok · ls -la")。
function Build-DisplayMessage {
  param(
    [string]$Message,
    [int]$Step,
    [int]$Total,
    [string]$Detail
  )
  $base = if ($Message) { $Message } else { '' }
  if ($Step -le 0) { return $base }

  $stepStr = if ($Total -gt 0) { "step $Step/$Total" } else { "step $Step" }
  if ($Detail) {
    # detail 非空时优先用 detail(agent 已经表达了"我在做什么")
    return "$stepStr · $Detail"
  }
  # detail 空但 step 给出 → 只显示 step,避免重复 message 造成噪声
  return $stepStr
}

# 状态更新
# Progress 取值约定（跟 notify-island.ps1 / detector 对齐）：
#   -1     → 没有进度信息，进度条隐藏
#   0..100 → 百分比，0=空条，100=满条；超出范围会被 clamp
# Usage5h：剩余百分比（0..100）；-2 = 未提供
# Usage5hResetMs：距下次 5h 刷新的毫秒数；0 = 未知
# TodoProgress：todowrite 列表的完成百分比（0..100）；-2 = 未提供
# Step/Total/Detail：sub-step 进度（agent 自报），参 Build-DisplayMessage
#   - 优先级：显式 Progress > TodoProgress > shimmer
#   - 即：agent 直接传 progress 最高；否则如果有 todo 列表就用 todo 完成度；都没就 shimmer 动画
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
    [int]$TodoProgress = -2,
    [int]$Step = -1,
    [int]$Total = -1,
    [string]$Detail = '',
    [string]$Family = ''
  )
  $s = $script:stateMap[$State]
  if (!$s) { $s = $script:stateMap['idle'] }
  # 家族色只作用于 active 态（thinking/working/waiting），这样 done 绿 / error 红
  # 依然是"结果"语义，家族色只用来区分"在做什么"。
  $dotHex  = $s.dot
  $ringHex = $s.ring
  if ($Family -and $State -in @('thinking','working','waiting')) {
    $famHex = $script:familyMap[$Family]
    if ($famHex) { $dotHex = $famHex; $ringHex = $famHex }
  }
  $script:statusDot.Fill = C $dotHex
  $script:pulseRing.Fill = C $ringHex
  $script:stateText.Text = $s.label
  $script:messageText.Text = Build-DisplayMessage -Message $Message -Step $Step -Total $Total -Detail $Detail
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
    $script:progressFill.Background = C $dotHex
    Stop-IndeterminateShimmer
  } elseif ($isActive -and $hasTodoProgress) {
    $script:progressBar.Visibility = 'Visible'
    $script:progressFill.Visibility = 'Visible'
    $script:progressIndeterminate.Visibility = 'Collapsed'
    $script:progressScale.ScaleX = $todoClamped / 100.0
    $script:progressFill.Background = C $dotHex
    Stop-IndeterminateShimmer
  } elseif ($isActive) {
    $script:progressBar.Visibility = 'Visible'
    $script:progressFill.Visibility = 'Collapsed'
    $script:progressIndeterminate.Visibility = 'Visible'
    $script:progressShimmer.Fill = C $dotHex
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

# 解析调用方窗口（caller.json → targetHwnd / targetPid）。
# 处理三种死法：hwnd 死了 / 进程死了（fallback 到父进程 terminal）/
# hwnd 被销毁重建。返回 [PSCustomObject]@{ Hwnd; Pid; Exe } 或 $null。
function Resolve-CallerWindow {
  $callerFile = Join-Path $env:APPDATA 'mcode-island\caller.json'
  if (!(Test-Path $callerFile)) { Dbg 'RESOLVE: no caller file'; return $null }

  $hwnd = [IntPtr]::Zero
  $targetPid = 0
  $targetExe = ''
  $targetSource = ''
  try {
    $data = Get-Content $callerFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $hwnd = [IntPtr]::new([int64]$data.targetHwnd)
    $targetPid = [int]$data.targetPid
    $targetExe = if ($data.targetExe) { [string]$data.targetExe } else { '' }
    $targetSource = if ($data.source) { [string]$data.source } else { '' }
  } catch {
    Dbg "RESOLVE: caller.json parse error"
    return $null
  }
  if ($targetPid -le 0) { Dbg 'RESOLVE: no target'; return $null }

  # 1) hwnd 死了 → 重找
  if ($hwnd -ne [IntPtr]::Zero -and -not [WinAPI]::IsWindow($hwnd)) {
    Dbg "RESOLVE: hwnd $hwnd dead, re-resolving"
    $hwnd = [IntPtr]::Zero
  }

  # 2) 进程死了 → fallback 到父进程（terminal）兜底
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if (-not $proc) {
    Dbg "RESOLVE: target PID $targetPid gone, finding parent (terminal)"
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue
    if ($parent -and $parent.ParentProcessId -and $parent.ParentProcessId -gt 0) {
      $parentProc = Get-Process -Id ([int]$parent.ParentProcessId) -ErrorAction SilentlyContinue
      if ($parentProc) {
        $targetPid = $parentProc.Id
        $targetExe = $parentProc.ProcessName
        $targetSource = 'parent-fallback'
        if ($parentProc.MainWindowHandle -ne [IntPtr]::Zero) {
          $hwnd = $parentProc.MainWindowHandle
        } else {
          $hwnd = [WinAPI]::FindVisibleWindowForPid([uint32]$targetPid)
        }
        Dbg "RESOLVE: fall back to parent $($parentProc.ProcessName) PID=$targetPid hwnd=$hwnd"
      }
    }
    if ($hwnd -eq [IntPtr]::Zero) {
      Dbg 'RESOLVE: no parent fallback available'
      return $null
    }
  }

  # 3) 进程还在但 hwnd 死了（被销毁/重建）→ 找新可见窗口
  if ($hwnd -eq [IntPtr]::Zero -or -not [WinAPI]::IsWindow($hwnd)) {
    Dbg "RESOLVE: hwnd invalid, finding new visible window for PID $targetPid ($targetExe)"
    $hwnd = [WinAPI]::FindVisibleWindowForPid([uint32]$targetPid)
    if ($hwnd -eq [IntPtr]::Zero) {
      Dbg 'RESOLVE: no visible window found for target process'
      return $null
    }
    Dbg "RESOLVE: re-resolved to hwnd $hwnd"
  }

  return [PSCustomObject]@{ Hwnd = $hwnd; Pid = $targetPid; Exe = $targetExe; Source = $targetSource }
}

# ---------------------------------------------------------------------------
# Click target resolution.
#
# In the desktop app (MiniMax Inside Code / MiniMax Code / Mavis) the agent
# is hosted by the app and runs in a terminal the app opened. That terminal
# belongs to the app session, so "hide the terminal" is meaningless there:
# the agent keeps running behind a static pill. "Take me back to the app
# window" is the action that matches the intent.
#
# The click target is therefore resolved in this order:
#   1. a manual pin (pin.json) -- the user named the target explicitly, so it
#      wins. A CLI user pins their terminal and it stays the target even
#      while the desktop app is open.
#   2. the desktop app main window -- found through a process-name allowlist
#      and focused, never hidden.
#   3. the caller's terminal (caller.json) -- without the desktop app the
#      original show/hide toggle is kept.
# ---------------------------------------------------------------------------

# Process-name allowlist of the desktop app. The app is not an ancestor of
# the agent process (the agent runs in a terminal the app opened), so the
# process tree cannot be used to locate it.
$script:desktopAppNames = @('MiniMax Inside Code', 'MiniMax Code', 'Mavis')

# Read pin.json: the click target the user pinned by hand.
# pin.json is separate from caller.json -- caller.json is rewritten by the
# agent side on every state transition, so a pin stored there would not
# survive the next notify and priority 1 would be unreachable.
function Resolve-PinnedWindow {
  $pinFile = Join-Path $env:APPDATA 'mcode-island\pin.json'
  if (!(Test-Path $pinFile)) { return $null }

  $hwnd = [IntPtr]::Zero
  $targetPid = 0
  $targetExe = ''
  try {
    $data = Get-Content $pinFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $hwnd = [IntPtr]::new([int64]$data.targetHwnd)
    $targetPid = [int]$data.targetPid
    $targetExe = if ($data.targetExe) { [string]$data.targetExe } else { '' }
  } catch {
    Dbg 'PIN: pin.json parse error'
    return $null
  }
  if ($targetPid -le 0) { return $null }

  # the hwnd died (window destroyed or recreated) -> find it again by pid
  if ($hwnd -eq [IntPtr]::Zero -or -not [WinAPI]::IsWindow($hwnd)) {
    $hwnd = [WinAPI]::FindVisibleWindowForPid([uint32]$targetPid)
  }
  if ($hwnd -eq [IntPtr]::Zero) {
    Dbg "PIN: pinned PID $targetPid is gone"
    return $null
  }
  return [PSCustomObject]@{ Hwnd = $hwnd; Pid = $targetPid; Exe = $targetExe }
}

# Find the desktop app main window: a process in the same session whose name
# hits the allowlist and that owns a main window. The app is an Electron
# multi-process (main + renderer + GPU + utility); only the main process
# reports a non-zero MainWindowHandle.
function Find-DesktopAppWindow {
  $mySession = (Get-Process -Id $PID).SessionId
  $cands = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $script:desktopAppNames -contains $_.ProcessName -and $_.SessionId -eq $mySession
  })
  if ($cands.Count -eq 0) { Dbg 'APP: no desktop app process'; return $null }

  foreach ($p in $cands) {
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
      Dbg "APP: desktop app $($p.ProcessName) PID=$($p.Id) hwnd=$($p.MainWindowHandle)"
      return [PSCustomObject]@{ Hwnd = $p.MainWindowHandle; Pid = $p.Id; Exe = $p.ProcessName }
    }
  }
  # The main process reports no MainWindowHandle (some Electron builds) ->
  # enumerate the visible windows as a fallback.
  foreach ($p in $cands) {
    $h = [WinAPI]::FindVisibleWindowForPid([uint32]$p.Id)
    if ($h -ne [IntPtr]::Zero) {
      Dbg "APP: desktop app $($p.ProcessName) PID=$($p.Id) hwnd=$h (enumerated)"
      return [PSCustomObject]@{ Hwnd = $h; Pid = $p.Id; Exe = $p.ProcessName }
    }
  }
  Dbg 'APP: desktop app process has no visible window'
  return $null
}

# Which target a click prefers when both are available.
#
#   'terminal' -- the caller's terminal first. The CLI habit: one click
#                 hides it, the next brings it back.
#   'app'      -- the desktop app window first. The Marketplace build ships
#                 this one: in the desktop app the agent is hosted by the
#                 app and the terminal belongs to the app session, so hiding
#                 that terminal leaves a static pill behind.
#
# The Marketplace package is built with 'app'. The builder flips this one
# line and FAILS the build when it cannot find it, so a renamed switch can
# never silently ship the CLI behaviour to the desktop users.
$script:clickPrefers = 'terminal'

# Resolve the click target. Mode = focus (raise and activate only) /
# toggle (show / hide).
function Resolve-ClickTarget {
  # 1) the manual pin -- the user's explicit choice, it always wins
  $pin = Resolve-PinnedWindow
  if ($pin) {
    return [PSCustomObject]@{ Hwnd = $pin.Hwnd; Pid = $pin.Pid; Exe = $pin.Exe; Mode = 'focus'; Origin = 'pin' }
  }
  # 2) the preferred target, then the other one
  if ($script:clickPrefers -eq 'app') {
    $app = Find-DesktopAppWindow
    if ($app) {
      return [PSCustomObject]@{ Hwnd = $app.Hwnd; Pid = $app.Pid; Exe = $app.Exe; Mode = 'focus'; Origin = 'desktop-app' }
    }
    $caller = Resolve-CallerWindow
    if ($caller) {
      return [PSCustomObject]@{ Hwnd = $caller.Hwnd; Pid = $caller.Pid; Exe = $caller.Exe; Mode = 'toggle'; Origin = 'caller' }
    }
  } else {
    $caller = Resolve-CallerWindow
    if ($caller) {
      return [PSCustomObject]@{ Hwnd = $caller.Hwnd; Pid = $caller.Pid; Exe = $caller.Exe; Mode = 'toggle'; Origin = 'caller' }
    }
    $app = Find-DesktopAppWindow
    if ($app) {
      return [PSCustomObject]@{ Hwnd = $app.Hwnd; Pid = $app.Pid; Exe = $app.Exe; Mode = 'focus'; Origin = 'desktop-app' }
    }
  }
  return $null
}

# Raise a window to the front: show + focus, whatever its current visible
# state is. After the desktop-app adaptation both focus and toggle take a
# resolved target object; the caller decides which one it is.
function Focus-Window {
  param([Parameter(Mandatory = $true)]$Target)

  try {
    [WinAPI]::AllowSetForegroundWindow([uint32]$Target.Pid) | Out-Null
    if ([WinAPI]::IsIconic($Target.Hwnd)) {
      [WinAPI]::ShowWindow($Target.Hwnd, 9) | Out-Null   # SW_RESTORE
    } else {
      [WinAPI]::ShowWindow($Target.Hwnd, 5) | Out-Null   # SW_SHOW
    }
    # TOPMOST -> NOTOPMOST: it lets BringWindowToTop push the window all the
    # way up without leaving a "always on top" side effect behind.
    [WinAPI]::SetWindowPos($Target.Hwnd, [WinAPI]::HWND_TOPMOST, 0, 0, 0, 0, [WinAPI]::SWP_NOACTIVATE) | Out-Null
    [WinAPI]::SetWindowPos($Target.Hwnd, [IntPtr]::new(-2), 0, 0, 0, 0, [WinAPI]::SWP_NOACTIVATE) | Out-Null  # HWND_NOTOPMOST
    [WinAPI]::BringWindowToTop($Target.Hwnd) | Out-Null
    [WinAPI]::SetForegroundWindow($Target.Hwnd) | Out-Null
    Dbg ("FOCUS OK: target=" + $Target.Exe + " PID=" + $Target.Pid + " hwnd=" + $Target.Hwnd)
  } catch {
    Dbg "FOCUS FAIL: $($_.Exception.Message)"
  }
}

# 兼容旧调用点：自动聚焦流程（needs_input 状态自动弹窗那种）用调用方窗口。
function Focus-CallerWindow {
  $r = Resolve-CallerWindow
  if (-not $r) { return }
  Focus-Window $r
}

# 单击 pill toggle：可见 → 隐藏；隐藏 → 全屏还原 + 抢焦点。
# 设计取舍 (round-14+15+16):
#   hide 分支用 SW_HIDE (而不是 SW_MINIMIZE)：
#     SW_MINIMIZE 在某些终端配置下(Windows Terminal "Always show tabs on top")
#     会保留一个 thin tab-bar strip 浮在桌面顶部,不算真"藏"。
#   show 分支先 SW_MAXIMIZE (激活+最大化),再用 SetWindowPos 强制拉到
#   MonitorFromWindow+GetMonitorInfo 拿到的真实 work area(2560x1392 而
#   不是 [Screen]::PrimaryScreen 报告的 1920x1080 — WinForms DPI 虚拟化
#   会把 2560x1440 物理像素报成 1920x1080 逻辑像素,SW_MAXIMIZE 跟着
#   1920x1080 走,结果 WT 只填了物理显示器的左上 75%)。
#   最后 SetWindowPos(HWND_TOP) + BringWindowToTop 抢 z-order,绕过
#   widget PID 没有 foreground 权限的限制。
# 状态判定: IsWindowVisible 在 SW_HIDE 和 SW_MINIMIZE 后都返回 false
# (区别是 IsIconic:SW_HIDE 后 false,SW_MINIMIZE 后 true)。toggle 只看
# IsWindowVisible 即可,SW_MAXIMIZE 在内部正确处理两种 case。
function Toggle-Window {
  param([Parameter(Mandatory = $true)]$Target)

  try {
    $isShown = [WinAPI]::IsWindowVisible($Target.Hwnd)
    if ($isShown) {
      [WinAPI]::ShowWindow($Target.Hwnd, 0) | Out-Null   # SW_HIDE
      Dbg "TOGGLE: hid target=$($Target.Exe) PID=$($Target.Pid) hwnd=$($Target.Hwnd)"
    } else {
      # 1) SW_MAXIMIZE 激活+标记 maximized
      [WinAPI]::ShowWindow($Target.Hwnd, 3) | Out-Null   # SW_MAXIMIZE
      # 2) SetWindowPos 强制拉到 monitor work area (绕过 DPI/remembered-size 限制)
      $wa = [WinAPI]::GetWorkAreaForWindow($Target.Hwnd)
      if ($wa.Left -ne -1) {
        $cx = $wa.Right - $wa.Left
        $cy = $wa.Bottom - $wa.Top
        [WinAPI]::SetWindowPos($Target.Hwnd, [IntPtr]::Zero, $wa.Left, $wa.Top, $cx, $cy, [WinAPI]::SWP_NOZORDER) | Out-Null
        # The -f has to sit inside the parentheses: written as
        # `Dbg "..." -f a, b` the format operator binds to the command, not to
        # the string, and the log line keeps the raw {0} {1} placeholders.
        Dbg ("TOGGLE: forced to work area ({0},{1}) {2}x{3}" -f $wa.Left, $wa.Top, $cx, $cy)
      }
      # 3) 抢 z-order 到最前(SetWindowPos(HWND_TOP) 不需要 foreground 权限)
      #    SWP_NOSIZE：cx=0/cy=0 缺它会被 Windows 当成"resize 到 0x0"，
      #    触发 WT 的 min-size 兜底，变成 480x76 strip。
      #    SWP_NOMOVE：X=0/Y=0 缺它会把窗口真的挪到 (0,0)。单屏时无所谓，
      #    但副屏（monitor 原点非 0）上会把还原后的窗口甩到主屏左上角。
      #    同样不能加 SWP_NOZORDER——那个 flag 会让 hWndInsertAfter 被忽略，
      #    HWND_TOP 就白传了，BringWindowToTop 之后仍可能被别的窗口盖住。
      [WinAPI]::AllowSetForegroundWindow([uint32]$Target.Pid) | Out-Null
      $nofollow = [WinAPI]::SWP_NOACTIVATE -bor [WinAPI]::SWP_NOSIZE -bor [WinAPI]::SWP_NOMOVE
      [WinAPI]::SetWindowPos($Target.Hwnd, [WinAPI]::HWND_TOP, 0, 0, 0, 0, $nofollow) | Out-Null
      [WinAPI]::BringWindowToTop($Target.Hwnd) | Out-Null
      [WinAPI]::SetForegroundWindow($Target.Hwnd) | Out-Null
      Dbg "TOGGLE: shown (maximized + work-area) target=$($Target.Exe) PID=$($Target.Pid) hwnd=$($Target.Hwnd)"
    }
  } catch {
    Dbg "TOGGLE FAIL: $($_.Exception.Message)"
  }
}

# 兼容旧调用点。
function Toggle-CallerWindow {
  $r = Resolve-CallerWindow
  if (-not $r) { return }
  Toggle-Window $r
}

# The single entry point for a pill click: resolve the target, then run the
# mode it resolved to. focus (manual pin / desktop app) and toggle (the
# caller's terminal) are two different semantics -- do not mix them.
function Invoke-ClickTarget {
  $t = Resolve-ClickTarget
  if (-not $t) { Dbg 'CLICK: no target resolved'; return }
  Dbg "CLICK: target=$($t.Exe) PID=$($t.Pid) hwnd=$($t.Hwnd) mode=$($t.Mode) origin=$($t.Origin)"
  if ($t.Mode -eq 'focus') {
    Focus-Window $t
  } else {
    Toggle-Window $t
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
  # Write pin.json, not caller.json: a pin is the user's explicit choice and
  # must not be wiped by the agent-side caller.json on every transition.
  $pinFile = Join-Path $env:APPDATA 'mcode-island\pin.json'
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
  [System.IO.File]::WriteAllText($pinFile, $payload, [System.Text.Encoding]::UTF8)
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

# Keep the pill above everything else.
#
# Why this exists: the only thing that ever made the pill topmost is
# Topmost="True" in the XAML, evaluated once at window creation. Every other
# SetWindowPos in this file targets the *caller* window, not the pill. So once
# anything else lands above the pill -- a maximized terminal being activated, a
# fullscreen app, another always-on-top tool -- the pill stays buried forever.
# WS_EX_TOPMOST is a persistent style but only orders the pill against the
# topmost band; whichever topmost window was raised last wins, and a plain
# maximized window that got re-shown can end up painting over it too.
# Observed 2026-09-28: pill fully invisible behind Windows Terminal while
# IsWindowVisible=1, IsIconic=0, DWMWA_CLOAKED=0, widget still polling.
#
# Fix: hit-test the pill centre on a throttle and re-assert HWND_TOPMOST when
# something else owns that pixel. SWP_NOACTIVATE means this never steals focus
# from the user's terminal. Skipped entirely while the pill is hidden so it
# cannot undo a user-initiated hide. "mcode-island show" passes -Force because
# $window.Show() is a no-op on an already-visible WPF window and therefore
# never restored z-order on its own.
$script:lastTopmostCheck = [DateTime]::MinValue
function Assert-Topmost {
  param([switch]$Force)
  if (-not $Force -and
      [DateTime]::UtcNow - $script:lastTopmostCheck -lt [TimeSpan]::FromMilliseconds(1500)) {
    return
  }
  $script:lastTopmostCheck = [DateTime]::UtcNow
  try {
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
    $h = $helper.Handle
    if (-not $h -or -not [WinAPI]::IsWindow($h)) { return }
    # Never resurrect a pill the user hid.
    if (-not [WinAPI]::IsWindowVisible($h)) { return }
    if ($Force -or [WinAPI]::IsPillCovered($h)) {
      $flags = [WinAPI]::SWP_NOACTIVATE -bor [WinAPI]::SWP_NOMOVE -bor `
               [WinAPI]::SWP_NOSIZE -bor [WinAPI]::SWP_SHOWWINDOW
      [WinAPI]::SetWindowPos($h, [WinAPI]::HWND_TOPMOST, 0, 0, 0, 0, $flags) | Out-Null
      Dbg "TOPMOST: re-raised (forced=$([bool]$Force))"
    }
  } catch {
    Dbg "TOPMOST FAIL: $($_.Exception.Message)"
  }
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
# 药丸高度锚点。row 0 锁死成这个高度，所以展开 session 列表时窗口变高、
# 药丸本身一动不动，列表在它下面长出来。
$script:pillHeight = $window.Height
try {
  $pillRow = $window.FindName('PillRow')
  if ($pillRow) { $pillRow.Height = New-Object System.Windows.GridLength($script:pillHeight) }
} catch {}
$window.Opacity = $cfg.opacity

# 右键被禁用（用 CLI 'mcode-island pin' 替代，更稳）
$window.Add_MouseRightButtonDown({
  $null = $_.Handled
  Dbg 'RIGHT-CLICK ignored, use "mcode-island pin" in mcode terminal'
})

# 点击 vs 拖动
#
# 为什么不用 DragMove()。
#
# DragMove() 会 SendMessage(WM_SYSCOMMAND, SC_MOVE) 进入 Win32 的模态移动
# 循环。那个循环里 WPF 的渲染线程不参与合成：DWM 不再把分层窗口
# （AllowsTransparency=True 的 per-pixel alpha 表面）重新合成出来，屏幕上
# 剩下的就是那块没被绘制过的表面 —— 一块白框，尺寸正好是窗口的 320x60。
# 窗口上的 DropShadowEffect 让它更明显：效果本身是软件渲染的，模态循环
# 期间那一帧根本没画出来。
#
# 所以这里自己实现拖动：正常消息泵里改 Left/Top，WPF 每帧照常合成，
# 白框不会出现。代价是失去 DragMove() 的系统级移动手感（边缘吸附等），
# 这个 pill 用不上那些。
#
# 另一个坑：MouseMove 里的 GetPosition($window) 是相对窗口的，而窗口正在
# 跟着鼠标走，所以相对位移恒为 0，直接用它算 delta 窗口永远不动。必须拿
# 屏幕坐标（PointToScreen）做差，再按 DPI 缩放换回 Left/Top 用的 DIP。
$script:dragStart = $null
$script:didDrag = $false
$script:dragOriginLeft = 0.0
$script:dragOriginTop = 0.0
$script:dragAnchorX = 0.0
$script:dragAnchorY = 0.0
$script:pill.RenderTransform = New-Object System.Windows.Media.ScaleTransform(1, 1)
$script:pill.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.5)

# 屏幕像素 -> DIP 的换算系数。PointToScreen 给的是设备像素，Window.Left/Top
# 用的是设备无关单位，缩放不是 100% 时两者不等。
function Get-DragScale {
  $sx = 1.0
  $sy = 1.0
  try {
    $src = [System.Windows.PresentationSource]::FromVisual($window)
    if ($src -and $src.CompositionTarget) {
      $m = $src.CompositionTarget.TransformToDevice
      if ($m.M11 -gt 0) { $sx = [double]$m.M11 }
      if ($m.M22 -gt 0) { $sy = [double]$m.M22 }
    }
  } catch {}
  return @{ X = $sx; Y = $sy }
}

$window.Add_MouseLeftButtonDown({
  $script:dragStart = $_.GetPosition($window)
  $script:didDrag = $false
  $script:dragOriginLeft = $window.Left
  $script:dragOriginTop = $window.Top
  try {
    $anchor = $window.PointToScreen($script:dragStart)
    $script:dragAnchorX = $anchor.X
    $script:dragAnchorY = $anchor.Y
  } catch {
    $script:dragAnchorX = $script:dragStart.X
    $script:dragAnchorY = $script:dragStart.Y
  }
  # 抓住鼠标，否则指针一移出 320x60 的窗口 MouseMove 就不再来，拖动会"粘住"。
  try { $window.CaptureMouse() } catch {}
})
$window.Add_MouseMove({
  # 列表没开、而鼠标就在药丸上：补开一次。
  #
  # MouseEnter 只在"鼠标进入窗口"时触发。widget 恰好在光标底下启动的话
  # （启动后光标没动过），MouseEnter 永远不会来，列表就再也不会出现。
  # 拖拽中不弹（dragStart 非空）。
  if ($null -eq $script:dragStart -and $script:sessionRowsPanel -and
      $script:sessionRowsPanel.Visibility -ne [System.Windows.Visibility]::Visible) {
    try { Show-SessionList } catch { Dbg "SESSION LIST SHOW FAIL: $($_.Exception.Message)" }
  }
  if ($null -eq $script:dragStart) { return }
  # The position is read EVERY event, not only before the threshold is
  # crossed: the window is moving, so a position read during an earlier
  # event is stale relative to where the window is now.
  $cur = $_.GetPosition($window)
  # The threshold gates the START of the drag, not the movement. The
  # previous guard returned as soon as didDrag was set, so the pill
  # followed the cursor for exactly one event and then stopped --
  # measured at 14% of the cursor movement.
  if (-not $script:didDrag) {
    $dx = [Math]::Abs($cur.X - $script:dragStart.X)
    $dy = [Math]::Abs($cur.Y - $script:dragStart.Y)
    if ($dx + $dy -le 5) { return }
    $script:didDrag = $true
  }
  try {
    $now = $window.PointToScreen($cur)
    $scale = Get-DragScale
    $window.Left = $script:dragOriginLeft + (($now.X - $script:dragAnchorX) / $scale.X)
    $window.Top  = $script:dragOriginTop  + (($now.Y - $script:dragAnchorY) / $scale.Y)
  } catch {
    Dbg "DRAG FAIL: $($_.Exception.Message)"
  }
})
$window.Add_MouseLeftButtonUp({
  try { $window.ReleaseMouseCapture() } catch {}
  try {
    if ($script:dragStart -and -not $script:didDrag) {
      Dbg 'CLICK detected'
      Flash-Click
      Invoke-ClickTarget
    }
  } catch {
    Dbg "CLICK FAIL: $($_.Exception.Message)"
  }
  $script:dragStart = $null
  $script:didDrag = $false
})

# 多 session 列表的展开/收起。
#
# 鼠标停在 pill 上 -> 展开；离开 -> 宽限期后收起。列表是独立窗口，鼠标从
# pill 走到列表会经过一段"两个窗口都不在"的地带，所以要留宽限期，鼠标
# 进列表窗口就取消。
$window.Add_MouseEnter({
  if ($script:listHideTimer) { try { $script:listHideTimer.Stop() } catch {} ; $script:listHideTimer = $null }
  try { Show-SessionList } catch { Dbg "SESSION LIST SHOW FAIL: $($_.Exception.Message)" }
})
$window.Add_MouseLeave({
  Schedule-SessionListHide
})


# FileSystemWatcher 监听 status.json（轮询版本，FSW 在 WPF 应用里经常抽风）
$script:lastStatusMtime = $null
$script:lastStatusSig = $null
$showSignalFile = Join-Path $configDir 'show.signal'
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(400)
$timer.Add_Tick({
  # 0) 自愈：被别的窗口压住就重新置顶（内部 1.5s 节流）
  Assert-Topmost
  # 1) 处理 "show" 信号（"mcode-island show" 创建这个文件）
  if (Test-Path $showSignalFile) {
    try { Remove-Item $showSignalFile -Force -ErrorAction SilentlyContinue } catch {}
    $window.Dispatcher.Invoke([Action]{
      $window.Show()
      $window.WindowState = [System.Windows.WindowState]::Normal
      $window.Activate()
      Assert-Topmost -Force
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
    # step/total/detail 也要进 sig,否则连续推同 state 但不同 step 会被去重
    $prog = if ($data.PSObject.Properties['progress']) { [int]$data.progress } else { -1 }
    $usage = $null
    $resetMs = 0
    $todoP = -2
    $step = -1
    $total = -1
    $detail = ''
    if ($data.PSObject.Properties['usage5h'] -and $null -ne $data.usage5h) { $usage = [int]$data.usage5h }
    if ($data.PSObject.Properties['usage5hResetMs'] -and $null -ne $data.usage5hResetMs) { $resetMs = [int]$data.usage5hResetMs }
    if ($data.PSObject.Properties['todoProgress'] -and $null -ne $data.todoProgress) { $todoP = [int]$data.todoProgress }
    if ($data.PSObject.Properties['step'] -and $null -ne $data.step) { $step = [int]$data.step }
    if ($data.PSObject.Properties['total'] -and $null -ne $data.total) { $total = [int]$data.total }
    if ($data.PSObject.Properties['detail'] -and $null -ne $data.detail) { $detail = [string]$data.detail }
    # family 也进 sig，否则同一工具连续 working 但换了家族不会重新上色
    $family = ''
    if ($data.PSObject.Properties['family'] -and $data.family) { $family = [string]$data.family }
    $sig = "$($data.state)|$($data.message)|$family|$prog|$usage|$resetMs|$todoP|$step|$total|$detail|$($data.ts)"
    if ($sig -eq $script:lastStatusSig) { return }
    $script:lastStatusSig = $sig
    Dbg "POLL: $($data.state) :: $($data.message) family=$family step=$step/$total detail=$detail (progress=$prog usage5h=$usage resetMs=$resetMs todoProgress=$todoP)"
    Update-State -State $data.state -Message $data.message -Progress $prog -Usage5h $usage -Usage5hResetMs $resetMs -TodoProgress $todoP -Step $step -Total $total -Detail $detail -Family $family
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
    $initStep = -1
    $initTotal = -1
    $initDetail = ''
    if ($init.PSObject.Properties['usage5h'] -and $null -ne $init.usage5h) { $initUsage = [int]$init.usage5h }
    if ($init.PSObject.Properties['usage5hResetMs'] -and $null -ne $init.usage5hResetMs) { $initReset = [int]$init.usage5hResetMs }
    if ($init.PSObject.Properties['todoProgress'] -and $null -ne $init.todoProgress) { $initTodo = [int]$init.todoProgress }
    if ($init.PSObject.Properties['step'] -and $null -ne $init.step) { $initStep = [int]$init.step }
    if ($init.PSObject.Properties['total'] -and $null -ne $init.total) { $initTotal = [int]$init.total }
    if ($init.PSObject.Properties['detail'] -and $null -ne $init.detail) { $initDetail = [string]$init.detail }
    $initFamily = ''
    if ($init.PSObject.Properties['family'] -and $init.family) { $initFamily = [string]$init.family }
    $script:lastStatusSig = "$($init.state)|$($init.message)|$initFamily|$initProg|$initUsage|$initReset|$initTodo|$initStep|$initTotal|$initDetail|$($init.ts)"
    $script:lastStatusMtime = (Get-Item $statusFile).LastWriteTimeUtc.Ticks
    Update-State -State $init.state -Message $init.message -Progress $initProg -Usage5h $initUsage -Usage5hResetMs $initReset -TodoProgress $initTodo -Step $initStep -Total $initTotal -Detail $initDetail -Family $initFamily
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
  # pill 藏起来时列表也得跟着藏，否则鼠标一移开就剩一个空框在屏幕上。
  try { Hide-SessionList } catch {}
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
