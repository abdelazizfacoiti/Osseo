/*
 * The Windows overlay process: one Windows PowerShell 5.1 process (STA) that hosts a WPF window per card and
 * speaks the same JSON-line protocol as the GTK renderer (hello, show, update, dismiss, clear, emergency_hide,
 * state, events, close). It exits when its stdin closes, so the cards go with the server.
 *
 * Control buttons act only on a real mouse press. A low-level mouse hook records whether each left-button
 * event came from the hardware or was injected (SendInput, mouse_event). WPF's preview events tell us which
 * button the event reached, so a press is real only if the same button saw a real press and a real release.
 * Keyboard activation, touch, UI Automation's Invoke and the agent's own clicks never pass that check.
 *
 * Checked on Windows 11 with scripts\windows-overlay-smoke.mjs (cards and the guard) and scripts\windows-dock-smoke.mjs
 * (the dock strip). The C# must
 * stay C# 5 (Windows PowerShell 5.1 compiles it with Add-Type): no string interpolation, no "?.", no
 * expression-bodied members. The text must not contain a backtick or the characters dollar-brace.
 */

const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace AgentHostOverlay
{
    public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct MsllPoint
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MsllHookStruct
    {
        public MsllPoint Pt;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    // APPBARDATA, for SHAppBarMessage (the dock's reserved strip).
    [StructLayout(LayoutKind.Sequential)]
    public struct AppBarData
    {
        public int cbSize;
        public IntPtr hWnd;
        public uint uCallbackMessage;
        public uint uEdge;
        public NativeRect rc;
        public IntPtr lParam;
    }

    public static class Native
    {
        public const int WhMouseLl = 14;
        public const int WmLButtonDown = 0x0201;
        public const int WmLButtonUp = 0x0202;
        public const uint LlmhfInjected = 0x00000001;
        public const uint LlmhfLowerIlInjected = 0x00000002;
        public const int GwlExStyle = -20;
        public const int WsExTransparent = 0x00000020;
        public const int WsExToolWindow = 0x00000080;
        public const int WsExNoActivate = 0x08000000;
        public const uint AbmNew = 0;
        public const uint AbmRemove = 1;
        public const uint AbmQueryPos = 2;
        public const uint AbmSetPos = 3;
        public const uint AbeLeft = 0;
        public const uint AbeRight = 2;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr GetModuleHandle(string moduleName);

        [DllImport("user32.dll")]
        public static extern int GetWindowLong(IntPtr hWnd, int index);

        [DllImport("user32.dll")]
        public static extern int SetWindowLong(IntPtr hWnd, int index, int value);

        [DllImport("shell32.dll")]
        public static extern IntPtr SHAppBarMessage(uint message, ref AppBarData data);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint RegisterWindowMessage(string text);
    }

    // The hook sees every left-button event and whether Windows marks it injected. Only a press that is
    // not injected counts as a person's press.
    public static class PressGuard
    {
        static IntPtr hook = IntPtr.Zero;
        static LowLevelMouseProc keepAlive;

        public static bool LastDownReal;
        public static bool LastUpReal;

        public static bool Install()
        {
            if (hook != IntPtr.Zero) return true;
            keepAlive = HookProc;
            hook = Native.SetWindowsHookEx(Native.WhMouseLl, keepAlive, Native.GetModuleHandle(null), 0);
            return hook != IntPtr.Zero;
        }

        public static void Remove()
        {
            if (hook != IntPtr.Zero) Native.UnhookWindowsHookEx(hook);
            hook = IntPtr.Zero;
        }

        static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int message = wParam.ToInt32();
                if (message == Native.WmLButtonDown || message == Native.WmLButtonUp)
                {
                    MsllHookStruct data = (MsllHookStruct)Marshal.PtrToStructure(lParam, typeof(MsllHookStruct));
                    bool real = (data.Flags & (Native.LlmhfInjected | Native.LlmhfLowerIlInjected)) == 0;
                    if (message == Native.WmLButtonDown) LastDownReal = real;
                    else LastUpReal = real;
                }
            }
            return Native.CallNextHookEx(hook, nCode, wParam, lParam);
        }
    }

    // One button's last press and release, each marked real or synthetic by the hook.
    public sealed class RealPress
    {
        public bool Down;
        public bool Up;
    }

    public sealed class Card
    {
        public string OverlayId = "";
        public string Sensitivity = "public";
        public string Placement = "top_right";
        public bool Interactive;
        public List<string> AllowedEvents = new List<string>();
        public Window Window;
        public Border Frame;
        public int Sequence;
        public string CreatedAt = "";
        public string UpdatedAt = "";
    }

    public static class Renderer
    {
        const int Version = 1;
        const int MaxBytes = 256 * 1024;
        const int MaxCards = 12;
        const double CardWidth = 340;
        const double Margin = 16;
        const double Gap = 8;
        const double OffscreenPosition = -20000;
        // The dock: the same numbers as the Linux renderer (CARD_MARGIN, dock_layout), in WPF units.
        const double DockMargin = 24;
        const double DockMinWidth = 160;
        const double DockMaxCard = 420;
        const double DockMinTimeline = 96;
        const double DockMinBottom = 64;
        const double DockBottomShare = 0.45;
        const int DockReleaseMs = 2000;
        const string TimelinePrefix = "agenthost-timeline-";

        static readonly string[] Commands = new string[] { "hello", "capabilities", "show", "update", "dismiss", "clear", "emergency_hide", "state", "events", "close" };
        static readonly string[] Placements = new string[] { "top_left", "top_center", "top_right", "bottom_left", "bottom_center", "bottom_right" };
        static readonly string[] Limitations = new string[] {
            "Primitives such as rings, pointers, highlights and pills are not drawn.",
            "Cards are placed on the primary display only.",
            "Buttons act only on a real mouse press. Keyboard, touch, UI Automation and injected input are refused.",
            "Cards without buttons pass clicks through.",
            "The rail layout is not drawn on Windows: its cards float over the work area."
        };
        static readonly Brush Ink = Rgb(238, 242, 250);
        static readonly Brush Muted = Rgb(160, 172, 196);
        static readonly Brush Amber = Rgb(255, 196, 92);
        static readonly Brush Red = Rgb(255, 140, 140);
        static readonly Brush Green = Rgb(140, 220, 160);
        static readonly Brush Blue = Rgb(140, 180, 255);
        static readonly Brush Neutral = Rgb(126, 156, 210);
        static readonly Brush Rule = Rgb(51, 65, 90);
        static readonly Brush Surface = Rgb(24, 28, 39);
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        static readonly Dictionary<string, Card> Cards = new Dictionary<string, Card>();
        static readonly List<Card> Order = new List<Card>();
        static readonly List<Dictionary<string, object>> Events = new List<Dictionary<string, object>>();
        static Dispatcher dispatcher;
        static string token;
        static string sessionId = "unknown";
        static int rendererEpoch;
        static int sequence;
        static bool emergencyHidden;
        static bool guardReady;
        static string layoutMode = "ambient";
        static string dockSide = "right";
        static int dockPercent = 18;
        static bool dockReserve = true;
        static Window dockOwner;
        static Window dockPanel;
        static bool dockRegistered;
        static uint dockCallback;
        static Rect dockRect;
        static DispatcherTimer dockRelease;
        static readonly Brush StripFill = Rgb(14, 17, 26);

        public static void Start()
        {
            Json.MaxJsonLength = MaxBytes * 4;
            dispatcher = Dispatcher.CurrentDispatcher;
            Thread reader = new Thread(ReadInput);
            reader.IsBackground = true;
            reader.Start();
        }

        static void ReadInput()
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                string captured = line;
                dispatcher.BeginInvoke(new Action(delegate() { HandleLine(captured); }));
            }
            dispatcher.BeginInvoke(new Action(delegate() { Shutdown(); }));
        }

        static void HandleLine(string line)
        {
            if (string.IsNullOrEmpty(line) || Encoding.UTF8.GetByteCount(line) > MaxBytes) return;
            Dictionary<string, object> request;
            try { request = Json.Deserialize<Dictionary<string, object>>(line); }
            catch (Exception) { return; }
            string id = Str(request, "id");
            if (id == null || id.Length < 1 || id.Length > 100) return;
            string command = Str(request, "command");
            string candidate = Str(request, "token");
            if (Int(request, "version", 0) != Version || candidate == null || candidate.Length < 32 || candidate.Length > 200 || command == null || Array.IndexOf(Commands, command) < 0)
            {
                Reply(id, false, null, "renderer_request_invalid");
                return;
            }
            Dictionary<string, object> payload = Dict(request, "payload") ?? new Dictionary<string, object>();
            if (token == null)
            {
                if (command != "hello")
                {
                    Reply(id, false, null, "renderer_handshake_required");
                    return;
                }
                token = candidate;
                string session = Str(payload, "sessionId");
                if (session != null && session.Length >= 1 && session.Length <= 200) sessionId = session;
            }
            if (candidate != token)
            {
                Reply(id, false, null, "renderer_token_invalid");
                return;
            }
            try { Run(id, command, payload); }
            catch (Exception) { Reply(id, false, null, "renderer_command_failed"); }
        }

        static void Run(string id, string command, Dictionary<string, object> payload)
        {
            if (command == "hello") { Hello(id, payload); return; }
            if (command == "capabilities") { Reply(id, true, Capabilities(), null); return; }
            if (command == "show" || command == "update") { ShowOrUpdate(id, command, payload); return; }
            if (command == "dismiss") { Dismiss(id, Str(payload, "overlayId")); return; }
            if (command == "clear") { ClearAll(id); return; }
            if (command == "emergency_hide") { EmergencyHide(id); return; }
            if (command == "state") { Reply(id, true, State(), null); return; }
            if (command == "events")
            {
                Dictionary<string, object> drained = new Dictionary<string, object>();
                drained["events"] = DrainEvents();
                Reply(id, true, drained, null);
                return;
            }
            if (command == "close")
            {
                Dictionary<string, object> closing = new Dictionary<string, object>();
                closing["reason"] = "renderer_closing";
                Reply(id, true, closing, null);
                Shutdown();
            }
        }

        static void Hello(string id, Dictionary<string, object> payload)
        {
            int epoch = Int(payload, "rendererEpoch", 0);
            if (epoch < 1)
            {
                Reply(id, false, null, "renderer_epoch_required");
                return;
            }
            rendererEpoch = epoch;
            ReadVisual(payload);
            if (!guardReady) guardReady = PressGuard.Install();
            Dictionary<string, object> data = new Dictionary<string, object>();
            data["protocolVersion"] = Version;
            data["rendererEpoch"] = rendererEpoch;
            data["capabilities"] = Capabilities();
            Reply(id, true, data, null);
        }

        static Dictionary<string, object> Capabilities()
        {
            bool ready = guardReady;
            Dictionary<string, object> c = new Dictionary<string, object>();
            c["supported"] = ready;
            c["available"] = true;
            c["visible"] = ready;
            c["renderer"] = "wpf-windows";
            c["rendererStatus"] = ready ? "available" : "unavailable";
            c["sessionType"] = "unknown";
            c["displayAvailable"] = true;
            c["clickThrough"] = ready;
            c["interactiveWidgets"] = ready;
            c["multipleDisplays"] = false;
            c["globalOverlayAvailable"] = ready;
            c["clickThroughAvailable"] = ready;
            c["multiDisplayAvailable"] = false;
            c["animationAvailable"] = false;
            c["interactiveWidgetsAvailable"] = ready;
            c["compositorAvailable"] = true;
            c["transparentWindowsAvailable"] = ready;
            c["reason"] = ready ? "wpf_overlay_ready" : "overlay_input_guard_unavailable";
            c["limitations"] = Limitations;
            return c;
        }

        static void ShowOrUpdate(string id, string command, Dictionary<string, object> payload)
        {
            string overlayId = Str(payload, "overlayId");
            Dictionary<string, object> body = Dict(payload, "payload");
            if (overlayId == null || overlayId.Length < 1 || overlayId.Length > 200 || body == null)
            {
                Reply(id, false, null, "render_record_invalid");
                return;
            }
            if (!guardReady)
            {
                Reply(id, false, null, "overlay_input_guard_unavailable");
                return;
            }
            if ((Str(payload, "type") ?? "widget") != "widget")
            {
                Reply(id, false, null, "overlay_primitive_unsupported");
                return;
            }
            Card card;
            bool exists = Cards.TryGetValue(overlayId, out card);
            if (command == "update" && !exists)
            {
                Reply(id, false, null, "overlay_not_found");
                return;
            }
            if (!exists && Cards.Count >= MaxCards)
            {
                Reply(id, false, null, "overlay_limit_reached");
                return;
            }
            if (!exists)
            {
                card = new Card();
                card.OverlayId = overlayId;
                card.Sequence = ++sequence;
                card.CreatedAt = Now();
            }
            UIElement content = BuildContent(card, body);
            if (IsDockCard(card))
            {
                EnsureDock();
                content = DockScroll(content);
            }
            card.UpdatedAt = Now();
            if (card.Window == null) card.Window = NewWindow();
            card.Window.Content = content;
            if (!card.Window.IsVisible) card.Window.Show();
            if (!exists)
            {
                Cards[overlayId] = card;
                Order.Add(card);
            }
            ApplyWindowStyle(card);
            card.Window.UpdateLayout();
            Reposition();
            if (!card.Window.IsVisible)
            {
                RemoveCard(card);
                Reply(id, false, null, "overlay_live_registration_missing");
                return;
            }
            emergencyHidden = false;
            bool shown = command == "show";
            Reply(id, true, Ack(command, shown ? "visible" : "updated", overlayId, shown ? "wpf_overlay_shown" : "wpf_overlay_updated", id), null);
        }

        static void Dismiss(string id, string overlayId)
        {
            Card card;
            if (overlayId != null && Cards.TryGetValue(overlayId, out card)) RemoveCard(card);
            Reply(id, true, Ack("dismiss", "dismissed", overlayId, "wpf_overlay_dismissed", id), null);
        }

        static void ClearAll(string id)
        {
            foreach (Card card in new List<Card>(Order)) RemoveCard(card);
            Reply(id, true, Ack("clear", "cleared", null, "wpf_overlays_cleared", id), null);
        }

        static void EmergencyHide(string id)
        {
            foreach (Card card in new List<Card>(Order)) RemoveCard(card);
            ReleaseDockNow();
            emergencyHidden = true;
            Reply(id, true, Ack("emergency_hide", "emergency_hidden", null, "wpf_emergency_hidden", id), null);
        }

        static void Shutdown()
        {
            foreach (Card card in new List<Card>(Order)) RemoveCard(card);
            ReleaseDockNow();
            PressGuard.Remove();
            if (dispatcher != null) dispatcher.InvokeShutdown();
        }

        static void RemoveCard(Card card)
        {
            Cards.Remove(card.OverlayId);
            Order.Remove(card);
            Window window = card.Window;
            card.Window = null;
            if (window != null) window.Close();
            Reposition();
            if (DockCardCount() == 0) ScheduleDockRelease();
        }

        static void Emit(Card card, string eventName)
        {
            if (!card.AllowedEvents.Contains(eventName) || !Cards.ContainsKey(card.OverlayId)) return;
            Dictionary<string, object> e = new Dictionary<string, object>();
            e["eventId"] = "event_" + Guid.NewGuid().ToString("N");
            e["overlayId"] = card.OverlayId;
            e["event"] = eventName;
            e["createdAt"] = Now();
            e["ownerSessionId"] = sessionId;
            Events.Add(e);
            if (Events.Count > 100) Events.RemoveAt(0);
            if (eventName == "dismissed" || eventName == "hide") RemoveCard(card);
        }

        static List<object> DrainEvents()
        {
            List<object> copy = new List<object>(Events);
            Events.Clear();
            return copy;
        }

        static Dictionary<string, object> State()
        {
            List<object> overlays = new List<object>();
            foreach (Card card in Order)
            {
                Dictionary<string, object> o = new Dictionary<string, object>();
                o["overlayId"] = card.OverlayId;
                o["ownerSessionId"] = sessionId;
                o["type"] = "widget";
                o["sensitivity"] = card.Sensitivity;
                o["interactive"] = card.Interactive;
                o["visible"] = card.Window != null && card.Window.IsVisible;
                o["createdAt"] = card.CreatedAt;
                o["updatedAt"] = card.UpdatedAt;
                o["expiresAt"] = card.UpdatedAt;
                overlays.Add(o);
            }
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["renderer"] = Capabilities();
            d["overlays"] = overlays;
            d["pendingEvents"] = new List<object>(Events);
            d["emergencyHidden"] = emergencyHidden;
            return d;
        }

        static Dictionary<string, object> Ack(string command, string acknowledgement, string overlayId, string reason, string requestId)
        {
            int visible = 0;
            int interactive = 0;
            int ready = 0;
            foreach (Card card in Order)
            {
                if (card.Window == null || !card.Window.IsVisible) continue;
                visible += 1;
                if (card.Interactive) interactive += 1;
                if (card.Window.ActualWidth > 0 && card.Window.ActualHeight > 0) ready += 1;
            }
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["command"] = command;
            d["acknowledgement"] = acknowledgement;
            d["rendererEpoch"] = rendererEpoch;
            d["visibleWindowCount"] = visible;
            d["interactiveWindowCount"] = interactive;
            d["transparentWindowCount"] = visible;
            d["drawReadyCount"] = ready;
            d["visible"] = visible > 0 && ready > 0;
            d["liveSurfaceRegistered"] = overlayId != null && Cards.ContainsKey(overlayId);
            if (overlayId != null) d["overlayId"] = overlayId;
            d["reason"] = reason;
            d["requestId"] = requestId;
            return d;
        }

        static void Reply(string id, bool ok, Dictionary<string, object> data, string error)
        {
            Dictionary<string, object> value = new Dictionary<string, object>();
            value["version"] = Version;
            value["id"] = id;
            value["ok"] = ok;
            if (data != null) value["data"] = data;
            if (error != null) value["error"] = Clip(error, 200);
            Console.Out.Write(Json.Serialize(value) + "\n");
            Console.Out.Flush();
        }

        static string Now()
        {
            return DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
        }

        static string Str(Dictionary<string, object> d, string key)
        {
            object value;
            if (d == null || !d.TryGetValue(key, out value)) return null;
            return value as string;
        }

        static int Int(Dictionary<string, object> d, string key, int fallback)
        {
            object value;
            if (d == null || !d.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToInt32(value, CultureInfo.InvariantCulture); }
            catch (Exception) { return fallback; }
        }

        static double Dbl(Dictionary<string, object> d, string key)
        {
            object value;
            if (d == null || !d.TryGetValue(key, out value) || value == null) return 0;
            try { return Convert.ToDouble(value, CultureInfo.InvariantCulture); }
            catch (Exception) { return 0; }
        }

        static bool Flag(Dictionary<string, object> d, string key)
        {
            object value;
            return d != null && d.TryGetValue(key, out value) && value is bool && (bool)value;
        }

        static Dictionary<string, object> Dict(Dictionary<string, object> d, string key)
        {
            object value;
            if (d == null || !d.TryGetValue(key, out value)) return null;
            return value as Dictionary<string, object>;
        }

        static object[] Items(Dictionary<string, object> d, string key)
        {
            object value;
            if (d == null || !d.TryGetValue(key, out value)) return new object[0];
            // JavaScriptSerializer.Deserialize<Dictionary<string, object>> returns nested arrays as ArrayList, not
            // object[] (only DeserializeObject gives object[]). Accept any IList, or every card would have no body.
            System.Collections.IList list = value as System.Collections.IList;
            if (list == null) return new object[0];
            object[] items = new object[list.Count];
            list.CopyTo(items, 0);
            return items;
        }

        static List<string> StringList(object[] items)
        {
            List<string> result = new List<string>();
            foreach (object item in items)
            {
                string text = item as string;
                if (text != null) result.Add(text);
            }
            return result;
        }

        static string Clip(string text, int limit)
        {
            if (text == null) return "";
            return text.Length > limit ? text.Substring(0, limit) : text;
        }

        static Brush Rgb(byte r, byte g, byte b)
        {
            SolidColorBrush brush = new SolidColorBrush(Color.FromRgb(r, g, b));
            brush.Freeze();
            return brush;
        }

        static Window NewWindow()
        {
            Window window = new Window();
            window.Title = "AgentHost overlay";
            window.WindowStyle = WindowStyle.None;
            window.AllowsTransparency = true;
            window.Background = Brushes.Transparent;
            window.Topmost = true;
            window.ShowInTaskbar = false;
            window.ShowActivated = false;
            window.Focusable = false;
            window.ResizeMode = ResizeMode.NoResize;
            window.SizeToContent = SizeToContent.Height;
            window.Width = CardWidth;
            window.Left = OffscreenPosition;
            window.Top = OffscreenPosition;
            return window;
        }

        static void ApplyWindowStyle(Card card)
        {
            ApplyFlags(card.Window, card.Interactive);
        }

        static void ApplyFlags(Window window, bool interactive)
        {
            IntPtr hwnd = new WindowInteropHelper(window).EnsureHandle();
            int style = Native.GetWindowLong(hwnd, Native.GwlExStyle);
            style |= Native.WsExToolWindow | Native.WsExNoActivate;
            if (interactive) style &= ~Native.WsExTransparent;
            else style |= Native.WsExTransparent;
            Native.SetWindowLong(hwnd, Native.GwlExStyle, style);
        }

        static void Reposition()
        {
            Rect area = SystemParameters.WorkArea;
            Dictionary<string, double> used = new Dictionary<string, double>();
            foreach (Card card in Order)
            {
                if (card.Window == null || !card.Window.IsVisible || IsDockCard(card)) continue;
                card.Window.UpdateLayout();
                double width = card.Window.ActualWidth > 0 ? card.Window.ActualWidth : CardWidth;
                double height = card.Window.ActualHeight;
                double offset;
                if (!used.TryGetValue(card.Placement, out offset)) offset = 0;
                double left = area.Right - width - Margin;
                if (card.Placement == "top_left" || card.Placement == "bottom_left") left = area.Left + Margin;
                else if (card.Placement == "top_center" || card.Placement == "bottom_center") left = area.Left + (area.Width - width) / 2;
                double top = area.Top + Margin + offset;
                if (card.Placement.StartsWith("bottom_", StringComparison.Ordinal)) top = area.Bottom - height - Margin - offset;
                card.Window.Left = left;
                card.Window.Top = top;
                used[card.Placement] = offset + height + Gap;
            }
            LayoutDock();
        }

        // ---- Dock ----------------------------------------------------------------------------------------------
        // layout "dock" (the default): a strip on the chosen edge that reserves work area with the shell, like the
        // taskbar, so maximized windows end at its edge. The timeline card sits at its top, bottom cards stack up
        // from its floor, and the strip is released when its last card goes. Other cards float as before.

        static bool DockActive()
        {
            return layoutMode == "dock";
        }

        static bool IsTimelineCard(Card card)
        {
            return card.OverlayId.StartsWith(TimelinePrefix, StringComparison.Ordinal);
        }

        static bool IsDockCard(Card card)
        {
            return DockActive() && (IsTimelineCard(card) || card.Placement.StartsWith("bottom_", StringComparison.Ordinal));
        }

        static int DockCardCount()
        {
            int count = 0;
            foreach (Card card in Order)
            {
                if (card.Window != null && IsDockCard(card)) count += 1;
            }
            return count;
        }

        static void ReadVisual(Dictionary<string, object> payload)
        {
            Dictionary<string, object> visual = Dict(payload, "visual");
            if (visual == null) return;
            string layout = Str(visual, "layout");
            if (layout == "dock" || layout == "ambient" || layout == "rail") layoutMode = layout;
            string side = Str(visual, "dockSide");
            if (side == "left" || side == "right") dockSide = side;
            int percent = Int(visual, "dockWidthPercent", dockPercent);
            if (percent >= 10 && percent <= 40) dockPercent = percent;
            object reserve;
            if (visual.TryGetValue("dockReserveSpace", out reserve) && reserve is bool) dockReserve = (bool)reserve;
        }

        static void EnsureDockOwner()
        {
            if (dockOwner != null) return;
            dockOwner = new Window();
            dockOwner.Title = "AgentHost dock owner";
            dockOwner.WindowStyle = WindowStyle.None;
            dockOwner.ShowInTaskbar = false;
            dockOwner.ShowActivated = false;
            dockOwner.Focusable = false;
            dockOwner.ResizeMode = ResizeMode.NoResize;
            dockOwner.Width = 1;
            dockOwner.Height = 1;
            dockOwner.Left = OffscreenPosition;
            dockOwner.Top = OffscreenPosition;
            dockOwner.Show();
            ApplyFlags(dockOwner, false);
            dockCallback = Native.RegisterWindowMessage("AgentHostDockCallback");
        }

        // Device pixels per WPF unit. A DPI-unaware process reports 1, and the shell virtualizes its coordinates
        // too, so the strip and the work area stay in the same units either way.
        static double DeviceScale(Visual visual)
        {
            PresentationSource source = PresentationSource.FromVisual(visual);
            if (source == null || source.CompositionTarget == null) return 1.0;
            return source.CompositionTarget.TransformToDevice.M11;
        }

        static void ReserveDock(double width)
        {
            EnsureDockOwner();
            bool right = dockSide != "left";
            double scale = DeviceScale(dockOwner);
            double screenWidth = SystemParameters.PrimaryScreenWidth;
            double screenHeight = SystemParameters.PrimaryScreenHeight;
            int widthPixels = (int)Math.Round(width * scale);
            AppBarData data = new AppBarData();
            data.cbSize = Marshal.SizeOf(typeof(AppBarData));
            data.hWnd = new WindowInteropHelper(dockOwner).Handle;
            data.uCallbackMessage = dockCallback;
            Native.SHAppBarMessage(Native.AbmNew, ref data);
            data.uEdge = right ? Native.AbeRight : Native.AbeLeft;
            // The full height of the primary display: the shell trims it to the work area in QUERYPOS (the taskbar).
            data.rc.Left = right ? (int)Math.Round((screenWidth - width) * scale) : 0;
            data.rc.Top = 0;
            data.rc.Right = right ? (int)Math.Round(screenWidth * scale) : widthPixels;
            data.rc.Bottom = (int)Math.Round(screenHeight * scale);
            Native.SHAppBarMessage(Native.AbmQueryPos, ref data);
            if (right) data.rc.Left = data.rc.Right - widthPixels;
            else data.rc.Right = data.rc.Left + widthPixels;
            Native.SHAppBarMessage(Native.AbmSetPos, ref data);
            dockRect = new Rect(data.rc.Left / scale, data.rc.Top / scale, (data.rc.Right - data.rc.Left) / scale, (data.rc.Bottom - data.rc.Top) / scale);
            dockRegistered = true;
        }

        // Shows the strip and its panel. Called before a dock card is shown, so the strip exists only while it has cards.
        static void EnsureDock()
        {
            CancelDockRelease();
            double screenWidth = SystemParameters.PrimaryScreenWidth;
            double width = Math.Min(screenWidth, Math.Max(240, Math.Round(screenWidth * dockPercent / 100.0)));
            if (dockReserve)
            {
                if (!dockRegistered) ReserveDock(width);
            }
            else
            {
                Rect area = SystemParameters.WorkArea;
                dockRect = new Rect(dockSide == "left" ? area.Left : area.Right - width, area.Top, width, area.Height);
            }
            if (dockPanel == null)
            {
                dockPanel = new Window();
                dockPanel.Title = "AgentHost dock";
                dockPanel.WindowStyle = WindowStyle.None;
                dockPanel.ShowInTaskbar = false;
                dockPanel.ShowActivated = false;
                dockPanel.Focusable = false;
                dockPanel.ResizeMode = ResizeMode.NoResize;
                dockPanel.Topmost = true;
                Border panel = new Border();
                panel.Background = StripFill;
                dockPanel.Content = panel;
            }
            dockPanel.Left = dockRect.Left;
            dockPanel.Top = dockRect.Top;
            dockPanel.Width = dockRect.Width;
            dockPanel.Height = dockRect.Height;
            if (!dockPanel.IsVisible)
            {
                dockPanel.Show();
                ApplyFlags(dockPanel, false);
            }
        }

        // Hides the panel at once and releases the reservation after a short grace period. Screenshot suppression
        // clears the cards and shows them again a moment later; without the grace period every capture would resize
        // every maximized window twice.
        static void ScheduleDockRelease()
        {
            if (dockPanel == null && !dockRegistered) return;
            if (dockRelease == null)
            {
                dockRelease = new DispatcherTimer();
                dockRelease.Interval = TimeSpan.FromMilliseconds(DockReleaseMs);
                dockRelease.Tick += delegate(object sender, EventArgs e)
                {
                    dockRelease.Stop();
                    if (DockCardCount() == 0) ReleaseDockNow();
                };
            }
            dockRelease.Stop();
            dockRelease.Start();
            if (dockPanel != null && dockPanel.IsVisible) dockPanel.Hide();
        }

        static void CancelDockRelease()
        {
            if (dockRelease != null) dockRelease.Stop();
        }

        static void ReleaseDockNow()
        {
            CancelDockRelease();
            if (dockRegistered && dockOwner != null)
            {
                AppBarData data = new AppBarData();
                data.cbSize = Marshal.SizeOf(typeof(AppBarData));
                data.hWnd = new WindowInteropHelper(dockOwner).Handle;
                Native.SHAppBarMessage(Native.AbmRemove, ref data);
            }
            dockRegistered = false;
            if (dockPanel != null)
            {
                dockPanel.Close();
                dockPanel = null;
            }
            if (dockOwner != null)
            {
                dockOwner.Close();
                dockOwner = null;
            }
        }

        static UIElement DockScroll(UIElement content)
        {
            ScrollViewer scroll = new ScrollViewer();
            scroll.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            scroll.HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;
            scroll.Content = content;
            return scroll;
        }

        static double Natural(Card card, double width)
        {
            if (card.Frame == null) return 0;
            card.Frame.Measure(new Size(width, double.PositiveInfinity));
            return card.Frame.DesiredSize.Height;
        }

        static void PlaceDockCard(Card card, double x, double y, double width, double height)
        {
            card.Window.SizeToContent = SizeToContent.Manual;
            card.Window.Width = width;
            card.Window.Height = height;
            card.Window.Left = x;
            card.Window.Top = y;
        }

        // Places the timeline at the top and the bottom cards from the floor, as the Linux dock_layout does.
        static void LayoutDock()
        {
            Card timeline = null;
            List<Card> bottom = new List<Card>();
            foreach (Card card in Order)
            {
                if (card.Window == null || !card.Window.IsVisible || !IsDockCard(card)) continue;
                if (timeline == null && IsTimelineCard(card)) timeline = card;
                else bottom.Add(card);
            }
            if (timeline == null && bottom.Count == 0) return;
            double width = Math.Max(DockMinWidth, dockRect.Width - 2 * DockMargin);
            double timelineWanted = timeline == null ? 0 : Natural(timeline, width);
            double[] wanted = new double[bottom.Count];
            for (int i = 0; i < bottom.Count; i++) wanted[i] = Math.Min(Natural(bottom[i], width), DockMaxCard);
            double timelineHeight;
            double[] tops;
            double[] heights;
            DockLayout(dockRect.Height, timelineWanted, wanted, out timelineHeight, out tops, out heights);
            double x = dockRect.Left + DockMargin;
            for (int i = 0; i < bottom.Count; i++) PlaceDockCard(bottom[i], x, dockRect.Top + tops[i], width, heights[i]);
            if (timeline != null) PlaceDockCard(timeline, x, dockRect.Top + DockMargin, width, timelineHeight);
        }

        // A port of overlay_geometry.dock_layout (packages/app-overlay/runtime/overlay_geometry.py). Keep the two equal.
        static void DockLayout(double areaHeight, double timelineWanted, double[] wanted, out double timeline, out double[] tops, out double[] heights)
        {
            double usable = Math.Max(1, areaHeight - 2 * DockMargin);
            bool hasTimeline = timelineWanted > 0;
            double budget = usable;
            if (hasTimeline)
            {
                double spare = usable - Math.Min(timelineWanted, usable) - DockMargin;
                budget = Math.Min(Math.Max(areaHeight * DockBottomShare, spare), usable - DockMargin - DockMinTimeline);
            }
            int count = wanted.Length;
            tops = new double[count];
            heights = new double[count];
            double floor = areaHeight - DockMargin;
            double remaining = budget;
            for (int i = 0; i < count; i++)
            {
                int later = count - i - 1;
                double available = remaining - later * (DockMinBottom + DockMargin);
                double height = Math.Max(DockMinBottom, Math.Min(wanted[i], available));
                floor -= height;
                heights[i] = height;
                tops[i] = Math.Max(DockMargin, floor);
                floor -= DockMargin;
                remaining -= height + DockMargin;
            }
            timeline = 0;
            if (hasTimeline)
            {
                double used = DockMargin * Math.Max(0, count - 1);
                for (int i = 0; i < count; i++) used += heights[i];
                double room = usable - used - (count > 0 ? DockMargin : 0);
                timeline = Math.Max(DockMinTimeline, Math.Min(timelineWanted, room));
            }
        }

        static UIElement BuildContent(Card card, Dictionary<string, object> body)
        {
            Dictionary<string, object> interaction = Dict(body, "interaction");
            Dictionary<string, object> style = Dict(body, "style");
            card.Sensitivity = Str(body, "sensitivity") ?? "public";
            string placement = Str(body, "placement") ?? "top_right";
            card.Placement = Array.IndexOf(Placements, placement) >= 0 ? placement : "top_right";
            card.AllowedEvents = StringList(Items(interaction, "allowedEvents"));
            bool wantInteractive = Flag(interaction, "interactive");

            StackPanel stack = new StackPanel();
            stack.Children.Add(Text(Clip(Str(body, "title"), 200), 15, true, Ink));
            StackPanel footer = new StackPanel();
            footer.Orientation = Orientation.Horizontal;
            int buttons = 0;
            foreach (object raw in Items(body, "components"))
            {
                Dictionary<string, object> component = raw as Dictionary<string, object>;
                if (component == null) continue;
                buttons += AddComponent(stack, footer, component, card, wantInteractive);
            }
            if (footer.Children.Count > 0) stack.Children.Add(footer);
            card.Interactive = wantInteractive && buttons > 0;

            Border frame = new Border();
            frame.Background = Surface;
            frame.BorderBrush = BorderFor(Str(style, "semantic"));
            frame.BorderThickness = new Thickness(1);
            frame.CornerRadius = new CornerRadius(12);
            frame.Padding = new Thickness(14);
            frame.Child = stack;
            card.Frame = frame;
            return frame;
        }

        static int AddComponent(StackPanel stack, StackPanel footer, Dictionary<string, object> c, Card card, bool wantInteractive)
        {
            string type = Str(c, "type") ?? "";
            if (type == "heading") stack.Children.Add(Text(Clip(Str(c, "text"), 1000), 15, true, Ink));
            else if (type == "text") stack.Children.Add(Text(Clip(Str(c, "text"), 1000), 13, false, Ink));
            else if (type == "warning") stack.Children.Add(Text(Clip(Str(c, "text"), 1000), 13, true, Amber));
            else if (type == "divider") stack.Children.Add(RuleLine());
            else if (type == "icon") stack.Children.Add(Text(IconGlyph(Str(c, "token")), 13, true, Ink));
            else if (type == "status_badge") stack.Children.Add(Text("[" + Clip(Str(c, "status"), 20) + "] " + Clip(Str(c, "text"), 300), 13, true, BrushFor(Str(c, "status"))));
            else if (type == "progress") AddProgress(stack, c);
            else if (type == "spinner") stack.Children.Add(Text("... " + Clip(Str(c, "label") ?? "working", 200), 13, false, Muted));
            else if (type == "checklist") AddChecklist(stack, c);
            else if (type == "timeline") AddTimeline(stack, c);
            else if (type == "key_value") stack.Children.Add(Text(Clip(Str(c, "key"), 200) + ": " + Clip(Str(c, "value"), 500), 13, false, Ink));
            else if (type == "comparison") stack.Children.Add(Text(Clip(Str(c, "before"), 500) + "  ->  " + Clip(Str(c, "after"), 500), 13, false, Ink));
            else if (type == "image_reference") stack.Children.Add(Text("[image: " + Clip(Str(c, "alt"), 200) + "]", 12, false, Muted));
            else if (type == "button" || type == "choice") return AddButton(footer, c, card, wantInteractive);
            return 0;
        }

        static int AddButton(StackPanel footer, Dictionary<string, object> c, Card card, bool wantInteractive)
        {
            string label = Clip(Str(c, "label") ?? Str(c, "text"), 60);
            if (label.Length == 0) label = "OK";
            string eventName = Str(c, "event") ?? "";
            bool enabled = wantInteractive && eventName.Length > 0 && card.AllowedEvents.Contains(eventName);
            Button button = new Button();
            button.Content = label;
            button.MinWidth = 72;
            button.Padding = new Thickness(10, 3, 10, 3);
            button.Margin = new Thickness(0, 8, 8, 0);
            button.Focusable = false;
            button.IsTabStop = false;
            button.IsEnabled = enabled;
            RealPress press = new RealPress();
            string name = eventName;
            button.PreviewMouseLeftButtonDown += delegate(object sender, System.Windows.Input.MouseButtonEventArgs e) { press.Down = PressGuard.LastDownReal; };
            button.PreviewMouseLeftButtonUp += delegate(object sender, System.Windows.Input.MouseButtonEventArgs e) { press.Up = PressGuard.LastUpReal; };
            button.Click += delegate(object sender, RoutedEventArgs e)
            {
                bool real = press.Down && press.Up;
                press.Down = false;
                press.Up = false;
                if (real) Emit(card, name);
            };
            footer.Children.Add(button);
            return enabled ? 1 : 0;
        }

        static void AddProgress(StackPanel stack, Dictionary<string, object> c)
        {
            string label = Str(c, "label");
            if (label != null) stack.Children.Add(Text(Clip(label, 200), 12, false, Muted));
            ProgressBar bar = new ProgressBar();
            bar.Minimum = 0;
            bar.Maximum = 100;
            bar.Value = Math.Max(0, Math.Min(100, Dbl(c, "value") * 100));
            bar.Height = 6;
            bar.Margin = new Thickness(0, 2, 0, 6);
            stack.Children.Add(bar);
        }

        static void AddChecklist(StackPanel stack, Dictionary<string, object> c)
        {
            foreach (object raw in Items(c, "items"))
            {
                Dictionary<string, object> item = raw as Dictionary<string, object>;
                if (item == null) continue;
                string state = Str(item, "state") ?? "";
                string marker = "\u25CB";
                if (Flag(item, "checked") || state == "done") marker = "\u2713";
                else if (state == "failed") marker = "\u2715";
                else if (state == "active") marker = "\u2192";
                stack.Children.Add(Text(marker + " " + Clip(Str(item, "label"), 300), 13, false, state == "failed" ? Red : Ink));
            }
        }

        static void AddTimeline(StackPanel stack, Dictionary<string, object> c)
        {
            foreach (object raw in Items(c, "entries"))
            {
                Dictionary<string, object> entry = raw as Dictionary<string, object>;
                if (entry == null) continue;
                string line = "[" + Clip(Str(entry, "state"), 20) + "] " + Clip(Str(entry, "label"), 300);
                string time = Str(entry, "time");
                string detail = Str(entry, "detail");
                if (time != null) line += " (" + Clip(time, 40) + ")";
                if (detail != null) line += " - " + Clip(detail, 300);
                stack.Children.Add(Text(line, 12, false, Muted));
            }
        }

        static TextBlock Text(string text, double size, bool bold, Brush brush)
        {
            TextBlock block = new TextBlock();
            block.Text = text ?? "";
            block.FontSize = size;
            if (bold) block.FontWeight = FontWeights.Bold;
            block.Foreground = brush;
            block.TextWrapping = TextWrapping.Wrap;
            block.Margin = new Thickness(0, 0, 0, 4);
            return block;
        }

        static Border RuleLine()
        {
            Border line = new Border();
            line.Height = 1;
            line.Background = Rule;
            line.Margin = new Thickness(0, 6, 0, 6);
            return line;
        }

        static string IconGlyph(string token)
        {
            if (token == "success" || token == "check") return "\u2713";
            if (token == "danger" || token == "close") return "\u2715";
            if (token == "warning") return "!";
            if (token == "pointer") return "\u25B8";
            return "i";
        }

        static Brush BrushFor(string status)
        {
            if (status == "warning") return Amber;
            if (status == "danger") return Red;
            if (status == "success") return Green;
            if (status == "info") return Blue;
            return Muted;
        }

        static Brush BorderFor(string semantic)
        {
            if (semantic == "warning") return Amber;
            if (semantic == "danger") return Red;
            if (semantic == "success") return Green;
            if (semantic == "info") return Blue;
            return Neutral;
        }
    }

    public static class Program
    {
        public static void Run()
        {
            Renderer.Start();
            Dispatcher.Run();
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

const POWERSHELL_TAIL = String.raw`
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies 'PresentationFramework','PresentationCore','WindowsBase','System.Xaml','System.Web.Extensions'
[AgentHostOverlay.Program]::Run()
`;

const trimLines = (text: string): string => text.replace(/^\r?\n/, "").replace(/\r?\n$/, "");

/** The whole overlay script, written to a file and started with `powershell.exe -STA -File`. */
export const WINDOWS_OVERLAY_SCRIPT = [trimLines(POWERSHELL_HEAD), trimLines(CSHARP), trimLines(POWERSHELL_TAIL)].join("\r\n").replace(/\r?\n/g, "\r\n") + "\r\n";
