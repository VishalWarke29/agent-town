# Stand-in for the person's browser during the folder-picker spike: a plain window the harness clicks so that it is the
# foreground window with fresh input. Harmless; closes itself when the harness dies or after AT_SPIKE_MAX_MS.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$parentPid = 0; if ($env:AT_SPIKE_PARENT_PID -match '^[0-9]{1,9}$') { $parentPid = [int]$env:AT_SPIKE_PARENT_PID }
$maxMs = 900000; if ($env:AT_SPIKE_MAX_MS -match '^[0-9]{1,9}$') { $maxMs = [int]$env:AT_SPIKE_MAX_MS }
$life = [Diagnostics.Stopwatch]::StartNew()
# The harness starts this process hidden (STARTUPINFO SW_HIDE); spend the first ShowWindow(SW_SHOWNORMAL) on a throwaway window.
Add-Type -Namespace T -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool LockSetForegroundWindow(uint c);'
# Optional strict regime: when the harness touches AT_SPIKE_LOCK_FILE while this window is active, call LockSetForegroundWindow(LSFW_LOCK),
# the documented state in which SetForegroundWindow calls from other processes are refused (a real click arms the equivalent timeout).
$lockFile = $env:AT_SPIKE_LOCK_FILE; $lastLock = ''
$burn = New-Object System.Windows.Forms.Form; [void]$burn.Handle; [void][T.W]::ShowWindow($burn.Handle, 1); $burn.Dispose()
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Agent Town spike - stand-in browser window'
$f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(60, 60); $f.Size = New-Object System.Drawing.Size(640, 300)
$f.TopMost = $true
$l = New-Object System.Windows.Forms.Label
$l.Text = 'This window stands in for the browser while the folder-picker spike runs. It is harmless and closes itself.'
$l.Dock = 'Top'; $l.Height = 60; $l.Padding = New-Object System.Windows.Forms.Padding(12)
$f.Controls.Add($l)
$t = New-Object System.Windows.Forms.Timer; $t.Interval = 120
$t.Add_Tick({
  $gone = $false
  if ($parentPid -gt 0) { try { $p = [Diagnostics.Process]::GetProcessById($parentPid); $gone = $p.HasExited } catch { $gone = $true } }
  if ($gone -or $life.ElapsedMilliseconds -gt $maxMs) { $f.Close() }
  if ($lockFile -and (Test-Path -LiteralPath $lockFile)) {
    try { $c = [IO.File]::ReadAllText($lockFile) } catch { $c = $script:lastLock }
    if ($c -ne $script:lastLock) { $script:lastLock = $c; if ([System.Windows.Forms.Form]::ActiveForm -eq $f) { [void][T.W]::LockSetForegroundWindow(1) } }
  }
})
$f.Add_Shown({
  $b = (New-Object System.Text.UTF8Encoding($false)).GetBytes('{"ev":"standin","hwnd":' + $f.Handle.ToInt64() + ',"pid":' + $PID + '}' + [char]10)
  $o = [Console]::OpenStandardOutput(); $o.Write($b, 0, $b.Length); $o.Flush()
  $t.Start()
})
[void]$f.ShowDialog()
