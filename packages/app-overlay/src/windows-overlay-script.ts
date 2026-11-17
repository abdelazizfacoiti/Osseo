/*
 * The Windows overlay process: one Windows PowerShell 5.1 process (STA) that hosts a WPF window per card and
 * speaks the same JSON-line protocol as the GTK renderer (hello, show, update, dismiss, clear, emergency_hide,
 * state, events, close). It exits when its stdin closes, so the cards go with the server.
 *
 * The script is PowerShell only. The Win32 calls (the mouse hook, window styles, the dock's app bar) come from
 * NATIVE_PS in @agenthost/os-windows, which emits them in memory: nothing is compiled and no DLL is written, so it
 * runs where an antivirus or policy blocks run-time compiled assemblies.
 *
 * Control buttons act only on a real mouse press. A low-level mouse hook records whether each left-button event came
 * from the hardware or was injected (SendInput, mouse_event). WPF's preview events tell us which button the event
 * reached, so a press is real only if the same button saw a real press and a real release. Keyboard activation,
 * touch, UI Automation's Invoke and the agent's own clicks never pass that check.
 *
 * The text must not contain a backtick or the characters dollar-brace (it is embedded in a template literal).
 * Checked on Windows 11 with scriptswindows-overlay-smoke.mjs (cards and the guard) and
 * scriptswindows-dock-smoke.mjs (the dock strip).
 */

import { NATIVE_PS } from "@agenthost/os-windows";

const POWERSHELL_HEAD = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml
Add-Type -AssemblyName System.Web.Extensions
`;

const RENDERER_PS = String.raw`
# ---- Renderer: JSON-line protocol, cards, dock, press guard -------------------------------------------------------
# Same protocol and behaviour as the C# renderer it replaces. Protocol strings are compared case-sensitively (-ceq):
# the rendererToken check is security-relevant.

$script:Version = 1
$script:MaxBytes = 262144
$script:MaxCards = 12
$script:CardWidth = 340.0
$script:Margin = 16.0
$script:Gap = 8.0
$script:OffscreenPosition = -20000.0
# The dock: the same numbers as the Linux renderer (CARD_MARGIN, dock_layout), in WPF units.
$script:DockMargin = 24.0
$script:DockMinWidth = 160.0
$script:DockMaxCard = 420.0
$script:DockMinTimeline = 96.0
$script:DockMinBottom = 64.0
$script:DockBottomShare = 0.45
$script:DockReleaseMs = 2000
$script:TimelinePrefix = 'agenthost-timeline-'
$script:Commands = @('hello', 'capabilities', 'show', 'update', 'dismiss', 'clear', 'emergency_hide', 'state', 'events', 'close')
$script:Placements = @('top_left', 'top_center', 'top_right', 'bottom_left', 'bottom_center', 'bottom_right')
$script:Limitations = @(
  'Primitives such as rings, pointers, highlights and pills are not drawn.',
  'Cards are placed on the primary display only.',
  'Buttons act only on a real mouse press. Keyboard, touch, UI Automation and injected input are refused.',
  'Cards without buttons pass clicks through.',
  'The rail layout is not drawn on Windows: its cards float over the work area.'
)

$script:Cards = New-Object 'System.Collections.Generic.Dictionary[string,object]'
$script:Order = New-Object System.Collections.ArrayList
$script:Events = New-Object System.Collections.ArrayList
$script:Json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$script:Json.MaxJsonLength = $script:MaxBytes * 4
$script:InputQueue = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue))
$script:Token = $null
$script:SessionId = 'unknown'
$script:RendererEpoch = 0
$script:Sequence = 0
$script:EmergencyHidden = $false
$script:GuardReady = $false
$script:LayoutMode = 'ambient'
$script:DockSide = 'right'
$script:DockPercent = 18
$script:DockReserve = $true
$script:DockOwner = $null
$script:DockPanel = $null
$script:DockRegistered = $false
$script:DockCallback = [uint32]0
$script:DockRect = @{ Left = 0.0; Top = 0.0; Width = 0.0; Height = 0.0 }
$script:DockRelease = $null
$script:Hook = [IntPtr]::Zero
$script:HookProc = $null
$script:LastDownReal = $false
$script:LastUpReal = $false
$script:Pump = $null
$script:ReaderShell = $null
$script:ReaderSpace = $null

# APPBARDATA is built in unmanaged memory: the field offsets depend on the pointer size.
if ([IntPtr]::Size -eq 8) {
  $script:AbHwnd = 8
  $script:AbCallback = 16
  $script:AbEdge = 20
  $script:AbRect = 24
  $script:AbSize = 48
} else {
  $script:AbHwnd = 4
  $script:AbCallback = 8
  $script:AbEdge = 12
  $script:AbRect = 16
  $script:AbSize = 36
}

# ---- Small helpers --------------------------------------------------------------------------------------------------

function New-OvRgb([int]$r, [int]$g, [int]$b) {
  $brush = New-Object System.Windows.Media.SolidColorBrush -ArgumentList @([System.Windows.Media.Color]::FromRgb([byte]$r, [byte]$g, [byte]$b))
  $brush.Freeze()
  return $brush
}

function New-OvTint([int]$r, [int]$g, [int]$b, [int]$a) {
  $brush = New-Object System.Windows.Media.SolidColorBrush -ArgumentList @([System.Windows.Media.Color]::FromArgb([byte]$a, [byte]$r, [byte]$g, [byte]$b))
  $brush.Freeze()
  return $brush
}

function New-OvCardGradient {
  $from = [System.Windows.Media.Color]::FromRgb(24, 28, 39)
  $to = [System.Windows.Media.Color]::FromRgb(13, 16, 24)
  $start = New-Object System.Windows.Point -ArgumentList @([double]0, [double]0)
  $end = New-Object System.Windows.Point -ArgumentList @([double]1, [double]1)
  $brush = New-Object System.Windows.Media.LinearGradientBrush -ArgumentList @($from, $to, $start, $end)
  $brush.Freeze()
  return $brush
}

function New-OvThickness([double]$left, [double]$top, [double]$right, [double]$bottom) {
  return New-Object System.Windows.Thickness -ArgumentList @($left, $top, $right, $bottom)
}

function Get-OvNow {
  return [DateTime]::UtcNow.ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
}

function Get-OvClip($text, [int]$limit) {
  if ($null -eq $text) { return '' }
  $value = [string]$text
  if ($value.Length -gt $limit) { return $value.Substring(0, $limit) }
  return $value
}

function Get-OvStr($dict, [string]$key) {
  if ($null -eq $dict -or -not $dict.ContainsKey($key)) { return $null }
  $value = $dict[$key]
  if ($value -is [string]) { return $value }
  return $null
}

function Get-OvInt($dict, [string]$key, [int]$fallback) {
  if ($null -eq $dict -or -not $dict.ContainsKey($key) -or $null -eq $dict[$key]) { return $fallback }
  try { return [System.Convert]::ToInt32($dict[$key], [System.Globalization.CultureInfo]::InvariantCulture) } catch { return $fallback }
}

function Get-OvDbl($dict, [string]$key) {
  if ($null -eq $dict -or -not $dict.ContainsKey($key) -or $null -eq $dict[$key]) { return 0.0 }
  try { return [System.Convert]::ToDouble($dict[$key], [System.Globalization.CultureInfo]::InvariantCulture) } catch { return 0.0 }
}

