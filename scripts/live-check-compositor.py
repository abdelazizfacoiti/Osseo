#!/usr/bin/env python3
"""Test-only helper for `npm run check:live`.

A nested X display (Xephyr) has no compositing manager, so the overlay renderer refuses to
draw cards there (overlay_compositor_unavailable). This claims the _NET_WM_CM_S0 selection on
that nested display only, which is the signal GDK reads as "composited". It draws nothing and
touches no other display. It exits when the live check kills it.
"""
import ctypes
import ctypes.util
import time

x11 = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11"))
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XCreateSimpleWindow.restype = ctypes.c_ulong
x11.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
x11.XSetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]

display = x11.XOpenDisplay(None)
if not display:
    raise SystemExit("cannot open the display")
owner = x11.XCreateSimpleWindow(display, x11.XDefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0)
x11.XSetSelectionOwner(display, x11.XInternAtom(display, b"_NET_WM_CM_S0", 0), owner, 0)
x11.XFlush(display)
while True:
    time.sleep(3600)
