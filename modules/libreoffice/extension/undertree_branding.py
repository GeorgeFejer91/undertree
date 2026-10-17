"""Application icons scoped to the add-on's own native dialog windows."""
import ctypes
from ctypes import wintypes
import os
from pathlib import Path

import uno


class WindowIcons:
    def __init__(self, peer):
        self.icons, self.previous, self.window = [], [], None
        if os.name != "nt":
            return
        self.api = ctypes.WinDLL("user32", use_last_error=True)
        self.api.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        self.api.LoadImageW.restype = wintypes.HANDLE
        self.api.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        self.api.SendMessageW.restype = ctypes.c_ssize_t
        self.api.IsWindow.argtypes = [wintypes.HWND]
        self.api.DestroyIcon.argtypes = [wintypes.HICON]
        self.api.GetDpiForWindow.argtypes = [wintypes.HWND]
        self.api.GetDpiForWindow.restype = wintypes.UINT
        self.api.GetSystemMetricsForDpi.argtypes = [ctypes.c_int, wintypes.UINT]
        self.window = peer.getWindowHandle(uno.ByteSequence(b""), uno.getConstantByName("com.sun.star.lang.SystemDependent.SYSTEM_WIN32"))
        if not self.window or not self.api.IsWindow(self.window):
            raise ValueError("The add-on dialog has no native window for its icon.")
        dpi = self.api.GetDpiForWindow(self.window)
        icon_file = Path(__file__).with_name("icon.ico")
        if not icon_file.is_file():
            icon_file = Path(__file__).resolve().parents[3] / "assets" / "wraiter" / "icon.ico"
        try:
            for width_metric, height_metric in ((49, 50), (11, 12)):
                width = self.api.GetSystemMetricsForDpi(width_metric, dpi)
                height = self.api.GetSystemMetricsForDpi(height_metric, dpi)
                icon = self.api.LoadImageW(None, str(icon_file), 1, width, height, 0x10)
                if not icon:
                    raise ctypes.WinError(ctypes.get_last_error())
                self.icons.append(icon)
            for index, icon in enumerate(self.icons):
                self.previous.append(self.api.SendMessageW(self.window, 0x80, index, icon))
        except Exception:
            self.close()
            raise

    def close(self):
        if self.window and self.api.IsWindow(self.window):
            for index, previous in enumerate(self.previous):
                self.api.SendMessageW(self.window, 0x80, index, previous)
        for icon in self.icons:
            self.api.DestroyIcon(icon)
        self.icons, self.previous = [], []