function Get-OvFlag($dict, [string]$key) {
  if ($null -eq $dict -or -not $dict.ContainsKey($key)) { return $false }
  return (($dict[$key] -is [bool]) -and [bool]$dict[$key])
}

function Get-OvDict($dict, [string]$key) {
  if ($null -eq $dict -or -not $dict.ContainsKey($key)) { return $null }
  $value = $dict[$key]
  if ($value -is [System.Collections.Generic.Dictionary[string,object]]) { return ,$value }
  return $null
}

# JavaScriptSerializer returns nested arrays as ArrayList, so accept any IList.
function Get-OvItems($dict, [string]$key) {
  if ($null -eq $dict -or -not $dict.ContainsKey($key)) { return ,@() }
  $value = $dict[$key]
  if ($value -isnot [System.Collections.IList]) { return ,@() }
  $items = New-Object System.Collections.ArrayList
  foreach ($item in $value) { [void]$items.Add($item) }
  return ,$items.ToArray()
}

function Get-OvStringList($items) {
  $list = New-Object System.Collections.ArrayList
  foreach ($item in $items) {
    if ($item -is [string]) { [void]$list.Add($item) }
  }
  return ,$list
}

function Get-OvWindowHandle($window) {
  return (New-Object System.Windows.Interop.WindowInteropHelper -ArgumentList @($window)).Handle
}

# ---- Protocol replies -----------------------------------------------------------------------------------------------

function Send-OvReply([string]$id, [bool]$ok, $data, $errorCode) {
  $value = @{}
  $value['version'] = $script:Version
  $value['id'] = $id
  $value['ok'] = $ok
  if ($null -ne $data) { $value['data'] = $data }
  if ($null -ne $errorCode) { $value['error'] = (Get-OvClip $errorCode 200) }
  $text = $script:Json.Serialize($value)
  [Console]::Out.Write($text + [string][char]10)
  [Console]::Out.Flush()
}

function Get-OvAck([string]$command, [string]$acknowledgement, $overlayId, [string]$reason, [string]$requestId) {
  $visible = 0
  $interactive = 0
  $ready = 0
  foreach ($card in @($script:Order.ToArray())) {
    if ($null -eq $card.Window -or -not $card.Window.IsVisible) { continue }
    $visible += 1
    if ($card.Interactive) { $interactive += 1 }
    if ($card.Window.ActualWidth -gt 0 -and $card.Window.ActualHeight -gt 0) { $ready += 1 }
  }
  $ack = @{}
  $ack['command'] = $command
  $ack['acknowledgement'] = $acknowledgement
  $ack['rendererEpoch'] = $script:RendererEpoch
  $ack['visibleWindowCount'] = $visible
  $ack['interactiveWindowCount'] = $interactive
  $ack['transparentWindowCount'] = $visible
  $ack['drawReadyCount'] = $ready
  $ack['visible'] = ($visible -gt 0 -and $ready -gt 0)
  $ack['liveSurfaceRegistered'] = ($null -ne $overlayId -and $script:Cards.ContainsKey([string]$overlayId))
  if ($null -ne $overlayId) { $ack['overlayId'] = [string]$overlayId }
  $ack['reason'] = $reason
  $ack['requestId'] = $requestId
  return $ack
}

function Get-OvCapabilities {
  $ready = [bool]$script:GuardReady
  $c = @{}
  $c['supported'] = $ready
  $c['available'] = $true
  $c['visible'] = $ready
  $c['renderer'] = 'wpf-windows'
  if ($ready) { $c['rendererStatus'] = 'available' } else { $c['rendererStatus'] = 'unavailable' }
  $c['sessionType'] = 'unknown'
  $c['displayAvailable'] = $true
  $c['clickThrough'] = $ready
  $c['interactiveWidgets'] = $ready
  $c['multipleDisplays'] = $false
  $c['globalOverlayAvailable'] = $ready
  $c['clickThroughAvailable'] = $ready
  $c['multiDisplayAvailable'] = $false
  $c['animationAvailable'] = $false
  $c['interactiveWidgetsAvailable'] = $ready
  $c['compositorAvailable'] = $true
  $c['transparentWindowsAvailable'] = $ready
  if ($ready) { $c['reason'] = 'wpf_overlay_ready' } else { $c['reason'] = 'overlay_input_guard_unavailable' }
  $c['limitations'] = $script:Limitations
  return $c
}

function Get-OvState {
  $overlays = New-Object System.Collections.ArrayList
  foreach ($card in @($script:Order.ToArray())) {
    $o = @{}
    $o['overlayId'] = $card.OverlayId
    $o['ownerSessionId'] = $script:SessionId
    $o['type'] = 'widget'
    $o['sensitivity'] = $card.Sensitivity
    $o['interactive'] = $card.Interactive
    $o['visible'] = ($null -ne $card.Window -and $card.Window.IsVisible)
    $o['createdAt'] = $card.CreatedAt
    $o['updatedAt'] = $card.UpdatedAt
    $o['expiresAt'] = $card.UpdatedAt
    [void]$overlays.Add($o)
  }
  $pending = New-Object System.Collections.ArrayList
  [void]$pending.AddRange($script:Events)
  $d = @{}
  $d['renderer'] = Get-OvCapabilities
  $d['overlays'] = $overlays.ToArray()
  $d['pendingEvents'] = $pending.ToArray()
  $d['emergencyHidden'] = $script:EmergencyHidden
  return $d
}

function Get-OvDrainEvents {
  $copy = New-Object System.Collections.ArrayList
  [void]$copy.AddRange($script:Events)
  $script:Events.Clear()
  return ,$copy.ToArray()
}

# ---- Requests -------------------------------------------------------------------------------------------------------

function Read-OvVisual($payload) {
  $visual = Get-OvDict $payload 'visual'
  if ($null -eq $visual) { return }
  $layout = Get-OvStr $visual 'layout'
  if ($layout -ceq 'dock' -or $layout -ceq 'ambient' -or $layout -ceq 'rail') { $script:LayoutMode = $layout }
  $side = Get-OvStr $visual 'dockSide'
  if ($side -ceq 'left' -or $side -ceq 'right') { $script:DockSide = $side }
  $percent = Get-OvInt $visual 'dockWidthPercent' $script:DockPercent
  if ($percent -ge 10 -and $percent -le 40) { $script:DockPercent = $percent }
  if ($visual.ContainsKey('dockReserveSpace') -and ($visual['dockReserveSpace'] -is [bool])) { $script:DockReserve = [bool]$visual['dockReserveSpace'] }
}

function Invoke-OvHello([string]$id, $payload) {
  $epoch = Get-OvInt $payload 'rendererEpoch' 0
  if ($epoch -lt 1) {
    Send-OvReply $id $false $null 'renderer_epoch_required'
    return
  }
  $script:RendererEpoch = $epoch
  Read-OvVisual $payload
  if (-not $script:GuardReady) { $script:GuardReady = Install-OvPressGuard }
  $data = @{}
  $data['protocolVersion'] = $script:Version
  $data['rendererEpoch'] = $script:RendererEpoch
  $data['capabilities'] = Get-OvCapabilities
  Send-OvReply $id $true $data $null
}

