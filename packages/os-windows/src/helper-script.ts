/*
 * The Windows helper: one long-lived Windows PowerShell 5.1 process (it ships with every Windows 10/11) that
 * answers JSON lines on stdin/stdout. Same shape as the GTK renderer on Linux. Requests:
 * {"id":1,"method":"windows.list","params":{...}}. Replies: {"id":1,"ok":true,"result":...} or
 * {"id":1,"ok":false,"error":{"code":"...","message":"..."}}.
 *
 * Win32 calls go through the in-memory bindings in native-ps.ts (Reflection.Emit): nothing is compiled and
 * nothing is written to disk. UI Automation runs in a worker runspace per request (uia-script.ts), with the
 * request's deadline. Keep the text free of backticks and dollar-brace: it lives in a template string.
 *
 * Input uses keybd_event and mouse_event, which inject the same events SendInput does (the overlay's guard
 * reads the same injected flag). Elevated windows are refused before any input is sent.
 */

import { NATIVE_PS } from "./native-ps.js";
import { UIA_WORKER_PS } from "./uia-script.js";

export const HELPER_PROTOCOL_VERSION = 1;

const HELPER_PS = String.raw`
function Get-HelperParam($p, [string]$key) {
  if ($null -eq $p) { return $null }
  $prop = $p.PSObject.Properties[$key]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

function Get-IntParam($p, [string]$key, [int]$fallback) {
  $value = Get-HelperParam $p $key
  if ($null -eq $value) { return $fallback }
  return [int][Math]::Round([double]$value)
}

function Get-DoubleParam($p, [string]$key, [double]$fallback) {
  $value = Get-HelperParam $p $key
  if ($null -eq $value) { return $fallback }
  return [double]$value
}

function Get-StrParam($p, [string]$key, [string]$fallback) {
  $value = Get-HelperParam $p $key
  if ($null -eq $value) { return $fallback }
  return [string]$value
}

function Throw-HelperError([string]$code, [string]$message) {
  $ex = New-Object System.Exception($message)
  $ex.Data['code'] = $code
  throw $ex
}

function Get-HwndParam($p, [string]$key) {
  $text = Get-StrParam $p $key ''
  [long]$value = 0
  if ($text.Length -eq 0 -or -not [long]::TryParse($text, [ref]$value)) { Throw-HelperError 'bad_window' 'A window handle is required.' }
  return [IntPtr][long]$value
}

function Test-IsZeroHandle([IntPtr]$hwnd) { return ($hwnd.ToInt64() -eq 0) }

# ---------- windows ----------

function Get-PingResult {
  return [ordered]@{ protocol = 1; os = [Environment]::OSVersion.VersionString; elevated = $script:selfElevated }
}

function Get-WindowRecord([IntPtr]$hwnd) {
  if ((Test-IsZeroHandle $hwnd) -or -not [AhNative.Native]::IsWindow($hwnd)) { return $null }
  $processId = Get-AhProcessId $hwnd
  $rect = Get-AhFrameRect $hwnd
  return [ordered]@{
    hwnd = $hwnd.ToInt64().ToString()
    title = (Get-AhWindowText $hwnd)
    pid = $processId
    process = (Get-AhProcessName $processId)
    x = $rect.Left
    y = $rect.Top
    width = $rect.Right - $rect.Left
    height = $rect.Bottom - $rect.Top
    minimized = [AhNative.Native]::IsIconic($hwnd)
  }
}

function Get-WindowListResult([int]$limit) {
  $script:windowCandidates = New-Object System.Collections.ArrayList
  $collect = [AhNative.EnumWindowsProc]{ param($hwnd, $lparam)
    if (-not [AhNative.Native]::IsWindowVisible($hwnd)) { return $true }
    if ([AhNative.Native]::GetWindowTextLengthW($hwnd) -eq 0) { return $true }
    if (Test-AhCloaked $hwnd) { return $true }
    [void]$script:windowCandidates.Add($hwnd)
    return $true
  }
  [void][AhNative.Native]::EnumWindows($collect, [IntPtr]::Zero)
  $list = New-Object System.Collections.ArrayList
  $truncated = $false
  foreach ($hwnd in $script:windowCandidates) {
    if ($list.Count -ge $limit) { $truncated = $true; break }
    $record = Get-WindowRecord $hwnd
    if ($null -ne $record) { [void]$list.Add($record) }
  }
  return [ordered]@{ windows = @($list.ToArray()); truncated = $truncated }
}

function Set-WindowFocus([IntPtr]$hwnd) {
  if (-not [AhNative.Native]::IsWindow($hwnd)) { Throw-HelperError 'window_gone' 'That window no longer exists.' }
  $previous = Get-WindowRecord ([AhNative.Native]::GetForegroundWindow())
  if ([AhNative.Native]::IsIconic($hwnd)) { [void][AhNative.Native]::ShowWindow($hwnd, 9) }
  [uint32]$ignored = 0
  $foregroundThread = [AhNative.Native]::GetWindowThreadProcessId([AhNative.Native]::GetForegroundWindow(), [ref]$ignored)
  $thisThread = [AhNative.Native]::GetCurrentThreadId()
  $attached = $false
  if ($foregroundThread -ne 0 -and $foregroundThread -ne $thisThread) { $attached = [AhNative.Native]::AttachThreadInput($thisThread, $foregroundThread, $true) }
  [void][AhNative.Native]::SetForegroundWindow($hwnd)
  if ($attached) { [void][AhNative.Native]::AttachThreadInput($thisThread, $foregroundThread, $false) }
  Start-Sleep -Milliseconds 80
  $focused = ([AhNative.Native]::GetForegroundWindow().ToInt64() -eq $hwnd.ToInt64())
  return [ordered]@{ focused = $focused; previous = $previous; window = (Get-WindowRecord $hwnd) }
}

# ---------- elevation (UIPI): input to a higher-integrity window is dropped, so refuse it ----------

function Test-HelperReachable([IntPtr]$hwnd) {
  if ($script:selfElevated -or (Test-IsZeroHandle $hwnd)) { return }
  $processId = Get-AhProcessId $hwnd
  if (Test-AhElevated ([uint32]$processId)) {
    Throw-HelperError 'elevated_window' 'That window runs as administrator, so Windows drops input from a normal process. Ask the person to use it themselves.'
  }
}

function Test-HelperReachableAt([int]$x, [int]$y) {
  $point = New-Object AhNative.POINT
  $point.X = $x
  $point.Y = $y
  $hwnd = [AhNative.Native]::WindowFromPoint($point)
  if (-not (Test-IsZeroHandle $hwnd)) { $hwnd = [AhNative.Native]::GetAncestor($hwnd, 2) }
  Test-HelperReachable $hwnd
}

# ---------- screen ----------

function Get-ScreenGeometry {
  $area = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return [ordered]@{ x = $area.X; y = $area.Y; width = $area.Width; height = $area.Height }
}

function Get-ScreenshotResult($p) {
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $area = $screen
  $hwndText = Get-StrParam $p 'hwnd' ''
  if ($hwndText.Length -gt 0) {
    $rect = Get-AhFrameRect (Get-HwndParam $p 'hwnd')
    $window = New-Object System.Drawing.Rectangle -ArgumentList ($rect.Left), ($rect.Top), ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
    $area = [System.Drawing.Rectangle]::Intersect($screen, $window)
  }
  $region = Get-HelperParam $p 'region'
  if ($null -ne $region) {
    $wanted = New-Object System.Drawing.Rectangle -ArgumentList ($area.X + (Get-IntParam $region 'x' 0)), ($area.Y + (Get-IntParam $region 'y' 0)), (Get-IntParam $region 'width' $area.Width), (Get-IntParam $region 'height' $area.Height)
    $area = [System.Drawing.Rectangle]::Intersect($area, $wanted)
  }
  if ($area.Width -le 0 -or $area.Height -le 0) { Throw-HelperError 'empty_capture' 'The area to capture is empty or off screen.' }
  $scale = Get-DoubleParam $p 'scale' 1.0
  if ($scale -le 0 -or $scale -gt 1) { $scale = 1.0 }
  $format = Get-StrParam $p 'format' 'png'
  $quality = Get-IntParam $p 'quality' 80

  $full = New-Object System.Drawing.Bitmap -ArgumentList $area.Width, $area.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $resized = $null
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($full)
    try {
      $size = New-Object System.Drawing.Size -ArgumentList $area.Width, $area.Height
      $graphics.CopyFromScreen($area.X, $area.Y, 0, 0, $size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    } finally { $graphics.Dispose() }
    $output = $full
    if ($scale -lt 1.0) {
      $w = [Math]::Max(1, [int][Math]::Round($area.Width * $scale))
      $h = [Math]::Max(1, [int][Math]::Round($area.Height * $scale))
      $resized = New-Object System.Drawing.Bitmap -ArgumentList $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $scaler = [System.Drawing.Graphics]::FromImage($resized)
      try {
        $scaler.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $scaler.DrawImage($full, 0, 0, $w, $h)
      } finally { $scaler.Dispose() }
      $output = $resized
    }
    $stream = New-Object System.IO.MemoryStream
    try {
      if ($format -eq 'jpeg') {
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        $encoder = New-Object System.Drawing.Imaging.EncoderParameters -ArgumentList 1
        $qualityValue = [long][Math]::Max(1, [Math]::Min(100, $quality))
        $encoder.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter -ArgumentList ([System.Drawing.Imaging.Encoder]::Quality), $qualityValue
        $output.Save($stream, $codec, $encoder)
      } else {
        $output.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      }
      return [ordered]@{
        data = [Convert]::ToBase64String($stream.ToArray())
        width = $output.Width
        height = $output.Height
        originX = $area.X
        originY = $area.Y
        captureWidth = $area.Width
        captureHeight = $area.Height
      }
    } finally { $stream.Dispose() }
  } finally {
    if ($null -ne $resized) { $resized.Dispose() }
    $full.Dispose()
  }
}

# ---------- input (keybd_event and mouse_event inject flagged events, like SendInput) ----------

function Get-MouseFlags([string]$button) {
  if ($button -eq 'right') { return @([uint32]0x0008, [uint32]0x0010) }
  if ($button -eq 'middle') { return @([uint32]0x0020, [uint32]0x0040) }
  return @([uint32]0x0002, [uint32]0x0004)
}

function Invoke-Move([int]$x, [int]$y) {
  Test-HelperReachableAt $x $y
  [void][AhNative.Native]::SetCursorPos($x, $y)
  return [ordered]@{ x = $x; y = $y }
}

function Invoke-Click($p) {
  $x = Get-IntParam $p 'x' 0
  $y = Get-IntParam $p 'y' 0
  $count = [Math]::Max(1, [Math]::Min(3, (Get-IntParam $p 'count' 1)))
  $flags = Get-MouseFlags (Get-StrParam $p 'button' 'left')
  Test-HelperReachableAt $x $y
  [void][AhNative.Native]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 30
  for ($i = 0; $i -lt $count; $i++) {
    [AhNative.Native]::mouse_event($flags[0], 0, 0, 0, [IntPtr]::Zero)
    [AhNative.Native]::mouse_event($flags[1], 0, 0, 0, [IntPtr]::Zero)
    if ($i + 1 -lt $count) { Start-Sleep -Milliseconds 60 }
  }
  return [ordered]@{ x = $x; y = $y }
}

function Invoke-Scroll($p) {
  if ($null -ne (Get-HelperParam $p 'x') -and $null -ne (Get-HelperParam $p 'y')) {
    $x = Get-IntParam $p 'x' 0
    $y = Get-IntParam $p 'y' 0
    Test-HelperReachableAt $x $y
    [void][AhNative.Native]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 30
  }
  $vertical = Get-IntParam $p 'vertical' 0
  $horizontal = Get-IntParam $p 'horizontal' 0
  if ($vertical -ne 0) { [AhNative.Native]::mouse_event([uint32]0x0800, 0, 0, [uint32](($vertical * 120) -band 0xFFFFFFFF), [IntPtr]::Zero) }
  if ($horizontal -ne 0) { [AhNative.Native]::mouse_event([uint32]0x1000, 0, 0, [uint32](($horizontal * 120) -band 0xFFFFFFFF), [IntPtr]::Zero) }
  return [ordered]@{ vertical = $vertical; horizontal = $horizontal }
}

function Invoke-Drag($p) {
  $x1 = Get-IntParam $p 'x1' 0
  $y1 = Get-IntParam $p 'y1' 0
  $x2 = Get-IntParam $p 'x2' 0
  $y2 = Get-IntParam $p 'y2' 0
  $duration = [Math]::Max(50, [Math]::Min(10000, (Get-IntParam $p 'durationMs' 300)))
  Test-HelperReachableAt $x1 $y1
  [void][AhNative.Native]::SetCursorPos($x1, $y1)
  Start-Sleep -Milliseconds 40
  [AhNative.Native]::mouse_event([uint32]0x0002, 0, 0, 0, [IntPtr]::Zero)
  $steps = [Math]::Max(4, [int][Math]::Floor($duration / 25))
  for ($i = 1; $i -le $steps; $i++) {
    [void][AhNative.Native]::SetCursorPos([int]($x1 + ($x2 - $x1) * $i / $steps), [int]($y1 + ($y2 - $y1) * $i / $steps))
    Start-Sleep -Milliseconds ([int][Math]::Floor($duration / $steps))
  }
  [AhNative.Native]::mouse_event([uint32]0x0004, 0, 0, 0, [IntPtr]::Zero)
  return [ordered]@{ x = $x2; y = $y2 }
}

function Send-KeyEvent([int]$vk, [bool]$up) {
  $flags = [uint32]0
  if ($up) { $flags = $flags -bor [uint32]0x0002 }
  if (($vk -ge 0x21 -and $vk -le 0x28) -or $vk -eq 0x2d -or $vk -eq 0x2e -or $vk -eq 0x5b) { $flags = $flags -bor [uint32]0x0001 }
  $scan = [byte]([AhNative.Native]::MapVirtualKeyW([uint32]$vk, 0) -band 0xFF)
  [AhNative.Native]::keybd_event([byte]$vk, $scan, $flags, [IntPtr]::Zero)
}

function Invoke-Keys($p) {
  $raw = Get-HelperParam $p 'vks'
  if ($null -eq $raw) { Throw-HelperError 'bad_keys' 'vks is required.' }
  $vks = @($raw | ForEach-Object { [int]$_ })
  if ($vks.Count -eq 0) { Throw-HelperError 'bad_keys' 'No keys were given.' }
  $repeat = [Math]::Max(1, [Math]::Min(50, (Get-IntParam $p 'repeat' 1)))
  $delay = [Math]::Max(0, [Math]::Min(1000, (Get-IntParam $p 'delayMs' 20)))
  Test-HelperReachable ([AhNative.Native]::GetForegroundWindow())
  for ($round = 0; $round -lt $repeat; $round++) {
    foreach ($vk in $vks) { Send-KeyEvent $vk $false }
    for ($i = $vks.Count - 1; $i -ge 0; $i--) { Send-KeyEvent $vks[$i] $true }
    if ($round + 1 -lt $repeat -and $delay -gt 0) { Start-Sleep -Milliseconds $delay }
  }
  return [ordered]@{ sent = $repeat }
}

# ---------- clipboard (this process runs on an STA thread) ----------

function Get-ClipboardResult {
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try {
      $text = $null
      if ([System.Windows.Forms.Clipboard]::ContainsText()) { $text = [System.Windows.Forms.Clipboard]::GetText() }
      return [ordered]@{ text = $text }
    } catch [System.Runtime.InteropServices.ExternalException] {
      Start-Sleep -Milliseconds 60
    }
  }
  Throw-HelperError 'clipboard_busy' 'Another program is holding the clipboard.'
}

function Set-ClipboardResult([string]$text) {
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try {
      if ($text.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() } else { [System.Windows.Forms.Clipboard]::SetDataObject($text, $true) }
      return [ordered]@{ length = $text.Length }
    } catch [System.Runtime.InteropServices.ExternalException] {
      Start-Sleep -Milliseconds 60
    }
  }
  Throw-HelperError 'clipboard_busy' 'Another program is holding the clipboard.'
}

function Get-IdleResult {
  $info = New-Object AhNative.LASTINPUTINFO
  $info.cbSize = [uint32]8
  if (-not [AhNative.Native]::GetLastInputInfo([ref]$info)) { Throw-HelperError 'idle_unavailable' 'Windows did not report the last input time.' }
  [long]$tick = [long][AhNative.Native]::GetTickCount64()
  [long]$idle = (($tick -band 4294967295) - [long]$info.dwTime) -band 4294967295
  return [ordered]@{ idleMs = [long]$idle }
}

function Invoke-HelperMethod([string]$method, $p) {
  switch ($method) {
    'ping' { return Get-PingResult }
    'windows.list' { return Get-WindowListResult (Get-IntParam $p 'limit' 50) }
    'window.active' { return Get-WindowRecord ([AhNative.Native]::GetForegroundWindow()) }
    'window.focus' { return Set-WindowFocus (Get-HwndParam $p 'hwnd') }
    'screenshot' { return Get-ScreenshotResult $p }
    'screen.geometry' { return Get-ScreenGeometry }
    'input.move' { return Invoke-Move (Get-IntParam $p 'x' 0) (Get-IntParam $p 'y' 0) }
    'input.click' { return Invoke-Click $p }
    'input.scroll' { return Invoke-Scroll $p }
    'input.drag' { return Invoke-Drag $p }
    'input.keys' { return Invoke-Keys $p }
    'clipboard.get' { return Get-ClipboardResult }
    'clipboard.set' { return Set-ClipboardResult (Get-StrParam $p 'text' '') }
    'idle' { return Get-IdleResult }
    default { Throw-HelperError 'unknown_method' ('Unknown method ' + $method) }
  }
}

# ---------- UI Automation: the requests run in a worker runspace with a deadline ----------

function Get-UiaRunspace {
  if ($null -ne $script:uiaSpare) {
    $spare = $script:uiaSpare
    $script:uiaSpare = $null
    return $spare
  }
  $runspace = [runspacefactory]::CreateRunspace()
  $runspace.ApartmentState = [System.Threading.ApartmentState]::MTA
  $runspace.ThreadOptions = [System.Management.Automation.Runspaces.PSThreadOptions]::ReuseThread
  $runspace.Open()
  $init = [System.Management.Automation.PowerShell]::Create()
  $init.Runspace = $runspace
  [void]$init.AddScript($script:uiaDefinitions)
  [void]$init.Invoke()
  return $runspace
}

function Get-UiaRoots([string]$method, $p) {
  if ($method -eq 'uia.textAtPoint') {
    Test-HelperReachableAt (Get-IntParam $p 'x' 0) (Get-IntParam $p 'y' 0)
    return @()
  }
  $hwndText = Get-StrParam $p 'hwnd' ''
  if ($hwndText.Length -gt 0) {
    [long]$value = 0
    if (-not [long]::TryParse($hwndText, [ref]$value)) { Throw-HelperError 'bad_window' 'A window handle is required.' }
    $hwnd = [IntPtr][long]$value
    if (-not [AhNative.Native]::IsWindow($hwnd)) { Throw-HelperError 'window_gone' 'That window no longer exists.' }
    Test-HelperReachable $hwnd
    return @([long]$value)
  }
  if ($null -ne (Get-HelperParam $p 'elementId')) { return @() }
  $processId = Get-IntParam $p 'pid' 0
  if ($processId -le 0) { Throw-HelperError 'bad_target' 'A window handle or a process id is required.' }
  $found = @(Get-AhWindowsOfProcess $processId)
  $roots = New-Object System.Collections.ArrayList
  foreach ($hwnd in $found) {
    Test-HelperReachable $hwnd
    [void]$roots.Add([long]$hwnd.ToInt64())
  }
  return $roots.ToArray()
}

function Invoke-UiaAsync([string]$method, $p, $roots) {
  $timeout = [Math]::Max(1000, [Math]::Min(30000, (Get-IntParam $p 'timeoutMs' 8000)))
  if ($method -eq 'uia.tree' -and $roots.Count -eq 0) {
    return [ordered]@{ root = $null; nodeCount = 0; truncated = $false; redacted = $false; timedOut = $false; found = $false }
  }
  $state = [hashtable]::Synchronized(@{
    cancel = $false; done = $false; root = $null; result = $null; count = 0; truncated = $false; redacted = $false
    failure = $null; phase = ''; selfElevated = $script:selfElevated; items = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
  })
  $runspace = Get-UiaRunspace
  $worker = [System.Management.Automation.PowerShell]::Create()
  $worker.Runspace = $runspace
  [void]$worker.AddScript('param($method, $p, $roots, $state) Invoke-UiaWorker $method $p $roots $state')
  [void]$worker.AddArgument($method)
  [void]$worker.AddArgument($p)
  [void]$worker.AddArgument($roots)
  [void]$worker.AddArgument($state)
  $async = $worker.BeginInvoke()
  $finished = $async.AsyncWaitHandle.WaitOne($timeout)
  $state.cancel = $true
  if ($finished) {
    [void]$worker.EndInvoke($async)
    $worker.Dispose()
    $script:uiaSpare = $runspace
  }
  if ($finished -and $null -ne $state.failure) {
    Throw-HelperError ([string]$state.failure.code) ([string]$state.failure.message)
  }
  switch ($method) {
    'uia.tree' {
      return [ordered]@{ root = $state.root; nodeCount = $state.count; truncated = ($state.truncated -or -not $finished); redacted = $state.redacted; timedOut = (-not $finished); found = ($null -ne $state.root) }
    }
    'uia.find' {
      $limit = [Math]::Max(1, [Math]::Min(50, (Get-IntParam $p 'limit' 10)))
      $ranked = New-Object System.Collections.ArrayList
      $index = 0
      foreach ($item in @($state.items.ToArray())) {
        [void]$ranked.Add([ordered]@{ order = $index; confidence = [double]$item['confidence']; item = $item })
        $index++
      }
      $sorted = @($ranked.ToArray() | Sort-Object -Property @{ Expression = { $_.confidence }; Descending = $true }, @{ Expression = { $_.order }; Descending = $false })
      $candidates = @($sorted | Select-Object -First $limit | ForEach-Object { $_.item })
      return [ordered]@{ candidates = $candidates; truncated = ($state.truncated -or -not $finished); timedOut = (-not $finished); windows = $roots.Count }
    }
    default {
      if ($finished) {
        if ($null -eq $state.result) { Throw-HelperError 'uia_error' ('UI Automation gave no answer for ' + $method + '.') }
        return $state.result
      }
      $partial = $state.result
      if ($null -ne $partial -and $state.phase -eq 'acting') {
        # The call went out but the app has not returned (a modal dialog blocks Invoke until it closes).
        $late = [ordered]@{}
        foreach ($key in $partial.Keys) { $late[$key] = $partial[$key] }
        $late['timedOut'] = $true
        if ($method -eq 'uia.activate') {
          $late['performed'] = $true
          $late['reason'] = 'The action was sent, but the app did not return in time (a dialog may be open). Check the screen.'
        } elseif ($method -eq 'uia.setText') {
          $late['changed'] = $true
          $late['reason'] = 'The value was sent, but the app did not return in time. Read it back to check.'
        }
        return $late
      }
      Throw-HelperError 'uia_timeout' 'The app did not answer UI Automation in time. It may be busy or hung.'
    }
  }
}

function ConvertTo-HelperReply($id, $result) {
  return (ConvertTo-Json -InputObject ([ordered]@{ id = $id; ok = $true; result = $result }) -Depth 30 -Compress)
}

function ConvertTo-HelperFailure($id, [string]$code, [string]$message) {
  $error = [ordered]@{ code = $code; message = (Get-AhPlain $message) }
  return (ConvertTo-Json -InputObject ([ordered]@{ id = $id; ok = $false; error = $error }) -Depth 5 -Compress)
}

function Get-ExceptionCode($exception) {
  if ($exception.Data.Contains('code')) { return [string]$exception.Data['code'] }
  return ''
}

function Invoke-HelperLine([string]$line) {
  $request = $null
  try { $request = $line | ConvertFrom-Json } catch { return (ConvertTo-HelperFailure $null 'helper_exception' 'The request is not valid JSON.') }
  $id = $request.id
  try {
    $result = Invoke-HelperMethod ([string]$request.method) $request.params
    return (ConvertTo-HelperReply $id $result)
  } catch {
    $code = Get-ExceptionCode $_.Exception
    if ($code.Length -gt 0) { return (ConvertTo-HelperFailure $id $code $_.Exception.Message) }
    return (ConvertTo-HelperFailure $id 'helper_exception' ($_.Exception.GetType().Name + ': ' + $_.Exception.Message))
  }
}

function Invoke-UiaLine([string]$line) {
  $request = $null
  try { $request = $line | ConvertFrom-Json } catch { return (ConvertTo-HelperFailure $null 'helper_exception' 'The request is not valid JSON.') }
  $id = $request.id
  $method = [string]$request.method
  try {
    if ($method -eq 'uia.ping') { return (ConvertTo-HelperReply $id ([ordered]@{ uia = $true; elevated = $script:selfElevated })) }
    if ($script:uiaError.Length -gt 0) { return (ConvertTo-HelperFailure $id 'uia_unavailable' ('UI Automation could not be loaded: ' + $script:uiaError)) }
    $roots = @(Get-UiaRoots $method $request.params)
    $result = Invoke-UiaAsync $method $request.params $roots
    return (ConvertTo-HelperReply $id $result)
  } catch {
    $code = Get-ExceptionCode $_.Exception
    if ($code.Length -gt 0) { return (ConvertTo-HelperFailure $id $code $_.Exception.Message) }
    return (ConvertTo-HelperFailure $id 'helper_exception' ($_.Exception.GetType().Name + ': ' + $_.Exception.Message))
  }
}
`;

