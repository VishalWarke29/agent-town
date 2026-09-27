# Folder-picker spike observer/driver. Started hidden by tests/smoke/folder-picker-smoke.mjs; not part of the product.
# Reads one JSON command per line on stdin, writes JSON lines (ASCII only) on stdout. It only ever acts on windows that
# belong to process ids the harness told it to track, plus the harness's own stand-in "browser" window.
# Env: AT_SPIKE_PARENT_PID (exit when the harness dies), AT_SPIKE_MAX_MS (hard lifetime cap).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$src = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Obs
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int cbSize, flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize, dwTime; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public ushort vk; [FieldOffset(10)] public ushort scan; [FieldOffset(12)] public uint flags; [FieldOffset(16)] public uint time; [FieldOffset(24)] public IntPtr extra; }
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO i);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
    [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int i);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
    [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int n);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint f, bool i, uint a);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint GetTickCount();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT v, int s);

    static readonly object OutLock = new object();
    static readonly object Gate = new object();
    static System.Collections.Concurrent.BlockingCollection<string> Cmds = new System.Collections.Concurrent.BlockingCollection<string>();
    static HashSet<uint> Watch = new HashSet<uint>();
    static IntPtr Standin = IntPtr.Zero; static uint StandinPid = 0; static IntPtr Ref = IntPtr.Zero;
    static volatile bool Running;
    static int SelfPid = Process.GetCurrentProcess().Id;

    public static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    public static string Q(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\""); else if (c == '\\') sb.Append("\\\\");
            else if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4")); else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
    public static string Ascii(string json)
    {
        StringBuilder sb = new StringBuilder();
        foreach (char c in json) { if (c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4")); else sb.Append(c); }
        return sb.ToString();
    }
    public static void Out(string json)
    {
        lock (OutLock) { Stream o = Console.OpenStandardOutput(); byte[] b = new UTF8Encoding(false).GetBytes(json + "\n"); o.Write(b, 0, b.Length); o.Flush(); }
    }

    public static void StartReader()
    {
        Thread t = new Thread(delegate()
        {
            try { StreamReader r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)); string l; while ((l = r.ReadLine()) != null) Cmds.Add(l); } catch (Exception) { }
            Cmds.Add("__EOF__");
        });
        t.IsBackground = true; t.Start();
    }
    public static string NextCommand(int ms) { string s; return Cmds.TryTake(out s, ms) ? s : null; }

    public static void Init(long standinHwnd, uint standinPid)
    {
        Standin = new IntPtr(standinHwnd); StandinPid = standinPid; Ref = Standin;
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
        if (Running) return;
        Running = true;
        Thread t = new Thread(Loop); t.IsBackground = true; t.Start();
    }
    public static void Stop() { Running = false; }
    public static void SetRef(long h) { Ref = new IntPtr(h); }
    public static void Track(uint pid) { lock (Gate) Watch.Add(pid); }
    public static void Untrack(uint pid) { lock (Gate) Watch.Remove(pid); }
    static bool IsWatched(uint pid) { lock (Gate) return Watch.Contains(pid); }
    public static bool FgIsWatched() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return IsWatched(pid); }

    static string Who(uint pid)
    {
        if (pid == 0) return "none"; if (IsWatched(pid)) return "helper"; if (pid == StandinPid) return "standin"; if (pid == (uint)SelfPid) return "observer"; return "other";
    }
    static string ProcName(uint pid) { try { return Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { return "?"; } }
    static string Cls(IntPtr h) { StringBuilder sb = new StringBuilder(128); GetClassNameW(h, sb, 128); return sb.ToString(); }

    static string HwndInfo(IntPtr h)
    {
        if (h == IntPtr.Zero) return "{\"hwnd\":0,\"pid\":0,\"who\":\"none\"}";
        uint pid; GetWindowThreadProcessId(h, out pid);
        string who = Who(pid);
        return "{\"hwnd\":" + h.ToInt64() + ",\"pid\":" + pid + ",\"who\":" + Q(who) + ",\"proc\":" + Q(who == "other" ? ProcName(pid) : who) + ",\"cls\":" + Q(Cls(h)) + "}";
    }
    static string FocusInfo()
    {
        IntPtr fg = GetForegroundWindow(); if (fg == IntPtr.Zero) return "{\"hwnd\":0,\"pid\":0,\"who\":\"none\"}";
        uint pid; uint tid = GetWindowThreadProcessId(fg, out pid);
        GUITHREADINFO gi = new GUITHREADINFO(); gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        if (!GetGUIThreadInfo(tid, ref gi)) return "{\"hwnd\":0,\"pid\":0,\"who\":\"unknown\"}";
        string h = HwndInfo(gi.hwndFocus);
        return h.Substring(0, h.Length - 1) + ",\"active\":" + gi.hwndActive.ToInt64() + "}";
    }
    static RECT Frame(IntPtr h)
    {
        RECT r; if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r); return r;
    }
    public static int[] FrameRect(long hwnd) { RECT r = Frame(new IntPtr(hwnd)); return new int[] { r.L, r.T, r.R, r.B }; }
    public static int Occlusion(long hwnd)
    {
        IntPtr h = new IntPtr(hwnd); RECT r = Frame(h); int w = r.R - r.L, ht = r.B - r.T, hits = 0;
        double[] fx = { 0.5, 0.15, 0.85, 0.15, 0.85, 0.5, 0.5, 0.15, 0.85 }; double[] fy = { 0.5, 0.15, 0.15, 0.85, 0.85, 0.15, 0.85, 0.5, 0.5 };
        for (int i = 0; i < 9; i++)
        {
            POINT p; p.X = r.L + (int)(w * fx[i]); p.Y = r.T + (int)(ht * fy[i]);
            IntPtr at = WindowFromPoint(p); if (at != IntPtr.Zero && GetAncestor(at, 2) == h) hits++;
        }
        return hits;
    }
    static List<IntPtr> ZOrder()
    {
        List<IntPtr> l = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr x) { if (IsWindowVisible(h)) l.Add(h); return true; }, IntPtr.Zero);
        return l;
    }
    public static string WinJson(string ev, long t, IntPtr h, List<IntPtr> order)
    {
        int ex = GetWindowLongW(h, -20), st = GetWindowLongW(h, -16); RECT r; GetWindowRect(h, out r); RECT fr = Frame(h);
        int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4);
        StringBuilder t2 = new StringBuilder(128); GetWindowTextW(h, t2, 128);
        int z = order.IndexOf(h), zs = Ref == IntPtr.Zero ? -1 : order.IndexOf(Ref); uint wpid; GetWindowThreadProcessId(h, out wpid);
        int aw = -1; try { aw = GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(h)); } catch (Exception) { }
        IntPtr fg = GetForegroundWindow();
        return "{\"ev\":" + Q(ev) + ",\"t\":" + t + ",\"hwnd\":" + h.ToInt64() + ",\"cls\":" + Q(Cls(h)) + ",\"title\":" + Q(t2.ToString())
            + ",\"pid\":" + wpid + ",\"rect\":[" + fr.L + "," + fr.T + "," + fr.R + "," + fr.B + "],\"z\":" + z + ",\"zRef\":" + zs
            + ",\"topmost\":" + ((ex & 0x8) != 0 ? "true" : "false") + ",\"toolWindow\":" + ((ex & 0x80) != 0 ? "true" : "false")
            + ",\"appWindowStyle\":" + ((ex & 0x40000) != 0 ? "true" : "false") + ",\"hasOwner\":" + (GetWindow(h, 4) != IntPtr.Zero ? "true" : "false")
            + ",\"cloaked\":" + cloaked + ",\"dpiAwareness\":" + aw + ",\"occlusionHitsOf9\":" + Occlusion(h.ToInt64())
            + ",\"isForeground\":" + (fg == h ? "true" : "false") + ",\"fg\":" + HwndInfo(fg) + ",\"focus\":" + FocusInfo() + "}";
    }
    public static string Snap(long hwnd)
    {
        List<IntPtr> order = ZOrder(); IntPtr h = new IntPtr(hwnd);
        if (!order.Contains(h)) return "{\"ev\":\"snap\",\"t\":" + Now() + ",\"gone\":true,\"fg\":" + HwndInfo(GetForegroundWindow()) + "}";
        return WinJson("snap", Now(), h, order);
    }
    public static string Env()
    {
        LASTINPUTINFO li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)); GetLastInputInfo(ref li);
        IntPtr d = OpenInputDesktop(0, false, 0x100); bool inputDesktop = d != IntPtr.Zero; if (inputDesktop) CloseDesktop(d);
        return "{\"idleMs\":" + (GetTickCount() - li.dwTime) + ",\"monitors\":" + GetSystemMetrics(80) + ",\"primary\":[" + GetSystemMetrics(0) + "," + GetSystemMetrics(1)
            + "],\"inputDesktopAccessible\":" + (inputDesktop ? "true" : "false") + ",\"fg\":" + HwndInfo(GetForegroundWindow()) + ",\"focus\":" + FocusInfo() + "}";
    }
    public static long IdleMs() { LASTINPUTINFO li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)); GetLastInputInfo(ref li); return GetTickCount() - li.dwTime; }

    static void Loop()
    {
        IntPtr lastFg = new IntPtr(-1); Dictionary<long, bool> seen = new Dictionary<long, bool>();
        while (Running)
        {
            try
            {
                long t = Now(); IntPtr fg = GetForegroundWindow();
                if (fg != lastFg) { lastFg = fg; Out("{\"ev\":\"fg\",\"t\":" + t + ",\"info\":" + HwndInfo(fg) + "}"); }
                List<IntPtr> order = ZOrder(); HashSet<long> now = new HashSet<long>();
                foreach (IntPtr h in order)
                {
                    uint pid; GetWindowThreadProcessId(h, out pid); if (!IsWatched(pid)) continue;
                    long k = h.ToInt64(); now.Add(k);
                    if (!seen.ContainsKey(k)) { seen[k] = true; Out(WinJson("win", t, h, order)); }
                }
                List<long> gone = new List<long>();
                foreach (long k in seen.Keys) if (!now.Contains(k)) gone.Add(k);
                foreach (long k in gone) { seen.Remove(k); Out("{\"ev\":\"gone\",\"t\":" + Now() + ",\"hwnd\":" + k + "}"); }
            }
            catch (Exception) { }
            Thread.Sleep(8);
        }
    }

    // Puts a real click on the stand-in window so it is the foreground window and the system's last-input time is fresh,
    // exactly as if the person had just clicked in their browser. Refuses to click unless the point belongs to the stand-in.
    public static string ClickStandin()
    {
        if (Standin == IntPtr.Zero) return "{\"clicked\":false,\"reason\":\"no-standin\"}";
        if (IsIconic(Standin)) ShowWindow(Standin, 9);
        SetWindowPos(Standin, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
        Thread.Sleep(80);
        RECT r; GetWindowRect(Standin, out r);
        POINT p; p.X = (r.L + r.R) / 2; p.Y = r.B - 40;
        string reason = "ok"; bool clicked = false;
        IntPtr at = WindowFromPoint(p);
        if (at == IntPtr.Zero || GetAncestor(at, 2) != Standin)
        {
            uint apid = 0; if (at != IntPtr.Zero) GetWindowThreadProcessId(GetAncestor(at, 2), out apid);
            reason = "point-not-on-standin(point=" + p.X + "," + p.Y + " rect=" + r.L + "," + r.T + "," + r.R + "," + r.B + " atPid=" + apid + " atProc=" + (apid == 0 ? "-" : ProcName(apid)) + " atClass=" + (at == IntPtr.Zero ? "-" : Cls(GetAncestor(at, 2))) + ")";
        }
        else
        {
            POINT saved; GetCursorPos(out saved);
            SetCursorPos(p.X, p.Y); Thread.Sleep(40);
            IntPtr again = WindowFromPoint(p);
            if (again != IntPtr.Zero && GetAncestor(again, 2) == Standin) { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(30); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); clicked = true; }
            else reason = "point-changed";
            Thread.Sleep(60); SetCursorPos(saved.X, saved.Y);
        }
        SetWindowPos(Standin, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
        bool isFg = false;
        for (int i = 0; i < 25 && !isFg; i++) { isFg = GetForegroundWindow() == Standin; if (!isFg) Thread.Sleep(20); }
        return "{\"clicked\":" + (clicked ? "true" : "false") + ",\"reason\":" + Q(reason) + ",\"fgIsStandin\":" + (isFg ? "true" : "false") + ",\"idleMsAfter\":" + IdleMs() + "}";
    }

    public static string CloseWindow(long hwnd)
    {
        IntPtr h = new IntPtr(hwnd); uint pid; GetWindowThreadProcessId(h, out pid);
        if (!IsWatched(pid)) return "refused-not-tracked";
        PostMessageW(h, 0x0010, IntPtr.Zero, IntPtr.Zero); return "wm_close-posted";
    }
    public static string StandinState()
    {
        RECT r; GetWindowRect(Standin, out r); int cl = 0; DwmGetWindowAttribute(Standin, 14, out cl, 4);
        List<IntPtr> o = ZOrder(); uint fp; GetWindowThreadProcessId(GetForegroundWindow(), out fp);
        return "{\"visible\":" + (IsWindowVisible(Standin) ? "true" : "false") + ",\"iconic\":" + (IsIconic(Standin) ? "true" : "false") + ",\"cloaked\":" + cl + ",\"zIndex\":" + o.IndexOf(Standin) + ",\"topmost\":" + ((GetWindowLongW(Standin, -20) & 8) != 0 ? "true" : "false") + ",\"rect\":[" + r.L + "," + r.T + "," + r.R + "," + r.B + "],\"fgPid\":" + fp + ",\"foregroundIsStandin\":" + (GetForegroundWindow() == Standin ? "true" : "false") + "}";
    }
    public static string MinimizeStandin(bool minimize) { if (Standin != IntPtr.Zero) ShowWindow(Standin, minimize ? 6 : 4); return "ok"; }
    [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr dlg, int id);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, string l);
    public static string ClickButton(long dlg, int id)
    {
        IntPtr d = new IntPtr(dlg); uint pid; GetWindowThreadProcessId(d, out pid); if (!IsWatched(pid)) return "refused-not-tracked";
        IntPtr b = GetDlgItem(d, id); if (b == IntPtr.Zero) return "no-dialog-item-" + id; PostMessageW(b, 0x00F5, IntPtr.Zero, IntPtr.Zero); return "win32-bm_click-posted";
    }
    public static string SetEditText(long dlg, int id, string text)
    {
        IntPtr d = new IntPtr(dlg); uint pid; GetWindowThreadProcessId(d, out pid); if (!IsWatched(pid)) return "refused-not-tracked";
        IntPtr e = GetDlgItem(d, id); if (e == IntPtr.Zero) return "no-dialog-item-" + id; SendMessageW(e, 0x000C, IntPtr.Zero, text); return "win32-wm_settext";
    }
    public static string CloseStandin() { if (Standin != IntPtr.Zero) PostMessageW(Standin, 0x0010, IntPtr.Zero, IntPtr.Zero); return "ok"; }

    static void Key(ushort vk, bool up)
    {
        INPUT[] i = new INPUT[1]; i[0].type = 1; i[0].vk = vk; i[0].flags = up ? 2u : 0u; SendInput(1, i, 40);
    }
    // Keyboard injection is refused unless the foreground window belongs to a tracked helper process.
    public static string Tap(ushort vk) { if (!FgIsWatched()) return "refused-foreground-is-not-helper"; Key(vk, false); Thread.Sleep(20); Key(vk, true); return "sent"; }
    public static string TypeText(string text)
    {
        if (!FgIsWatched()) return "refused-foreground-is-not-helper";
        foreach (char c in text)
        {
            INPUT[] i = new INPUT[2]; i[0].type = 1; i[0].scan = c; i[0].flags = 4; i[1].type = 1; i[1].scan = c; i[1].flags = 4 | 2; SendInput(2, i, 40); Thread.Sleep(4);
        }
        return "typed";
    }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$parentPid = 0; if ($env:AT_SPIKE_PARENT_PID -match '^[0-9]{1,9}$') { $parentPid = [int]$env:AT_SPIKE_PARENT_PID }
