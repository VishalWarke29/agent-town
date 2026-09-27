/**
 * The Windows PowerShell script that shows the "Browse..." folder window (plan items WS1-05 / WS1-07).
 *
 * It compiles a small fixed C# wrapper around the Windows folder chooser (IFileOpenDialog with FOS_PICKFOLDERS, the same
 * Explorer-style window other Windows programs show) and reports what happened as JSON lines on standard output, first
 * `{"state":"open"}` once the window is really on screen, then exactly one of `{"state":"selected","path":"..."}` or
 * `{"state":"cancelled"}` (the schema lives in packages/contracts/src/folder-picker.ts). There is no user text in it: the
 * only inputs are two numbers from the environment. It never lists folders, reads files or writes anything of its own
 * (Windows itself remembers the last folder the window showed, as it does for every program).
 *
 * Choices measured in the WS1-05 spike (docs/13, 2026-09-24):
 * - The Vista-style window opens in front of the other program on Windows 11 in about 1.2 to 1.7 s. The older
 *   tree-style FolderBrowserDialog was the fallback and was not needed.
 * - The service starts the helper with `windowsHide: true`, which makes Windows hide the process's first window; the
 *   throwaway window in `Spend` uses up that one hidden show so the folder window is visible.
 * - `Front` is a safety net only: if the folder window does not become the front window on its own it asks Windows
 *   politely, then makes the window always-on-top so it cannot stay hidden behind the browser.
 * - The helper watches the service's process id and closes the window when the service is gone (or after the window
 *   limit), so a killed service leaves no window behind (ended outright 1.5 s later if the window will not close). It refuses to show a window at all (exit code 2) when that
 *   process id is missing, malformed or already gone, and exits with code 3 on a session with no interactive desktop;
 *   the service reports either as "unavailable".
 *
 * The service runs the script with `-EncodedCommand`, so the whole script travels on one Windows command line (about
 * 32,000 characters). The launcher refuses a script whose encoded form is too large; folder-picker-script.test.ts checks
 * this constant against that limit, forbids `${` and backticks (they would change meaning inside this template) and pins
 * the text with a checksum, so any edit is a deliberate, reviewed change. C# 5 only: Windows PowerShell 5.1 compiles with
 * the legacy compiler.
 */
