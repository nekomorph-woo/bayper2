#!/usr/bin/env python3
"""S07c 真实系统鼠标事件辅助。

只把 CGEvent 发到调用方给出的坐标（本轮自建底板/角色窗口），不点击用户内容，
不修改权限设置，不安装任何全局钩子。运行前只读检测辅助功能信任；未授权时
返回 trusted=false 并退出，不弹系统授权提示。
"""
import ctypes
import json
import sys
import time

CG = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
CF = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
AS = ctypes.CDLL(
    "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
)

CG_EVENT_LEFT_DOWN = 1
CG_EVENT_LEFT_UP = 2
CG_EVENT_MOUSE_MOVED = 5
CG_EVENT_LEFT_DRAGGED = 6
CG_HID_EVENT_TAP = 0
CG_MOUSE_CLICK_STATE = 1


class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


CG.CGEventCreate.restype = ctypes.c_void_p
CG.CGEventCreate.argtypes = [ctypes.c_void_p]
CG.CGEventGetLocation.restype = CGPoint
CG.CGEventGetLocation.argtypes = [ctypes.c_void_p]
CG.CGEventCreateMouseEvent.restype = ctypes.c_void_p
CG.CGEventCreateMouseEvent.argtypes = [
    ctypes.c_void_p,
    ctypes.c_uint32,
    CGPoint,
    ctypes.c_uint32,
]
CG.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
CG.CGEventSetIntegerValueField.argtypes = [
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.c_int64,
]
CG.CGWarpMouseCursorPosition.argtypes = [CGPoint]
CG.CGWarpMouseCursorPosition.restype = ctypes.c_int32
CF.CFRelease.argtypes = [ctypes.c_void_p]
AS.AXIsProcessTrusted.restype = ctypes.c_bool


def trusted():
    return bool(AS.AXIsProcessTrusted())


def cursor():
    event = CG.CGEventCreate(None)
    point = CG.CGEventGetLocation(event)
    CF.CFRelease(event)
    return {"x": round(point.x, 2), "y": round(point.y, 2)}


def post(event_type, x, y):
    point = CGPoint(float(x), float(y))
    event = CG.CGEventCreateMouseEvent(None, event_type, point, 0)
    if not event:
        raise RuntimeError("CGEventCreateMouseEvent 失败")
    CG.CGEventSetIntegerValueField(event, CG_MOUSE_CLICK_STATE, 1)
    CG.CGEventPost(CG_HID_EVENT_TAP, event)
    CF.CFRelease(event)


def move(x, y):
    post(CG_EVENT_MOUSE_MOVED, x, y)


def click(x, y, hold):
    move(x, y)
    time.sleep(0.08)
    post(CG_EVENT_LEFT_DOWN, x, y)
    time.sleep(hold)
    post(CG_EVENT_LEFT_UP, x, y)
    time.sleep(0.08)


def drag(x1, y1, x2, y2, duration):
    move(x1, y1)
    time.sleep(0.08)
    post(CG_EVENT_LEFT_DOWN, x1, y1)
    time.sleep(0.05)
    steps = max(4, int(duration / 0.025))
    for index in range(1, steps + 1):
        ratio = index / steps
        post(CG_EVENT_LEFT_DRAGGED, x1 + (x2 - x1) * ratio, y1 + (y2 - y1) * ratio)
        time.sleep(duration / steps)
    post(CG_EVENT_LEFT_UP, x2, y2)
    time.sleep(0.1)


def main(argv):
    if len(argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少命令"}, ensure_ascii=False))
        return 2
    command = argv[1]
    if command == "check":
        print(json.dumps({"ok": True, "trusted": trusted(), "cursor": cursor()}))
        return 0
    if command == "cursor":
        print(json.dumps({"ok": True, "trusted": trusted(), "cursor": cursor()}))
        return 0
    if not trusted():
        print(json.dumps({"ok": False, "trusted": False, "error": "辅助功能未授权"}))
        return 2

    before = cursor()
    if command == "move":
        move(float(argv[2]), float(argv[3]))
    elif command == "down":
        move(float(argv[2]), float(argv[3]))
        time.sleep(0.08)
        post(CG_EVENT_LEFT_DOWN, float(argv[2]), float(argv[3]))
    elif command == "dragto":
        post(CG_EVENT_LEFT_DRAGGED, float(argv[2]), float(argv[3]))
    elif command == "up":
        post(CG_EVENT_LEFT_UP, float(argv[2]), float(argv[3]))
    elif command == "click":
        click(float(argv[2]), float(argv[3]), float(argv[4]) if len(argv) > 4 else 0.06)
    elif command == "drag":
        drag(
            float(argv[2]),
            float(argv[3]),
            float(argv[4]),
            float(argv[5]),
            float(argv[6]) / 1000 if len(argv) > 6 else 0.35,
        )
    elif command == "restore":
        CG.CGWarpMouseCursorPosition(CGPoint(float(argv[2]), float(argv[3])))
    else:
        print(json.dumps({"ok": False, "error": f"未知命令 {command}"}, ensure_ascii=False))
        return 2
    print(
        json.dumps(
            {
                "ok": True,
                "trusted": True,
                "command": command,
                "before": before,
                "after": cursor(),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