const HELPER_HEAD = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$script:uiaError = ''
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
} catch {
  $script:uiaError = (($_.Exception.Message -replace '\s+', ' ') -replace '[\\"]', ' ')
  if ($script:uiaError.Length -gt 600) { $script:uiaError = $script:uiaError.Substring(0, 600) }
}
$script:uiaSpare = $null
`;

const HELPER_LOOP = String.raw`
[AhNative.Native]::SetProcessDPIAware() | Out-Null
$script:selfElevated = Test-AhElevated ([uint32]$PID)
$reader = [Console]::In
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  if ($line.IndexOf('"method":"uia.') -ge 0) {
    [Console]::Out.WriteLine((Invoke-UiaLine $line))
  } else {
    [Console]::Out.WriteLine((Invoke-HelperLine $line))
  }
  [Console]::Out.Flush()
}
`;

/** The definitions the UI Automation worker runs once in each new runspace: the bindings and the worker. */
const UIA_DEFINITIONS = [NATIVE_PS, UIA_WORKER_PS].join("\r\n");

/** The whole script, written to a file and started with `powershell.exe -STA -File`. */
export const HELPER_SCRIPT = [
  HELPER_HEAD.replace(/^\n/, "").replace(/\n$/, ""),
  NATIVE_PS.replace(/^\n/, "").replace(/\n$/, ""),
  HELPER_PS.replace(/^\n/, "").replace(/\n$/, ""),
  "$script:uiaDefinitions = @'",
  UIA_DEFINITIONS,
  "'@",
  HELPER_LOOP.replace(/^\n/, "").replace(/\n$/, "")
].join("\r\n").replace(/\r?\n/g, "\r\n") + "\r\n";