function Invoke-OvShowOrUpdate([string]$id, [string]$command, $payload) {
  $overlayId = Get-OvStr $payload 'overlayId'
  $body = Get-OvDict $payload 'payload'
  if ($null -eq $overlayId -or $overlayId.Length -lt 1 -or $overlayId.Length -gt 200 -or $null -eq $body) {
    Send-OvReply $id $false $null 'render_record_invalid'
    return
  }
  if (-not $script:GuardReady) {
    Send-OvReply $id $false $null 'overlay_input_guard_unavailable'
    return
  }
  $type = Get-OvStr $payload 'type'
  if ($null -eq $type) { $type = 'widget' }
  if ($type -cne 'widget') {
    Send-OvReply $id $false $null 'overlay_primitive_unsupported'
    return
  }
  $exists = $script:Cards.ContainsKey($overlayId)
  if ($command -ceq 'update' -and -not $exists) {
    Send-OvReply $id $false $null 'overlay_not_found'
    return
  }
  if (-not $exists -and $script:Cards.Count -ge $script:MaxCards) {
    Send-OvReply $id $false $null 'overlay_limit_reached'
    return
  }
  if ($exists) {
    $card = $script:Cards[$overlayId]
  } else {
    $script:Sequence += 1
    $card = @{
      OverlayId = $overlayId
      Sequence = $script:Sequence
      CreatedAt = (Get-OvNow)
      UpdatedAt = ''
      Sensitivity = 'public'
      Placement = 'top_right'
      Interactive = $false
      AllowedEvents = (New-Object System.Collections.ArrayList)
      Window = $null
      Frame = $null
    }
  }
  $content = Build-OvContent $card $body
  if (Test-OvDockCard $card) {
    Start-OvDock
    $content = New-OvDockScroll $content
  }
  $card.UpdatedAt = Get-OvNow
  if ($null -eq $card.Window) { $card.Window = New-OvWindow }
  $card.Window.Content = $content
  if (-not $card.Window.IsVisible) { $card.Window.Show() }
  if (-not $exists) {
    $script:Cards[$overlayId] = $card
    [void]$script:Order.Add($card)
  }
  Set-OvWindowFlags $card.Window $card.Interactive
  $card.Window.UpdateLayout()
  Invoke-OvReposition
  if (-not $card.Window.IsVisible) {
    Remove-OvCard $card
    Send-OvReply $id $false $null 'overlay_live_registration_missing'
    return
  }
  $script:EmergencyHidden = $false
  if ($command -ceq 'show') {
    $ack = Get-OvAck $command 'visible' $overlayId 'wpf_overlay_shown' $id
  } else {
    $ack = Get-OvAck $command 'updated' $overlayId 'wpf_overlay_updated' $id
  }
  Send-OvReply $id $true $ack $null
}

function Invoke-OvDismiss([string]$id, $overlayId) {
  if ($null -ne $overlayId -and $script:Cards.ContainsKey([string]$overlayId)) { Remove-OvCard $script:Cards[[string]$overlayId] }
  Send-OvReply $id $true (Get-OvAck 'dismiss' 'dismissed' $overlayId 'wpf_overlay_dismissed' $id) $null
}

function Invoke-OvClearAll([string]$id) {
  foreach ($card in @($script:Order.ToArray())) { Remove-OvCard $card }
  Send-OvReply $id $true (Get-OvAck 'clear' 'cleared' $null 'wpf_overlays_cleared' $id) $null
}

function Invoke-OvEmergencyHide([string]$id) {
  foreach ($card in @($script:Order.ToArray())) { Remove-OvCard $card }
  Release-OvDockNow
  $script:EmergencyHidden = $true
  Send-OvReply $id $true (Get-OvAck 'emergency_hide' 'emergency_hidden' $null 'wpf_emergency_hidden' $id) $null
}

function Invoke-OvRunCommand([string]$id, [string]$command, $payload) {
  if ($command -ceq 'hello') { Invoke-OvHello $id $payload; return }
  if ($command -ceq 'capabilities') { Send-OvReply $id $true (Get-OvCapabilities) $null; return }
  if ($command -ceq 'show' -or $command -ceq 'update') { Invoke-OvShowOrUpdate $id $command $payload; return }
  if ($command -ceq 'dismiss') { Invoke-OvDismiss $id (Get-OvStr $payload 'overlayId'); return }
  if ($command -ceq 'clear') { Invoke-OvClearAll $id; return }
  if ($command -ceq 'emergency_hide') { Invoke-OvEmergencyHide $id; return }
  if ($command -ceq 'state') { Send-OvReply $id $true (Get-OvState) $null; return }
  if ($command -ceq 'events') {
    $drained = @{}
    $drained['events'] = Get-OvDrainEvents
    Send-OvReply $id $true $drained $null
    return
  }
  if ($command -ceq 'close') {
    $closing = @{}
    $closing['reason'] = 'renderer_closing'
    Send-OvReply $id $true $closing $null
    Stop-Overlay
  }
}

function Invoke-OvHandleLine([string]$line) {
  if ([string]::IsNullOrEmpty($line)) { return }
  if ([System.Text.Encoding]::UTF8.GetByteCount($line) -gt $script:MaxBytes) { return }
  $request = $null
  try {
    $request = $script:Json.Deserialize($line, [System.Collections.Generic.Dictionary[string,object]])
  } catch {
    return
  }
  if ($null -eq $request) { return }
  $id = Get-OvStr $request 'id'
  if ($null -eq $id -or $id.Length -lt 1 -or $id.Length -gt 100) { return }
  $command = Get-OvStr $request 'command'
  $candidate = Get-OvStr $request 'token'
  $valid = ((Get-OvInt $request 'version' 0) -eq $script:Version)
  $valid = $valid -and ($null -ne $candidate) -and ($candidate.Length -ge 32) -and ($candidate.Length -le 200)
  $valid = $valid -and ($null -ne $command) -and ($script:Commands -ccontains $command)
  if (-not $valid) {
    Send-OvReply $id $false $null 'renderer_request_invalid'
    return
  }
  $payload = Get-OvDict $request 'payload'
  if ($null -eq $payload) { $payload = @{} }
  if ($null -eq $script:Token) {
    if ($command -cne 'hello') {
      Send-OvReply $id $false $null 'renderer_handshake_required'
      return
    }
    $script:Token = $candidate
    $session = Get-OvStr $payload 'sessionId'
    if ($null -ne $session -and $session.Length -ge 1 -and $session.Length -le 200) { $script:SessionId = $session }
  }
  if (-not [string]::Equals($candidate, $script:Token, [System.StringComparison]::Ordinal)) {
    Send-OvReply $id $false $null 'renderer_token_invalid'
    return
  }
  try {
    Invoke-OvRunCommand $id $command $payload
  } catch {
    [Console]::Error.WriteLine('renderer command failed: ' + $_.Exception.Message)
    Send-OvReply $id $false $null 'renderer_command_failed'
  }
}

# ---- Input: a reader runspace fills a queue, the UI thread drains it on a timer -------------------------------------