$maxMs = 900000; if ($env:AT_SPIKE_MAX_MS -match '^[0-9]{1,9}$') { $maxMs = [int]$env:AT_SPIKE_MAX_MS }
$life = [Diagnostics.Stopwatch]::StartNew()

function Get-ParentAlive { if ($parentPid -le 0) { return $true }; try { $p = [Diagnostics.Process]::GetProcessById($parentPid); return -not $p.HasExited } catch { return $false } }
function Get-Root($hwnd) { $AE::FromHandle([IntPtr][int64]$hwnd) }
function Find-By($root, $prop, $val) { $c = New-Object System.Windows.Automation.PropertyCondition($prop, $val); $root.FindFirst($TS::Descendants, $c) }
function Find-Wait($ms, [scriptblock]$finder) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  do { $e = & $finder; if ($e) { return $e }; Start-Sleep -Milliseconds 80 } while ($sw.ElapsedMilliseconds -lt $ms)
  return $null
}
function Describe($el) {
  $c = $el.Current
  $pat = @()
  if ($c.ClassName -in @('Button', 'Edit', 'SearchEditBox', 'Button3d', 'AJOSplitButton')) { try { $pat = @($el.GetSupportedPatterns() | ForEach-Object { ($_.ProgrammaticName -replace 'Identifiers.PatternProperty$', '') -replace 'Pattern$', '' }) } catch { } }
  [ordered]@{ patterns = ($pat -join ','); name = $c.Name; type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', ''); id = $c.AutomationId; cls = $c.ClassName; focusable = $c.IsKeyboardFocusable; enabled = $c.IsEnabled; offscreen = $c.IsOffscreen; hasFocus = $c.HasKeyboardFocus; pid = $c.ProcessId }
}
function Invoke-El($el) { $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke() }
function Find-Button($root, $names, $ids) {
  foreach ($id in $ids) { $e = Find-By $root $AE::AutomationIdProperty $id; if ($e -and $e.Current.ControlType.ProgrammaticName -eq 'ControlType.Button') { return $e } }
  foreach ($n in $names) { $e = Find-By $root $AE::NameProperty $n; if ($e -and $e.Current.ControlType.ProgrammaticName -eq 'ControlType.Button') { return $e } }
  return $null
}
function Find-Native($root, $id, $name) {
  $e = Find-By $root $AE::AutomationIdProperty $id
  if (-not $e -and $name) { $e = Find-By $root $AE::NameProperty $name }
  return $e
}
function Invoke-Native($el) { try { $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke(); return 'uia-invoke-pattern' } catch { return $null } }
function Walk($el, $depth, $list, $max) {
  if ($list.Count -ge $max -or $depth -gt 8) { return }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($el)
  while ($child -and $list.Count -lt $max) {
    $d = Describe $child; $d['depth'] = $depth
    # Never record item names inside lists and trees (they are the owner's file and folder names).
    if ($d.type -in @('Tree', 'List', 'DataGrid', 'Table', 'Tab')) { $n = 0; $g = $walker.GetFirstChild($child); while ($g -and $n -lt 500) { $n++; $g = $walker.GetNextSibling($g) }; $d['childCount'] = $n; $d['name'] = if ($d.name) { $d.name } else { '' } }
    $list.Add($d) | Out-Null
    if ($d.type -notin @('Tree', 'List', 'DataGrid', 'Table')) { Walk $child ($depth + 1) $list $max }
    $child = $walker.GetNextSibling($child)
  }
}
function Send-Result($res) { [Obs]::Out([Obs]::Ascii(($res | ConvertTo-Json -Compress -Depth 8))) }

[Obs]::StartReader()
[Obs]::Out('{"ev":"ready","pid":' + $PID + '}')
while ($true) {
  if ($life.ElapsedMilliseconds -gt $maxMs) { break }
  $line = [Obs]::NextCommand(250)
  if ($null -eq $line) { if (-not (Get-ParentAlive)) { break }; continue }
  if ($line -eq '__EOF__') { break }
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $res = [ordered]@{ id = $req.id; ok = $true }
  try {
    switch ($req.cmd) {
      'env' { $res['env'] = ([Obs]::Env() | ConvertFrom-Json) }
      'init' { [Obs]::Init([int64]$req.standinHwnd, [uint32]$req.standinPid) }
      'track' { [Obs]::Track([uint32]$req.pid) }
      'ref' { [Obs]::SetRef([int64]$req.hwnd) }
      'untrack' { [Obs]::Untrack([uint32]$req.pid) }
      'click' { $res['click'] = ([Obs]::ClickStandin() | ConvertFrom-Json) }
      'snap' { $res['snap'] = ([Obs]::Snap([int64]$req.hwnd) | ConvertFrom-Json) }
      'idle' { $res['idleMs'] = [Obs]::IdleMs() }
      'close' { $res['result'] = [Obs]::CloseWindow([int64]$req.hwnd) }
      'minimizeStandin' { $res['result'] = [Obs]::MinimizeStandin($true) }
      'restoreStandin' { $res['result'] = [Obs]::MinimizeStandin($false) }
      'standinState' { $res['standin'] = ([Obs]::StandinState() | ConvertFrom-Json) }
      'closeStandin' { $res['result'] = [Obs]::CloseStandin() }
      'dump' {
        $root = Get-Root $req.hwnd; $list = New-Object System.Collections.ArrayList
        $top = Describe $root; $top['depth'] = 0; $list.Add($top) | Out-Null
        Walk $root 1 $list 220
        $res['controls'] = $list
      }
      'uiaCancel' {
        $root = Get-Root $req.hwnd
        $btn = Find-Wait 2500 { Find-Native $root '2' 'Cancel' }
        if ($btn) {
          $how = Invoke-Native $btn
          if ($how) { $res['method'] = $how } else { $res['method'] = [Obs]::ClickButton([int64]$req.hwnd, 2) + ' (UIA shows Cancel as a Pane with no Invoke pattern)' }
        } else { $res['method'] = 'no-cancel-found; ' + [Obs]::CloseWindow([int64]$req.hwnd) }
      }
      'uiaSelect' {
        $root = Get-Root $req.hwnd
        if ($req.kind -eq 'vista') {
          $edit = Find-Wait 4000 { Find-Native $root '1152' '' }
          $set = $false
          if ($edit) { try { $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $vp.SetValue([string]$req.path); $set = $true; $res['setMethod'] = 'uia-value-pattern' } catch { } }
          if (-not $set) { $res['setMethod'] = [Obs]::SetEditText([int64]$req.hwnd, 1152, [string]$req.path) + ' (UIA shows the Folder: edit as a Pane with no Value pattern)' }
          Start-Sleep -Milliseconds 200
          $btn = Find-Native $root '1' 'Select Folder'
          $how = $null; if ($btn) { $how = Invoke-Native $btn }
          if ($how) { $res['method'] = $how } else { $res['method'] = [Obs]::ClickButton([int64]$req.hwnd, 1) + ' (Select Folder)' }
          if ($btn) { $res['buttonName'] = $btn.Current.Name }
          # Windows' folder window treats a typed full path as "go to that folder"; a second press of Select Folder chooses it.
          Start-Sleep -Milliseconds 900
          $still = $false; try { $null = $root.Current.Name; $still = $true } catch { }
          if ($still) { $b2 = Find-Native $root '1' 'Select Folder'; if ($b2) { $res['secondPress'] = Invoke-Native $b2 } }
        } else {
          $btn = Find-Wait 3000 { Find-Native $root '1' 'OK' }
          $how = $null; if ($btn) { $how = Invoke-Native $btn }
          if ($how) { $res['method'] = $how } else { $res['method'] = [Obs]::ClickButton([int64]$req.hwnd, 1) + ' (OK)' }
        }
      }
      'tabwalk' {
        $seq = New-Object System.Collections.ArrayList
        for ($i = 0; $i -lt [int]$req.n; $i++) {
          $r = [Obs]::Tap(0x09); if ($r -ne 'sent') { $seq.Add(@{ skipped = $r }) | Out-Null; break }
          Start-Sleep -Milliseconds 220
          $f = $AE::FocusedElement
          if ($f) { $d = Describe $f; $seq.Add(@{ name = $d.name; type = $d.type; id = $d.id }) | Out-Null } else { $seq.Add(@{ none = $true }) | Out-Null }
        }
        $res['tabs'] = $seq
      }
      'keyboardSelect' {
        # Keyboard-only: Tab until a text box holds focus (max 12 presses), type the path, press Enter.
        $log = New-Object System.Collections.ArrayList
        $found = $false
        for ($i = 0; $i -lt 12; $i++) {
          $f = $AE::FocusedElement
          if ($f -and $f.Current.AutomationId -eq '1152') { $found = $true; break }
          $r = [Obs]::Tap(0x09); if ($r -ne 'sent') { $log.Add($r) | Out-Null; break }
          Start-Sleep -Milliseconds 180
        }
        $res['editFocused'] = $found
        if ($found) { $res['typed'] = [Obs]::TypeText([string]$req.path); Start-Sleep -Milliseconds 200; $res['enter'] = [Obs]::Tap(0x0D) }
        if ($found) {
          # The typed path only navigates into the folder; Tab to Select Folder and press it, as a person would.
          Start-Sleep -Milliseconds 900
          $root2 = Get-Root $req.hwnd; $still = $false; try { $null = $root2.Current.Name; $still = $true } catch { }
          if ($still) {
            $second = 'not-reached'
            for ($i = 0; $i -lt 12; $i++) {
              $f = $AE::FocusedElement
              if ($f -and $f.Current.Name -eq 'Select Folder') { $second = [Obs]::Tap(0x20); break }
              $r = [Obs]::Tap(0x09); if ($r -ne 'sent') { $second = $r; break }
              Start-Sleep -Milliseconds 180
            }
            $res['secondPress'] = $second
          }
        }
        $res['log'] = $log
      }
      'shot' {
        $fr = [Obs]::FrameRect([int64]$req.hwnd); $hits = [Obs]::Occlusion([int64]$req.hwnd)
        if ($hits -lt 9) { $res['ok'] = $false; $res['error'] = "not fully in front (hit $hits of 9), no screenshot taken" }
        else {
          $w = $fr[2] - $fr[0]; $h = $fr[3] - $fr[1]
          $bmp = New-Object System.Drawing.Bitmap($w, $h)
          $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($fr[0], $fr[1], 0, 0, (New-Object System.Drawing.Size($w, $h))); $g.Dispose()
          $bmp.Save([string]$req.file, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
          $res['size'] = @($w, $h)
        }
      }
      'quit' { Send-Result $res; break }
      default { $res['ok'] = $false; $res['error'] = 'unknown command' }
    }
  } catch { $res['ok'] = $false; $res['error'] = $_.Exception.GetType().Name + ': ' + $_.Exception.Message }
  if ($req.cmd -eq 'quit') { break }
  Send-Result $res
}
[Obs]::Stop()
