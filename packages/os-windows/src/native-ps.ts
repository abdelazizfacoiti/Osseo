/*
 * The Win32 bindings the Windows helper and the overlay use, written as PowerShell 5.1 text.
 *
 * Nothing here is compiled and nothing is written to disk. Initialize-AhNative builds a dynamic assembly
 * in memory with System.Reflection.Emit: the delegate types and the P/Invoke signatures exist only in this
 * process. (The earlier approach ran Add-Type on C# source, which wrote a compiled DLL into the temp folder;
 * antivirus quarantined it, and that DLL is what IT would not approve.)
 *
 * Calls go through [AhNative.Native]. Structs are AhNative.RECT, POINT and LASTINPUTINFO. Callbacks are
 * PowerShell script blocks converted to the generated delegate types. Keep this text free of backticks and
 * dollar-brace, because it lives in a template string.
 */

export const NATIVE_PS = String.raw`
function Initialize-AhNative {
  foreach ($existing in [AppDomain]::CurrentDomain.GetAssemblies()) {
    if ($existing.GetName().Name -eq 'AhNative') { return }
  }
  $assembly = [System.Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly((New-Object System.Reflection.AssemblyName 'AhNative'), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('AhNative')

  function New-AhStruct([string]$name, [string[]]$fieldNames, [type[]]$fieldTypes) {
    $builder = $module.DefineType('AhNative.' + $name, 'Public, Sealed, SequentialLayout', [System.ValueType])
    for ($i = 0; $i -lt $fieldNames.Length; $i++) { [void]$builder.DefineField($fieldNames[$i], $fieldTypes[$i], 'Public') }
    return $builder.CreateType()
  }

  function New-AhDelegate([string]$name, [type]$returnType, [type[]]$parameterTypes) {
    $builder = $module.DefineType('AhNative.' + $name, 'Sealed, AutoClass, Public', [System.MulticastDelegate])
    $ctor = $builder.DefineConstructor('RTSpecialName, HideBySig, Public', [System.Reflection.CallingConventions]::Standard, @([object], [IntPtr]))
    $ctor.SetImplementationFlags('Runtime, Managed')
    $invoke = $builder.DefineMethod('Invoke', 'Public, HideBySig, NewSlot, Virtual', $returnType, $parameterTypes)
    $invoke.SetImplementationFlags('Runtime, Managed')
    return $builder.CreateType()
  }

  $rectType = New-AhStruct 'RECT' @('Left', 'Top', 'Right', 'Bottom') @([int], [int], [int], [int])
  $pointType = New-AhStruct 'POINT' @('X', 'Y') @([int], [int])
  $lastInputType = New-AhStruct 'LASTINPUTINFO' @('cbSize', 'dwTime') @([uint32], [uint32])
  $enumType = New-AhDelegate 'EnumWindowsProc' ([bool]) ([type[]]@([IntPtr], [IntPtr]))
  $hookType = New-AhDelegate 'LowLevelMouseProc' ([IntPtr]) ([type[]]@([int], [IntPtr], [IntPtr]))

  $native = $module.DefineType('AhNative.Native', 'Public, Abstract, Sealed, Class')
  $flags = 'Public, Static, PinvokeImpl'
  $callConv = [System.Runtime.InteropServices.CallingConvention]::Winapi
  $charSet = [System.Runtime.InteropServices.CharSet]::Unicode
  $standard = [System.Reflection.CallingConventions]::Standard
  function Add-AhPinvoke([string]$name, [string]$dll, [string]$entry, [type]$returnType, [type[]]$parameterTypes) {
    $method = $native.DefinePInvokeMethod($name, $dll, $entry, $flags, $standard, $returnType, $parameterTypes, $callConv, $charSet)
    $method.SetImplementationFlags('PreserveSig')
  }

  Add-AhPinvoke 'EnumWindows' 'user32.dll' 'EnumWindows' ([bool]) ([type[]]@($enumType, [IntPtr]))
  Add-AhPinvoke 'IsWindowVisible' 'user32.dll' 'IsWindowVisible' ([bool]) ([type[]]@([IntPtr]))
  Add-AhPinvoke 'IsWindow' 'user32.dll' 'IsWindow' ([bool]) ([type[]]@([IntPtr]))
  Add-AhPinvoke 'IsIconic' 'user32.dll' 'IsIconic' ([bool]) ([type[]]@([IntPtr]))
  Add-AhPinvoke 'GetWindowTextLengthW' 'user32.dll' 'GetWindowTextLengthW' ([int]) ([type[]]@([IntPtr]))
  Add-AhPinvoke 'GetWindowTextW' 'user32.dll' 'GetWindowTextW' ([int]) ([type[]]@([IntPtr], [System.Text.StringBuilder], [int]))
  Add-AhPinvoke 'GetWindowThreadProcessId' 'user32.dll' 'GetWindowThreadProcessId' ([uint32]) ([type[]]@([IntPtr], [uint32].MakeByRefType()))
  Add-AhPinvoke 'GetForegroundWindow' 'user32.dll' 'GetForegroundWindow' ([IntPtr]) ([type[]]@())
  Add-AhPinvoke 'SetForegroundWindow' 'user32.dll' 'SetForegroundWindow' ([bool]) ([type[]]@([IntPtr]))
  Add-AhPinvoke 'ShowWindow' 'user32.dll' 'ShowWindow' ([bool]) ([type[]]@([IntPtr], [int]))
  Add-AhPinvoke 'GetWindowRect' 'user32.dll' 'GetWindowRect' ([bool]) ([type[]]@([IntPtr], $rectType.MakeByRefType()))
  Add-AhPinvoke 'AttachThreadInput' 'user32.dll' 'AttachThreadInput' ([bool]) ([type[]]@([uint32], [uint32], [bool]))
  Add-AhPinvoke 'SetCursorPos' 'user32.dll' 'SetCursorPos' ([bool]) ([type[]]@([int], [int]))
  Add-AhPinvoke 'keybd_event' 'user32.dll' 'keybd_event' ([void]) ([type[]]@([byte], [byte], [uint32], [IntPtr]))
  Add-AhPinvoke 'mouse_event' 'user32.dll' 'mouse_event' ([void]) ([type[]]@([uint32], [int], [int], [uint32], [IntPtr]))
  Add-AhPinvoke 'MapVirtualKeyW' 'user32.dll' 'MapVirtualKeyW' ([uint32]) ([type[]]@([uint32], [uint32]))
  Add-AhPinvoke 'GetLastInputInfo' 'user32.dll' 'GetLastInputInfo' ([bool]) ([type[]]@($lastInputType.MakeByRefType()))
  Add-AhPinvoke 'WindowFromPoint' 'user32.dll' 'WindowFromPoint' ([IntPtr]) ([type[]]@($pointType))
  Add-AhPinvoke 'GetAncestor' 'user32.dll' 'GetAncestor' ([IntPtr]) ([type[]]@([IntPtr], [uint32]))
  Add-AhPinvoke 'SetWindowsHookExW' 'user32.dll' 'SetWindowsHookExW' ([IntPtr]) ([type[]]@([int], $hookType, [IntPtr], [uint32]))
  Add-AhPinvoke 'UnhookWindowsHookEx' 'user32.dll' 'UnhookWindowsHookEx' ([bool]) ([type[]]@([IntPtr]))
  Add-AhPinvoke 'CallNextHookEx' 'user32.dll' 'CallNextHookEx' ([IntPtr]) ([type[]]@([IntPtr], [int], [IntPtr], [IntPtr]))
  Add-AhPinvoke 'GetWindowLongW' 'user32.dll' 'GetWindowLongW' ([int]) ([type[]]@([IntPtr], [int]))
  Add-AhPinvoke 'SetWindowLongW' 'user32.dll' 'SetWindowLongW' ([int]) ([type[]]@([IntPtr], [int], [int]))
  Add-AhPinvoke 'RegisterWindowMessageW' 'user32.dll' 'RegisterWindowMessageW' ([uint32]) ([type[]]@([string]))
  Add-AhPinvoke 'SetProcessDPIAware' 'user32.dll' 'SetProcessDPIAware' ([bool]) ([type[]]@())
  Add-AhPinvoke 'DwmGetWindowAttributeRect' 'dwmapi.dll' 'DwmGetWindowAttribute' ([int]) ([type[]]@([IntPtr], [int], $rectType.MakeByRefType(), [int]))
  Add-AhPinvoke 'DwmGetWindowAttributeInt' 'dwmapi.dll' 'DwmGetWindowAttribute' ([int]) ([type[]]@([IntPtr], [int], [int].MakeByRefType(), [int]))
  Add-AhPinvoke 'GetCurrentThreadId' 'kernel32.dll' 'GetCurrentThreadId' ([uint32]) ([type[]]@())
  Add-AhPinvoke 'GetTickCount64' 'kernel32.dll' 'GetTickCount64' ([uint64]) ([type[]]@())
  Add-AhPinvoke 'OpenProcess' 'kernel32.dll' 'OpenProcess' ([IntPtr]) ([type[]]@([uint32], [bool], [uint32]))
  Add-AhPinvoke 'CloseHandle' 'kernel32.dll' 'CloseHandle' ([bool]) ([type[]]@([IntPtr]))
  Add-AhPinvoke 'GetModuleHandleW' 'kernel32.dll' 'GetModuleHandleW' ([IntPtr]) ([type[]]@([string]))
  Add-AhPinvoke 'GetStdHandle' 'kernel32.dll' 'GetStdHandle' ([IntPtr]) ([type[]]@([int]))
  Add-AhPinvoke 'PeekNamedPipe' 'kernel32.dll' 'PeekNamedPipe' ([bool]) ([type[]]@([IntPtr], [IntPtr], [uint32], [IntPtr], [uint32].MakeByRefType(), [IntPtr]))
  Add-AhPinvoke 'OpenProcessToken' 'advapi32.dll' 'OpenProcessToken' ([bool]) ([type[]]@([IntPtr], [uint32], [IntPtr].MakeByRefType()))
  Add-AhPinvoke 'GetTokenInformation' 'advapi32.dll' 'GetTokenInformation' ([bool]) ([type[]]@([IntPtr], [int], [IntPtr], [uint32], [uint32].MakeByRefType()))
  Add-AhPinvoke 'SHAppBarMessage' 'shell32.dll' 'SHAppBarMessage' ([IntPtr]) ([type[]]@([uint32], [IntPtr]))

  [void]$native.CreateType()
}

# Shared helpers, used by the helper, the UI Automation worker and the overlay.
function Get-AhWindowText([IntPtr]$hwnd) {
  $length = [AhNative.Native]::GetWindowTextLengthW($hwnd)
  $text = New-Object System.Text.StringBuilder ($length + 1)
  [void][AhNative.Native]::GetWindowTextW($hwnd, $text, $text.Capacity)
  return $text.ToString()
}

function Get-AhProcessId([IntPtr]$hwnd) {
  [uint32]$processId = 0
  [void][AhNative.Native]::GetWindowThreadProcessId($hwnd, [ref]$processId)
  return [int]$processId
}

function Get-AhProcessName([int]$processId) {
  try { return (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { return "" }
}

# The visible frame (the DWM extended frame, without the invisible resize border), or the GetWindowRect frame.
function Get-AhFrameRect([IntPtr]$hwnd) {
  $rect = New-Object AhNative.RECT
  if ([AhNative.Native]::DwmGetWindowAttributeRect($hwnd, 9, [ref]$rect, 16) -ne 0) {
    [void][AhNative.Native]::GetWindowRect($hwnd, [ref]$rect)
  }
  return $rect
}

function Test-AhCloaked([IntPtr]$hwnd) {
  [int]$cloaked = 0
  if ([AhNative.Native]::DwmGetWindowAttributeInt($hwnd, 14, [ref]$cloaked, 4) -ne 0) { return $false }
  return ($cloaked -ne 0)
}

# True when the process runs as administrator. Input to such a window is dropped (UIPI), so it must be refused.
function Test-AhElevated([uint32]$processId) {
  $process = [AhNative.Native]::OpenProcess(0x1000, $false, $processId)
  if ($process -eq [IntPtr]::Zero) { return $true }
  try {
    [IntPtr]$token = [IntPtr]::Zero
    if (-not [AhNative.Native]::OpenProcessToken($process, 8, [ref]$token)) { return $true }
    try {
      $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(4)
      try {
        [uint32]$returned = 0
        if (-not [AhNative.Native]::GetTokenInformation($token, 20, $buffer, 4, [ref]$returned)) { return $true }
        return ([System.Runtime.InteropServices.Marshal]::ReadInt32($buffer) -ne 0)
      } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
    } finally { [void][AhNative.Native]::CloseHandle($token) }
  } finally { [void][AhNative.Native]::CloseHandle($process) }
}

# Visible, titled, not cloaked top-level windows of one process.
function Get-AhWindowsOfProcess([int]$processId) {
  $found = New-Object System.Collections.ArrayList
  $foreground = [AhNative.Native]::GetForegroundWindow()
  $collect = [AhNative.EnumWindowsProc]{ param($hwnd, $lparam)
    if (-not [AhNative.Native]::IsWindowVisible($hwnd)) { return $true }
    if ((Get-AhProcessId $hwnd) -ne $processId) { return $true }
    if ($hwnd -ne $foreground -and [AhNative.Native]::GetWindowTextLengthW($hwnd) -eq 0) { return $true }
    if (Test-AhCloaked $hwnd) { return $true }
    if ($hwnd -eq $foreground) { [void]$found.Insert(0, $hwnd) }
    elseif ($found.Count -lt 8) { [void]$found.Add($hwnd) }
    return $true
  }
  [void][AhNative.Native]::EnumWindows($collect, [IntPtr]::Zero)
  return $found.ToArray()
}

# Keep the text of a single line: JSON replies must not contain raw newlines or tabs.
function Get-AhPlain([string]$text) {
  if ($null -eq $text) { return "" }
  return ($text -replace "[
	]+", " ")
}

Initialize-AhNative
`;
