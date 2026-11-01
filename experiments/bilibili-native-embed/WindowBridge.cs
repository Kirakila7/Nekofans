// Isolated Windows prototype. No third-party source or native addon is used.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

class WindowBridge
{
    const int STYLE = -16, EXSTYLE = -20, OWNER = -8;
    const long CHILD = 0x40000000L, POPUP = 0x80000000L;
    const uint FRAMECHANGED = 0x20, NOACTIVATE = 0x10;
    static JavaScriptSerializer json = new JavaScriptSerializer();
    delegate bool EnumProc(IntPtr hwnd, IntPtr arg);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Placement { public int length, flags, showCmd; public Point min, max; public Rect normal; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr arg);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr arg);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] static extern IntPtr SetLong(IntPtr hwnd, int index, IntPtr value);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint code);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetParent(IntPtr hwnd, IntPtr parent);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hwnd, ref Placement placement);
    [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr hwnd, ref Placement placement);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr hwnd, IntPtr region, bool redraw);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] static extern int CombineRgn(IntPtr dest, IntPtr a, IntPtr b, int mode);
    [DllImport("gdi32.dll")] static extern bool EqualRgn(IntPtr a, IntPtr b);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);

    static IntPtr host, target, oldParent, oldOwner;
    static uint targetPid;
    static long oldStyle, oldExStyle;
    static Placement oldPlacement;
    static Rect oldRect;
    static bool attached, mutated;
    static IntPtr oldRegion;
    static bool hadRegion;
    static int boundX, boundY, boundWidth, boundHeight;
    const int ControlsWidthDip=164, ControlsHeightDip=64;
    static Dictionary<IntPtr, long> hostStyles = new Dictionary<IntPtr, long>();
    static Dictionary<IntPtr, long> hostClipFlags = new Dictionary<IntPtr, long>();
    static int requestId;
    static IntPtr Handle(string s) { return new IntPtr(Convert.ToInt64(s, 16)); }
    static string Hex(IntPtr p) { return p.ToInt64().ToString("x"); }
    static void Emit(object value) {
        if (requestId!=0) {
            var envelope=json.Deserialize<Dictionary<string,object>>(json.Serialize(value));
            envelope["requestId"]=requestId; value=envelope;
        }
        Console.WriteLine(json.Serialize(value)); Console.Out.Flush();
    }
    static bool SameTarget() { uint pid; GetWindowThreadProcessId(target, out pid); return IsWindow(target) && pid == targetPid; }
    static void WriteLong(IntPtr h, int index, long value) {
        SetLastError(0); IntPtr previous = SetLong(h, index, new IntPtr(value));
        int error = Marshal.GetLastWin32Error();
        if (previous == IntPtr.Zero && error != 0) throw new Win32Exception(error, "SetWindowLongPtr index="+index+" hwnd="+Hex(h)+": "+new Win32Exception(error).Message);
    }
    static void Parent(IntPtr h, IntPtr p) {
        SetLastError(0); IntPtr previous = SetParent(h, p); int error = Marshal.GetLastWin32Error();
        if (previous == IntPtr.Zero && error != 0) throw new Win32Exception(error);
    }
    static object State(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid); Rect r; GetWindowRect(h, out r);
        StringBuilder name = new StringBuilder(256); GetClassName(h, name, name.Capacity);
        return new { hwnd=Hex(h), pid=pid, parent=Hex(GetParent(h)), owner=Hex(GetWindow(h,4)),
            style=GetLong(h,STYLE).ToInt64(), exStyle=GetLong(h,EXSTYLE).ToInt64(),
            rect=r, dpi=GetDpiForWindow(h), awareness=GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(h)),
            visible=IsWindowVisible(h), minimized=IsIconic(h), maximized=IsZoomed(h), className=name.ToString() };
    }
    static void ClipHost(IntPtr h, long flag) {
        long style = GetLong(h,STYLE).ToInt64(); hostStyles[h] = style; hostClipFlags[h]=flag; WriteLong(h,STYLE,style | flag);
    }
    static void Attach(IntPtr h, IntPtr t, uint pid) {
        if (mutated) throw new InvalidOperationException("Already attached");
        host=h; target=t; targetPid=pid;
        if (!IsWindow(host) || !SameTarget() || GetWindow(target,4)!=IntPtr.Zero || (GetLong(target,STYLE).ToInt64() & CHILD)!=0)
            throw new InvalidOperationException("Expected a live, unowned top-level target of the selected process");
        if (!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(host),GetWindowDpiAwarenessContext(target)))
            throw new InvalidOperationException("Host and target DPI awareness differ; refusing cross-DPI reparenting");
        oldParent=GetParent(target); oldOwner=GetWindow(target,4);
        oldStyle=GetLong(target,STYLE).ToInt64(); oldExStyle=GetLong(target,EXSTYLE).ToInt64();
        oldPlacement=new Placement(); oldPlacement.length=Marshal.SizeOf(typeof(Placement));
        if (!GetWindowPlacement(target,ref oldPlacement) || !GetWindowRect(target,out oldRect))
            throw new InvalidOperationException("Cannot save original placement");
        object before=State(target);
        oldRegion=CreateRectRgn(0,0,0,0);
        if (oldRegion==IntPtr.Zero) throw new InvalidOperationException("Cannot save original window region");
        hadRegion=GetWindowRgn(target,oldRegion)!=0;
        mutated=true;
        ClipHost(host,0x02000000L);
        EnumChildWindows(host,delegate(IntPtr child, IntPtr unused) {
            StringBuilder name=new StringBuilder(256); GetClassName(child,name,name.Capacity);
            if (name.ToString()=="Intermediate D3D Window") ClipHost(child,0x04000000L);
            return true;
        },IntPtr.Zero);
        WriteLong(target,STYLE,(oldStyle & ~(POPUP | 0x00c00000L | 0x00040000L | 0x00080000L | 0x00030000L)) | CHILD);
        Parent(target,host);
        if (GetParent(target)!=host) throw new InvalidOperationException("Parent verification failed");
        attached=true;
        boundWidth=boundHeight=0;
        Emit(new { type="attached", before=before, placement=oldPlacement, after=State(target), host=State(host) });
    }
    static void Resize(int x,int y,int w,int h) {
        if (!attached || !SameTarget() || GetParent(target)!=host || (GetLong(target,STYLE).ToInt64() & CHILD)==0)
            throw new InvalidOperationException("Target is not a child of this host; refusing resize");
        if (w<1 || h<1 || w>20000 || h>20000) throw new ArgumentException("Invalid bounds");
        if (!SetWindowPos(target,IntPtr.Zero,x,y,w,h,FRAMECHANGED | NOACTIVATE | 0x40)) throw new Win32Exception();
        boundX=x; boundY=y; boundWidth=w; boundHeight=h;
        ApplyControlsRegion();
    }
    static IntPtr ControlsRegion() {
        double scale=GetDpiForWindow(target)/96.0;
        IntPtr region=CreateRectRgn(0,0,boundWidth,boundHeight);
        IntPtr controls=CreateRectRgn(Math.Max(0,boundWidth-(int)Math.Round(ControlsWidthDip*scale)),0,boundWidth,(int)Math.Round(ControlsHeightDip*scale));
        if (region==IntPtr.Zero || controls==IntPtr.Zero) {
            if (region!=IntPtr.Zero) DeleteObject(region); if (controls!=IntPtr.Zero) DeleteObject(controls);
            throw new InvalidOperationException("Cannot allocate controls region");
        }
        try { if (CombineRgn(region,region,controls,4)==0) throw new InvalidOperationException("Cannot subtract controls region"); }
        catch { DeleteObject(region); throw; }
        finally { DeleteObject(controls); }
        return region;
    }
    static void ApplyControlsRegion() {
        IntPtr region=ControlsRegion();
        if (SetWindowRgn(target,region,true)==0) { DeleteObject(region); throw new InvalidOperationException("Cannot protect native controls"); }
        // Successful SetWindowRgn transfers HRGN ownership to the OS.
    }
    static bool Guard() {
        if (!attached || boundWidth==0 || !SameTarget() || GetParent(target)!=host) return false;
        if (IsIconic(host)) return false;
        bool recovered=IsIconic(target) || IsZoomed(target) || !IsWindowVisible(target);
        if (recovered) { ShowWindow(target,4); Resize(boundX,boundY,boundWidth,boundHeight); }
        IntPtr expected=ControlsRegion(), actual=CreateRectRgn(0,0,0,0);
        try { if (GetWindowRgn(target,actual)==0 || !EqualRgn(expected,actual)) { ApplyControlsRegion(); recovered=true; } }
        finally { DeleteObject(expected); DeleteObject(actual); }
        return recovered;
    }
    static object ProbeControls() {
        if (!SameTarget()) throw new InvalidOperationException("Target exited");
        Rect r; GetWindowRect(target,out r); double scale=GetDpiForWindow(target)/96.0;
        List<object> hits=new List<object>();
        foreach (int offset in new int[] { 136,88,40 }) {
            Point point=new Point(); point.X=r.Right-(int)Math.Round(offset*scale); point.Y=r.Top+(int)Math.Round(32*scale);
            IntPtr hit=WindowFromPoint(point);
            hits.Add(new { rightDip=offset, targetReceivesInput=hit==target || IsChild(target,hit), hit=Hex(hit) });
        }
        return hits;
    }
    static bool RestoreRegion() {
        IntPtr restored=IntPtr.Zero;
        if (hadRegion) {
            restored=CreateRectRgn(0,0,0,0);
            if (CombineRgn(restored,oldRegion,IntPtr.Zero,5)==0) { DeleteObject(restored); throw new InvalidOperationException("Cannot copy saved region"); }
        }
        if (SetWindowRgn(target,restored,true)==0) { if (restored!=IntPtr.Zero) DeleteObject(restored); throw new InvalidOperationException("Cannot restore original region"); }
        IntPtr actual=CreateRectRgn(0,0,0,0);
        try { int kind=GetWindowRgn(target,actual); return hadRegion?kind!=0 && EqualRgn(actual,oldRegion):kind==0; }
        finally { DeleteObject(actual); }
    }
    static void Restore(bool announce = true) {
        if (!mutated) { if (announce) Emit(new { type="detached", restored=true, unchanged=true }); return; }
        bool restored=false, regionRestored=false;
        try {
            if (SameTarget()) {
                if (IsIconic(target) || IsZoomed(target)) ShowWindow(target,4);
                Parent(target,oldParent);
                WriteLong(target,STYLE,oldStyle); WriteLong(target,EXSTYLE,oldExStyle);
                if (GetWindow(target,4)!=oldOwner) WriteLong(target,OWNER,oldOwner.ToInt64());
                if (!SetWindowPos(target,IntPtr.Zero,oldRect.Left,oldRect.Top,oldRect.Right-oldRect.Left,oldRect.Bottom-oldRect.Top,FRAMECHANGED | NOACTIVATE | 4))
                    throw new Win32Exception(Marshal.GetLastWin32Error(),"Restore SetWindowPos failed");
                if (!SetWindowPlacement(target,ref oldPlacement)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Restore SetWindowPlacement failed");
                if ((oldStyle & 0x10000000L)!=0 && !IsWindowVisible(target)) ShowWindow(target,4);
                regionRestored=RestoreRegion();
                restored=GetParent(target)==oldParent && GetLong(target,STYLE).ToInt64()==oldStyle && GetLong(target,EXSTYLE).ToInt64()==oldExStyle;
                if (!restored || !regionRestored) throw new InvalidOperationException("Restore verification failed: "+json.Serialize(State(target)));
            }
        } finally {
            foreach (var item in hostStyles) if (IsWindow(item.Key)) {
                long mask=hostClipFlags[item.Key];
                WriteLong(item.Key,STYLE,(GetLong(item.Key,STYLE).ToInt64() & ~mask) | (item.Value & mask));
            }
            hostStyles.Clear(); hostClipFlags.Clear();
        }
        attached=false; mutated=false;
        if (oldRegion!=IntPtr.Zero) { DeleteObject(oldRegion); oldRegion=IntPtr.Zero; }
        if (announce) Emit(new { type="detached", restored=restored, regionRestored=regionRestored, targetAlive=SameTarget(), after=SameTarget()?State(target):null });
    }
    static void Discover(string[] args) {
                string expected=Path.GetFullPath(args[1]); DateTime since=DateTime.Parse(args[2],null,System.Globalization.DateTimeStyles.RoundtripKind);
                HashSet<uint> allowed=new HashSet<uint>();
                foreach (Process p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(expected))) {
                    try { if (String.Equals(p.MainModule.FileName,expected,StringComparison.OrdinalIgnoreCase) && p.StartTime.ToUniversalTime()>=since.ToUniversalTime()) allowed.Add((uint)p.Id); }
                    catch (Win32Exception) {} catch (InvalidOperationException) {} finally { p.Dispose(); }
                }
                List<object> found=new List<object>();
                EnumWindows(delegate(IntPtr h,IntPtr unused) { uint pid; GetWindowThreadProcessId(h,out pid);
                    if (allowed.Contains(pid) && IsWindowVisible(h) && GetWindow(h,4)==IntPtr.Zero) found.Add(State(h)); return true;
                },IntPtr.Zero); Emit(found);
    }
    static void Capture(IntPtr hwnd,string path) {
        Rect r; if (!IsWindow(hwnd) || !GetWindowRect(hwnd,out r)) throw new InvalidOperationException("No capture window");
        using (Bitmap bmp=new Bitmap(r.Right-r.Left,r.Bottom-r.Top)) {
            using (Graphics g=Graphics.FromImage(bmp)) g.CopyFromScreen(r.Left,r.Top,0,0,bmp.Size);
            bmp.Save(path,ImageFormat.Png);
        }
        Emit(new { type="captured", path=path });
    }
    static int Main(string[] args) {
        Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false); SetProcessDpiAwarenessContext(new IntPtr(-4));
        try {
            if (args.Length==2 && args[0]=="state") { Emit(State(Handle(args[1]))); return 0; }
            if (args.Length==3 && args[0]=="discover") { Discover(args); return 0; }
            if (args.Length==2 && args[0]=="list") {
                uint wanted=uint.Parse(args[1]); List<object> result=new List<object>();
                EnumWindows(delegate(IntPtr h,IntPtr unused) { uint pid; GetWindowThreadProcessId(h,out pid);
                    if (pid==wanted && IsWindowVisible(h) && GetWindow(h,4)==IntPtr.Zero) result.Add(State(h)); return true;
                },IntPtr.Zero); Emit(result); return 0;
            }
            Emit(new { type="ready" });
            string line;
            while ((line=Console.ReadLine())!=null) {
                requestId=0;
                try {
                    var c=json.Deserialize<Dictionary<string,object>>(line); string op=(string)c["op"];
                    requestId=Convert.ToInt32(c["requestId"]);
                    if (requestId<=0) throw new ArgumentException("Positive requestId required");
                    if (op=="attach") {
                        if (mutated) throw new InvalidOperationException("Already attached; detach first");
                        try { Attach(Handle((string)c["host"]),Handle((string)c["target"]),Convert.ToUInt32(c["pid"])); }
                        catch { Restore(false); throw; }
                    }
                    else if (op=="resize") { Resize(Convert.ToInt32(c["x"]),Convert.ToInt32(c["y"]),Convert.ToInt32(c["w"]),Convert.ToInt32(c["h"])); Emit(new { type="resized", after=State(target) }); }
                    else if (op=="detach") Restore();
                    else if (op=="inspect") Emit(new { type="inspected", target=SameTarget()?State(target):null, host=IsWindow(host)?State(host):null });
                    else if (op=="guard") Emit(new { type="guarded", recovered=Guard() });
                    else if (op=="probe-controls") Emit(new { type="controls-probed", hits=ProbeControls() });
                    // Diagnostic operations are reachable only on the helper's private stdin, not renderer IPC.
                    else if (op=="test-window-state") {
                        if (!SameTarget()) throw new InvalidOperationException("Target exited");
                        string state=(string)c["state"];
                        if (state!="minimize" && state!="maximize" && state!="restore") throw new ArgumentException("Invalid test state");
                        ShowWindow(target,state=="minimize"?6:state=="maximize"?3:4);
                        Emit(new { type="test-window-state", after=State(target) });
                    }
                    else if (op=="capture") Capture(Handle((string)c["hwnd"]),(string)c["path"]);
                    else if (op=="close-target") { if (attached) throw new InvalidOperationException("Detach before close"); if (SameTarget()) PostMessage(target,0x10,IntPtr.Zero,IntPtr.Zero); Emit(new { type="close-requested" }); }
                    else if (op=="quit") break;
                    else throw new ArgumentException("Unknown operation");
                } catch (Exception e) { Emit(new { type="error", message=e.Message }); }
            }
            return 0;
        } catch (Exception e) { Emit(new { type="error", message=e.Message }); return 1; }
        finally {
            requestId=0;
            try { if (mutated) Restore(); }
            catch (Exception e) { Emit(new { type="restore-error", message=e.Message }); }
            // CLI inspection/discovery must remain a single JSON response.
            if (args.Length==0) Emit(new { type="bridge-closed", safeToClose=!mutated });
        }
    }
}
