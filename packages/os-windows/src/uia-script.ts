/*
 * The UI Automation half of the Windows helper, in PowerShell 5.1. It runs in a worker runspace (MTA), one
 * per request, so a hung app blocks only that worker: the main loop waits for the worker up to the
 * request's deadline and returns what the worker has (truncated: true). The worker is left to finish on its
 * own, the same rule as the earlier C# worker thread.
 *
 * The managed UI Automation API (System.Windows.Automation) is used directly: nothing is compiled. No
 * AutomationElement is kept between requests; an element id is a window handle, a child-index path and a
 * hash of role and name, and is walked again on each call.
 *
 * Rules that must hold (the tests check them): a password or credential field is never read, its text is
 * never returned, and ui.set_text refuses it; a window of an administrator process is refused; the roles use
 * the Linux names; invoke, toggle, select and expand are the only ways an action runs.
 *
 * Text lives in a template string: no backtick and no dollar-brace.
 */

export const UIA_WORKER_PS = String.raw`
$global:ahSecretPattern = [regex]::new('password|passwd|passcode|passphrase|secret|token|api[ _-]?key|credential|private key|one[- ]time|\botp\b|\bcvv\b|\bcvc\b|card number|security code|\bpin\b|\bssn\b', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
$global:ahMaxSiblings = 200
$global:ahMaxDepth = 14

function Get-UiaNowMs { return [long]([DateTime]::UtcNow.Ticks / 10000) }

# The walk stops a little before the request's join times out, so a slow tree still returns what it has.
function Get-UiaDeadline([int]$timeoutMs) { return (Get-UiaNowMs) + [Math]::Max(500, $timeoutMs - 800) }

function Test-UiaStop($state, [long]$deadline) {
  if ($state.cancel) { return $true }
  return ((Get-UiaNowMs) -gt $deadline)
}

function Get-UiaClip([string]$value, [int]$limit) {
  if ($null -eq $value) { return $null }
  if ($value.Length -gt $limit) { return $value.Substring(0, $limit) + '...' }
  return $value
}

function Throw-UiaError([string]$code, [string]$message) {
  $ex = New-Object System.Exception($message)
  $ex.Data['code'] = $code
  throw $ex
}

function Test-UiaEditLike($type) {
  $id = $type.Id
  return ($id -eq [System.Windows.Automation.ControlType]::Edit.Id -or $id -eq [System.Windows.Automation.ControlType]::Document.Id -or $id -eq [System.Windows.Automation.ControlType]::ComboBox.Id -or $id -eq [System.Windows.Automation.ControlType]::Spinner.Id)
}

function Get-UiaRole($type, [bool]$password) {
  if ($password) { return 'password text' }
  $name = [string]$type.ProgrammaticName
  $dot = $name.LastIndexOf('.')
  if ($dot -ge 0) { $name = $name.Substring($dot + 1) }
  switch ($name) {
    'Button' { return 'push button' }
    'SplitButton' { return 'push button' }
    'CheckBox' { return 'check box' }
    'RadioButton' { return 'radio button' }
    'ComboBox' { return 'combo box' }
    'Edit' { return 'entry' }
    'Hyperlink' { return 'link' }
    'MenuItem' { return 'menu item' }
    'Menu' { return 'menu' }
    'MenuBar' { return 'menu bar' }
    'TabItem' { return 'page tab' }
    'Tab' { return 'page tab list' }
    'ListItem' { return 'list item' }
    'List' { return 'list' }
    'DataItem' { return 'list item' }
    'DataGrid' { return 'table' }
    'Table' { return 'table' }
    'Text' { return 'label' }
    'Image' { return 'image' }
    'ToolBar' { return 'tool bar' }
    'ToolTip' { return 'tool tip' }
    'Tree' { return 'tree' }
    'TreeItem' { return 'tree item' }
    'ScrollBar' { return 'scroll bar' }
    'Slider' { return 'slider' }
    'Spinner' { return 'spin button' }
    'ProgressBar' { return 'progress bar' }
    'StatusBar' { return 'status bar' }
    'TitleBar' { return 'title bar' }
    'Separator' { return 'separator' }
    'Window' { return 'window' }
    'Pane' { return 'panel' }
    'Group' { return 'panel' }
    'Document' { return 'document' }
    'Header' { return 'table column header' }
    'HeaderItem' { return 'table column header' }
    'Calendar' { return 'calendar' }
    'Thumb' { return 'thumb' }
    'AppBar' { return 'tool bar' }
    'Custom' { return 'unknown' }
    default { return $name.ToLowerInvariant() }
  }
}

# Reads one element once. Returns $null when the element cannot be read.
function Read-UiaFacts($element) {
  try {
    $info = $element.Current
    $type = $info.ControlType
    $name = ''
    if ($null -ne $info.Name) { $name = $info.Name.Trim() }
    $automationId = ''
    if ($null -ne $info.AutomationId) { $automationId = [string]$info.AutomationId }
    $facts = @{ type = $type; role = 'unknown'; name = $name; automationId = $automationId; password = $false; sensitive = $false; hidden = $false; enabled = [bool]$info.IsEnabled; hasRect = $false; x = 0; y = 0; w = 0; h = 0; pid = [int]$info.ProcessId }
    $facts.hidden = [bool]$info.IsOffscreen
    $editLike = Test-UiaEditLike $type
    if ($editLike) {
      # An unreadable flag counts as a password: the safe side.
      try { $facts.password = (($type.Id -eq [System.Windows.Automation.ControlType]::Edit.Id) -and [bool]$info.IsPassword) } catch { $facts.password = $true }
      if ($facts.name.Length -eq 0) {
        try {
          $label = $info.LabeledBy
          if ($null -ne $label) { $facts.name = ([string]$label.Current.Name).Trim() }
        } catch { }
      }
    }
    $facts.role = Get-UiaRole $type $facts.password
    $facts.sensitive = ($facts.password -or ($editLike -and ($global:ahSecretPattern.IsMatch($facts.name) -or $global:ahSecretPattern.IsMatch($facts.automationId))))
    $r = $info.BoundingRectangle
    if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X) -and -not [double]::IsInfinity($r.Y) -and -not [double]::IsInfinity($r.Width) -and -not [double]::IsInfinity($r.Height) -and -not [double]::IsNaN($r.X) -and -not [double]::IsNaN($r.Y) -and $r.Width -gt 0 -and $r.Height -gt 0) {
      $facts.hasRect = $true
      $facts.x = [int][Math]::Round($r.X)
      $facts.y = [int][Math]::Round($r.Y)
      $facts.w = [int][Math]::Round($r.Width)
      $facts.h = [int][Math]::Round($r.Height)
    }
    return $facts
  } catch {
    return $null
  }
}

function Get-UiaPattern($element, $pattern) {
  try {
    $found = $null
    if ($element.TryGetCurrentPattern($pattern, [ref]$found)) { return $found }
  } catch { }
  return $null
}

# The whole text of an element (ValuePattern, else TextPattern), or $null. Never call it for a sensitive element.
function Read-UiaFullText($element, [int]$limit) {
  try {
    $value = Get-UiaPattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $value) {
      $text = $value.Current.Value
      if ($null -ne $text) {
        if ($text.Length -gt $limit) { return $text.Substring(0, $limit) }
        return $text
      }
    }
    $document = Get-UiaPattern $element ([System.Windows.Automation.TextPattern]::Pattern)
    if ($null -ne $document) {
      $text = $document.DocumentRange.GetText($limit)
      if ($null -ne $text) { return $text }
    }
  } catch { }
  return $null
}

# FNV-1a over role and name, lower case, as eight hex digits at most.
function Get-UiaHash([string]$role, [string]$name) {
  $text = ($role + '|' + $name).ToLowerInvariant()
  [long]$hash = 2166136261
  foreach ($ch in $text.ToCharArray()) {
    [long]$mixed = $hash -bxor [long][int]$ch
    $hash = ($mixed * 16777619) -band 4294967295
  }
  return $hash.ToString('x')
}

function Get-UiaElementId([string]$hwndText, [string]$path, $facts) {
  return ($hwndText + ':' + $path + '#' + (Get-UiaHash $facts.role $facts.name))
}

function Split-UiaElementId([string]$id) {
  $colon = $id.IndexOf(':')
  $hashAt = $id.LastIndexOf('#')
  [long]$hwnd = 0
  if ($colon -le 0 -or $hashAt -lt $colon -or -not [long]::TryParse($id.Substring(0, $colon), [ref]$hwnd)) {
    Throw-UiaError 'bad_element' 'That element id is not one this helper made. Find the element again.'
  }
  return @{ hwnd = $hwnd; path = $id.Substring($colon + 1, $hashAt - $colon - 1); hash = $id.Substring($hashAt + 1) }
}

function Get-UiaBounds($facts) {
  if (-not $facts.hasRect) { return $null }
  return [ordered]@{ x = $facts.x; y = $facts.y; width = $facts.w; height = $facts.h }
}

function New-UiaNode($element, $facts, [string]$id, [bool]$includeText) {
  $node = [ordered]@{ id = $id; role = $facts.role }
  if ($facts.name.Length -gt 0) { $node['name'] = Get-UiaClip $facts.name 300 }
  $bounds = Get-UiaBounds $facts
  if ($null -ne $bounds) { $node['bounds'] = $bounds }
  $node['enabled'] = $facts.enabled
  if ($facts.sensitive) { $node['sensitive'] = $true }
  if ($facts.hidden) { $node['hidden'] = $true }
  if ($includeText -and (Test-UiaEditLike $facts.type) -and -not $facts.sensitive -and -not $facts.hidden) {
    $text = Read-UiaFullText $element 200
    if ($null -ne $text -and $text.Length -gt 0) { $node['text'] = Get-UiaClip $text 200 }
  }
  return $node
}

# Depth-first build of the tree under one element, with the same limits as the C# walk.
function Add-UiaChildren($state, $walker, $element, $node, [string]$hwndText, [string]$path, [int]$depth, [int]$maxDepth, [int]$maxNodes, [bool]$includeText, [long]$deadline) {
  if ($depth -ge $maxDepth) { return }
  $kids = New-Object System.Collections.ArrayList
  $child = $walker.GetFirstChild($element)
  $index = 0
  while ($null -ne $child) {
    if (Test-UiaStop $state $deadline) { $state.truncated = $true; break }
    if ($state.count -ge $maxNodes) { $state.truncated = $true; break }
    if ($index -ge $global:ahMaxSiblings) { $state.truncated = $true; break }
    $facts = Read-UiaFacts $child
    if ($null -ne $facts) {
      $childPath = [string]$index
      if ($path.Length -gt 0) { $childPath = $path + '/' + $index }
      $childNode = New-UiaNode $child $facts (Get-UiaElementId $hwndText $childPath $facts) $includeText
      if ($state.cancel) { return }
      $state.count = $state.count + 1
      if ($facts.sensitive -or $facts.hidden) { $state.redacted = $true }
      [void]$kids.Add($childNode)
      $node['children'] = $kids
      Add-UiaChildren $state $walker $child $childNode $hwndText $childPath ($depth + 1) $maxDepth $maxNodes $includeText $deadline
    }
    $index = $index + 1
    $child = $walker.GetNextSibling($child)
  }
}

# Walks under one window and calls the visitor for every readable element; the visitor returns $false to stop.
function Invoke-UiaScan($state, $element, [string]$path, [int]$depth, [int]$maxDepth, [int]$maxNodes, [long]$deadline, $visit) {
  if ($depth -ge $maxDepth) { return $true }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($element)
  $index = 0
  while ($null -ne $child) {
    if (Test-UiaStop $state $deadline) { $state.truncated = $true; return $false }
    if ($state.count -ge $maxNodes) { $state.truncated = $true; return $false }
    if ($index -ge $global:ahMaxSiblings) { $state.truncated = $true; return $true }
    $facts = Read-UiaFacts $child
    if ($null -ne $facts) {
      $childPath = [string]$index
      if ($path.Length -gt 0) { $childPath = $path + '/' + $index }
      $state.count = $state.count + 1
      if (-not (& $visit $child $facts $childPath ($depth + 1))) { return $false }
      if (-not (Invoke-UiaScan $state $child $childPath ($depth + 1) $maxDepth $maxNodes $deadline $visit)) { return $false }
    }
    $index = $index + 1
    $child = $walker.GetNextSibling($child)
  }
  return $true
}

# A window root found the way the UI Automation client finds top-level windows: a FindFirst on the desktop by its
# handle. AutomationElement.FromHandle is only the fallback: on WinForms windows it returns children that all come
# back as generic panes (no buttons, no edit boxes, no password boxes), so reads would be wrong.
function Get-UiaWindowRoot([IntPtr]$hwnd) {
  $found = $null
  try {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$hwnd.ToInt64())
    $found = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
  } catch { $found = $null }
  if ($null -eq $found) { $found = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) }
  return $found
}

# The window itself first (path empty), then its descendants.
function Invoke-UiaScanRoot($state, [IntPtr]$hwnd, [int]$maxDepth, [int]$maxNodes, [long]$deadline, $visit) {
  $root = Get-UiaWindowRoot $hwnd
  $facts = Read-UiaFacts $root
  if ($null -eq $facts) { return $true }
  $state.count = $state.count + 1
  if (-not (& $visit $root $facts '' 0)) { return $false }
  return (Invoke-UiaScan $state $root '' 0 $maxDepth $maxNodes $deadline $visit)
}

function Get-UiaElementByPath($root, [string]$path) {
  $element = $root
  if ($path.Length -eq 0) { return $element }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  foreach ($part in $path.Split('/')) {
    [int]$index = -1
    if (-not [int]::TryParse($part, [ref]$index) -or $index -lt 0) { return $null }
    $child = $walker.GetFirstChild($element)
    for ($i = 0; $i -lt $index -and $null -ne $child; $i++) { $child = $walker.GetNextSibling($child) }
    if ($null -eq $child) { return $null }
    $element = $child
  }
  return $element
}

function Get-UiaNormalizedRole([string]$role) {
  $text = $role.Trim().ToLowerInvariant()
  switch ($text) {
    'button' { return 'push button' }
    'textbox' { return 'entry' }
    'text box' { return 'entry' }
    'text field' { return 'entry' }
    'edit' { return 'entry' }
    'checkbox' { return 'check box' }
    'hyperlink' { return 'link' }
    'combobox' { return 'combo box' }
    'tab' { return 'page tab' }
    'tab item' { return 'page tab' }
    'radio' { return 'radio button' }
    'radiobutton' { return 'radio button' }
    'menuitem' { return 'menu item' }
    'listitem' { return 'list item' }
    'text' { return 'text' }
    default { return $text }
  }
}

function Test-UiaRoleMatch([string]$wanted, [string]$role) {
  if ($wanted.Length -eq 0) { return $true }
  if ($wanted -eq $role) { return $true }
  if ($wanted -eq 'text') { return ($role -eq 'entry' -or $role -eq 'label' -or $role -eq 'document' -or $role -eq 'password text') }
  return $false
}

function Get-UiaConfidence([bool]$queryMatch, [bool]$roleMatch, [bool]$exact) {
  if ($exact -and $roleMatch) { return 1.0 }
  if ($exact) { return 0.95 }
  if ($queryMatch -and $roleMatch) { return 0.9 }
  if ($queryMatch) { return 0.82 }
  if ($roleMatch) { return 0.7 }
  return 0.0
}

# Resolves one element for an action: by its id (the path, then the same role and name), or by name and role.
function Resolve-UiaTarget($state, $p, $roots, [long]$deadline) {
  $target = @{ element = $null; facts = $null; id = ''; hwnd = [IntPtr]::Zero; ambiguous = $false; matches = 0; reason = '' }
  $elementId = Get-UiaParam $p 'elementId' ''
  if ($elementId.Length -gt 0) {
    $parsed = Split-UiaElementId $elementId
    $hwnd = [IntPtr]$parsed.hwnd
    if (-not [AhNative.Native]::IsWindow($hwnd)) { Throw-UiaError 'window_gone' 'That window no longer exists.' }
    if (-not $state.selfElevated -and (Test-AhElevated (Get-AhProcessId $hwnd))) { Throw-UiaError 'elevated_window' 'That window runs as administrator, so a normal process cannot read or operate it through UI Automation. Ask the person to use it themselves.' }
    $target.hwnd = $hwnd
    $hwndText = [string]$parsed.hwnd
    $root = Get-UiaWindowRoot $hwnd
    $element = Get-UiaElementByPath $root $parsed.path
    $facts = $null
    if ($null -ne $element) { $facts = Read-UiaFacts $element }
    if ($null -ne $facts -and (Get-UiaHash $facts.role $facts.name) -eq $parsed.hash) {
      $target.element = $element
      $target.facts = $facts
      $target.id = $elementId
      $target.matches = 1
      return $target
    }
    # The tree changed since the id was made: look for the same role and name once.
    $same = New-Object System.Collections.ArrayList
    [void](Invoke-UiaScanRoot $state $hwnd $global:ahMaxDepth 1500 $deadline {
      param($el2, $f2, $path2, $depth2)
      if ((Get-UiaHash $f2.role $f2.name) -eq $parsed.hash -and -not $f2.hidden) {
        $c = @{ element = $el2; facts = $f2; id = (Get-UiaElementId $hwndText $path2 $f2); hwnd = $hwnd; matches = 1; ambiguous = $false; reason = '' }
        [void]$same.Add($c)
      }
      return ($same.Count -lt 3)
    })
    if ($same.Count -eq 1) { return $same[0] }
    $target.matches = $same.Count
    $target.ambiguous = ($same.Count -gt 1)
    if ($same.Count -gt 1) { $target.reason = 'The element id matches several controls now. Find it again by name.' } else { $target.reason = 'The element is gone or changed. Find it again.' }
    return $target
  }

  $query = (Get-UiaParam $p 'query' '').Trim().ToLowerInvariant()
  $role = Get-UiaNormalizedRole (Get-UiaParam $p 'role' '')
  $requireExact = [bool](Get-UiaParam $p 'requireExactMatch' $false)
  if ($query.Length -eq 0 -and $role.Length -eq 0) { Throw-UiaError 'bad_target' 'An element id, a name or a role is required.' }
  $hits = New-Object System.Collections.ArrayList
  foreach ($root in $roots) {
    $rootHwnd = [IntPtr]$root
    $hwndText2 = [string]$root
    [void](Invoke-UiaScanRoot $state $rootHwnd $global:ahMaxDepth 1500 $deadline {
      param($el3, $f3, $path3, $depth3)
      if ($f3.hidden) { return $true }
      if ($role.Length -gt 0 -and -not (Test-UiaRoleMatch $role $f3.role)) { return $true }
      if ($query.Length -gt 0) {
        $name = $f3.name.ToLowerInvariant()
        $automationId = $f3.automationId.ToLowerInvariant()
        if ($requireExact) { $ok = ($name -eq $query -or $automationId -eq $query) } else { $ok = (($name.Length -gt 0 -and $name.Contains($query)) -or ($automationId.Length -gt 0 -and $automationId.Contains($query))) }
        if (-not $ok) { return $true }
      }
      $c = @{ element = $el3; facts = $f3; id = (Get-UiaElementId $hwndText2 $path3 $f3); hwnd = $rootHwnd; matches = 1; ambiguous = $false; reason = '' }
      [void]$hits.Add($c)
      return ($hits.Count -lt 50)
    })
    if ($hits.Count -ge 50) { break }
  }
  if ($hits.Count -eq 1) { return $hits[0] }
  $target.matches = $hits.Count
  if ($hits.Count -eq 0) {
    if ($roots.Count -eq 0) { $target.reason = 'No window of that app is open.' } else { $target.reason = 'No matching element was found.' }
  } else {
    $target.ambiguous = $true
    $target.reason = 'Several elements match (' + $hits.Count + '). Use an element id from ui.find, or add a role.'
  }
  return $target
}

function Get-UiaParam($p, [string]$key, $fallback) {
  if ($null -eq $p) { return $fallback }
  $prop = $p.PSObject.Properties[$key]
  if ($null -eq $prop -or $null -eq $prop.Value) { return $fallback }
  return $prop.Value
}

function New-UiaResult($target) {
  return [ordered]@{ matched = ($null -ne $target.element); ambiguous = $target.ambiguous; matches = $target.matches; reason = $target.reason }
}

function New-UiaDetails($element, $facts, [string]$id, [IntPtr]$hwnd) {
  $d = [ordered]@{ id = $id; role = $facts.role }
  if ($facts.name.Length -gt 0) { $d['name'] = Get-UiaClip $facts.name 300 }
  if (-not $facts.sensitive) {
    try {
      $help = [string]$element.Current.HelpText
      if ($help.Trim().Length -gt 0) { $d['description'] = Get-UiaClip ($help.Trim()) 300 }
    } catch { }
  }
  $states = New-Object System.Collections.ArrayList
  if ($facts.enabled) { [void]$states.Add('enabled') } else { [void]$states.Add('disabled') }
  if ($facts.hidden) { [void]$states.Add('offscreen') } else { [void]$states.Add('showing') }
  try { if ($element.Current.HasKeyboardFocus) { [void]$states.Add('focused') } } catch { }
  try { if ($element.Current.IsKeyboardFocusable) { [void]$states.Add('focusable') } } catch { }
  if ($facts.password) { [void]$states.Add('password text') }
  $actions = New-Object System.Collections.ArrayList
  if ($null -ne (Get-UiaPattern $element ([System.Windows.Automation.InvokePattern]::Pattern))) { [void]$actions.Add('invoke') }
  $toggle = Get-UiaPattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
  if ($null -ne $toggle) {
    [void]$actions.Add('toggle')
    try {
      $toggleState = $toggle.Current.ToggleState
      if ($toggleState -eq [System.Windows.Automation.ToggleState]::On) { [void]$states.Add('checked') }
      elseif ($toggleState -eq [System.Windows.Automation.ToggleState]::Off) { [void]$states.Add('unchecked') }
      else { [void]$states.Add('indeterminate') }
    } catch { }
  }
  $selection = Get-UiaPattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($null -ne $selection) {
    [void]$actions.Add('select')
    try { if ($selection.Current.IsSelected) { [void]$states.Add('selected') } } catch { }
  }
  $expand = Get-UiaPattern $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if ($null -ne $expand) {
    [void]$actions.Add('expand')
    [void]$actions.Add('collapse')
    try {
      $expandState = $expand.Current.ExpandCollapseState
      if ($expandState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { [void]$states.Add('expanded') }
      elseif ($expandState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) { [void]$states.Add('collapsed') }
    } catch { }
  }
  $value = Get-UiaPattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
  $hasText = ($null -ne (Get-UiaPattern $element ([System.Windows.Automation.TextPattern]::Pattern)))
  if ($null -ne $value -or $hasText) {
    $meta = [ordered]@{}
    $readOnly = $false
    if ($null -ne $value) {
      try { $readOnly = [bool]$value.Current.IsReadOnly } catch { $readOnly = $true }
      [void]$actions.Add('set value')
    } else {
      $readOnly = $true
    }
    if ($readOnly) { [void]$states.Add('readonly') }
    $meta['supportsText'] = $true
    $meta['supportsValue'] = ($null -ne $value)
    $meta['readOnly'] = $readOnly
    $meta['editable'] = (-not $readOnly -and $facts.enabled)
    if (-not $facts.sensitive -and -not $facts.hidden) {
      $text = Read-UiaFullText $element 20000
      if ($null -ne $text) { $meta['textLength'] = $text.Length }
    }
    $d['valueMetadata'] = $meta
  }
  $d['states'] = $states
  $d['availableActions'] = $actions
  $bounds = Get-UiaBounds $facts
  if ($null -ne $bounds) { $d['bounds'] = $bounds }
  $windowInfo = Get-AhWindowText $hwnd
  $processName = Get-AhProcessName (Get-AhProcessId $hwnd)
  if ($processName.Length -gt 0) { $d['appName'] = $processName }
  $d['windowId'] = $hwnd.ToInt64().ToString()
  if ($windowInfo.Length -gt 0) { $d['windowTitle'] = Get-UiaClip $windowInfo 160 }
  $d['pid'] = $facts.pid
  $d['sensitive'] = $facts.sensitive
  $d['hidden'] = $facts.hidden
  return $d
}

# Performs one action by the first pattern that supports it. Returns @{ performed; used; why }.
function Invoke-UiaPerform($state, $element, [string]$action) {
  $any = ($action.Length -eq 0 -or $action -eq 'click' -or $action -eq 'press' -or $action -eq 'activate' -or $action -eq 'invoke' -or $action -eq 'default')
  try {
    $pattern = Get-UiaPattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
    if (($any -or $action -eq 'invoke') -and $null -ne $pattern) {
      $state.phase = 'acting'
      $pattern.Invoke()
      $state.phase = ''
      return @{ performed = $true; used = 'invoke'; why = '' }
    }
    $pattern = Get-UiaPattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
    if (($any -or $action -eq 'toggle') -and $null -ne $pattern) {
      $state.phase = 'acting'
      $pattern.Toggle()
      $state.phase = ''
      return @{ performed = $true; used = 'toggle'; why = '' }
    }
    $pattern = Get-UiaPattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if (($any -or $action -eq 'select') -and $null -ne $pattern) {
      $state.phase = 'acting'
      $pattern.Select()
      $state.phase = ''
      return @{ performed = $true; used = 'select'; why = '' }
    }
    $pattern = Get-UiaPattern $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if (($any -or $action -eq 'expand' -or $action -eq 'collapse') -and $null -ne $pattern) {
      $open = ($pattern.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded)
      $state.phase = 'acting'
      if ($action -eq 'expand' -or ($any -and -not $open)) { $pattern.Expand(); $used = 'expand' } else { $pattern.Collapse(); $used = 'collapse' }
      $state.phase = ''
      return @{ performed = $true; used = $used; why = '' }
    }
  } catch [System.Windows.Automation.ElementNotEnabledException] {
    $state.phase = ''
    return @{ performed = $false; used = ''; why = 'The element is disabled.' }
  } catch [System.InvalidOperationException] {
    $state.phase = ''
    return @{ performed = $false; used = ''; why = ('UI Automation refused the action: ' + $_.Exception.Message) }
  }
  return @{ performed = $false; used = ''; why = 'The element supports no invoke, toggle, select or expand action. Click it by its bounds instead.' }
}

function Set-UiaResult($state, $result) {
  if (-not $state.cancel) { $state.result = $result }
}

function Invoke-UiaTree($state, $p, $roots) {
  $timeout = Get-UiaTimeout $p
  $deadline = Get-UiaDeadline $timeout
  $maxDepth = [Math]::Max(1, [Math]::Min($global:ahMaxDepth, [int](Get-UiaParam $p 'maxDepth' 3)))
  $maxNodes = [Math]::Max(1, [Math]::Min(1000, [int](Get-UiaParam $p 'maxNodes' 200)))
  $includeText = [bool](Get-UiaParam $p 'includeText' $false)
  if ($roots.Count -eq 0) { return }
  $hwnd = [IntPtr]$roots[0]
  $hwndText = [string]$roots[0]
  $element = Get-UiaWindowRoot $hwnd
  $facts = Read-UiaFacts $element
  if ($null -eq $facts) { Throw-UiaError 'uia_unavailable' 'UI Automation could not read that window.' }
  $node = New-UiaNode $element $facts (Get-UiaElementId $hwndText '' $facts) $includeText
  $state.root = $node
  $state.count = 1
  if ($facts.sensitive -or $facts.hidden) { $state.redacted = $true }
  Add-UiaChildren $state ([System.Windows.Automation.TreeWalker]::ControlViewWalker) $element $node $hwndText '' 0 $maxDepth $maxNodes $includeText $deadline
}

function Invoke-UiaFind($state, $p, $roots) {
  $timeout = Get-UiaTimeout $p
  $deadline = Get-UiaDeadline $timeout
  $query = (Get-UiaParam $p 'query' '').Trim().ToLowerInvariant()
  $role = Get-UiaNormalizedRole (Get-UiaParam $p 'role' '')
  $maxNodes = [Math]::Max(1, [Math]::Min(2000, [int](Get-UiaParam $p 'maxNodes' 1000)))
  foreach ($root in $roots) {
    $rootHwnd = [IntPtr]$root
    $hwndText = [string]$root
    $more = Invoke-UiaScanRoot $state $rootHwnd $global:ahMaxDepth $maxNodes $deadline {
      param($el, $f, $path, $depth)
      if ($f.hidden) { return $true }
      $roleMatch = ($role.Length -eq 0 -or (Test-UiaRoleMatch $role $f.role))
      if (-not $roleMatch) { return $true }
      $queryMatch = $false
      $exact = $false
      if ($query.Length -gt 0) {
        $name = $f.name.ToLowerInvariant()
        $automationId = $f.automationId.ToLowerInvariant()
        $queryMatch = (($name.Length -gt 0 -and $name.Contains($query)) -or ($automationId.Length -gt 0 -and $automationId.Contains($query)))
        $exact = ($name -eq $query -or $automationId -eq $query)
        if (-not $queryMatch) { return $true }
      }
      $c = New-UiaNode $el $f (Get-UiaElementId $hwndText $path $f) $true
      $c['confidence'] = (Get-UiaConfidence $queryMatch ($role.Length -gt 0 -and $roleMatch) $exact)
      $c['reason'] = 'Matched accessibility role.'
      if ($query.Length -gt 0) { $c['reason'] = 'Matched accessibility query.' }
      if ($state.cancel) { return $false }
      [void]$state.items.Add($c)
      return ($state.items.Count -lt 200)
    }
    if (-not $more) { break }
  }
}

function Invoke-UiaInspect($state, $p, $roots) {
  $timeout = Get-UiaTimeout $p
  $deadline = Get-UiaDeadline $timeout
  $target = Resolve-UiaTarget $state $p $roots $deadline
  $result = New-UiaResult $target
  if ($null -ne $target.element) { $result['element'] = New-UiaDetails $target.element $target.facts $target.id $target.hwnd }
  Set-UiaResult $state $result
}

function Invoke-UiaActivate($state, $p, $roots) {
  $timeout = Get-UiaTimeout $p
  $deadline = Get-UiaDeadline $timeout
  $action = (Get-UiaParam $p 'action' 'click').Trim().ToLowerInvariant()
  $target = Resolve-UiaTarget $state $p $roots $deadline
  $result = New-UiaResult $target
  $result['performed'] = $false
  if ($null -ne $target.element) { $result['element'] = New-UiaDetails $target.element $target.facts $target.id $target.hwnd }
  Set-UiaResult $state $result
  if ($null -eq $target.element) { return }
  if (-not $target.facts.enabled) {
    $result['reason'] = 'The element is disabled, so nothing was done.'
    return
  }
  if ($state.cancel) { return }
  $outcome = Invoke-UiaPerform $state $target.element $action
  $result['performed'] = $outcome.performed
  if ($outcome.used.Length -gt 0) { $result['action'] = $outcome.used }
  if ($outcome.performed) { $result['reason'] = 'Performed the ' + $outcome.used + ' action.' } else { $result['reason'] = $outcome.why }
  Set-UiaResult $state $result
}

function Invoke-UiaSetText($state, $p, $roots) {
  $timeout = Get-UiaTimeout $p
  $deadline = Get-UiaDeadline $timeout
  $value = [string](Get-UiaParam $p 'value' '')
  $target = Resolve-UiaTarget $state $p $roots $deadline
  $result = New-UiaResult $target
  $result['changed'] = $false
  if ($null -ne $target.element) {
    $result['element'] = New-UiaDetails $target.element $target.facts $target.id $target.hwnd
    $result['sensitive'] = $target.facts.sensitive
  }
  Set-UiaResult $state $result
  if ($null -eq $target.element) { return }
  if ($target.facts.sensitive) {
    $result['reason'] = 'That field holds a password or credential, so nothing was typed. The person must enter it.'
    return
  }
  if (-not $target.facts.enabled) {
    $result['reason'] = 'The field is disabled.'
    return
  }
  $pattern = Get-UiaPattern $target.element ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -eq $pattern) {
    $result['reason'] = 'The element has no editable value through UI Automation. Click it and use desktop.type_text.'
    return
  }
  $readOnly = $true
  try { $readOnly = [bool]$pattern.Current.IsReadOnly } catch { $readOnly = $true }
  if ($readOnly) {
    $result['reason'] = 'The field is read-only.'
    return
  }
  if ($state.cancel) { return }
  try {
    $state.phase = 'acting'
    $pattern.SetValue($value)
    $state.phase = ''
    $result['changed'] = $true
    $result['reason'] = 'Set the field value.'
  } catch [System.Windows.Automation.ElementNotEnabledException] {
    $state.phase = ''
    $result['reason'] = 'The field is disabled.'
  } catch [System.InvalidOperationException] {
    $state.phase = ''
    $result['reason'] = ('UI Automation refused the value: ' + $_.Exception.Message)
  } catch [System.ArgumentException] {
    $state.phase = ''
    $result['reason'] = ('The field did not accept the value: ' + $_.Exception.Message)
  }
  Set-UiaResult $state $result
}

function Invoke-UiaGetText($state, $p, $roots) {
  $timeout = Get-UiaTimeout $p
  $deadline = Get-UiaDeadline $timeout
  $target = Resolve-UiaTarget $state $p $roots $deadline
  $result = New-UiaResult $target
  $result['readable'] = $false
  if ($null -ne $target.element) {
    $result['sensitive'] = ($target.facts.sensitive -or $target.facts.hidden)
    if ($target.facts.sensitive -or $target.facts.hidden) {
      $result['reason'] = 'The element is a password, credential or hidden field, so its text is never read.'
    } else {
      $text = Read-UiaFullText $target.element 20000
      if ($null -eq $text) {
        $result['reason'] = 'The element exposes no text through UI Automation.'
      } else {
        $result['readable'] = $true
        $result['text'] = $text
        $result['length'] = $text.Length
        $result['reason'] = 'Read the element text.'
      }
    }
  }
  Set-UiaResult $state $result
}

function Invoke-UiaFocus($state, $p, $roots) {
  $timeout = Get-UiaTimeout $p
  $deadline = Get-UiaDeadline $timeout
  $target = Resolve-UiaTarget $state $p $roots $deadline
  $result = New-UiaResult $target
  $result['focused'] = $false
  if ($null -ne $target.element) {
    if (-not $target.facts.enabled) {
      $result['reason'] = 'The element is disabled.'
    } else {
      try {
        $target.element.SetFocus()
        $has = $false
        try { $has = [bool]$target.element.Current.HasKeyboardFocus } catch { }
        $result['focused'] = $has
        if ($has) { $result['reason'] = 'Moved keyboard focus to the element.' } else { $result['reason'] = 'The element did not take keyboard focus.' }
      } catch [System.InvalidOperationException] {
        $result['reason'] = ('The element cannot take focus: ' + $_.Exception.Message)
      }
    }
    $result['element'] = New-UiaDetails $target.element $target.facts $target.id $target.hwnd
  }
  Set-UiaResult $state $result
}

function Invoke-UiaTextAtPoint($state, $p) {
  $timeout = Get-UiaTimeout $p
  $x = [int](Get-UiaParam $p 'x' 0)
  $y = [int](Get-UiaParam $p 'y' 0)
  $processId = [int](Get-UiaParam $p 'pid' 0)
  $point = New-Object System.Windows.Point($x, $y)
  $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $facts = $null
  for ($up = 0; $up -lt 4 -and $null -ne $element; $up++) {
    $facts = Read-UiaFacts $element
    if ($null -ne $facts -and (Test-UiaEditLike $facts.type) -and $facts.type.Id -ne [System.Windows.Automation.ControlType]::ComboBox.Id) { break }
    $facts = $null
    $element = $walker.GetParent($element)
  }
  $result = @{ found = $false }
  if ($null -eq $element -or $null -eq $facts) {
    $result['reason'] = 'No editable text field is exposed through UI Automation at that point.'
  } elseif ($processId -gt 0 -and $facts.pid -ne $processId) {
    $result['reason'] = 'The field at that point belongs to another app.'
  } else {
    $focused = $false
    try { $focused = [bool]$element.Current.HasKeyboardFocus } catch { }
    $result['found'] = $true
    $result['role'] = $facts.role
    $result['focused'] = $focused
    $result['sensitive'] = ($facts.sensitive -or $facts.hidden)
    $result['reason'] = 'Read the editable text field at that point through UI Automation.'
    if (-not $facts.sensitive -and -not $facts.hidden) {
      $text = Read-UiaFullText $element 20000
      if ($null -ne $text) {
        $result['text'] = $text
        $result['length'] = $text.Length
      }
    }
  }
  Set-UiaResult $state $result
}

function Get-UiaTimeout($p) {
  return [Math]::Max(1000, [Math]::Min(30000, [int](Get-UiaParam $p 'timeoutMs' 8000)))
}

# Entry point of the worker: one request, the state object is what the main loop reads back.
function Invoke-UiaWorker([string]$method, $p, $roots, $state) {
  try {
    switch ($method) {
      'uia.tree' { Invoke-UiaTree $state $p $roots }
      'uia.find' { Invoke-UiaFind $state $p $roots }
      'uia.inspect' { Invoke-UiaInspect $state $p $roots }
      'uia.activate' { Invoke-UiaActivate $state $p $roots }
      'uia.setText' { Invoke-UiaSetText $state $p $roots }
      'uia.getText' { Invoke-UiaGetText $state $p $roots }
      'uia.focus' { Invoke-UiaFocus $state $p $roots }
      'uia.textAtPoint' { Invoke-UiaTextAtPoint $state $p }
      default { Throw-UiaError 'unknown_method' ('Unknown method ' + $method) }
    }
  } catch {
    $code = 'helper_exception'
    if ($_.Exception.Data.Contains('code')) { $code = [string]$_.Exception.Data['code'] }
    $state.failure = @{ code = $code; message = (Get-AhPlain $_.Exception.Message) }
  }
  $state.done = $true
}
`;
