/*
 * The UI Automation half of the Windows helper. It is a second C# class, compiled by a second
 * Add-Type inside try/catch (see helper-script.ts), so that a failure here (a missing assembly, a
 * compile error) turns off only the uia.* methods and never the windows, input and screenshots.
 *
 * Same rules as the first class: C# 5 only (no string interpolation, no "?.", no expression-bodied
 * members, no "out var"), and no backtick or dollar-brace in this template string.
 *
 * Requests: {"id":1,"method":"uia.find","params":{...}}. The PowerShell loop hands every line whose
 * method starts with "uia." to AgentHostUia.Uia.Handle and writes back the JSON reply it returns.
 *
 * Every UI Automation call runs on a worker thread with a deadline: a hung app blocks the COM call
 * (not this process), the request returns what it has (truncated: true), and the worker is left to
 * finish on its own. No AutomationElement is kept between requests; an element id is a window handle,
 * a child-index path and a hash of role and name, and is walked again on each call.
 *
 * Not yet run on a real Windows machine: scripts\windows-desktop-check.ps1 is the first test.
 */

export const UIA_CSHARP = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace AgentHostUia
{
    public class UiaError : Exception
    {
        public string Code;
        public UiaError(string code, string message) : base(message) { Code = code; }
    }

    public delegate bool UiaEnumProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct UiaPoint { public int X; public int Y; }

    public static class UNative
    {
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool EnumWindows(UiaEnumProc proc, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(UiaPoint point);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll")] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll")] public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint length, out uint returned);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
    }

    public class UiaState
    {
        public object Sync = new object();
        public bool Cancel;
        public bool Truncated;
        public bool Redacted;
        public int Count;
        public string Phase = "";
        public object Root;
        public object Result;
        public ArrayList Items = new ArrayList();
        public UiaError Failure;
        public Exception Crash;
    }

    public static class Uia
    {
        class Facts
        {
            public ControlType Type;
            public string Role = "unknown";
            public string Name = "";
            public string AutomationId = "";
            public bool Password;
            public bool Sensitive;
            public bool Hidden;
            public bool Enabled;
            public bool HasRect;
            public int X;
            public int Y;
            public int W;
            public int H;
            public int Pid;
        }

        class Target
        {
            public AutomationElement Element;
            public Facts F;
            public string Id = "";
            public IntPtr Hwnd = IntPtr.Zero;
            public bool Ambiguous;
            public int Matches;
            public string Reason = "";
        }

        delegate bool Visitor(AutomationElement el, Facts f, string path, int depth);

        const int MaxSiblings = 200;
        const int MaxDepthAllowed = 14;
        static JavaScriptSerializer json = new JavaScriptSerializer();
        static bool selfElevated;
        static Regex SecretName = new Regex("password|passwd|passcode|passphrase|secret|token|api[ _-]?key|credential|private key|one[- ]time|\\botp\\b|\\bcvv\\b|\\bcvc\\b|card number|security code|\\bpin\\b|\\bssn\\b", RegexOptions.IgnoreCase);

        static Uia()
        {
            json.MaxJsonLength = int.MaxValue;
            json.RecursionLimit = 1000;
            try { UNative.SetProcessDPIAware(); } catch (Exception) { }
            selfElevated = IsElevated((uint)Process.GetCurrentProcess().Id);
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
            catch (UiaError e)
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
                case "uia.ping": return PingUia();
                case "uia.tree": return Tree(p);
                case "uia.find": return Find(p);
                case "uia.inspect": return Inspect(p);
                case "uia.activate": return Activate(p);
                case "uia.setText": return SetText(p);
                case "uia.getText": return GetText(p);
                case "uia.focus": return Focus(p);
                case "uia.textAtPoint": return TextAtPoint(p);
                default: throw new UiaError("unknown_method", "Unknown method " + method);
            }
        }

        static object PingUia()
        {
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["uia"] = true;
            r["elevated"] = selfElevated;
            return r;
        }

        // ---------- parameters ----------

        static int IntOr(Dictionary<string, object> p, string key, int fallback)
        {
            if (!p.ContainsKey(key) || p[key] == null) return fallback;
            return (int)Math.Round(Convert.ToDouble(p[key]));
        }

        static string StrOr(Dictionary<string, object> p, string key, string fallback)
        {
            if (!p.ContainsKey(key) || p[key] == null) return fallback;
            return Convert.ToString(p[key]);
        }

        static bool BoolOr(Dictionary<string, object> p, string key, bool fallback)
        {
            if (!p.ContainsKey(key) || p[key] == null) return fallback;
            return Convert.ToBoolean(p[key]);
        }

        static int TimeoutOf(Dictionary<string, object> p)
        {
            return Math.Max(1000, Math.Min(30000, IntOr(p, "timeoutMs", 8000)));
        }

        static long NowMs()
        {
            return DateTime.UtcNow.Ticks / 10000;
        }

        /// <summary>The walk stops a little before the join times out, so a slow tree still returns what it has.</summary>
        static long DeadlineFor(int timeoutMs)
        {
            return NowMs() + Math.Max(500, timeoutMs - 800);
        }

        static string Clip(string value, int limit)
        {
            if (value == null) return null;
            return value.Length > limit ? value.Substring(0, limit) + "..." : value;
        }

        // ---------- elevation (UIPI) ----------

        static bool IsElevated(uint pid)
        {
            IntPtr process = UNative.OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero) return true;
            try
            {
                IntPtr token;
                if (!UNative.OpenProcessToken(process, 8, out token)) return true;
                try
                {
                    IntPtr buffer = Marshal.AllocHGlobal(4);
                    try
                    {
                        uint returned;
                        if (!UNative.GetTokenInformation(token, 20, buffer, 4, out returned)) return true;
                        return Marshal.ReadInt32(buffer) != 0;
                    }
                    finally { Marshal.FreeHGlobal(buffer); }
                }
                finally { UNative.CloseHandle(token); }
            }
            finally { UNative.CloseHandle(process); }
        }

        static void RequireReachable(IntPtr hwnd)
        {
            if (selfElevated || hwnd == IntPtr.Zero) return;
            uint pid;
            UNative.GetWindowThreadProcessId(hwnd, out pid);
            if (IsElevated(pid))
            {
                throw new UiaError("elevated_window", "That window runs as administrator, so a normal process cannot read or operate it through UI Automation. Ask the person to use it themselves.");
            }
        }

        static void RequireReachableAt(int x, int y)
        {
            UiaPoint point = new UiaPoint();
            point.X = x;
            point.Y = y;
            IntPtr hwnd = UNative.WindowFromPoint(point);
            if (hwnd != IntPtr.Zero) hwnd = UNative.GetAncestor(hwnd, 2);
            RequireReachable(hwnd);
        }

        // ---------- windows ----------

        static bool IsCloaked(IntPtr hwnd)
        {
            int cloaked;
            if (UNative.DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) != 0) return false;
            return cloaked != 0;
        }

        static List<IntPtr> WindowsOfPid(int pid)
        {
            List<IntPtr> found = new List<IntPtr>();
            IntPtr front = UNative.GetForegroundWindow();
            UiaEnumProc collect = delegate(IntPtr hwnd, IntPtr lParam)
            {
                if (!UNative.IsWindowVisible(hwnd)) return true;
                uint owner;
                UNative.GetWindowThreadProcessId(hwnd, out owner);
                if ((int)owner != pid) return true;
                if (hwnd != front && UNative.GetWindowTextLength(hwnd) == 0) return true;
                if (IsCloaked(hwnd)) return true;
                if (hwnd == front) found.Insert(0, hwnd);
                else if (found.Count < 8) found.Add(hwnd);
                return true;
            };
            UNative.EnumWindows(collect, IntPtr.Zero);
            return found;
        }

        static List<IntPtr> RootsOf(Dictionary<string, object> p)
        {
            List<IntPtr> roots = new List<IntPtr>();
            string text = StrOr(p, "hwnd", "");
            if (text.Length > 0)
            {
                long value;
                if (!long.TryParse(text, out value)) throw new UiaError("bad_window", "A window handle is required.");
                IntPtr hwnd = new IntPtr(value);
                if (!UNative.IsWindow(hwnd)) throw new UiaError("window_gone", "That window no longer exists.");
                roots.Add(hwnd);
                return roots;
            }
            int pid = IntOr(p, "pid", 0);
            if (pid <= 0) throw new UiaError("bad_target", "A window handle or a process id is required.");
            return WindowsOfPid(pid);
        }

        static void WindowInfo(IntPtr hwnd, out string title, out string process)
        {
            title = "";
            process = "";
            try
            {
                int length = UNative.GetWindowTextLength(hwnd);
                StringBuilder text = new StringBuilder(length + 1);
                UNative.GetWindowText(hwnd, text, text.Capacity);
                title = text.ToString();
                uint pid;
                UNative.GetWindowThreadProcessId(hwnd, out pid);
                process = Process.GetProcessById((int)pid).ProcessName;
            }
            catch (Exception) { }
        }

        // ---------- worker thread with a deadline ----------

        static bool Run(int timeoutMs, UiaState s, ThreadStart work)
        {
            Thread worker = new Thread(delegate()
            {
                try { work(); }
                catch (UiaError e) { s.Failure = e; }
                catch (Exception e) { s.Crash = e; }
            });
            worker.IsBackground = true;
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
            bool done = worker.Join(timeoutMs);
            // From here on the worker may still run (a hung app), but it can no longer change what is returned.
            lock (s.Sync) { s.Cancel = true; }
            if (done)
            {
                if (s.Failure != null) throw s.Failure;
                if (s.Crash != null) throw new UiaError("uia_error", s.Crash.GetType().Name + ": " + s.Crash.Message);
            }
            return done;
        }

        static bool Stop(UiaState s, long deadline)
        {
            return s.Cancel || NowMs() > deadline;
        }

        static void Put(UiaState s, Dictionary<string, object> d, string key, object value)
        {
            lock (s.Sync) { if (!s.Cancel) d[key] = value; }
        }

        // ---------- reading one element ----------

        static bool IsEditLike(ControlType t)
        {
            return t.Id == ControlType.Edit.Id || t.Id == ControlType.Document.Id || t.Id == ControlType.ComboBox.Id || t.Id == ControlType.Spinner.Id;
        }

        static string RoleOf(ControlType type, bool password)
        {
            if (password) return "password text";
            string name = type.ProgrammaticName;
            int dot = name.LastIndexOf('.');
            if (dot >= 0) name = name.Substring(dot + 1);
            switch (name)
            {
                case "Button": return "push button";
                case "SplitButton": return "push button";
                case "CheckBox": return "check box";
                case "RadioButton": return "radio button";
                case "ComboBox": return "combo box";
                case "Edit": return "entry";
                case "Hyperlink": return "link";
                case "MenuItem": return "menu item";
                case "Menu": return "menu";
                case "MenuBar": return "menu bar";
                case "TabItem": return "page tab";
                case "Tab": return "page tab list";
                case "ListItem": return "list item";
                case "List": return "list";
                case "DataItem": return "list item";
                case "DataGrid": return "table";
                case "Table": return "table";
                case "Text": return "label";
                case "Image": return "image";
                case "ToolBar": return "tool bar";
                case "ToolTip": return "tool tip";
                case "Tree": return "tree";
                case "TreeItem": return "tree item";
                case "ScrollBar": return "scroll bar";
                case "Slider": return "slider";
                case "Spinner": return "spin button";
                case "ProgressBar": return "progress bar";
                case "StatusBar": return "status bar";
                case "TitleBar": return "title bar";
                case "Separator": return "separator";
                case "Window": return "window";
                case "Pane": return "panel";
                case "Group": return "panel";
                case "Document": return "document";
                case "Header": return "table column header";
                case "HeaderItem": return "table column header";
                case "Calendar": return "calendar";
                case "Thumb": return "thumb";
                case "AppBar": return "tool bar";
                case "Custom": return "unknown";
                default: return name.ToLowerInvariant();
            }
        }

        static Facts Read(AutomationElement el)
        {
            try
            {
                AutomationElement.AutomationElementInformation c = el.Current;
                Facts f = new Facts();
                f.Type = c.ControlType;
                f.Name = c.Name == null ? "" : c.Name.Trim();
                f.AutomationId = c.AutomationId == null ? "" : c.AutomationId;
                f.Pid = c.ProcessId;
                f.Enabled = c.IsEnabled;
                f.Hidden = c.IsOffscreen;
                bool editLike = IsEditLike(f.Type);
                if (editLike)
                {
                    // An unreadable flag counts as a password: the safe side.
                    try { f.Password = f.Type.Id == ControlType.Edit.Id && c.IsPassword; }
                    catch (Exception) { f.Password = true; }
                    if (f.Name.Length == 0)
                    {
                        try
                        {
                            AutomationElement label = c.LabeledBy;
                            if (label != null) f.Name = (label.Current.Name ?? "").Trim();
                        }
                        catch (Exception) { }
                    }
                }
                f.Role = RoleOf(f.Type, f.Password);
                f.Sensitive = f.Password || (editLike && (SecretName.IsMatch(f.Name) || SecretName.IsMatch(f.AutomationId)));
                System.Windows.Rect r = c.BoundingRectangle;
                if (!r.IsEmpty && !double.IsInfinity(r.X) && !double.IsInfinity(r.Y) && !double.IsInfinity(r.Width) && !double.IsInfinity(r.Height)
                    && !double.IsNaN(r.X) && !double.IsNaN(r.Y) && r.Width > 0 && r.Height > 0)
                {
                    f.HasRect = true;
                    f.X = (int)Math.Round(r.X);
                    f.Y = (int)Math.Round(r.Y);
                    f.W = (int)Math.Round(r.Width);
                    f.H = (int)Math.Round(r.Height);
                }
                return f;
            }
            catch (Exception)
            {
                return null;
            }
        }

        static object Pat(AutomationElement el, AutomationPattern pattern)
        {
            try
            {
                object found;
                if (el.TryGetCurrentPattern(pattern, out found)) return found;
            }
            catch (Exception) { }
            return null;
        }

        /// <summary>The whole text of an element (ValuePattern, else TextPattern), or null. Never call it for a sensitive element.</summary>
        static string ReadFullText(AutomationElement el, int limit)
        {
            try
            {
                ValuePattern value = Pat(el, ValuePattern.Pattern) as ValuePattern;
                if (value != null)
                {
                    string text = value.Current.Value;
                    if (text != null) return text.Length > limit ? text.Substring(0, limit) : text;
                }
                TextPattern doc = Pat(el, TextPattern.Pattern) as TextPattern;
                if (doc != null)
                {
                    string text = doc.DocumentRange.GetText(limit);
                    if (text != null) return text;
                }
            }
            catch (Exception) { }
            return null;
        }

        static string Hash(string role, string name)
        {
            uint h = 2166136261;
            string text = (role + "|" + (name == null ? "" : name)).ToLowerInvariant();
            for (int i = 0; i < text.Length; i++)
            {
                h ^= text[i];
                h = unchecked(h * 16777619);
            }
            return h.ToString("x");
        }

        static string MakeId(string hwnd, string path, Facts f)
        {
            return hwnd + ":" + path + "#" + Hash(f.Role, f.Name);
        }

        static void ParseId(string id, out long hwnd, out string path, out string hash)
        {
            hwnd = 0;
            path = "";
            hash = "";
            int colon = id.IndexOf(':');
            int hashAt = id.LastIndexOf('#');
            if (colon <= 0 || hashAt < colon || !long.TryParse(id.Substring(0, colon), out hwnd))
            {
                throw new UiaError("bad_element", "That element id is not one this helper made. Find the element again.");
            }
            path = id.Substring(colon + 1, hashAt - colon - 1);
            hash = id.Substring(hashAt + 1);
        }

        static object BoundsOf(Facts f)
        {
            if (!f.HasRect) return null;
            Dictionary<string, object> b = new Dictionary<string, object>();
            b["x"] = f.X;
            b["y"] = f.Y;
            b["width"] = f.W;
            b["height"] = f.H;
            return b;
        }

        static Dictionary<string, object> NodeOf(AutomationElement el, Facts f, string id, bool includeText)
        {
            Dictionary<string, object> n = new Dictionary<string, object>();
            n["id"] = id;
            n["role"] = f.Role;
            if (f.Name.Length > 0) n["name"] = Clip(f.Name, 300);
            object bounds = BoundsOf(f);
            if (bounds != null) n["bounds"] = bounds;
            n["enabled"] = f.Enabled;
            if (f.Sensitive) n["sensitive"] = true;
            if (f.Hidden) n["hidden"] = true;
            if (includeText && IsEditLike(f.Type) && !f.Sensitive && !f.Hidden)
            {
                string text = ReadFullText(el, 200);
                if (text != null && text.Length > 0) n["text"] = Clip(text, 200);
            }
            return n;
        }

        // ---------- walking ----------

        static void Build(UiaState s, TreeWalker walker, AutomationElement el, Dictionary<string, object> node, string hwndText, string path, int depth, int maxDepth, int maxNodes, bool includeText, long deadline)
        {
            if (depth >= maxDepth) return;
            ArrayList kids = new ArrayList();
            bool attached = false;
            AutomationElement child = walker.GetFirstChild(el);
            int index = 0;
            while (child != null)
            {
                if (Stop(s, deadline)) { s.Truncated = true; return; }
                if (s.Count >= maxNodes) { s.Truncated = true; return; }
                if (index >= MaxSiblings) { s.Truncated = true; return; }
                Facts f = Read(child);
                if (f != null)
                {
                    string childPath = path.Length == 0 ? index.ToString() : path + "/" + index.ToString();
                    Dictionary<string, object> childNode = NodeOf(child, f, MakeId(hwndText, childPath, f), includeText);
                    lock (s.Sync)
                    {
                        if (s.Cancel) return;
                        s.Count++;
                        if (f.Sensitive || f.Hidden) s.Redacted = true;
                        kids.Add(childNode);
                        if (!attached) { node["children"] = kids; attached = true; }
                    }
                    Build(s, walker, child, childNode, hwndText, childPath, depth + 1, maxDepth, maxNodes, includeText, deadline);
                }
                index++;
                child = walker.GetNextSibling(child);
            }
        }

        /// <summary>Depth-first walk under one window. The visitor sees the window itself first (path empty). Returns false when the walk was stopped.</summary>
        static bool ScanRoot(UiaState s, IntPtr hwnd, int maxDepth, int maxNodes, long deadline, Visitor visit)
        {
            AutomationElement root = AutomationElement.FromHandle(hwnd);
            Facts f = Read(root);
            if (f == null) return true;
            s.Count++;
            if (!visit(root, f, "", 0)) return false;
            return Scan(s, TreeWalker.ControlViewWalker, root, "", 0, maxDepth, maxNodes, deadline, visit);
        }

        static bool Scan(UiaState s, TreeWalker walker, AutomationElement el, string path, int depth, int maxDepth, int maxNodes, long deadline, Visitor visit)
        {
            if (depth >= maxDepth) return true;
            AutomationElement child = walker.GetFirstChild(el);
            int index = 0;
            while (child != null)
            {
                if (Stop(s, deadline)) { s.Truncated = true; return false; }
                if (s.Count >= maxNodes) { s.Truncated = true; return false; }
                if (index >= MaxSiblings) { s.Truncated = true; return true; }
                Facts f = Read(child);
                if (f != null)
                {
                    string childPath = path.Length == 0 ? index.ToString() : path + "/" + index.ToString();
                    s.Count++;
                    if (!visit(child, f, childPath, depth + 1)) return false;
                    if (!Scan(s, walker, child, childPath, depth + 1, maxDepth, maxNodes, deadline, visit)) return false;
                }
                index++;
                child = walker.GetNextSibling(child);
            }
            return true;
        }

        static AutomationElement FollowPath(AutomationElement root, string path)
        {
            AutomationElement el = root;
            if (path.Length == 0) return el;
            TreeWalker walker = TreeWalker.ControlViewWalker;
            foreach (string part in path.Split('/'))
            {
                int index;
                if (!int.TryParse(part, out index) || index < 0) return null;
                AutomationElement child = walker.GetFirstChild(el);
                for (int i = 0; i < index && child != null; i++) child = walker.GetNextSibling(child);
                if (child == null) return null;
                el = child;
            }
            return el;
        }

        // ---------- matching ----------

        static string NormalizeRole(string role)
        {
            string text = role.Trim().ToLowerInvariant();
            switch (text)
            {
                case "button": return "push button";
                case "textbox": return "entry";
                case "text box": return "entry";
                case "text field": return "entry";
                case "edit": return "entry";
                case "checkbox": return "check box";
                case "hyperlink": return "link";
                case "combobox": return "combo box";
                case "tab": return "page tab";
                case "tab item": return "page tab";
                case "radio": return "radio button";
                case "radiobutton": return "radio button";
                case "menuitem": return "menu item";
                case "listitem": return "list item";
                case "text": return "text";
                default: return text;
            }
        }

        static bool RoleMatches(string wanted, string role)
        {
            if (wanted.Length == 0) return true;
            if (wanted == role) return true;
            if (wanted == "text") return role == "entry" || role == "label" || role == "document" || role == "password text";
            return false;
        }

        static double Confidence(bool queryMatch, bool roleMatch, bool exact)
        {
            if (exact && roleMatch) return 1.0;
            if (exact) return 0.95;
            if (queryMatch && roleMatch) return 0.9;
            if (queryMatch) return 0.82;
            if (roleMatch) return 0.7;
            return 0.0;
        }

        // ---------- uia.tree ----------

        static object Tree(Dictionary<string, object> p)
        {
            int timeout = TimeoutOf(p);
            long deadline = DeadlineFor(timeout);
            int maxDepth = Math.Max(1, Math.Min(MaxDepthAllowed, IntOr(p, "maxDepth", 3)));
            int maxNodes = Math.Max(1, Math.Min(1000, IntOr(p, "maxNodes", 200)));
            bool includeText = BoolOr(p, "includeText", false);
            List<IntPtr> roots = RootsOf(p);
            Dictionary<string, object> r = new Dictionary<string, object>();
            if (roots.Count == 0)
            {
                r["root"] = null;
                r["nodeCount"] = 0;
                r["truncated"] = false;
                r["redacted"] = false;
                r["timedOut"] = false;
                r["found"] = false;
                return r;
            }
            IntPtr rootHwnd = roots[0];
            RequireReachable(rootHwnd);
            string hwndText = rootHwnd.ToInt64().ToString();
            UiaState s = new UiaState();
            bool done = Run(timeout, s, delegate()
            {
                AutomationElement el = AutomationElement.FromHandle(rootHwnd);
                Facts f = Read(el);
                if (f == null) throw new UiaError("uia_unavailable", "UI Automation could not read that window.");
                Dictionary<string, object> node = NodeOf(el, f, MakeId(hwndText, "", f), includeText);
                lock (s.Sync)
                {
                    if (s.Cancel) return;
                    s.Root = node;
                    s.Count = 1;
                    if (f.Sensitive || f.Hidden) s.Redacted = true;
                }
                Build(s, TreeWalker.ControlViewWalker, el, node, hwndText, "", 0, maxDepth, maxNodes, includeText, deadline);
            });
            r["root"] = s.Root;
            r["nodeCount"] = s.Count;
            r["truncated"] = s.Truncated || !done;
            r["redacted"] = s.Redacted;
            r["timedOut"] = !done;
            r["found"] = s.Root != null;
            return r;
        }

        // ---------- uia.find ----------

        static object Find(Dictionary<string, object> p)
        {
            int timeout = TimeoutOf(p);
            long deadline = DeadlineFor(timeout);
            string query = StrOr(p, "query", "").Trim().ToLowerInvariant();
            string role = NormalizeRole(StrOr(p, "role", ""));
            int limit = Math.Max(1, Math.Min(50, IntOr(p, "limit", 10)));
            int maxNodes = Math.Max(1, Math.Min(2000, IntOr(p, "maxNodes", 1000)));
            if (query.Length == 0 && role.Length == 0) throw new UiaError("bad_query", "A name or a role is required.");
            List<IntPtr> roots = RootsOf(p);
            foreach (IntPtr root in roots) RequireReachable(root);
            UiaState s = new UiaState();
            bool done = Run(timeout, s, delegate()
            {
                foreach (IntPtr root in roots)
                {
                    string hwndText = root.ToInt64().ToString();
                    bool more = ScanRoot(s, root, MaxDepthAllowed, maxNodes, deadline, delegate(AutomationElement el, Facts f, string path, int depth)
                    {
                        if (f.Hidden) return true;
                        bool roleMatch = role.Length == 0 || RoleMatches(role, f.Role);
                        if (!roleMatch) return true;
                        bool queryMatch = false;
                        bool exact = false;
                        if (query.Length > 0)
                        {
                            string name = f.Name.ToLowerInvariant();
                            string automationId = f.AutomationId.ToLowerInvariant();
                            queryMatch = (name.Length > 0 && name.Contains(query)) || (automationId.Length > 0 && automationId.Contains(query));
                            exact = name == query || automationId == query;
                            if (!queryMatch) return true;
                        }
                        Dictionary<string, object> c = NodeOf(el, f, MakeId(hwndText, path, f), true);
                        c["confidence"] = Confidence(queryMatch, role.Length > 0 && roleMatch, exact);
                        c["reason"] = query.Length > 0 ? "Matched accessibility query." : "Matched accessibility role.";
                        lock (s.Sync)
                        {
                            if (s.Cancel) return false;
                            s.Items.Add(c);
                        }
                        return s.Items.Count < 200;
                    });
                    if (!more) break;
                }
            });
            List<Dictionary<string, object>> all = new List<Dictionary<string, object>>();
            foreach (object item in s.Items) all.Add((Dictionary<string, object>)item);
            // Stable by tree order within one confidence.
            List<KeyValuePair<int, Dictionary<string, object>>> ranked = new List<KeyValuePair<int, Dictionary<string, object>>>();
            for (int i = 0; i < all.Count; i++) ranked.Add(new KeyValuePair<int, Dictionary<string, object>>(i, all[i]));
            ranked.Sort(delegate(KeyValuePair<int, Dictionary<string, object>> a, KeyValuePair<int, Dictionary<string, object>> b)
            {
                int byConfidence = Convert.ToDouble(b.Value["confidence"]).CompareTo(Convert.ToDouble(a.Value["confidence"]));
                return byConfidence != 0 ? byConfidence : a.Key.CompareTo(b.Key);
            });
            ArrayList candidates = new ArrayList();
            for (int i = 0; i < ranked.Count && i < limit; i++) candidates.Add(ranked[i].Value);
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["candidates"] = candidates;
            r["truncated"] = s.Truncated || !done;
            r["timedOut"] = !done;
            r["windows"] = roots.Count;
            return r;
        }

        // ---------- resolving one element for the actions ----------

        /// <summary>Runs on the worker thread. By element id (walk the path, check the hash, else look for the hash), or by name and role.</summary>
        static Target Resolve(UiaState s, Dictionary<string, object> p, long deadline)
        {
            Target t = new Target();
            string elementId = StrOr(p, "elementId", "");
            if (elementId.Length > 0)
            {
                long hv;
                string path;
                string hash;
                ParseId(elementId, out hv, out path, out hash);
                IntPtr hwnd = new IntPtr(hv);
                if (!UNative.IsWindow(hwnd)) throw new UiaError("window_gone", "That window no longer exists.");
                RequireReachable(hwnd);
                t.Hwnd = hwnd;
                string hwndText = hv.ToString();
                AutomationElement root = AutomationElement.FromHandle(hwnd);
                AutomationElement el = FollowPath(root, path);
                Facts f = el == null ? null : Read(el);
                if (f != null && Hash(f.Role, f.Name) == hash)
                {
                    t.Element = el;
                    t.F = f;
                    t.Id = elementId;
                    t.Matches = 1;
                    return t;
                }
                // The tree changed since the id was made: look for the same role and name once.
                List<Target> same = new List<Target>();
                ScanRoot(s, hwnd, MaxDepthAllowed, 1500, deadline, delegate(AutomationElement e2, Facts f2, string path2, int depth2)
                {
                    if (Hash(f2.Role, f2.Name) == hash && !f2.Hidden)
                    {
                        Target c = new Target();
                        c.Element = e2; c.F = f2; c.Id = MakeId(hwndText, path2, f2); c.Hwnd = hwnd; c.Matches = 1;
                        same.Add(c);
                    }
                    return same.Count < 3;
                });
                if (same.Count == 1) return same[0];
                t.Matches = same.Count;
                t.Ambiguous = same.Count > 1;
                t.Reason = same.Count > 1 ? "The element id matches several controls now. Find it again by name." : "The element is gone or changed. Find it again.";
                return t;
            }

            string query = StrOr(p, "query", "").Trim().ToLowerInvariant();
            string role = NormalizeRole(StrOr(p, "role", ""));
            bool requireExact = BoolOr(p, "requireExactMatch", false);
            if (query.Length == 0 && role.Length == 0) throw new UiaError("bad_target", "An element id, a name or a role is required.");
            List<IntPtr> roots = RootsOf(p);
            foreach (IntPtr root in roots) RequireReachable(root);
            List<Target> hits = new List<Target>();
            foreach (IntPtr root in roots)
            {
                IntPtr rootHwnd = root;
                string hwndText2 = rootHwnd.ToInt64().ToString();
                bool more = ScanRoot(s, rootHwnd, MaxDepthAllowed, 1500, deadline, delegate(AutomationElement el2, Facts f3, string path3, int depth3)
                {
                    if (f3.Hidden) return true;
                    if (role.Length > 0 && !RoleMatches(role, f3.Role)) return true;
                    if (query.Length > 0)
                    {
                        string name = f3.Name.ToLowerInvariant();
                        string automationId = f3.AutomationId.ToLowerInvariant();
                        bool ok = requireExact ? (name == query || automationId == query) : ((name.Length > 0 && name.Contains(query)) || (automationId.Length > 0 && automationId.Contains(query)));
                        if (!ok) return true;
                    }
                    Target c = new Target();
                    c.Element = el2; c.F = f3; c.Id = MakeId(hwndText2, path3, f3); c.Hwnd = rootHwnd; c.Matches = 1;
                    hits.Add(c);
                    return hits.Count < 50;
                });
                if (!more && hits.Count >= 50) break;
            }
            if (hits.Count == 1) { hits[0].Matches = 1; return hits[0]; }
            t.Matches = hits.Count;
            if (hits.Count == 0)
            {
                t.Reason = roots.Count == 0 ? "No window of that app is open." : "No matching element was found.";
            }
            else
            {
                t.Ambiguous = true;
                t.Reason = "Several elements match (" + hits.Count.ToString() + "). Use an element id from ui.find, or add a role.";
            }
            return t;
        }

        static Dictionary<string, object> Details(AutomationElement el, Facts f, string id, IntPtr hwnd)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["id"] = id;
            d["role"] = f.Role;
            if (f.Name.Length > 0) d["name"] = Clip(f.Name, 300);
            if (!f.Sensitive)
            {
                try
                {
                    string help = el.Current.HelpText;
                    if (help != null && help.Trim().Length > 0) d["description"] = Clip(help.Trim(), 300);
                }
                catch (Exception) { }
            }
            ArrayList states = new ArrayList();
            states.Add(f.Enabled ? "enabled" : "disabled");
            states.Add(f.Hidden ? "offscreen" : "showing");
            try { if (el.Current.HasKeyboardFocus) states.Add("focused"); } catch (Exception) { }
            try { if (el.Current.IsKeyboardFocusable) states.Add("focusable"); } catch (Exception) { }
            if (f.Password) states.Add("password text");
            ArrayList actions = new ArrayList();
            if (Pat(el, InvokePattern.Pattern) != null) actions.Add("invoke");
            TogglePattern toggle = Pat(el, TogglePattern.Pattern) as TogglePattern;
            if (toggle != null)
            {
                actions.Add("toggle");
                try
                {
                    ToggleState state = toggle.Current.ToggleState;
                    states.Add(state == ToggleState.On ? "checked" : state == ToggleState.Off ? "unchecked" : "indeterminate");
                }
                catch (Exception) { }
            }
            SelectionItemPattern selection = Pat(el, SelectionItemPattern.Pattern) as SelectionItemPattern;
            if (selection != null)
            {
                actions.Add("select");
                try { if (selection.Current.IsSelected) states.Add("selected"); } catch (Exception) { }
            }
            ExpandCollapsePattern expand = Pat(el, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
            if (expand != null)
            {
                actions.Add("expand");
                actions.Add("collapse");
                try
                {
                    ExpandCollapseState state = expand.Current.ExpandCollapseState;
                    if (state == ExpandCollapseState.Expanded) states.Add("expanded");
                    else if (state == ExpandCollapseState.Collapsed) states.Add("collapsed");
                }
                catch (Exception) { }
            }
            ValuePattern value = Pat(el, ValuePattern.Pattern) as ValuePattern;
            bool hasText = Pat(el, TextPattern.Pattern) != null;
            if (value != null || hasText)
            {
                Dictionary<string, object> meta = new Dictionary<string, object>();
                bool readOnly = false;
                if (value != null)
                {
                    try { readOnly = value.Current.IsReadOnly; } catch (Exception) { readOnly = true; }
                    actions.Add("set value");
                }
                else readOnly = true;
                if (readOnly) states.Add("readonly");
                meta["supportsText"] = true;
                meta["supportsValue"] = value != null;
                meta["readOnly"] = readOnly;
                meta["editable"] = !readOnly && f.Enabled;
                if (!f.Sensitive && !f.Hidden)
                {
                    string text = ReadFullText(el, 20000);
                    if (text != null) meta["textLength"] = text.Length;
                }
                d["valueMetadata"] = meta;
            }
            d["states"] = states;
            d["availableActions"] = actions;
            object bounds = BoundsOf(f);
            if (bounds != null) d["bounds"] = bounds;
            string title;
            string process;
            WindowInfo(hwnd, out title, out process);
            if (process.Length > 0) d["appName"] = process;
            d["windowId"] = hwnd.ToInt64().ToString();
            if (title.Length > 0) d["windowTitle"] = Clip(title, 160);
            d["pid"] = f.Pid;
            d["sensitive"] = f.Sensitive;
            d["hidden"] = f.Hidden;
            return d;
        }

        static Dictionary<string, object> ResultFor(Target t)
        {
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["matched"] = t.Element != null;
            r["ambiguous"] = t.Ambiguous;
            r["matches"] = t.Matches;
            r["reason"] = t.Reason;
            return r;
        }

        static object FinishOrTimeout(UiaState s, bool done, string what)
        {
            if (done)
            {
                if (s.Result == null) throw new UiaError("uia_error", "UI Automation gave no answer for " + what + ".");
                return s.Result;
            }
            throw new UiaError("uia_timeout", "The app did not answer UI Automation in time (" + what + "). It may be busy or hung.");
        }

        // ---------- uia.inspect ----------

        static object Inspect(Dictionary<string, object> p)
        {
            int timeout = TimeoutOf(p);
            long deadline = DeadlineFor(timeout);
            UiaState s = new UiaState();
            bool done = Run(timeout, s, delegate()
            {
                Target t = Resolve(s, p, deadline);
                Dictionary<string, object> r = ResultFor(t);
                if (t.Element != null) r["element"] = Details(t.Element, t.F, t.Id, t.Hwnd);
                lock (s.Sync) { if (!s.Cancel) s.Result = r; }
            });
            return FinishOrTimeout(s, done, "inspect");
        }

        // ---------- uia.activate ----------

        static bool Perform(UiaState s, AutomationElement el, string action, out string used, out string why)
        {
            used = "";
            why = "";
            bool any = action.Length == 0 || action == "click" || action == "press" || action == "activate" || action == "invoke" || action == "default";
            try
            {
                object pattern;
                if ((any || action == "invoke") && el.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
                {
                    s.Phase = "acting";
                    ((InvokePattern)pattern).Invoke();
                    s.Phase = "";
                    used = "invoke";
                    return true;
                }
                if ((any || action == "toggle") && el.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
                {
                    s.Phase = "acting";
                    ((TogglePattern)pattern).Toggle();
                    s.Phase = "";
                    used = "toggle";
                    return true;
                }
                if ((any || action == "select") && el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
                {
                    s.Phase = "acting";
                    ((SelectionItemPattern)pattern).Select();
                    s.Phase = "";
                    used = "select";
                    return true;
                }
                if ((any || action == "expand" || action == "collapse") && el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
                {
                    ExpandCollapsePattern expand = (ExpandCollapsePattern)pattern;
                    bool open = expand.Current.ExpandCollapseState == ExpandCollapseState.Expanded;
                    s.Phase = "acting";
                    if (action == "expand" || (any && !open)) { expand.Expand(); used = "expand"; }
                    else { expand.Collapse(); used = "collapse"; }
                    s.Phase = "";
                    return true;
                }
            }
            catch (ElementNotEnabledException)
            {
                s.Phase = "";
                why = "The element is disabled.";
                return false;
            }
            catch (InvalidOperationException e)
            {
                s.Phase = "";
                why = "UI Automation refused the action: " + e.Message;
                return false;
            }
            why = "The element supports no invoke, toggle, select or expand action. Click it by its bounds instead.";
            return false;
        }

        static object Activate(Dictionary<string, object> p)
        {
            int timeout = TimeoutOf(p);
            long deadline = DeadlineFor(timeout);
            string action = StrOr(p, "action", "click").Trim().ToLowerInvariant();
            UiaState s = new UiaState();
            bool done = Run(timeout, s, delegate()
            {
                Target t = Resolve(s, p, deadline);
                Dictionary<string, object> r = ResultFor(t);
                r["performed"] = false;
                if (t.Element != null) r["element"] = Details(t.Element, t.F, t.Id, t.Hwnd);
                lock (s.Sync) { if (!s.Cancel) s.Result = r; }
                if (t.Element == null) return;
                if (!t.F.Enabled)
                {
                    Put(s, r, "reason", "The element is disabled, so nothing was done.");
                    return;
                }
                if (s.Cancel) return;
                string used;
                string why;
                bool performed = Perform(s, t.Element, action, out used, out why);
                Put(s, r, "performed", performed);
                if (used.Length > 0) Put(s, r, "action", used);
                Put(s, r, "reason", performed ? "Performed the " + used + " action." : why);
            });
            if (!done)
            {
                Dictionary<string, object> r = s.Result as Dictionary<string, object>;
                if (s.Phase == "acting" && r != null)
                {
                    // The call went out but the app has not returned (a modal dialog blocks Invoke until it closes).
                    Dictionary<string, object> late = new Dictionary<string, object>(r);
                    late["performed"] = true;
                    late["timedOut"] = true;
                    late["reason"] = "The action was sent, but the app did not return in time (a dialog may be open). Check the screen.";
                    return late;
                }
                throw new UiaError("uia_timeout", "The app did not answer UI Automation in time. It may be busy or hung.");
            }
            return FinishOrTimeout(s, done, "activate");
        }

        // ---------- uia.setText / uia.getText ----------

        static object SetText(Dictionary<string, object> p)
        {
            int timeout = TimeoutOf(p);
            long deadline = DeadlineFor(timeout);
            string value = StrOr(p, "value", "");
            UiaState s = new UiaState();
            bool done = Run(timeout, s, delegate()
            {
                Target t = Resolve(s, p, deadline);
                Dictionary<string, object> r = ResultFor(t);
                r["changed"] = false;
                if (t.Element != null)
                {
                    r["element"] = Details(t.Element, t.F, t.Id, t.Hwnd);
                    r["sensitive"] = t.F.Sensitive;
                }
                lock (s.Sync) { if (!s.Cancel) s.Result = r; }
                if (t.Element == null) return;
                if (t.F.Sensitive)
                {
                    Put(s, r, "reason", "That field holds a password or credential, so nothing was typed. The person must enter it.");
                    return;
                }
                if (!t.F.Enabled)
                {
                    Put(s, r, "reason", "The field is disabled.");
                    return;
                }
                ValuePattern pattern = Pat(t.Element, ValuePattern.Pattern) as ValuePattern;
                if (pattern == null)
                {
                    Put(s, r, "reason", "The element has no editable value through UI Automation. Click it and use desktop.type_text.");
                    return;
                }
                bool readOnly;
                try { readOnly = pattern.Current.IsReadOnly; } catch (Exception) { readOnly = true; }
                if (readOnly)
                {
                    Put(s, r, "reason", "The field is read-only.");
                    return;
                }
                if (s.Cancel) return;
                try
                {
                    s.Phase = "acting";
                    pattern.SetValue(value);
                    s.Phase = "";
                    Put(s, r, "changed", true);
                    Put(s, r, "reason", "Set the field value.");
                }
                catch (ElementNotEnabledException)
                {
                    s.Phase = "";
                    Put(s, r, "reason", "The field is disabled.");
                }
                catch (InvalidOperationException e)
                {
                    s.Phase = "";
                    Put(s, r, "reason", "UI Automation refused the value: " + e.Message);
                }
                catch (ArgumentException e)
                {
                    s.Phase = "";
                    Put(s, r, "reason", "The field did not accept the value: " + e.Message);
                }
            });
            if (!done)
            {
                Dictionary<string, object> r = s.Result as Dictionary<string, object>;
                if (s.Phase == "acting" && r != null)
                {
                    Dictionary<string, object> late = new Dictionary<string, object>(r);
                    late["changed"] = true;
                    late["timedOut"] = true;
                    late["reason"] = "The value was sent, but the app did not return in time. Read it back to check.";
                    return late;
                }
                throw new UiaError("uia_timeout", "The app did not answer UI Automation in time. It may be busy or hung.");
            }
            return FinishOrTimeout(s, done, "set text");
        }

        static object GetText(Dictionary<string, object> p)
        {
            int timeout = TimeoutOf(p);
            long deadline = DeadlineFor(timeout);
            UiaState s = new UiaState();
            bool done = Run(timeout, s, delegate()
            {
                Target t = Resolve(s, p, deadline);
                Dictionary<string, object> r = ResultFor(t);
                r["readable"] = false;
                if (t.Element != null)
                {
                    r["sensitive"] = t.F.Sensitive || t.F.Hidden;
                    if (t.F.Sensitive || t.F.Hidden)
                    {
                        r["reason"] = "The element is a password, credential or hidden field, so its text is never read.";
                    }
                    else
                    {
                        string text = ReadFullText(t.Element, 20000);
                        if (text == null) r["reason"] = "The element exposes no text through UI Automation.";
                        else
                        {
                            r["readable"] = true;
                            r["text"] = text;
                            r["length"] = text.Length;
                            r["reason"] = "Read the element text.";
                        }
                    }
                }
                lock (s.Sync) { if (!s.Cancel) s.Result = r; }
            });
            return FinishOrTimeout(s, done, "get text");
        }

        // ---------- uia.focus ----------

        static object Focus(Dictionary<string, object> p)
        {
            int timeout = TimeoutOf(p);
            long deadline = DeadlineFor(timeout);
            UiaState s = new UiaState();
            bool done = Run(timeout, s, delegate()
            {
                Target t = Resolve(s, p, deadline);
                Dictionary<string, object> r = ResultFor(t);
                r["focused"] = false;
                if (t.Element != null)
                {
                    if (!t.F.Enabled) r["reason"] = "The element is disabled.";
                    else
                    {
                        try
                        {
                            t.Element.SetFocus();
                            bool has = false;
                            try { has = t.Element.Current.HasKeyboardFocus; } catch (Exception) { }
                            r["focused"] = has;
                            r["reason"] = has ? "Moved keyboard focus to the element." : "The element did not take keyboard focus.";
                        }
                        catch (InvalidOperationException e)
                        {
                            r["reason"] = "The element cannot take focus: " + e.Message;
                        }
                    }
                    r["element"] = Details(t.Element, t.F, t.Id, t.Hwnd);
                }
                lock (s.Sync) { if (!s.Cancel) s.Result = r; }
            });
            return FinishOrTimeout(s, done, "focus");
        }

        // ---------- uia.textAtPoint (desktop.set_field read-back) ----------

        static object TextAtPoint(Dictionary<string, object> p)
        {
            int timeout = TimeoutOf(p);
            int x = IntOr(p, "x", 0);
            int y = IntOr(p, "y", 0);
            int pid = IntOr(p, "pid", 0);
            RequireReachableAt(x, y);
            UiaState s = new UiaState();
            bool done = Run(timeout, s, delegate()
            {
                Dictionary<string, object> r = new Dictionary<string, object>();
                r["found"] = false;
                AutomationElement el = AutomationElement.FromPoint(new System.Windows.Point(x, y));
                TreeWalker walker = TreeWalker.ControlViewWalker;
                Facts f = null;
                for (int up = 0; up < 4 && el != null; up++)
                {
                    f = Read(el);
                    if (f != null && IsEditLike(f.Type) && f.Type.Id != ControlType.ComboBox.Id) break;
                    f = null;
                    el = walker.GetParent(el);
                }
                if (el == null || f == null)
                {
                    r["reason"] = "No editable text field is exposed through UI Automation at that point.";
                }
                else if (pid > 0 && f.Pid != pid)
                {
                    r["reason"] = "The field at that point belongs to another app.";
                }
                else
                {
                    bool focused = false;
                    try { focused = el.Current.HasKeyboardFocus; } catch (Exception) { }
                    r["found"] = true;
                    r["role"] = f.Role;
                    r["focused"] = focused;
                    r["sensitive"] = f.Sensitive || f.Hidden;
                    r["reason"] = "Read the editable text field at that point through UI Automation.";
                    if (!f.Sensitive && !f.Hidden)
                    {
                        string text = ReadFullText(el, 20000);
                        if (text != null)
                        {
                            r["text"] = text;
                            r["length"] = text.Length;
                        }
                    }
                }
                lock (s.Sync) { if (!s.Cancel) s.Result = r; }
            });
            return FinishOrTimeout(s, done, "text at point");
        }
    }
}
`;