function Start-OvReader {
  $space = [runspacefactory]::CreateRunspace()
  $space.ApartmentState = [System.Threading.ApartmentState]::MTA
  $space.ThreadOptions = [System.Management.Automation.Runspaces.PSThreadOptions]::ReuseThread
  $space.Open()
  $space.SessionStateProxy.SetVariable('queue', $script:InputQueue)
  $shell = [System.Management.Automation.PowerShell]::Create()
  $shell.Runspace = $space
  [void]$shell.AddScript('while ($true) { $line = [Console]::In.ReadLine(); if ($null -eq $line) { break }; $queue.Enqueue($line) }; $queue.Enqueue($null)')
  $script:ReaderSpace = $space
  $script:ReaderShell = $shell
  [void]$shell.BeginInvoke()
}

function Invoke-OvPump {
  try {
    while ($script:InputQueue.Count -gt 0) {
      $line = $script:InputQueue.Dequeue()
      if ($null -eq $line) {
        Stop-Overlay
        return
      }
      Invoke-OvHandleLine ([string]$line)
    }
  } catch {
    [Console]::Error.WriteLine('renderer pump failed: ' + $_.Exception.Message)
  }
}

# ---- Press guard: a low-level mouse hook marks each left-button event real or injected -----------------------------

function Install-OvPressGuard {
  if ($script:Hook -ne [IntPtr]::Zero) { return $true }
  $script:HookProc = [AhNative.LowLevelMouseProc]{
    param([int]$nCode, [IntPtr]$wParam, [IntPtr]$lParam)
    try {
      if ($nCode -ge 0) {
        $message = $wParam.ToInt32()
        if ($message -eq 0x0201 -or $message -eq 0x0202) {
          # MSLLHOOKSTRUCT: pt (8 bytes), mouseData (4), flags (4) at offset 12.
          $flags = [System.Runtime.InteropServices.Marshal]::ReadInt32($lParam, 12)
          $real = (([uint32]$flags -band [uint32]3) -eq 0)
          if ($message -eq 0x0201) { $script:LastDownReal = $real } else { $script:LastUpReal = $real }
        }
      }
    } catch { }
    return [AhNative.Native]::CallNextHookEx($script:Hook, $nCode, $wParam, $lParam)
  }
  $module = [AhNative.Native]::GetModuleHandleW($null)
  $script:Hook = [AhNative.Native]::SetWindowsHookExW(14, $script:HookProc, $module, [uint32]0)
  return ($script:Hook -ne [IntPtr]::Zero)
}

function Remove-OvPressGuard {
  if ($script:Hook -ne [IntPtr]::Zero) { [void][AhNative.Native]::UnhookWindowsHookEx($script:Hook) }
  $script:Hook = [IntPtr]::Zero
}

# ---- Windows --------------------------------------------------------------------------------------------------------

function New-OvWindow {
  $window = New-Object System.Windows.Window
  $window.Title = 'AgentHost overlay'
  $window.WindowStyle = [System.Windows.WindowStyle]::None
  $window.AllowsTransparency = $true
  $window.Background = [System.Windows.Media.Brushes]::Transparent
  $window.Topmost = $true
  $window.ShowInTaskbar = $false
  $window.ShowActivated = $false
  $window.Focusable = $false
  $window.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $window.SizeToContent = [System.Windows.SizeToContent]::Height
  $window.Width = $script:CardWidth
  $window.Left = $script:OffscreenPosition
  $window.Top = $script:OffscreenPosition
  return $window
}

function Set-OvWindowFlags($window, [bool]$interactive) {
  $handle = Get-OvWindowHandle $window
  $style = [AhNative.Native]::GetWindowLongW($handle, -20)
  $style = $style -bor 0x00000080 -bor 0x08000000
  if ($interactive) {
    $style = $style -band (-bnot 0x00000020)
  } else {
    $style = $style -bor 0x00000020
  }
  [void][AhNative.Native]::SetWindowLongW($handle, -20, $style)
}

function Test-OvTimelineCard($card) {
  return $card.OverlayId.StartsWith($script:TimelinePrefix, [System.StringComparison]::Ordinal)
}

function Test-OvDockCard($card) {
  if ($script:LayoutMode -cne 'dock') { return $false }
  return ((Test-OvTimelineCard $card) -or $card.Placement.StartsWith('bottom_', [System.StringComparison]::Ordinal))
}

function Get-OvDockCardCount {
  $count = 0
  foreach ($card in @($script:Order.ToArray())) {
    if ($null -ne $card.Window -and (Test-OvDockCard $card)) { $count += 1 }
  }
  return $count
}

function Get-OvNatural($card, [double]$width) {
  if ($null -eq $card.Frame) { return 0.0 }
  $card.Frame.Measure((New-Object System.Windows.Size -ArgumentList @([double]$width, [double]::PositiveInfinity)))
  return $card.Frame.DesiredSize.Height
}

function Invoke-OvReposition {
  $area = [System.Windows.SystemParameters]::WorkArea
  $used = @{}
  foreach ($card in @($script:Order.ToArray())) {
    if ($null -eq $card.Window -or -not $card.Window.IsVisible -or (Test-OvDockCard $card)) { continue }
    $card.Window.UpdateLayout()
    $width = $script:CardWidth
    if ($card.Window.ActualWidth -gt 0) { $width = $card.Window.ActualWidth }
    $height = $card.Window.ActualHeight
    $offset = 0.0
    if ($used.ContainsKey($card.Placement)) { $offset = [double]$used[$card.Placement] }
    $left = $area.Right - $width - $script:Margin
    if ($card.Placement -ceq 'top_left' -or $card.Placement -ceq 'bottom_left') {
      $left = $area.Left + $script:Margin
    } elseif ($card.Placement -ceq 'top_center' -or $card.Placement -ceq 'bottom_center') {
      $left = $area.Left + (($area.Width - $width) / 2)
    }
    $top = $area.Top + $script:Margin + $offset
    if ($card.Placement.StartsWith('bottom_', [System.StringComparison]::Ordinal)) {
      $top = $area.Bottom - $height - $script:Margin - $offset
    }
    $card.Window.Left = $left
    $card.Window.Top = $top
    $used[$card.Placement] = $offset + $height + $script:Gap
  }
  Invoke-OvLayoutDock
}

function Remove-OvCard($card) {
  [void]$script:Cards.Remove([string]$card.OverlayId)
  [void]$script:Order.Remove($card)
  $window = $card.Window
  $card.Window = $null
  if ($null -ne $window) { $window.Close() }
  Invoke-OvReposition
  if ((Get-OvDockCardCount) -eq 0) { Request-OvDockRelease }
}

function Publish-OvEvent($card, [string]$eventName) {
  if (-not ($card.AllowedEvents -ccontains $eventName) -or -not $script:Cards.ContainsKey([string]$card.OverlayId)) { return }
  $e = @{}
  $e['eventId'] = 'event_' + [guid]::NewGuid().ToString('N')
  $e['overlayId'] = $card.OverlayId
  $e['event'] = $eventName
  $e['createdAt'] = Get-OvNow
  $e['ownerSessionId'] = $script:SessionId
  [void]$script:Events.Add($e)
  if ($script:Events.Count -gt 100) { $script:Events.RemoveAt(0) }
  if ($eventName -ceq 'dismissed' -or $eventName -ceq 'hide') { Remove-OvCard $card }
}

function Stop-Overlay {
  foreach ($card in @($script:Order.ToArray())) { Remove-OvCard $card }
  Release-OvDockNow
  Remove-OvPressGuard
  if ($null -ne $script:Pump) { $script:Pump.Stop() }
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
}

# ---- Dock: a strip that reserves work area with the shell (SHAppBarMessage), like the taskbar -----------------------

