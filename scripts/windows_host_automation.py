"""Windows 11 Host Desktop Automation Helper for Grok Bot.
Supports screenshot, mouse/keyboard control, window focusing, and clipboard paste.
Requires: pyautogui, mss, pyperclip (installed).
"""

import sys
import os
import json
import base64
import io
import time
import ctypes
from ctypes import wintypes

# Set DPI awareness for 1:1 pixel accuracy on Windows 11
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

import mss
import pyautogui
import pyperclip

# Configure pyautogui safety margins
pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.05


def take_screenshot() -> str:
    """Captures the primary monitor and returns base64 PNG data."""
    factory = getattr(mss, "MSS", getattr(mss, "mss", None))
    with factory() as sct:
        monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
        sct_img = sct.grab(monitor)
        png_bytes = mss.tools.to_png(sct_img.rgb, sct_img.size)
        return base64.b64encode(png_bytes).decode("ascii")


def find_and_focus_window(title_substring: str) -> dict:
    """Finds a top-level window by case-insensitive substring and brings it to foreground."""
    user32 = ctypes.windll.user32
    target_substring = title_substring.strip().lower()
    found_windows = []

    def enum_windows_proc(hwnd, extra):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length > 0:
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            title = buff.value
            if target_substring in title.lower():
                found_windows.append((hwnd, title))
        return True

    ENUM_WINDOWS_PROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(ENUM_WINDOWS_PROC(enum_windows_proc), 0)

    if not found_windows:
        return {"success": False, "error": f"No window found matching '{title_substring}'"}

    target_hwnd, target_title = found_windows[0]
    SW_RESTORE = 9
    user32.ShowWindow(target_hwnd, SW_RESTORE)
    user32.SetForegroundWindow(target_hwnd)
    time.sleep(0.15)
    return {"success": True, "title": target_title, "hwnd": target_hwnd}


def paste_text(text: str, press_enter: bool = False) -> dict:
    """Copies text to clipboard, triggers Ctrl+V, and optionally presses Enter."""
    pyperclip.copy(text)
    time.sleep(0.05)
    pyautogui.hotkey("ctrl", "v")
    if press_enter:
        time.sleep(0.05)
        pyautogui.press("enter")
    return {"success": True, "chars_pasted": len(text), "pressed_enter": press_enter}


def press_key(key_combo: str) -> dict:
    """Presses key or key combination (e.g. 'ctrl+enter', 'enter', 'esc')."""
    keys = [k.strip().lower() for k in key_combo.split("+")]
    if len(keys) == 1:
        pyautogui.press(keys[0])
    else:
        pyautogui.hotkey(*keys)
    return {"success": True, "key_combo": key_combo}


def handle_action(action: str, params: dict) -> dict:
    act = action.lower()
    if act == "screenshot":
        img_b64 = take_screenshot()
        return {"success": True, "screenshot": img_b64}
    elif act == "click":
        x = params.get("x")
        y = params.get("y")
        button = params.get("button", "left")
        clicks = 2 if params.get("double", False) else int(params.get("count", 1))
        if x is not None and y is not None:
            pyautogui.click(x=int(x), y=int(y), button=button, clicks=clicks)
        else:
            pyautogui.click(button=button, clicks=clicks)
        return {"success": True, "action": "click", "x": x, "y": y, "button": button}
    elif act == "move":
        x = int(params["x"])
        y = int(params["y"])
        pyautogui.moveTo(x=x, y=y)
        return {"success": True, "action": "move", "x": x, "y": y}
    elif act == "drag":
        x1 = int(params.get("x", params.get("startX", 0)))
        y1 = int(params.get("y", params.get("startY", 0)))
        x2 = int(params.get("x2", params.get("endX", 0)))
        y2 = int(params.get("y2", params.get("endY", 0)))
        pyautogui.moveTo(x1, y1)
        pyautogui.dragTo(x2, y2, button=params.get("button", "left"))
        return {"success": True, "action": "drag", "from": [x1, y1], "to": [x2, y2]}
    elif act == "scroll":
        delta = int(params.get("deltaY", params.get("amount", -100)))
        x = params.get("x")
        y = params.get("y")
        if x is not None and y is not None:
            pyautogui.scroll(delta, x=int(x), y=int(y))
        else:
            pyautogui.scroll(delta)
        return {"success": True, "action": "scroll", "delta": delta}
    elif act == "focus_window":
        title = params.get("title") or params.get("window_title", "")
        return find_and_focus_window(title)
    elif act == "paste_text":
        text = params.get("text", "")
        press_enter = bool(params.get("press_enter", False) or params.get("enter", False))
        return paste_text(text, press_enter=press_enter)
    elif act == "press_key" or act == "key":
        key = params.get("key") or params.get("key_combo", "")
        return press_key(key)
    elif act == "type":
        text = params.get("text", "")
        pyautogui.write(text, interval=0.01)
        return {"success": True, "action": "type", "chars": len(text)}
    else:
        return {"success": False, "error": f"Unknown action: {action}"}


def main():
    if len(sys.argv) > 1:
        # CLI argument mode: parse JSON from arg or flags
        first_arg = sys.argv[1]
        if first_arg.startswith("{"):
            payload = json.loads(first_arg)
            action = payload.get("action", "")
            params = payload
        else:
            action = first_arg
            params = {}
            for i in range(2, len(sys.argv), 2):
                if i + 1 < len(sys.argv):
                    key = sys.argv[i].lstrip("-")
                    val = sys.argv[i + 1]
                    params[key] = val
        result = handle_action(action, params)
        print(json.dumps(result))
    else:
        # Stdin JSON mode
        input_data = sys.stdin.read().strip()
        if input_data:
            payload = json.loads(input_data)
            action = payload.get("action", "")
            result = handle_action(action, payload)
            print(json.dumps(result))
        else:
            print(json.dumps({"success": False, "error": "No input provided"}))


if __name__ == "__main__":
    main()
