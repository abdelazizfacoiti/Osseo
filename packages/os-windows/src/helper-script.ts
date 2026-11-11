/*
 * The Windows helper: one long-lived PowerShell 5.1 process (it ships with every Windows 10/11)
 * that compiles a small C# class and answers JSON lines on stdin/stdout. Same shape as the GTK
 * renderer on Linux. Requests: {"id":1,"method":"windows.list","params":{...}}. Replies:
 * {"id":1,"ok":true,"result":...} or {"id":1,"ok":false,"error":{"code":"...","message":"..."}}.
 *
 * The C# targets the C# 5 compiler that Windows PowerShell 5.1 uses: no string interpolation, no
 * "?.", no expression-bodied members. Keep it that way. The text must not contain a backtick or
 * the characters dollar-brace, because it lives in a template string.
 *
 * Not yet run on a real Windows machine: scripts\windows-desktop-check.ps1 is the first test.
 */

import { UIA_CSHARP } from "./uia-script.js";

export const HELPER_PROTOCOL_VERSION = 1;

const CSHARP = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace AgentHostWin
{
    public class HelperError : Exception
    {
        public string Code;
        public HelperError(string code, string message) : base(message) { Code = code; }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static class Native
    {
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] public static extern uint GetTickCount();
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll")] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll")] public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint length, out uint returned);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
    }

    public static class Host
    {
        static JavaScriptSerializer json = new JavaScriptSerializer();
        static bool selfElevated;

        static Host()
        {
            json.MaxJsonLength = int.MaxValue;
            try { Native.SetProcessDPIAware(); } catch (Exception) { }
            selfElevated = IsElevatedProcess((uint)Process.GetCurrentProcess().Id);
        }

        // ---------- protocol ----------

        public static string Handle(string line)
        {
            object id = null;
            try
            {
                Dictionary<string, object> request = json.Deserialize<Dictionary<string, object>>(line);
                if (request.ContainsKey("id")) id = request["id"];
                string method = (string)request["method"];
                Dictionary<string, object> p = new Dictionary<string, object>();
                if (request.ContainsKey("params") && request["params"] != null) p = (Dictionary<string, object>)request["params"];
                Dictionary<string, object> reply = new Dictionary<string, object>();
                reply["id"] = id;
                reply["ok"] = true;
                reply["result"] = Dispatch(method, p);
                return json.Serialize(reply);
            }
            catch (HelperError e)
            {
                return Fail(id, e.Code, e.Message);
            }
            catch (Exception e)
            {
                return Fail(id, "helper_exception", e.GetType().Name + ": " + e.Message);
            }
        }

        static string Fail(object id, string code, string message)
        {
            Dictionary<string, object> error = new Dictionary<string, object>();
            error["code"] = code;
            error["message"] = message;
            Dictionary<string, object> reply = new Dictionary<string, object>();
            reply["id"] = id;
            reply["ok"] = false;
            reply["error"] = error;
            return json.Serialize(reply);
        }

        static object Dispatch(string method, Dictionary<string, object> p)
        {
            switch (method)
            {
                case "ping": return Ping();
                case "windows.list": return WindowList(IntOr(p, "limit", 50));
                case "window.active": return WindowRecord(Native.GetForegroundWindow());
                case "window.focus": return Focus(Hwnd(p, "hwnd"));
                case "screenshot": return Screenshot(p);
                case "screen.geometry": return ScreenGeometry();
                case "input.move": return Move(IntOr(p, "x", 0), IntOr(p, "y", 0));
                case "input.click": return Click(p);
                case "input.scroll": return Scroll(p);
                case "input.drag": return Drag(p);
                case "input.keys": return Keys(p);
                case "clipboard.get": return ClipboardGet();
                case "clipboard.set": return ClipboardSet(StrOr(p, "text", ""));
                case "idle": return Idle();
                default: throw new HelperError("unknown_method", "Unknown method " + method);
            }
        }

        // ---------- parameter helpers ----------

        static int IntOr(Dictionary<string, object> p, string key, int fallback)
        {
            if (!p.ContainsKey(key) || p[key] == null) return fallback;
            return (int)Math.Round(Convert.ToDouble(p[key]));
        }

        static double DoubleOr(Dictionary<string, object> p, string key, double fallback)
        {
            if (!p.ContainsKey(key) || p[key] == null) return fallback;
            return Convert.ToDouble(p[key]);
        }

        static string StrOr(Dictionary<string, object> p, string key, string fallback)
        {
            if (!p.ContainsKey(key) || p[key] == null) return fallback;
            return Convert.ToString(p[key]);
        }

        static IntPtr Hwnd(Dictionary<string, object> p, string key)
        {
            string text = StrOr(p, key, "");
            long value;
            if (text.Length == 0 || !long.TryParse(text, out value)) throw new HelperError("bad_window", "A window handle is required.");
            return new IntPtr(value);
        }

        // ---------- windows ----------

        static object Ping()
        {
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["protocol"] = 1;
            r["os"] = Environment.OSVersion.VersionString;
            r["elevated"] = selfElevated;
            return r;
        }

        static RECT FrameBounds(IntPtr hwnd)
        {
            RECT rect;
            // The extended frame excludes the invisible resize border that GetWindowRect includes.
            if (Native.DwmGetWindowAttribute(hwnd, 9, out rect, Marshal.SizeOf(typeof(RECT))) != 0)
            {
                Native.GetWindowRect(hwnd, out rect);
            }
            return rect;
        }

        static bool IsCloaked(IntPtr hwnd)
        {
            int cloaked;
            if (Native.DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) != 0) return false;
            return cloaked != 0;
        }

        static object WindowRecord(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) return null;
            int length = Native.GetWindowTextLength(hwnd);
            StringBuilder title = new StringBuilder(length + 1);
            Native.GetWindowText(hwnd, title, title.Capacity);
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            string processName = "";
            try { processName = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
            RECT rect = FrameBounds(hwnd);
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["hwnd"] = hwnd.ToInt64().ToString();
            r["title"] = title.ToString();
            r["pid"] = (int)pid;
            r["process"] = processName;
            r["x"] = rect.Left;
            r["y"] = rect.Top;
            r["width"] = rect.Right - rect.Left;
            r["height"] = rect.Bottom - rect.Top;
            r["minimized"] = Native.IsIconic(hwnd);
            return r;
        }

        static object WindowList(int limit)
        {
            List<IntPtr> handles = new List<IntPtr>();
            EnumWindowsProc collect = delegate(IntPtr hwnd, IntPtr lParam)
            {
                if (!Native.IsWindowVisible(hwnd)) return true;
                if (Native.GetWindowTextLength(hwnd) == 0) return true;
                if (IsCloaked(hwnd)) return true;
                handles.Add(hwnd);
                return true;
            };
            Native.EnumWindows(collect, IntPtr.Zero);
            ArrayList list = new ArrayList();
            bool truncated = false;
            foreach (IntPtr hwnd in handles)
            {
                if (list.Count >= limit) { truncated = true; break; }
                object record = WindowRecord(hwnd);
                if (record != null) list.Add(record);
            }
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["windows"] = list;
            r["truncated"] = truncated;
            return r;
        }

        static object Focus(IntPtr hwnd)
        {
            if (!Native.IsWindow(hwnd)) throw new HelperError("window_gone", "That window no longer exists.");
            object previous = WindowRecord(Native.GetForegroundWindow());
            if (Native.IsIconic(hwnd)) Native.ShowWindow(hwnd, 9);
            uint ignored;
            uint foregroundThread = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out ignored);
            uint thisThread = Native.GetCurrentThreadId();
            bool attached = false;
            if (foregroundThread != 0 && foregroundThread != thisThread) attached = Native.AttachThreadInput(thisThread, foregroundThread, true);
            Native.SetForegroundWindow(hwnd);
            if (attached) Native.AttachThreadInput(thisThread, foregroundThread, false);
            Thread.Sleep(80);
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["focused"] = Native.GetForegroundWindow() == hwnd;
            r["previous"] = previous;
            r["window"] = WindowRecord(hwnd);
            return r;
        }

        // ---------- elevation (UIPI): input to a higher-integrity window is dropped, so refuse it ----------

        static bool IsElevatedProcess(uint pid)
        {
            IntPtr process = Native.OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero) return true;
            try
            {
                IntPtr token;
                if (!Native.OpenProcessToken(process, 8, out token)) return true;
                try
                {
                    IntPtr buffer = Marshal.AllocHGlobal(4);
                    try
                    {
                        uint returned;
                        if (!Native.GetTokenInformation(token, 20, buffer, 4, out returned)) return true;
                        return Marshal.ReadInt32(buffer) != 0;
                    }
                    finally { Marshal.FreeHGlobal(buffer); }
                }
                finally { Native.CloseHandle(token); }
            }
            finally { Native.CloseHandle(process); }
        }

        static void RequireReachable(IntPtr hwnd)
        {
            if (selfElevated || hwnd == IntPtr.Zero) return;
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            if (IsElevatedProcess(pid))
            {
                throw new HelperError("elevated_window", "That window runs as administrator, so Windows drops input from a normal process. Ask the person to use it themselves.");
            }
        }

        static void RequireReachableAt(int x, int y)
        {
            POINT point = new POINT();
            point.X = x;
            point.Y = y;
            IntPtr hwnd = Native.WindowFromPoint(point);
            if (hwnd != IntPtr.Zero) hwnd = Native.GetAncestor(hwnd, 2);
            RequireReachable(hwnd);
        }

        // ---------- screen ----------

        static object ScreenGeometry()
        {
            Rectangle area = SystemInformation.VirtualScreen;
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["x"] = area.X;
            r["y"] = area.Y;
            r["width"] = area.Width;
            r["height"] = area.Height;
            return r;
        }

        static object Screenshot(Dictionary<string, object> p)
        {
            Rectangle screen = SystemInformation.VirtualScreen;
            Rectangle area = screen;
            string hwndText = StrOr(p, "hwnd", "");
            if (hwndText.Length > 0)
            {
                RECT rect = FrameBounds(Hwnd(p, "hwnd"));
                area = Rectangle.Intersect(screen, new Rectangle(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top));
            }
            if (p.ContainsKey("region") && p["region"] != null)
            {
                Dictionary<string, object> region = (Dictionary<string, object>)p["region"];
                Rectangle wanted = new Rectangle(area.X + IntOr(region, "x", 0), area.Y + IntOr(region, "y", 0), IntOr(region, "width", area.Width), IntOr(region, "height", area.Height));
                area = Rectangle.Intersect(area, wanted);
            }
            if (area.Width <= 0 || area.Height <= 0) throw new HelperError("empty_capture", "The area to capture is empty or off screen.");
            double scale = DoubleOr(p, "scale", 1.0);
            if (scale <= 0 || scale > 1) scale = 1.0;
            string format = StrOr(p, "format", "png");
            int quality = IntOr(p, "quality", 80);

            using (Bitmap full = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(full))
                {
                    g.CopyFromScreen(area.X, area.Y, 0, 0, new Size(area.Width, area.Height), CopyPixelOperation.SourceCopy);
                }
                Bitmap output = full;
                Bitmap resized = null;
                if (scale < 1.0)
                {
                    int w = Math.Max(1, (int)Math.Round(area.Width * scale));
                    int h = Math.Max(1, (int)Math.Round(area.Height * scale));
                    resized = new Bitmap(w, h, PixelFormat.Format32bppArgb);
                    using (Graphics g = Graphics.FromImage(resized))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.DrawImage(full, 0, 0, w, h);
                    }
                    output = resized;
                }
                try
                {
                    using (MemoryStream stream = new MemoryStream())
                    {
                        if (format == "jpeg")
                        {
                            ImageCodecInfo codec = null;
                            foreach (ImageCodecInfo candidate in ImageCodecInfo.GetImageEncoders())
                            {
                                if (candidate.MimeType == "image/jpeg") { codec = candidate; break; }
                            }
                            EncoderParameters encoder = new EncoderParameters(1);
                            encoder.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(1, Math.Min(100, quality)));
                            output.Save(stream, codec, encoder);
                        }
                        else
                        {
                            output.Save(stream, ImageFormat.Png);
                        }
                        Dictionary<string, object> r = new Dictionary<string, object>();
                        r["data"] = Convert.ToBase64String(stream.ToArray());
                        r["width"] = output.Width;
                        r["height"] = output.Height;
                        r["originX"] = area.X;
                        r["originY"] = area.Y;
                        r["captureWidth"] = area.Width;
                        r["captureHeight"] = area.Height;
                        return r;
                    }
                }
                finally
                {
                    if (resized != null) resized.Dispose();
                }
            }
        }

        // ---------- input ----------

        static void Send(INPUT[] inputs)
        {
            uint sent = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != (uint)inputs.Length) throw new HelperError("input_blocked", "Windows accepted " + sent + " of " + inputs.Length + " input events. A higher-integrity window or the secure desktop may be in front.");
        }

        static INPUT MouseEvent(uint flags, uint data)
        {
            INPUT input = new INPUT();
            input.type = 0;
            input.U.mi.dwFlags = flags;
            input.U.mi.mouseData = data;
            return input;
        }

        static bool IsExtendedKey(int vk)
        {
            return (vk >= 0x21 && vk <= 0x28) || vk == 0x2d || vk == 0x2e || vk == 0x5b;
        }

        static INPUT KeyEvent(int vk, bool up)
        {
            INPUT input = new INPUT();
            input.type = 1;
            input.U.ki.wVk = (ushort)vk;
            input.U.ki.wScan = (ushort)Native.MapVirtualKey((uint)vk, 0);
            uint flags = 0;
            if (up) flags |= 0x0002;
            if (IsExtendedKey(vk)) flags |= 0x0001;
            input.U.ki.dwFlags = flags;
            return input;
        }

        static object Move(int x, int y)
        {
            RequireReachableAt(x, y);
            Native.SetCursorPos(x, y);
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["x"] = x;
            r["y"] = y;
            return r;
        }

        static object Click(Dictionary<string, object> p)
        {
            int x = IntOr(p, "x", 0);
            int y = IntOr(p, "y", 0);
            int count = Math.Max(1, Math.Min(3, IntOr(p, "count", 1)));
            string button = StrOr(p, "button", "left");
            uint down = 0x0002;
            uint up = 0x0004;
            if (button == "right") { down = 0x0008; up = 0x0010; }
            else if (button == "middle") { down = 0x0020; up = 0x0040; }
            RequireReachableAt(x, y);
            Native.SetCursorPos(x, y);
            Thread.Sleep(30);
            for (int i = 0; i < count; i++)
            {
                Send(new INPUT[] { MouseEvent(down, 0), MouseEvent(up, 0) });
                if (i + 1 < count) Thread.Sleep(60);
            }
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["x"] = x;
            r["y"] = y;
            return r;
        }

        static object Scroll(Dictionary<string, object> p)
        {
            if (p.ContainsKey("x") && p.ContainsKey("y") && p["x"] != null && p["y"] != null)
            {
                int x = IntOr(p, "x", 0);
                int y = IntOr(p, "y", 0);
                RequireReachableAt(x, y);
                Native.SetCursorPos(x, y);
                Thread.Sleep(30);
            }
            int vertical = IntOr(p, "vertical", 0);
            int horizontal = IntOr(p, "horizontal", 0);
            if (vertical != 0) Send(new INPUT[] { MouseEvent(0x0800, unchecked((uint)(vertical * 120))) });
            if (horizontal != 0) Send(new INPUT[] { MouseEvent(0x1000, unchecked((uint)(horizontal * 120))) });
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["vertical"] = vertical;
            r["horizontal"] = horizontal;
            return r;
        }

        static object Drag(Dictionary<string, object> p)
        {
            int x1 = IntOr(p, "x1", 0);
            int y1 = IntOr(p, "y1", 0);
            int x2 = IntOr(p, "x2", 0);
            int y2 = IntOr(p, "y2", 0);
            int duration = Math.Max(50, Math.Min(10000, IntOr(p, "durationMs", 300)));
            RequireReachableAt(x1, y1);
            Native.SetCursorPos(x1, y1);
            Thread.Sleep(40);
            Send(new INPUT[] { MouseEvent(0x0002, 0) });
            int steps = Math.Max(4, duration / 25);
            for (int i = 1; i <= steps; i++)
            {
                Native.SetCursorPos(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
                Thread.Sleep(duration / steps);
            }
            Send(new INPUT[] { MouseEvent(0x0004, 0) });
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["x"] = x2;
            r["y"] = y2;
            return r;
        }

        static object Keys(Dictionary<string, object> p)
        {
            List<int> vks = new List<int>();
            IEnumerable raw = p["vks"] as IEnumerable;
            if (raw == null) throw new HelperError("bad_keys", "vks is required.");
            foreach (object item in raw) vks.Add(Convert.ToInt32(item));
            if (vks.Count == 0) throw new HelperError("bad_keys", "No keys were given.");
            int repeat = Math.Max(1, Math.Min(50, IntOr(p, "repeat", 1)));
            int delay = Math.Max(0, Math.Min(1000, IntOr(p, "delayMs", 20)));
            RequireReachable(Native.GetForegroundWindow());
            for (int round = 0; round < repeat; round++)
            {
                List<INPUT> events = new List<INPUT>();
                foreach (int vk in vks) events.Add(KeyEvent(vk, false));
                for (int i = vks.Count - 1; i >= 0; i--) events.Add(KeyEvent(vks[i], true));
                Send(events.ToArray());
                if (round + 1 < repeat && delay > 0) Thread.Sleep(delay);
            }
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["sent"] = repeat;
            return r;
        }

        // ---------- clipboard (needs the STA thread this process runs on) ----------

        static object ClipboardGet()
        {
            Dictionary<string, object> r = new Dictionary<string, object>();
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    r["text"] = Clipboard.ContainsText() ? Clipboard.GetText() : null;
                    return r;
                }
                catch (ExternalException) { Thread.Sleep(60); }
            }
            throw new HelperError("clipboard_busy", "Another program is holding the clipboard.");
        }

        static object ClipboardSet(string text)
        {
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    if (text.Length == 0) Clipboard.Clear();
                    else Clipboard.SetDataObject(text, true);
                    Dictionary<string, object> r = new Dictionary<string, object>();
                    r["length"] = text.Length;
                    return r;
                }
                catch (ExternalException) { Thread.Sleep(60); }
            }
            throw new HelperError("clipboard_busy", "Another program is holding the clipboard.");
        }

        static object Idle()
        {
            LASTINPUTINFO info = new LASTINPUTINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            if (!Native.GetLastInputInfo(ref info)) throw new HelperError("idle_unavailable", "Windows did not report the last input time.");
            uint idle = unchecked(Native.GetTickCount() - info.dwTime);
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["idleMs"] = (long)idle;
            return r;
        }
    }
}
`;

const POWERSHELL_HEAD = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$source = @'
`;

