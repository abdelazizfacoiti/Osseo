"""Pure helpers deciding whether an X input device is physical hardware."""
import os
import re

DEVICE_NODE = re.compile(r'Device Node \(\d+\):\s*"(/dev/input/event\d+)"')


def device_node_from_props(text):
    """Extract the evdev node from `xinput list-props` output, or None."""
    match = DEVICE_NODE.search(text or "")
    return match.group(1) if match else None


def is_uinput_sysfs_path(real_path):
    """uinput devices always live here, whatever name their creator chose.

    Bluetooth HID sits under /devices/virtual/misc/uhid/ and is real hardware,
    so the match must be this exact prefix rather than "/virtual/".
    """
    return "/devices/virtual/input/" in (real_path or "")


def node_is_physical(device_node, realpath=os.path.realpath):
    """True only when the node is proven to be backed by a non-uinput device."""
    if device_node is None:
        return False
    target = realpath("/sys/class/input/" + os.path.basename(device_node))
    return target.startswith("/sys/devices/") and not is_uinput_sysfs_path(target)