export const FOLDER_PICKER_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class AtFolderWindow
{
    const string U = "user32.dll";
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport(U)] static extern IntPtr GetForegroundWindow();
    [DllImport(U)] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport(U)] static extern bool BringWindowToTop(IntPtr h);
    [DllImport(U)] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport(U)] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport(U)] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport(U)] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport(U, CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(int ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport(U)] static extern bool DestroyWindow(IntPtr h);
    [DllImport(U)] static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport(U)] static extern bool IsWindowVisible(IntPtr h);
    [DllImport(U, CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);
    [DllImport(U)] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport(U)] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
    [DllImport(U)] static extern bool SetProcessDPIAware();
    [DllImport(U)] static extern IntPtr GetProcessWindowStation();
    [StructLayout(LayoutKind.Sequential)] struct UOF { public int Inherit, Reserved, Flags; }
    [DllImport(U)] static extern bool GetUserObjectInformationW(IntPtr h, int idx, ref UOF f, int len, out int needed);

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCom { }
    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint c, IntPtr spec);
        void SetFileTypeIndex(uint i);
        void GetFileTypeIndex(out uint i);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint fos);
        void GetOptions(out uint fos);
        void SetDefaultFolder(IShellItem si);
        void SetFolder(IShellItem si);
        void GetFolder(out IShellItem si);
        void GetCurrentSelection(out IShellItem si);
        void SetFileName(IntPtr n);
        void GetFileName(out IntPtr n);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel(IntPtr t);
        void SetFileNameLabel(IntPtr l);
        void GetResult(out IShellItem si);
        void AddPlace(IShellItem si, int fdap);
        void SetDefaultExtension(IntPtr e);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
        void GetResults(out IntPtr e);
        void GetSelectedItems(out IntPtr e);
    }
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem si);
        void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(uint mask, out uint attrs);
        void Compare(IShellItem si, uint hint, out int order);
    }

    static readonly object OutLock = new object();
    static volatile bool ending, closeRequested;
    static bool openSent;
    static IntPtr dialog = IntPtr.Zero;
    static Process parent;
    static int myPid, result;

    static string Q(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static void Emit(string json)
    {
        try
        {
            byte[] b = new UTF8Encoding(false).GetBytes(json + "\n");
            lock (OutLock) { System.IO.Stream o = Console.OpenStandardOutput(); o.Write(b, 0, b.Length); o.Flush(); }
        }
        catch (Exception) { }
    }

    // "open" always comes first and exactly once, from whichever thread gets there first, so a window dismissed within
    // the first moments still reports open before its result.
    static void EmitOpen()
    {
        lock (OutLock) { if (openSent) return; openSent = true; Emit("{\"state\":\"open\"}"); }
    }

    static void Spend()
    {
        IntPtr h = CreateWindowExW(0x80, "STATIC", "", 0x80000000, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (h != IntPtr.Zero) { ShowWindow(h, 10); DestroyWindow(h); }
    }

    static bool IsFront(IntPtr h) { for (int i = 0; i < 6; i++) { if (GetForegroundWindow() == h) return true; Thread.Sleep(25); } return false; }

    static void Front(IntPtr h)
    {
        if (IsFront(h)) return;
        if (SetForegroundWindow(h) && IsFront(h)) return;
        uint pid; uint other = GetWindowThreadProcessId(GetForegroundWindow(), out pid), me = GetCurrentThreadId();
        bool joined = other != 0 && other != me && AttachThreadInput(me, other, true);
        BringWindowToTop(h); SetForegroundWindow(h);
        if (joined) AttachThreadInput(me, other, false);
        if (!IsFront(h)) SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    }

    static IntPtr FindDialog()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid != (uint)myPid) return true;
            StringBuilder cls = new StringBuilder(64); GetClassNameW(h, cls, 64);
            if (cls.ToString() != "#32770") return true;
            found = h; return false;
        }, IntPtr.Zero);
        return found;
    }

    static void Watch(object state)
    {
        int windowMs = (int)state;
        Stopwatch sw = Stopwatch.StartNew(); long closeAt = 0; bool opened = false, closePosted = false;
        while (!ending)
        {
            if (!opened)
            {
                IntPtr h = FindDialog();
                if (h != IntPtr.Zero) { dialog = h; opened = true; EmitOpen(); if (!closeRequested) Front(h); }
            }
            bool parentDead = false;
            try { parentDead = parent.WaitForExit(0); } catch (Exception) { parentDead = true; }
            if (!closeRequested && (parentDead || sw.ElapsedMilliseconds > windowMs))
            {
                closeRequested = true; closeAt = sw.ElapsedMilliseconds;
            }
            // A window that only appears after the request is closed the moment it is found.
            if (closeRequested && !closePosted && dialog != IntPtr.Zero) { closePosted = true; PostMessageW(dialog, 0x0010, IntPtr.Zero, IntPtr.Zero); }
            if (closeRequested && sw.ElapsedMilliseconds - closeAt > 1500) Process.GetCurrentProcess().Kill();
            Thread.Sleep(40);
        }
    }

    public static int Run(int parentPid, int windowMs)
    {
        myPid = Process.GetCurrentProcess().Id;
        // Without a live service to answer to, no window is shown: a missing, malformed or already-gone parent is a refusal.
        if (parentPid <= 0) return 2;
        try { parent = Process.GetProcessById(parentPid); if (parent.HasExited) return 2; } catch (Exception) { return 2; }
        Thread body = new Thread(delegate() { result = Body(windowMs); });
        body.SetApartmentState(ApartmentState.STA);
        body.Start(); body.Join();
        ending = true;
        return result;
    }

    static int Body(int windowMs)
    {
        UOF uof = new UOF(); int need;
        if (!GetUserObjectInformationW(GetProcessWindowStation(), 1, ref uof, 12, out need) || (uof.Flags & 1) == 0) return 3;
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { try { SetProcessDPIAware(); } catch (Exception) { } }
        Spend();
        Thread watch = new Thread(Watch); watch.IsBackground = true; watch.Start(windowMs);
        try
        {
            IFileOpenDialog dlg = (IFileOpenDialog)new FileOpenDialogCom();
            uint opts; dlg.GetOptions(out opts);
            dlg.SetOptions(opts | 0x8 | 0x20 | 0x40 | 0x800 | 0x02000000);
            dlg.SetTitle("Agent Town: choose a project folder");
            if (closeRequested) return 2;
            int hr = dlg.Show(IntPtr.Zero);
            if (hr == 0)
            {
                IShellItem item; dlg.GetResult(out item);
                string path; item.GetDisplayName(0x80058000, out path);
                if (string.IsNullOrEmpty(path)) return 2;
                EmitOpen(); Emit("{\"state\":\"selected\",\"path\":" + Q(path) + "}"); return 0;
            }
            if (hr == unchecked((int)0x800704C7)) { EmitOpen(); Emit("{\"state\":\"cancelled\"}"); return 0; }
            return 2;
        }
        catch (Exception) { return 2; }
    }
}
'@
function Read-Number($name, $fallback) { $v = [Environment]::GetEnvironmentVariable($name); if ($v -match '^[0-9]{1,9}$') { [int]$v } else { $fallback } }
exit ([AtFolderWindow]::Run((Read-Number 'AGENT_TOWN_PARENT_PID' 0), (Read-Number 'AGENT_TOWN_WINDOW_MS' 300000)))
`;
