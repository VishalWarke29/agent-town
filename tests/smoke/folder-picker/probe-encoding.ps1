# Prints the same non-ASCII text several ways so the harness can see which survive a stdout pipe into Node.
$ErrorActionPreference = 'Stop'
$text = 'uni ' + [char]0x00fc + [char]0x00ef + ' ' + [char]0x6f22 + [char]0x5b57 + ' ' + [char]0xD83D + [char]0xDE00 + ' e' + [char]0x0301
function Raw($s) { $b = (New-Object System.Text.UTF8Encoding($false)).GetBytes($s + [char]10); $o = [Console]::OpenStandardOutput(); $o.Write($b, 0, $b.Length); $o.Flush() }
Write-Output ('default-write-output:' + $text)
[Console]::Out.WriteLine('console-out-default:' + $text)
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $set = 'set' } catch { $set = 'failed' }
Raw ('encoding-' + $set + ':')
[Console]::Out.WriteLine('console-out-after-utf8:' + $text)
Raw ('raw-utf8-bytes:' + $text)
Raw ('json-ascii-escaped:' + ('"' + (($text.ToCharArray() | ForEach-Object { if ([int]$_ -gt 126) { '\u' + ([int]$_).ToString('x4') } else { [string]$_ } }) -join '') + '"'))