function Initialize-OvDockOwner {
  if ($null -ne $script:DockOwner) { return }
  $owner = New-Object System.Windows.Window
  $owner.Title = 'AgentHost dock owner'
  $owner.WindowStyle = [System.Windows.WindowStyle]::None
  $owner.ShowInTaskbar = $false
  $owner.ShowActivated = $false
  $owner.Focusable = $false
  $owner.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $owner.Width = 1
  $owner.Height = 1
  $owner.Left = $script:OffscreenPosition
  $owner.Top = $script:OffscreenPosition
  $script:DockOwner = $owner
  $owner.Show()
  Set-OvWindowFlags $owner $false
  $script:DockCallback = [AhNative.Native]::RegisterWindowMessageW('AgentHostDockCallback')
}

# Device pixels per WPF unit. A DPI-unaware process reports 1, and the shell virtualizes its coordinates too.
function Get-OvDeviceScale($visual) {
  $source = [System.Windows.PresentationSource]::FromVisual($visual)
  if ($null -eq $source -or $null -eq $source.CompositionTarget) { return 1.0 }
  return $source.CompositionTarget.TransformToDevice.M11
}

function New-OvAppBar([IntPtr]$handle, [uint32]$callback) {
  $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($script:AbSize)
  for ($offset = 0; $offset -lt $script:AbSize; $offset += 4) {
    [System.Runtime.InteropServices.Marshal]::WriteInt32($ptr, $offset, 0)
  }
  [System.Runtime.InteropServices.Marshal]::WriteInt32($ptr, 0, $script:AbSize)
  [System.Runtime.InteropServices.Marshal]::WriteIntPtr($ptr, $script:AbHwnd, $handle)
  [System.Runtime.InteropServices.Marshal]::WriteInt32($ptr, $script:AbCallback, [int]$callback)
  return $ptr
}

function Set-OvAppBarRect($ptr, [int]$left, [int]$top, [int]$right, [int]$bottom) {
  [System.Runtime.InteropServices.Marshal]::WriteInt32($ptr, $script:AbRect, $left)
  [System.Runtime.InteropServices.Marshal]::WriteInt32($ptr, $script:AbRect + 4, $top)
  [System.Runtime.InteropServices.Marshal]::WriteInt32($ptr, $script:AbRect + 8, $right)
  [System.Runtime.InteropServices.Marshal]::WriteInt32($ptr, $script:AbRect + 12, $bottom)
}

function Get-OvAppBarRect($ptr) {
  return @{
    Left = [System.Runtime.InteropServices.Marshal]::ReadInt32($ptr, $script:AbRect)
    Top = [System.Runtime.InteropServices.Marshal]::ReadInt32($ptr, $script:AbRect + 4)
    Right = [System.Runtime.InteropServices.Marshal]::ReadInt32($ptr, $script:AbRect + 8)
    Bottom = [System.Runtime.InteropServices.Marshal]::ReadInt32($ptr, $script:AbRect + 12)
  }
}

function Reserve-OvDock([double]$width) {
  Initialize-OvDockOwner
  $right = ($script:DockSide -cne 'left')
  $scale = Get-OvDeviceScale $script:DockOwner
  $screenWidth = [System.Windows.SystemParameters]::PrimaryScreenWidth
  $screenHeight = [System.Windows.SystemParameters]::PrimaryScreenHeight
  $widthPixels = [int][Math]::Round($width * $scale)
  $buffer = New-OvAppBar (Get-OvWindowHandle $script:DockOwner) $script:DockCallback
  [void][AhNative.Native]::SHAppBarMessage(0, $buffer)
  if ($right) {
    [System.Runtime.InteropServices.Marshal]::WriteInt32($buffer, $script:AbEdge, 2)
  } else {
    [System.Runtime.InteropServices.Marshal]::WriteInt32($buffer, $script:AbEdge, 0)
  }
  # The full height of the primary display: the shell trims it to the work area in QUERYPOS (the taskbar).
  if ($right) {
    $rectLeft = [int][Math]::Round(($screenWidth - $width) * $scale)
    $rectRight = [int][Math]::Round($screenWidth * $scale)
  } else {
    $rectLeft = 0
    $rectRight = $widthPixels
  }
  Set-OvAppBarRect $buffer $rectLeft 0 $rectRight ([int][Math]::Round($screenHeight * $scale))
  [void][AhNative.Native]::SHAppBarMessage(2, $buffer)
  $rect = Get-OvAppBarRect $buffer
  if ($right) {
    $rect.Left = $rect.Right - $widthPixels
  } else {
    $rect.Right = $rect.Left + $widthPixels
  }
  Set-OvAppBarRect $buffer $rect.Left $rect.Top $rect.Right $rect.Bottom
  [void][AhNative.Native]::SHAppBarMessage(3, $buffer)
  $script:DockRect = @{
    Left = $rect.Left / $scale
    Top = $rect.Top / $scale
    Width = ($rect.Right - $rect.Left) / $scale
    Height = ($rect.Bottom - $rect.Top) / $scale
  }
  $script:DockRegistered = $true
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
}

# Shows the strip and its panel. Called before a dock card is shown, so the strip exists only while it has cards.
function Start-OvDock {
  Stop-OvDockRelease
  $screenWidth = [System.Windows.SystemParameters]::PrimaryScreenWidth
  $width = [Math]::Min($screenWidth, [Math]::Max(240.0, [Math]::Round($screenWidth * $script:DockPercent / 100.0)))
  if ($script:DockReserve) {
    if (-not $script:DockRegistered) { Reserve-OvDock $width }
  } else {
    $area = [System.Windows.SystemParameters]::WorkArea
    $left = $area.Right - $width
    if ($script:DockSide -ceq 'left') { $left = $area.Left }
    $script:DockRect = @{ Left = $left; Top = $area.Top; Width = $width; Height = $area.Height }
  }
  if ($null -eq $script:DockPanel) {
    $panel = New-Object System.Windows.Window
    $panel.Title = 'AgentHost dock'
    $panel.WindowStyle = [System.Windows.WindowStyle]::None
    $panel.ShowInTaskbar = $false
    $panel.ShowActivated = $false
    $panel.Focusable = $false
    $panel.ResizeMode = [System.Windows.ResizeMode]::NoResize
    $panel.Topmost = $true
    $strip = New-Object System.Windows.Controls.Border
    $strip.Background = $script:StripFill
    $panel.Content = $strip
    $script:DockPanel = $panel
  }
  $script:DockPanel.Left = $script:DockRect.Left
  $script:DockPanel.Top = $script:DockRect.Top
  $script:DockPanel.Width = $script:DockRect.Width
  $script:DockPanel.Height = $script:DockRect.Height
  if (-not $script:DockPanel.IsVisible) {
    $script:DockPanel.Show()
    Set-OvWindowFlags $script:DockPanel $false
  }
}

# Hides the panel at once and releases the reservation after a short grace period. Screenshot suppression clears the
# cards and shows them again a moment later; without the grace period every capture would resize every window twice.
function Request-OvDockRelease {
  if ($null -eq $script:DockPanel -and -not $script:DockRegistered) { return }
  if ($null -eq $script:DockRelease) {
    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds($script:DockReleaseMs)
    $timer.Add_Tick({
      $script:DockRelease.Stop()
      if ((Get-OvDockCardCount) -eq 0) { Release-OvDockNow }
    })
    $script:DockRelease = $timer
  }
  $script:DockRelease.Stop()
  $script:DockRelease.Start()
  if ($null -ne $script:DockPanel -and $script:DockPanel.IsVisible) { $script:DockPanel.Hide() }
}

