# LingoLearn Lens - persistent selection watcher.
#
# Installs a low-level mouse hook (WH_MOUSE_LL) and detects selection gestures:
#   - left-button drag (movement >= 6px) = typical text selection
#   - left-button double-click = word selection
# On a gesture a dedicated worker thread performs an invisible capture:
# remembers the clipboard text, clears it, sends Ctrl+C to the foreground app,
# waits up to ~700ms for new text, restores the clipboard, and emits ONE
# base64 line: {"ok":true,"text":...,"x":..,"y":..} with the mouse position
# where the selection ended. Nothing about the text is ever stored.
#
# Diagnostics: event-only lines (no text content) are appended to
# %TEMP%\lingolearn-lens.log (auto-truncated at 64KB).
#
# Commands come from stdin (one per line):
#   CAPTURE        -> capture at the current cursor (hotkey path)
#   PING           -> emit {"pong":true,"x":..,"y":..} (health check)
#   POS            -> emit {"pos":true,"x":..,"y":..} with the last cursor
#                     position the hook saw (copy path anchoring)
#   CLIPTEST       -> clipboard write/read self-test, restores clipboard
#   AUTO:1/0       -> enable/disable gesture-triggered capture (starts 0)
#   WATCH:1/0      -> report mouse-down positions (popup dismiss)
#   HOSTPID:<pid>  -> skip gestures that start inside the host app's windows
#   QUIT           -> exit

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$csharp = @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class LLWatch
{
    private const int WH_MOUSE_LL = 14;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_LBUTTONDBLCLK = 0x0203;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const byte VK_CONTROL = 0x11;
    private const byte VK_C = 0x43;
    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")]
    private static extern uint GetDoubleClickTime();
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    private static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")]
    private static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll")]
    private static extern bool CloseClipboard();
    [DllImport("user32.dll")]
    private static extern bool EmptyClipboard();
    [DllImport("user32.dll")]
    private static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")]
    private static extern IntPtr SetClipboardData(uint format, IntPtr hMem);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll")]
    private static extern bool GlobalUnlock(IntPtr hMem);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalFree(IntPtr hMem);

    private static IntPtr hookId = IntPtr.Zero;
    private static LowLevelMouseProc proc;
    private static volatile bool running = false;
    private static volatile bool autoMode = false;
    private static volatile bool watchClicks = false;
    private static volatile bool busy = false;
    private static volatile int hostPid = 0;

    private static POINT downPt;
    private static bool downFlag = false;
    private static uint lastUpTick = 0;
    private static POINT lastUpPt;
    private static bool lastUpValid = false;

    // Latest cursor position seen by the hook. Updated on every mouse move so
    // the copy path can anchor the popup where the user actually was, instead
    // of re-querying (and possibly drifting) at poll time.
    private static int lastCursorX = 0;
    private static int lastCursorY = 0;
    private static volatile bool hasCursor = false;

    private static readonly BlockingCollection<string> jobs = new BlockingCollection<string>();
    private static readonly object logLock = new object();
    private static string logPath;
    private static int pendingX = 0, pendingY = 0;
    private static volatile bool hasPending = false;

    private static void Log(string msg)
    {
        try
        {
            lock (logLock)
            {
                if (logPath == null) logPath = Path.Combine(Path.GetTempPath(), "lingolearn-lens.log");
                FileInfo fi = new FileInfo(logPath);
                if (fi.Exists && fi.Length > 65536) fi.Delete();
                File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + Environment.NewLine);
            }
        }
        catch { }
    }

    public static void SetAuto(bool on) { autoMode = on; Log("auto=" + (on ? "1" : "0")); }
    public static void SetWatchClicks(bool on) { watchClicks = on; }
    public static void SetHostPid(int pid) { hostPid = pid; Log("hostpid=" + pid); }

    public static void RequestCaptureAtCursor()
    {
        POINT p;
        GetCursorPos(out p);
        Enqueue(p.X, p.Y);
    }

    public static void Ping()
    {
        POINT p;
        GetCursorPos(out p);
        Emit("{\"pong\":true,\"x\":" + p.X + ",\"y\":" + p.Y + "}");
    }

    // Emit the last cursor position the hook observed (falls back to the live
    // cursor position). Used by the copy path to anchor the popup correctly.
    public static void Pos()
    {
        int x, y;
        if (hasCursor)
        {
            x = lastCursorX;
            y = lastCursorY;
        }
        else
        {
            POINT p;
            GetCursorPos(out p);
            x = p.X;
            y = p.Y;
        }
        Emit("{\"pos\":true,\"x\":" + x + ",\"y\":" + y + "}");
    }

    public static void ClipTest()
    {
        bool ok = false;
        try
        {
            string orig = GetClipboardText();
            bool wrote = SetClipboardText("__LL_CLIP_TEST__");
            string back = GetClipboardText();
            ok = wrote && back == "__LL_CLIP_TEST__";
            if (string.IsNullOrEmpty(orig)) SetClipboardText(null);
            else SetClipboardText(orig);
        }
        catch { ok = false; }
        Log("cliptest=" + (ok ? "ok" : "fail"));
        Emit("{\"cliptest\":" + (ok ? "true" : "false") + "}");
    }

    private static void Enqueue(int x, int y)
    {
        try { jobs.Add(x + "," + y); } catch { }
    }

    // Latest pending gesture while a capture is in flight: instead of losing
    // a gesture that happens during a capture, keep only the most recent one
    // and let the worker pick it up right after the current capture ends.
    private static void EnqueueLatest(int x, int y)
    {
        lock (jobs)
        {
            pendingX = x;
            pendingY = y;
            hasPending = true;
        }
    }

    private static bool TakePending(out int x, out int y)
    {
        lock (jobs)
        {
            if (!hasPending) { x = 0; y = 0; return false; }
            x = pendingX;
            y = pendingY;
            hasPending = false;
            return true;
        }
    }

    private static void EnqueueDismiss(int x, int y)
    {
        try { jobs.Add("d:" + x + "," + y); } catch { }
    }

    private static bool PointInOwnWindow(POINT p)
    {
        if (hostPid == 0) return false;
        try
        {
            IntPtr hwnd = WindowFromPoint(p);
            if (hwnd == IntPtr.Zero) return false;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            return pid == (uint)hostPid;
        }
        catch { return false; }
    }

    public static void Start()
    {
        if (running) return;
        running = true;
        Log("watcher starting");

        Thread worker = new Thread(WorkerLoop);
        worker.IsBackground = true;
        worker.Start();

        Thread hookThread = new Thread(HookLoop);
        hookThread.IsBackground = true;
        hookThread.Start();
    }

    public static void Stop()
    {
        running = false;
        Log("watcher stopping");
        try { jobs.CompleteAdding(); } catch { }
        if (hookId != IntPtr.Zero)
        {
            UnhookWindowsHookEx(hookId);
            hookId = IntPtr.Zero;
        }
    }

    private static void HookLoop()
    {
        proc = HookCallback;
        hookId = SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(null), 0);
        int err = Marshal.GetLastWin32Error();
        if (hookId == IntPtr.Zero)
        {
            Log("hook install FAILED err=" + err);
            Emit("{\"hook\":false,\"err\":" + err + "}");
        }
        else
        {
            Log("hook installed");
            Emit("{\"hook\":true}");
        }
        MSG msg;
        while (running)
        {
            int res = GetMessage(out msg, IntPtr.Zero, 0, 0);
            if (res == 0 || res == -1) break;
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (nCode >= 0 && autoMode)
            {
                int msg = wParam.ToInt32();
                MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                if (msg == WM_MOUSEMOVE)
                {
                    lastCursorX = data.pt.X;
                    lastCursorY = data.pt.Y;
                    hasCursor = true;
                }
                else if (msg == WM_LBUTTONDOWN)
                {
                    downFlag = !PointInOwnWindow(data.pt);
                    downPt = data.pt;
                    if (watchClicks) EnqueueDismiss(data.pt.X, data.pt.Y);
                }
                else if (msg == WM_LBUTTONUP)
                {
                    bool dragGesture = false;
                    if (downFlag)
                    {
                        downFlag = false;
                        int dx = data.pt.X - downPt.X;
                        int dy = data.pt.Y - downPt.Y;
                        // 4px (16 = 4^2) is the classic drag threshold; 6px was
                        // too strict and missed short/quick selections.
                        if (dx * dx + dy * dy >= 16)
                        {
                            Log("gesture drag " + data.pt.X + "," + data.pt.Y);
                            if (busy) EnqueueLatest(data.pt.X, data.pt.Y);
                            else Enqueue(data.pt.X, data.pt.Y);
                            dragGesture = true;
                        }
                    }

                    // WH_MOUSE_LL never receives WM_LBUTTONDBLCLK (it is
                    // synthesized per-window after the raw events), so
                    // double-clicks are detected here: two ups close together
                    // in time and position.
                    if (!dragGesture)
                    {
                        uint dtime = GetDoubleClickTime();
                        int cx = GetSystemMetrics(36);
                        int cy = GetSystemMetrics(37);
                        uint delta = (uint)(data.time - lastUpTick);
                        bool isDbl = lastUpValid
                            && delta <= dtime
                            && Math.Abs(data.pt.X - lastUpPt.X) <= cx
                            && Math.Abs(data.pt.Y - lastUpPt.Y) <= cy;
                        if (isDbl)
                        {
                            lastUpValid = false;
                            if (!PointInOwnWindow(data.pt))
                            {
                                Log("gesture dblclk " + data.pt.X + "," + data.pt.Y);
                                if (busy) EnqueueLatest(data.pt.X, data.pt.Y);
                                else Enqueue(data.pt.X, data.pt.Y);
                            }
                        }
                        else
                        {
                            lastUpValid = true;
                            lastUpTick = data.time;
                            lastUpPt = data.pt;
                        }
                    }
                }
            }
        }
        catch { }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    private static void WorkerLoop()
    {
        foreach (string job in jobs.GetConsumingEnumerable())
        {
            if (!running) break;
            busy = true;
            try
            {
                if (job.StartsWith("d:"))
                {
                    string rest = job.Substring(2);
                    int dc = rest.IndexOf(',');
                    if (dc > 0) Emit("{\"dismiss\":true,\"x\":" + rest.Substring(0, dc) + ",\"y\":" + rest.Substring(dc + 1) + "}");
                    continue;
                }
                int comma = job.IndexOf(',');
                if (comma < 0) continue;
                int x = int.Parse(job.Substring(0, comma));
                int y = int.Parse(job.Substring(comma + 1));
                Log("capture start");
                string text = CaptureSelection();
                if (!string.IsNullOrEmpty(text))
                {
                    Log("capture got " + text.Length + " chars");
                    Emit("{\"ok\":true,\"text\":" + JsonQuote(text) + ",\"x\":" + x + ",\"y\":" + y + "}");
                }
                else
                {
                    Log("capture empty");
                }
            }
            catch (Exception ex)
            {
                Log("worker error: " + ex.Message);
                try { Console.Error.WriteLine("worker: " + ex.Message); } catch { }
            }
            finally
            {
                busy = false;
            }

            // If a gesture arrived while this capture was running, handle the
            // most recent one now instead of dropping it.
            int px, py;
            if (running && TakePending(out px, out py))
            {
                try
                {
                    Log("capture start (queued)");
                    string text2 = CaptureSelection();
                    if (!string.IsNullOrEmpty(text2))
                    {
                        Log("capture got " + text2.Length + " chars");
                        Emit("{\"ok\":true,\"text\":" + JsonQuote(text2) + ",\"x\":" + px + ",\"y\":" + py + "}");
                    }
                    else
                    {
                        Log("capture empty");
                    }
                }
                catch (Exception ex2)
                {
                    Log("worker error (queued): " + ex2.Message);
                }
            }
        }
    }

    private static string CaptureSelection()
    {
        string original = GetClipboardText();
        if (!SetClipboardText(null)) Log("clear clipboard failed");

        SendCopy();

        // Wait for the app to place the selection on the clipboard. The
        // clipboard was cleared first, so ANY non-empty text that appears is
        // the selection — including text identical to what was there before
        // (re-selecting the same word must still pop the translate screen).
        string captured = null;
        Stopwatch sw = Stopwatch.StartNew();
        int resends = 0;
        bool cleared = string.IsNullOrEmpty(GetClipboardText());
        while (sw.ElapsedMilliseconds < 1200)
        {
            Thread.Sleep(30);
            string t = GetClipboardText();
            if (!string.IsNullOrEmpty(t) && (cleared || t != original))
            {
                captured = t;
                break;
            }
            // Re-send Ctrl+C for slow apps (Office, PDF viewers, IDEs) at
            // ~300ms and ~700ms if nothing has arrived yet.
            if (resends == 0 && sw.ElapsedMilliseconds >= 300) { resends = 1; SendCopy(); }
            else if (resends == 1 && sw.ElapsedMilliseconds >= 700) { resends = 2; SendCopy(); }
        }

        // Restore the original clipboard ONLY when nothing changed after us.
        // If the user (or another app) copied something during our capture
        // window, their text is on the clipboard now and must be kept — never
        // overwrite it with the pre-selection value.
        string afterCapture = GetClipboardText();
        bool clipboardChangedByUser =
            !string.IsNullOrEmpty(afterCapture)
            && afterCapture != captured
            && afterCapture != original;
        if (clipboardChangedByUser)
        {
            Log("clipboard changed during capture; keeping user copy");
        }
        else if (string.IsNullOrEmpty(original))
        {
            SetClipboardText(null);
        }
        else
        {
            if (!SetClipboardText(original)) Log("restore clipboard failed");
        }

        return captured;
    }

    private static void SendCopy()
    {
        Thread.Sleep(60); // let the app finish processing the mouse-up
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        keybd_event(VK_C, 0, 0, UIntPtr.Zero);
        Thread.Sleep(35);
        keybd_event(VK_C, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    private static string GetClipboardText()
    {
        bool opened = false;
        try
        {
            if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
            for (int attempt = 0; attempt < 10; attempt++)
            {
                if (OpenClipboard(IntPtr.Zero)) { opened = true; break; }
                Thread.Sleep(15);
            }
            if (!opened) return null;
            IntPtr h = GetClipboardData(CF_UNICODETEXT);
            if (h == IntPtr.Zero) return null;
            IntPtr ptr = GlobalLock(h);
            if (ptr == IntPtr.Zero) return null;
            string s;
            try { s = Marshal.PtrToStringUni(ptr); }
            finally { GlobalUnlock(h); }
            return s;
        }
        catch { return null; }
        finally { if (opened) CloseClipboard(); }
    }

    private static bool SetClipboardText(string text)
    {
        bool opened = false;
        try
        {
            for (int attempt = 0; attempt < 10; attempt++)
            {
                if (OpenClipboard(IntPtr.Zero)) { opened = true; break; }
                Thread.Sleep(15);
            }
            if (!opened) return false;
            try
            {
                EmptyClipboard();
                if (string.IsNullOrEmpty(text)) return true;
                int bytes = (text.Length + 1) * 2;
                IntPtr h = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes);
                if (h == IntPtr.Zero) return false;
                IntPtr ptr = GlobalLock(h);
                if (ptr == IntPtr.Zero) { GlobalFree(h); return false; }
                try
                {
                    char[] data = new char[text.Length + 1];
                    text.CopyTo(0, data, 0, text.Length);
                    data[text.Length] = '\0';
                    Marshal.Copy(data, 0, ptr, data.Length);
                }
                finally { GlobalUnlock(h); }
                IntPtr res = SetClipboardData(CF_UNICODETEXT, h);
                return res != IntPtr.Zero;
            }
            finally { CloseClipboard(); }
        }
        catch { return false; }
        finally { if (opened) CloseClipboard(); }
    }

    private static void Emit(string json)
    {
        try
        {
            Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(json)));
            Console.Out.Flush();
        }
        catch { }
    }

    private static string JsonQuote(string s)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies 'System.dll', 'System.Core.dll'

[LLWatch]::Start()
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $cmd = $line.Trim()
    if ($cmd -eq 'QUIT') { break }
    elseif ($cmd -eq 'CAPTURE') { [LLWatch]::RequestCaptureAtCursor() }
    elseif ($cmd -eq 'PING') { [LLWatch]::Ping() }
    elseif ($cmd -eq 'POS') { [LLWatch]::Pos() }
    elseif ($cmd -eq 'CLIPTEST') { [LLWatch]::ClipTest() }
    elseif ($cmd -eq 'AUTO:1') { [LLWatch]::SetAuto($true) }
    elseif ($cmd -eq 'AUTO:0') { [LLWatch]::SetAuto($false) }
    elseif ($cmd -eq 'WATCH:1') { [LLWatch]::SetWatchClicks($true) }
    elseif ($cmd -eq 'WATCH:0') { [LLWatch]::SetWatchClicks($false) }
    elseif ($cmd -like 'HOSTPID:*') {
        try { [LLWatch]::SetHostPid([int]$cmd.Substring(8)) } catch {}
    }
}

[LLWatch]::Stop()
