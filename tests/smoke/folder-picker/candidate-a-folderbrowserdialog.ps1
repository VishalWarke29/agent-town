# SPIKE candidate A: System.Windows.Forms.FolderBrowserDialog (tree-style dialog under Windows PowerShell 5.1).
# Test-only env inputs: AT_SPIKE_OWNER=1 (topmost 1x1 WinForms owner), AT_SPIKE_PRE (steps on the owner before showing),
# AT_SPIKE_PRESELECT (path preselected so the harness can press OK and check the returned text).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$psStartMs = [int]((Get-Date) - (Get-Process -Id $PID).StartTime).TotalMilliseconds
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
function Out-Line($json) { $b = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json + [char]10); $o = [Console]::OpenStandardOutput(); $o.Write($b, 0, $b.Length); $o.Flush() }
function Q($s) { $sb = New-Object System.Text.StringBuilder; [void]$sb.Append('"'); foreach ($c in $s.ToCharArray()) { $n = [int]$c; if ($c -eq '"') { [void]$sb.Append('\"') } elseif ($c -eq '\') { [void]$sb.Append('\') } elseif ($n -lt 32 -or $n -gt 126) { [void]$sb.Append('\u' + $n.ToString('x4')) } else { [void]$sb.Append($c) } }; [void]$sb.Append('"'); $sb.ToString() }
Add-Type -AssemblyName System.Windows.Forms
$needNative = ($env:AT_SPIKE_PRE -or $env:AT_SPIKE_DPI -eq '1' -or $env:AT_SPIKE_BURN -eq '1')
$addTypeMs = 0
if ($needNative) {
  $src = @'
#@include fp-native.cs native
'@
  $sw = [Diagnostics.Stopwatch]::StartNew(); Add-Type -TypeDefinition $src -Language CSharp; $addTypeMs = $sw.ElapsedMilliseconds
  if ($env:AT_SPIKE_DPI -eq '1') { [AtNative]::Dpi() }
  if ($env:AT_SPIKE_BURN -eq '1') { [AtNative]::BurnShowState() }
}
Out-Line ('{"diag":"timing","psStartMs":' + $psStartMs + ',"addTypeMs":' + $addTypeMs + ',"apartment":"' + [Threading.Thread]::CurrentThread.GetApartmentState() + '","ps":"' + $PSVersionTable.PSVersion + '"}')
$ownerForm = $null
if ($env:AT_SPIKE_OWNER -eq '1') {
  $ownerForm = New-Object System.Windows.Forms.Form
  $ownerForm.ShowInTaskbar = $false; $ownerForm.FormBorderStyle = 'None'; $ownerForm.StartPosition = 'Manual'
  $ownerForm.Size = New-Object System.Drawing.Size(1, 1)
  $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $ownerForm.Location = New-Object System.Drawing.Point([int]($scr.Width / 2), [int]($scr.Height / 2))
  $ownerForm.TopMost = $true; $ownerForm.Opacity = 0
  $ownerForm.Show()
  if ($needNative -and $env:AT_SPIKE_PRE -match '^[a-z0-9,]{1,80}$') { Out-Line ('{"diag":"pre","v":' + (Q ([AtNative]::RunSteps($env:AT_SPIKE_PRE, $ownerForm.Handle))) + '}') }
}
$fb = New-Object System.Windows.Forms.FolderBrowserDialog
$fb.Description = 'Choose a project folder'
$fb.ShowNewFolderButton = $false
if ($env:AT_SPIKE_PRESELECT) { $fb.SelectedPath = $env:AT_SPIKE_PRESELECT }
Out-Line '{"state":"open"}'
if ($ownerForm) { $r = $fb.ShowDialog($ownerForm) } else { $r = $fb.ShowDialog() }
if ($r -eq [System.Windows.Forms.DialogResult]::OK -and $fb.SelectedPath) { Out-Line ('{"state":"selected","path":' + (Q $fb.SelectedPath) + '}') } else { Out-Line '{"state":"cancelled"}' }
if ($ownerForm) { $ownerForm.Close() }
exit 0