function Stop-OvDockRelease {
  if ($null -ne $script:DockRelease) { $script:DockRelease.Stop() }
}

function Release-OvDockNow {
  Stop-OvDockRelease
  if ($script:DockRegistered -and $null -ne $script:DockOwner) {
    $buffer = New-OvAppBar (Get-OvWindowHandle $script:DockOwner) 0
    [void][AhNative.Native]::SHAppBarMessage(1, $buffer)
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
  $script:DockRegistered = $false
  if ($null -ne $script:DockPanel) {
    $script:DockPanel.Close()
    $script:DockPanel = $null
  }
  if ($null -ne $script:DockOwner) {
    $script:DockOwner.Close()
    $script:DockOwner = $null
  }
}

function New-OvDockScroll($content) {
  $scroll = New-Object System.Windows.Controls.ScrollViewer
  $scroll.VerticalScrollBarVisibility = [System.Windows.Controls.ScrollBarVisibility]::Auto
  $scroll.HorizontalScrollBarVisibility = [System.Windows.Controls.ScrollBarVisibility]::Disabled
  $scroll.Content = $content
  return $scroll
}

function Set-OvDockPlacement($card, [double]$x, [double]$y, [double]$width, [double]$height) {
  $card.Window.SizeToContent = [System.Windows.SizeToContent]::Manual
  $card.Window.Width = $width
  $card.Window.Height = $height
  $card.Window.Left = $x
  $card.Window.Top = $y
}

# Places the timeline at the top and the bottom cards from the floor, as the Linux dock_layout does.
function Invoke-OvLayoutDock {
  $timeline = $null
  $bottom = New-Object System.Collections.ArrayList
  foreach ($card in @($script:Order.ToArray())) {
    if ($null -eq $card.Window -or -not $card.Window.IsVisible -or -not (Test-OvDockCard $card)) { continue }
    if ($null -eq $timeline -and (Test-OvTimelineCard $card)) {
      $timeline = $card
    } else {
      [void]$bottom.Add($card)
    }
  }
  if ($null -eq $timeline -and $bottom.Count -eq 0) { return }
  $width = [Math]::Max($script:DockMinWidth, $script:DockRect.Width - 2 * $script:DockMargin)
  $timelineWanted = 0.0
  if ($null -ne $timeline) { $timelineWanted = Get-OvNatural $timeline $width }
  $wanted = New-Object 'double[]' $bottom.Count
  for ($i = 0; $i -lt $bottom.Count; $i++) {
    $wanted[$i] = [Math]::Min((Get-OvNatural $bottom[$i] $width), $script:DockMaxCard)
  }
  $layout = Get-OvDockLayout $script:DockRect.Height $timelineWanted $wanted
  $x = $script:DockRect.Left + $script:DockMargin
  for ($i = 0; $i -lt $bottom.Count; $i++) {
    Set-OvDockPlacement $bottom[$i] $x ($script:DockRect.Top + $layout.tops[$i]) $width $layout.heights[$i]
  }
  if ($null -ne $timeline) {
    Set-OvDockPlacement $timeline $x ($script:DockRect.Top + $script:DockMargin) $width $layout.timeline
  }
}

# A port of overlay_geometry.dock_layout (packages/app-overlay/runtime/overlay_geometry.py). Keep the two equal.
function Get-OvDockLayout([double]$areaHeight, [double]$timelineWanted, [double[]]$wanted) {
  $usable = [Math]::Max(1.0, $areaHeight - 2 * $script:DockMargin)
  $hasTimeline = ($timelineWanted -gt 0)
  $budget = $usable
  if ($hasTimeline) {
    $spare = $usable - [Math]::Min($timelineWanted, $usable) - $script:DockMargin
    $budget = [Math]::Min([Math]::Max($areaHeight * $script:DockBottomShare, $spare), $usable - $script:DockMargin - $script:DockMinTimeline)
  }
  $count = $wanted.Length
  $tops = New-Object 'double[]' $count
  $heights = New-Object 'double[]' $count
  $floor = $areaHeight - $script:DockMargin
  $remaining = $budget
  for ($i = 0; $i -lt $count; $i++) {
    $later = $count - $i - 1
    $available = $remaining - $later * ($script:DockMinBottom + $script:DockMargin)
    $height = [Math]::Max($script:DockMinBottom, [Math]::Min($wanted[$i], $available))
    $floor -= $height
    $heights[$i] = $height
    $tops[$i] = [Math]::Max($script:DockMargin, $floor)
    $floor -= $script:DockMargin
    $remaining -= $height + $script:DockMargin
  }
  $timeline = 0.0
  if ($hasTimeline) {
    $used = $script:DockMargin * [Math]::Max(0, $count - 1)
    for ($i = 0; $i -lt $count; $i++) { $used += $heights[$i] }
    $gap = 0.0
    if ($count -gt 0) { $gap = $script:DockMargin }
    $room = $usable - $used - $gap
    $timeline = [Math]::Max($script:DockMinTimeline, [Math]::Min($timelineWanted, $room))
  }
  return @{ timeline = $timeline; tops = $tops; heights = $heights }
}

# ---- Card content ---------------------------------------------------------------------------------------------------

function New-OvText([string]$text, [double]$size, [bool]$bold, $brush) {
  $block = New-Object System.Windows.Controls.TextBlock
  $block.Text = $text
  $block.FontSize = $size
  if ($bold) { $block.FontWeight = [System.Windows.FontWeights]::Bold }
  $block.Foreground = $brush
  $block.TextWrapping = [System.Windows.TextWrapping]::Wrap
  $block.Margin = New-OvThickness 0 0 0 4
  return $block
}

function New-OvRule {
  $line = New-Object System.Windows.Controls.Border
  $line.Height = 1
  $line.Background = $script:Rule
  $line.Margin = New-OvThickness 0 6 0 6
  return $line
}

function New-OvStatusBadge([string]$status, [string]$text) {
  $key = 'neutral'
  if ($status -ceq 'info' -or $status -ceq 'success' -or $status -ceq 'warning' -or $status -ceq 'danger') { $key = $status }
  $badge = New-Object System.Windows.Controls.Border
  $badge.CornerRadius = New-Object System.Windows.CornerRadius -ArgumentList @([double]10)
  $badge.Padding = New-OvThickness 10 2 10 2
  $badge.Margin = New-OvThickness 0 0 0 6
  $badge.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
  $badge.Background = Get-OvBadgeFill $key
  $block = New-OvText (Get-OvClip $text 300) 12 $true (Get-OvBadgeInk $key)
  $block.Margin = New-OvThickness 0 0 0 0
  $badge.Child = $block
  return $badge
}

function Get-OvBadgeFill([string]$key) {
  if ($key -ceq 'info') { return New-OvTint 59 130 246 51 }
  if ($key -ceq 'success') { return New-OvTint 52 211 153 46 }
  if ($key -ceq 'warning') { return New-OvTint 245 184 64 46 }
  if ($key -ceq 'danger') { return New-OvTint 248 113 113 46 }
  return New-OvTint 148 163 184 41
}

function Get-OvBadgeInk([string]$key) {
  if ($key -ceq 'info') { return New-OvRgb 156 194 255 }
  if ($key -ceq 'success') { return New-OvRgb 142 240 194 }
  if ($key -ceq 'warning') { return New-OvRgb 255 213 138 }
  if ($key -ceq 'danger') { return New-OvRgb 255 173 173 }
  return New-OvRgb 203 213 225
}

function New-OvKeyValue([string]$key, [string]$value) {
  $grid = New-Object System.Windows.Controls.Grid
  $keyColumn = New-Object System.Windows.Controls.ColumnDefinition
  $keyColumn.Width = New-Object System.Windows.GridLength -ArgumentList @([double]96)
  $valueColumn = New-Object System.Windows.Controls.ColumnDefinition
  $valueColumn.Width = New-Object System.Windows.GridLength -ArgumentList @([double]1, [System.Windows.GridUnitType]::Star)
  [void]$grid.ColumnDefinitions.Add($keyColumn)
  [void]$grid.ColumnDefinitions.Add($valueColumn)
  $keyBlock = New-OvText $key 12 $false $script:Muted
  $valueBlock = New-OvText $value 13 $true $script:Ink
  [System.Windows.Controls.Grid]::SetColumn($keyBlock, 0)
  [System.Windows.Controls.Grid]::SetColumn($valueBlock, 1)
  [void]$grid.Children.Add($keyBlock)
  [void]$grid.Children.Add($valueBlock)
  return $grid
}

function Get-OvIconGlyph([string]$token) {
  if ($token -ceq 'success' -or $token -ceq 'check') { return [string][char]0x2713 }
  if ($token -ceq 'danger' -or $token -ceq 'close') { return [string][char]0x2715 }
  if ($token -ceq 'warning') { return '!' }
  if ($token -ceq 'pointer') { return [string][char]0x25B8 }
  return 'i'
}

function Get-OvTimelineGlyph([string]$state) {
  if ($state -ceq 'done') { return [string][char]0x2713 }
  if ($state -ceq 'running') { return [string][char]0x25CF }
  if ($state -ceq 'failed') { return [string][char]0x2715 }
  return [string][char]0x25CB
}

function Get-OvTimelineBrush([string]$state) {
  if ($state -ceq 'done') { return $script:Green }
  if ($state -ceq 'running') { return $script:Blue }
  if ($state -ceq 'failed') { return $script:Red }
  if ($state -ceq 'waiting') { return $script:Amber }
  return $script:Muted
}

function Get-OvBorderFor([string]$semantic) {
  if ($semantic -ceq 'warning') { return $script:Amber }
  if ($semantic -ceq 'danger') { return $script:Red }
  if ($semantic -ceq 'success') { return $script:Green }
  if ($semantic -ceq 'info') { return $script:Blue }
  return $script:CardEdge
}

function Add-OvProgress($stack, $c) {
  $label = Get-OvStr $c 'label'
  if ($null -ne $label) { [void]$stack.Children.Add((New-OvText (Get-OvClip $label 200) 12 $false $script:Muted)) }
  $bar = New-Object System.Windows.Controls.ProgressBar
  $bar.Minimum = 0
  $bar.Maximum = 100
  $bar.Value = [Math]::Max(0.0, [Math]::Min(100.0, (Get-OvDbl $c 'value') * 100))
  $bar.Height = 6
  $bar.Margin = New-OvThickness 0 2 0 6
  [void]$stack.Children.Add($bar)
}

function Add-OvChecklist($stack, $c) {
  foreach ($item in (Get-OvItems $c 'items')) {
    if ($item -isnot [System.Collections.Generic.Dictionary[string,object]]) { continue }
    $state = Get-OvStr $item 'state'
    if ($null -eq $state) { $state = '' }
    $marker = [string][char]0x25CB
    if ((Get-OvFlag $item 'checked') -or $state -ceq 'done') {
      $marker = [string][char]0x2713
    } elseif ($state -ceq 'failed') {
      $marker = [string][char]0x2715
    } elseif ($state -ceq 'active') {
      $marker = [string][char]0x2192
    }
    $brush = $script:Ink
    if ($state -ceq 'failed') { $brush = $script:Red }
    [void]$stack.Children.Add((New-OvText ($marker + ' ' + (Get-OvClip (Get-OvStr $item 'label') 300)) 13 $false $brush))
  }
}

# A timeline row as on Linux: a state glyph, the label bold with the detail dim under it, and the time at the right.
function Add-OvTimeline($stack, $c) {
  foreach ($entry in (Get-OvItems $c 'entries')) {
    if ($entry -isnot [System.Collections.Generic.Dictionary[string,object]]) { continue }
    $state = Get-OvClip (Get-OvStr $entry 'state') 20
    $row = New-Object System.Windows.Controls.Grid
    $markerColumn = New-Object System.Windows.Controls.ColumnDefinition
    $markerColumn.Width = New-Object System.Windows.GridLength -ArgumentList @([double]18)
    $bodyColumn = New-Object System.Windows.Controls.ColumnDefinition
    $bodyColumn.Width = New-Object System.Windows.GridLength -ArgumentList @([double]1, [System.Windows.GridUnitType]::Star)
    $timeColumn = New-Object System.Windows.Controls.ColumnDefinition
    $timeColumn.Width = [System.Windows.GridLength]::Auto
    [void]$row.ColumnDefinitions.Add($markerColumn)
    [void]$row.ColumnDefinitions.Add($bodyColumn)
    [void]$row.ColumnDefinitions.Add($timeColumn)
    $glyph = New-OvText (Get-OvTimelineGlyph $state) 12 $true (Get-OvTimelineBrush $state)
    [System.Windows.Controls.Grid]::SetColumn($glyph, 0)
    $text = New-Object System.Windows.Controls.StackPanel
    [void]$text.Children.Add((New-OvText (Get-OvClip (Get-OvStr $entry 'label') 300) 12 $true $script:Ink))
    $detail = Get-OvStr $entry 'detail'
    if ($null -ne $detail) { [void]$text.Children.Add((New-OvText (Get-OvClip $detail 300) 11 $false $script:Muted)) }
    [System.Windows.Controls.Grid]::SetColumn($text, 1)
    [void]$row.Children.Add($glyph)
    [void]$row.Children.Add($text)
    $time = Get-OvStr $entry 'time'
    if ($null -ne $time) {
      $stamp = New-OvText (Get-OvClip $time 40) 11 $false $script:Muted
      [System.Windows.Controls.Grid]::SetColumn($stamp, 2)
      [void]$row.Children.Add($stamp)
    }
    [void]$stack.Children.Add($row)
  }
}

function Add-OvButton($footer, $c, $card, [bool]$wantInteractive) {
  $label = Get-OvStr $c 'label'
  if ($null -eq $label) { $label = Get-OvStr $c 'text' }
  $label = Get-OvClip $label 60
  if ($label.Length -eq 0) { $label = 'OK' }
  $eventName = Get-OvStr $c 'event'
  if ($null -eq $eventName) { $eventName = '' }
  $enabled = ($wantInteractive -and $eventName.Length -gt 0 -and ($card.AllowedEvents -ccontains $eventName))
  $button = New-Object System.Windows.Controls.Button
  $button.Content = $label
  $button.MinWidth = 72
  $button.Padding = New-OvThickness 10 3 10 3
  $button.Margin = New-OvThickness 0 8 8 0
  $button.Focusable = $false
  $button.IsTabStop = $false
  $button.IsEnabled = $enabled
  # A press counts only when the hook saw the down and the up as real (not injected).
  $press = @{ Down = $false; Up = $false }
  $button.Add_PreviewMouseLeftButtonDown(({
    param($sender, $eventArgs)
    $press.Down = [bool]$script:LastDownReal
  }).GetNewClosure())
  $button.Add_PreviewMouseLeftButtonUp(({
    param($sender, $eventArgs)
    $press.Up = [bool]$script:LastUpReal
  }).GetNewClosure())
  $name = $eventName
  $button.Add_Click(({
    param($sender, $eventArgs)
    $real = ($press.Down -and $press.Up)
    $press.Down = $false
    $press.Up = $false
    if ($real) { Publish-OvEvent $card $name }
  }).GetNewClosure())
  [void]$footer.Children.Add($button)
  if ($enabled) { return 1 }
  return 0
}

function Add-OvComponent($stack, $footer, $c, $card, [bool]$wantInteractive) {
  $type = Get-OvStr $c 'type'
  if ($null -eq $type) { $type = '' }
  if ($type -ceq 'heading') { [void]$stack.Children.Add((New-OvText (Get-OvClip (Get-OvStr $c 'text') 1000) 15 $true $script:Ink)); return 0 }
  if ($type -ceq 'text') { [void]$stack.Children.Add((New-OvText (Get-OvClip (Get-OvStr $c 'text') 1000) 13 $false $script:Ink)); return 0 }
  if ($type -ceq 'warning') { [void]$stack.Children.Add((New-OvText (Get-OvClip (Get-OvStr $c 'text') 1000) 13 $true $script:Amber)); return 0 }
  if ($type -ceq 'divider') { [void]$stack.Children.Add((New-OvRule)); return 0 }
  if ($type -ceq 'icon') { [void]$stack.Children.Add((New-OvText (Get-OvIconGlyph (Get-OvStr $c 'token')) 13 $true $script:Ink)); return 0 }
  if ($type -ceq 'status_badge') { [void]$stack.Children.Add((New-OvStatusBadge (Get-OvStr $c 'status') (Get-OvClip (Get-OvStr $c 'text') 300))); return 0 }
  if ($type -ceq 'progress') { Add-OvProgress $stack $c; return 0 }
  if ($type -ceq 'spinner') {
    $spinLabel = Get-OvStr $c 'label'
    if ($null -eq $spinLabel) { $spinLabel = 'working' }
    [void]$stack.Children.Add((New-OvText ('... ' + (Get-OvClip $spinLabel 200)) 13 $false $script:Muted))
    return 0
  }
  if ($type -ceq 'checklist') { Add-OvChecklist $stack $c; return 0 }
  if ($type -ceq 'timeline') { Add-OvTimeline $stack $c; return 0 }
  if ($type -ceq 'key_value') { [void]$stack.Children.Add((New-OvKeyValue (Get-OvClip (Get-OvStr $c 'key') 200) (Get-OvClip (Get-OvStr $c 'value') 500))); return 0 }
  if ($type -ceq 'comparison') {
    $before = Get-OvClip (Get-OvStr $c 'before') 500
    $after = Get-OvClip (Get-OvStr $c 'after') 500
    [void]$stack.Children.Add((New-OvText ($before + '  ->  ' + $after) 13 $false $script:Ink))
    return 0
  }
  if ($type -ceq 'image_reference') { [void]$stack.Children.Add((New-OvText ('[image: ' + (Get-OvClip (Get-OvStr $c 'alt') 200) + ']') 12 $false $script:Muted)); return 0 }
  if ($type -ceq 'button' -or $type -ceq 'choice') { return (Add-OvButton $footer $c $card $wantInteractive) }
  return 0
}

function Build-OvContent($card, $body) {
  $interaction = Get-OvDict $body 'interaction'
  $style = Get-OvDict $body 'style'
  $sensitivity = Get-OvStr $body 'sensitivity'
  if ($null -eq $sensitivity) { $sensitivity = 'public' }
  $card.Sensitivity = $sensitivity
  $placement = Get-OvStr $body 'placement'
  if ($null -eq $placement) { $placement = 'top_right' }
  if ($script:Placements -ccontains $placement) { $card.Placement = $placement } else { $card.Placement = 'top_right' }
  $card.AllowedEvents = Get-OvStringList (Get-OvItems $interaction 'allowedEvents')
  $wantInteractive = Get-OvFlag $interaction 'interactive'

  $stack = New-Object System.Windows.Controls.StackPanel
  [void]$stack.Children.Add((New-OvText (Get-OvClip (Get-OvStr $body 'title') 200) 15 $true $script:Ink))
  $footer = New-Object System.Windows.Controls.StackPanel
  $footer.Orientation = [System.Windows.Controls.Orientation]::Horizontal
  $buttons = 0
  foreach ($component in (Get-OvItems $body 'components')) {
    if ($component -isnot [System.Collections.Generic.Dictionary[string,object]]) { continue }
    $buttons += (Add-OvComponent $stack $footer $component $card $wantInteractive)
  }
  if ($footer.Children.Count -gt 0) { [void]$stack.Children.Add($footer) }
  $card.Interactive = ($wantInteractive -and $buttons -gt 0)

  $frame = New-Object System.Windows.Controls.Border
  $frame.Background = $script:CardFill
  $frame.BorderBrush = Get-OvBorderFor (Get-OvStr $style 'semantic')
  $frame.BorderThickness = New-OvThickness 1 1 1 1
  $frame.CornerRadius = New-Object System.Windows.CornerRadius -ArgumentList @([double]16)
  $frame.Padding = New-OvThickness 14 14 14 14
  $frame.Child = $stack
  $card.Frame = $frame
  return $frame
}

# ---- Startup --------------------------------------------------------------------------------------------------------

$script:Ink = New-OvRgb 238 242 250
$script:Muted = New-OvRgb 160 172 196
$script:Amber = New-OvRgb 255 196 92
$script:Red = New-OvRgb 255 140 140
$script:Green = New-OvRgb 140 220 160
$script:Blue = New-OvRgb 140 180 255
$script:Rule = New-OvRgb 51 65 90
$script:StripFill = New-OvRgb 14 17 26
$script:CardFill = New-OvCardGradient
$script:CardEdge = New-OvTint 126 156 210 89

Start-OvReader
$script:Pump = New-Object System.Windows.Threading.DispatcherTimer
$script:Pump.Interval = [TimeSpan]::FromMilliseconds(15)
$script:Pump.Add_Tick({ Invoke-OvPump })
$script:Pump.Start()
[System.Windows.Threading.Dispatcher]::Run()
`;

const trimLines = (text: string): string => text.replace(/^\r?\n/, "").replace(/\r?\n$/, "");

/** The whole overlay script, written to a file and started with `powershell.exe -STA -File`. */
export const WINDOWS_OVERLAY_SCRIPT = [trimLines(POWERSHELL_HEAD), trimLines(NATIVE_PS), trimLines(RENDERER_PS)].join("\r\n").replace(/\r?\n/g, "\r\n") + "\r\n";
