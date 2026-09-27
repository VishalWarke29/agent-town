# SPIKE control: an ordinary WinForms window from a background process, to calibrate whether the foreground lock is
# really in effect in the harness. AT_SPIKE_PRE steps run on the window after it is shown. Closes itself after 20 s.
$ErrorActionPreference = 'Stop'
$psStartMs = [int]((Get-Date) - (Get-Process -Id $PID).StartTime).TotalMilliseconds
function Out-Line($json) { $b = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json + [char]10); $o = [Console]::OpenStandardOutput(); $o.Write($b, 0, $b.Length); $o.Flush() }
Add-Type -AssemblyName System.Windows.Forms
$src = @'
#@include fp-native.cs native
'@
$sw = [Diagnostics.Stopwatch]::StartNew(); Add-Type -TypeDefinition $src -Language CSharp; $ms = $sw.ElapsedMilliseconds
if ($env:AT_SPIKE_BURN -eq '1') { [AtNative]::BurnShowState() }
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Choose a project folder'; $f.Size = New-Object System.Drawing.Size(360, 140); $f.StartPosition = 'CenterScreen'
$t = New-Object System.Windows.Forms.Timer; $t.Interval = 20000; $t.Add_Tick({ $f.Close() }); $t.Start()
$f.Add_Shown({
  Out-Line '{"state":"open"}'
  if ($env:AT_SPIKE_PRE -match '^[a-z0-9,]{1,80}$') { $log = [AtNative]::RunSteps($env:AT_SPIKE_PRE, $f.Handle); Out-Line ('{"diag":"pre","v":"' + $log + '"}') }
})
Out-Line ('{"diag":"timing","psStartMs":' + $psStartMs + ',"addTypeMs":' + $ms + '}')
[void]$f.ShowDialog()
Out-Line '{"state":"cancelled"}'
exit 0
