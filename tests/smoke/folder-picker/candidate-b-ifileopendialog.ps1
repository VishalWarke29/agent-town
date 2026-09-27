# SPIKE candidate B: C# wrapper around IFileOpenDialog (Vista-style Explorer folder window), compiled with Add-Type.
# Test-only env inputs (never in the shipped helper): AT_SPIKE_OWNER=1, AT_SPIKE_PRE, AT_SPIKE_POST, AT_SPIKE_DPI=1, AT_SPIKE_BURN=1.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$psStartMs = [int]((Get-Date) - (Get-Process -Id $PID).StartTime).TotalMilliseconds
$total = [Diagnostics.Stopwatch]::StartNew()
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$src = @'
#@include fp-native.cs
'@
$sw = [Diagnostics.Stopwatch]::StartNew()
Add-Type -TypeDefinition $src -Language CSharp
$compileMs = $sw.ElapsedMilliseconds
function Get-Num($name, $default) { $v = [Environment]::GetEnvironmentVariable($name); if ($v -match '^[0-9]{1,9}$') { [int]$v } else { $default } }
function Get-Steps($name) { $v = [Environment]::GetEnvironmentVariable($name); if ($v -match '^[a-z0-9,]{0,80}$') { $v } else { '' } }
$parentPid = Get-Num 'AGENT_TOWN_PARENT_PID' 0
$windowMs = Get-Num 'AGENT_TOWN_WINDOW_MS' 300000
$owner = ''; if ($env:AT_SPIKE_OWNER -eq '1') { $owner = 'owner' }
[AtNative]::Emit('{"diag":"timing","psStartMs":' + $psStartMs + ',"addTypeMs":' + $compileMs + ',"apartment":"' + [Threading.Thread]::CurrentThread.GetApartmentState() + '"}')
$code = [AtNative]::Run($parentPid, $windowMs, $owner, (Get-Steps 'AT_SPIKE_PRE'), (Get-Steps 'AT_SPIKE_POST'), ($env:AT_SPIKE_DPI -eq '1'), ($env:AT_SPIKE_BURN -eq '1'), $true)
exit $code
