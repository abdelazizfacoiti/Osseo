import { execFile } from "node:child_process";

/*
 * Milliseconds since the last keyboard or pointer input on the X display, from
 * the XScreenSaver extension. XTEST input injected by AgentHost counts too, so
 * callers must compare against their own last injection time.
 */
const SCRIPT = `
import ctypes, ctypes.util, sys
x11 = ctypes.CDLL(ctypes.util.find_library("X11"))
xss = ctypes.CDLL(ctypes.util.find_library("Xss"))
class Info(ctypes.Structure):
    _fields_ = [("window", ctypes.c_ulong), ("state", ctypes.c_int), ("kind", ctypes.c_int), ("til_or_since", ctypes.c_ulong), ("idle", ctypes.c_ulong), ("event_mask", ctypes.c_ulong)]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
xss.XScreenSaverAllocInfo.restype = ctypes.POINTER(Info)
xss.XScreenSaverQueryInfo.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(Info)]
display = x11.XOpenDisplay(None)
if not display:
    sys.exit(2)
info = xss.XScreenSaverAllocInfo()
if not xss.XScreenSaverQueryInfo(display, x11.XDefaultRootWindow(display), info):
    sys.exit(3)
print(info.contents.idle)
`;

export function readUserIdleMs(options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<number | undefined> {
  const env = options.env ?? process.env;
  if (env.DISPLAY === undefined || env.DISPLAY === "") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      execFile("python3", ["-I", "-c", SCRIPT], { timeout: options.timeoutMs ?? 1_500, env: { ...env } }, (error, stdout) => {
        if (error !== null) { resolve(undefined); return; }
        const value = Number.parseInt(stdout.trim(), 10);
        resolve(Number.isFinite(value) && value >= 0 ? value : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}