const POWERSHELL_MID = String.raw`
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Drawing','System.Windows.Forms','System.Web.Extensions'
$uiaSource = @'
`;

// UI Automation is compiled on its own and inside try/catch: if it fails to load, only uia.* is
// unavailable (with the reason in the reply), and windows, input and screenshots keep working.
const POWERSHELL_TAIL = String.raw`
'@
$uiaError = ''
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
  $uiaRefs = @('System.Web.Extensions')
  foreach ($uiaType in @([System.Windows.Automation.AutomationElement], [System.Windows.Automation.ControlType], [System.Windows.Rect])) { $uiaRefs += $uiaType.Assembly.Location }
  Add-Type -TypeDefinition $uiaSource -ReferencedAssemblies $uiaRefs
} catch {
  $uiaError = ($_.Exception.Message -replace '\s+', ' ')
  if ($uiaError.Length -gt 600) { $uiaError = $uiaError.Substring(0, 600) }
}
function Write-UiaError([string]$line, [string]$code, [string]$message) {
  $idMatch = [regex]::Match($line, '"id":(-?\d+)')
  $idText = 'null'
  if ($idMatch.Success) { $idText = $idMatch.Groups[1].Value }
  $clean = ($message -replace '\s+', ' ') -replace '[\\"]', ' '
  [Console]::Out.WriteLine('{"id":' + $idText + ',"ok":false,"error":{"code":"' + $code + '","message":"' + $clean + '"}}')
}
$reader = [Console]::In
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  if ($line.IndexOf('"method":"uia.') -ge 0) {
    if ($uiaError -ne '') {
      Write-UiaError $line 'uia_unavailable' ('UI Automation could not be loaded: ' + $uiaError)
    } else {
      try { [Console]::Out.WriteLine([AgentHostUia.Uia]::Handle($line)) }
      catch { Write-UiaError $line 'helper_exception' $_.Exception.Message }
    }
    [Console]::Out.Flush()
    continue
  }
  [Console]::Out.WriteLine([AgentHostWin.Host]::Handle($line))
  [Console]::Out.Flush()
}
`;

/** The whole script, written to a file and started with `powershell.exe -STA -File`. */
export const HELPER_SCRIPT = [
  POWERSHELL_HEAD.replace(/^\n/, "").replace(/\n$/, ""),
  CSHARP,
  POWERSHELL_MID.replace(/^\n/, "").replace(/\n$/, ""),
  UIA_CSHARP,
  POWERSHELL_TAIL.replace(/^\n/, "")
].join("\r\n").replace(/\r?\n/g, "\r\n");
