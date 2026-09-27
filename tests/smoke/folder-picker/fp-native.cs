// Shared native source for the folder-picker SPIKE candidates. The candidate .ps1 files receive this text through the
// "#@include fp-native.cs" marker (replaced by the harness; comments and indentation are stripped to stay under the 32,767
// character Windows command-line limit that -EncodedCommand is subject to). C# 5 only: Windows PowerShell 5.1 compiles with
// the legacy csc. The shipped helper (tests/smoke/folder-picker-helper.ps1) carries its own trimmed, fixed copy.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AtNative
{
    const string U = "user32.dll";
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport(U)] static extern IntPtr GetForegroundWindow();
    [DllImport(U)] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport(U)] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport(U)] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport(U)] static extern bool BringWindowToTop(IntPtr h);
    [DllImport(U)] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport(U)] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport(U)] static extern void SwitchToThisWindow(IntPtr h, bool alt);
    [DllImport(U)] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport(U)] static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
    [DllImport(U, CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(int ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport(U)] static extern bool DestroyWindow(IntPtr h);
    [DllImport(U)] static extern int GetSystemMetrics(int i);
    [DllImport(U)] static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport(U)] static extern bool IsWindowVisible(IntPtr h);
    [DllImport(U, CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);
    [DllImport(U)] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport(U)] static extern bool SetProcessDPIAware();
    [DllImport(U)] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
    [DllImport(U)] static extern IntPtr GetProcessWindowStation();
    [StructLayout(LayoutKind.Sequential)] struct UOF { public int Inherit, Reserved, Flags; }
    [DllImport(U)] static extern bool GetUserObjectInformationW(IntPtr h, int idx, ref UOF f, int len, out int needed);

    static readonly IntPtr TOPMOST = new IntPtr(-1), NOTOPMOST = new IntPtr(-2);

    static bool Fg(IntPtr h) { for (int i = 0; i < 6; i++) { if (GetForegroundWindow() == h) return true; Thread.Sleep(25); } return false; }
    static void Tap(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
    static bool Attach(IntPtr t)
    {
        uint pid; uint fgTid = GetWindowThreadProcessId(GetForegroundWindow(), out pid), me = GetCurrentThreadId();
        bool att = fgTid != 0 && fgTid != me && AttachThreadInput(me, fgTid, true);
        BringWindowToTop(t); bool ok = SetForegroundWindow(t);
        if (att) AttachThreadInput(me, fgTid, false);
        return ok;
    }
    // The escalation ladder: plain call first, then progressively more invasive; nothing is injected unless it is needed.
    static string Ladder(IntPtr t)
    {
        string r = "denied";
        if (SetForegroundWindow(t) && Fg(t)) r = "sfw";
        else if (Attach(t) && Fg(t)) r = "attach";
        else { Tap(0xE8); if (SetForegroundWindow(t) && Fg(t)) r = "tap-unassigned-vk"; }
        if (r != "denied") SetWindowPos(t, NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
        return r;
    }

    // One step of a foreground-lock mitigation. Returns "step:result:isForeground" for the diagnostics only.
    public static string Step(string step, IntPtr t)
    {
        string ret = "";
        try
        {
            switch (step)
            {
                case "tapalt": Tap(0x12); ret = "sent"; break;
                case "tapf24": Tap(0x87); ret = "sent"; break;
                case "tapvk": Tap(0xE8); ret = "sent"; break;
                case "mouse0": mouse_event(0x0001, 0, 0, 0, UIntPtr.Zero); ret = "sent"; break;
                case "sfw": ret = SetForegroundWindow(t).ToString(); break;
                case "sw2": SwitchToThisWindow(t, true); ret = "sent"; break;
                case "bring": ret = BringWindowToTop(t).ToString(); ShowWindow(t, 5); break;
                case "topmost": ret = SetWindowPos(t, TOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040).ToString(); break;
                case "notopmost": ret = SetWindowPos(t, NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010).ToString(); break;
                case "attach": ret = Attach(t).ToString(); break;
                case "ladder": ret = Ladder(t); break;
                default: ret = "unknown"; break;
            }
        }
        catch (Exception e) { ret = "error:" + e.GetType().Name; }
        return step + ":" + ret + ":fg=" + (GetForegroundWindow() == t);
    }

    public static string RunSteps(string csv, IntPtr t)
    {
        List<string> log = new List<string>();
        if (csv != null && csv.Length > 0)
            foreach (string s in csv.Split(',')) { if (s.Length > 0) { log.Add(Step(s, t)); Thread.Sleep(40); } }
        return string.Join(";", log.ToArray());
    }

    // Node's windowsHide:true starts the child with STARTUPINFO.wShowWindow = SW_HIDE, and Windows replaces the FIRST
    // ShowWindow(SW_SHOWNORMAL or SW_SHOWDEFAULT) of the process with that value, so a window could silently stay hidden.
    // Spend that one call (SW_SHOWDEFAULT burns it on a plain popup; SW_SHOWNORMAL only for overlapped windows, measured).
    public static void BurnShowState()
    {
        IntPtr h = CreateWindowExW(0x00000080, "STATIC", "", 0x80000000, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (h != IntPtr.Zero) { ShowWindow(h, 10); DestroyWindow(h); }
    }

    public static void Dpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { try { SetProcessDPIAware(); } catch (Exception) { } } }

    // A 1x1 topmost tool-window popup ("STATIC" is a predefined class, no window procedure of our own is needed).
    public static IntPtr CreateOwner()
    {
        IntPtr h = CreateWindowExW(0x00000080 | 0x00000008, "STATIC", "", 0x80000000, GetSystemMetrics(0) / 2, GetSystemMetrics(1) / 2, 1, 1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (h != IntPtr.Zero) ShowWindow(h, 4);
        return h;
    }

    // @@dialog (the folder window itself)
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCom { }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr hwndOwner);
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
    static volatile bool opened, ending, closeRequested;
    static IntPtr dialogHwnd = IntPtr.Zero;
    static bool diagOn;
    static string postSteps = "";
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

    public static void Emit(string json)
    {
        try
        {
            byte[] b = new UTF8Encoding(false).GetBytes(json + "\n");
            lock (OutLock) { Stream o = Console.OpenStandardOutput(); o.Write(b, 0, b.Length); o.Flush(); }
        }
        catch (Exception) { }
    }

    static void Diag(string key, string value) { if (diagOn) Emit("{\"diag\":" + Q(key) + ",\"v\":" + Q(value) + "}"); }

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
        int parentPid = ((int[])state)[0], windowMs = ((int[])state)[1];
        Process parent = null; bool parentGone = false;
        if (parentPid > 0)
        {
            try { parent = Process.GetProcessById(parentPid); parent.WaitForExit(0); } catch (Exception) { parentGone = true; }
        }
        Stopwatch sw = Stopwatch.StartNew(); long closeAt = 0;
        while (!ending)
        {
            if (!opened)
            {
                IntPtr h = FindDialog();
                if (h != IntPtr.Zero)
                {
                    dialogHwnd = h; opened = true;
                    Emit("{\"state\":\"open\"}");
                    if (postSteps.Length > 0) Diag("post", RunSteps(postSteps, h));
                }
            }
            bool parentDead = parentGone;
            if (!parentDead && parent != null) { try { parentDead = parent.WaitForExit(0); } catch (Exception) { parentDead = true; } }
            if (!closeRequested && (parentDead || sw.ElapsedMilliseconds > windowMs))
            {
                closeRequested = true; closeAt = sw.ElapsedMilliseconds;
                if (dialogHwnd != IntPtr.Zero) PostMessageW(dialogHwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
            }
            if (closeRequested && sw.ElapsedMilliseconds - closeAt > 1500) Environment.Exit(0);
            Thread.Sleep(40);
        }
    }

    // ownerMode: "" (no owner) or "owner" (1x1 topmost owner). pre/post: comma lists of Step names.
    public static int Run(int parentPid, int windowMs, string ownerMode, string pre, string post, bool dpi, bool burn, bool diag)
    {
        diagOn = diag; postSteps = post ?? ""; myPid = Process.GetCurrentProcess().Id;
        Thread body = new Thread(delegate() { result = Body(parentPid, windowMs, ownerMode, pre, dpi, burn); });
        body.SetApartmentState(ApartmentState.STA);
        body.Start(); body.Join();
        ending = true;
        return result;
    }

    static int Body(int parentPid, int windowMs, string ownerMode, string pre, bool dpi, bool burn)
    {
        UOF uof = new UOF(); int need;
        if (!GetUserObjectInformationW(GetProcessWindowStation(), 1, ref uof, 12, out need) || (uof.Flags & 1) == 0) return 3;
        if (dpi) Dpi();
        if (burn) BurnShowState();
        Thread watch = new Thread(Watch); watch.IsBackground = true; watch.Start(new int[] { parentPid, windowMs });
        IntPtr owner = IntPtr.Zero;
        try
        {
            if (ownerMode == "owner") owner = CreateOwner();
            if (owner != IntPtr.Zero && pre != null && pre.Length > 0) Diag("pre", RunSteps(pre, owner));
            if (closeRequested) { Emit("{\"state\":\"cancelled\"}"); return 0; }
            IFileOpenDialog dlg = (IFileOpenDialog)new FileOpenDialogCom();
            uint opts; dlg.GetOptions(out opts);
            // FOS_NOCHANGEDIR | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_DONTADDTORECENT
            dlg.SetOptions(opts | 0x8 | 0x20 | 0x40 | 0x800 | 0x02000000);
            dlg.SetTitle("Choose a project folder");
            int hr = dlg.Show(owner);
            if (hr == 0)
            {
                IShellItem item; dlg.GetResult(out item);
                string path; item.GetDisplayName(0x80058000, out path);
                if (string.IsNullOrEmpty(path)) return 2;
                Emit("{\"state\":\"selected\",\"path\":" + Q(path) + "}"); return 0;
            }
            if (hr == unchecked((int)0x800704C7)) { Emit("{\"state\":\"cancelled\"}"); return 0; }
            return 2;
        }
        catch (Exception e) { Diag("error", e.GetType().Name + ":" + e.Message); return 2; }
        finally { if (owner != IntPtr.Zero) DestroyWindow(owner); }
    }
}
