#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
心枕 · 图标生成
按 assets/icon.svg 的几何，用 Pillow 以 8 倍超采样绘制，导出各尺寸 PNG 与 favicon.ico。
后面打包成桌面版 / 手机版时可以直接用这些文件。
"""
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "assets")

SS = 8                       # 超采样倍数
BASE = 512                   # 基准尺寸
W = BASE * SS                # 绘制画布边长
U = W / 64.0                 # 一个 SVG 用户单位对应的像素


def u(v):
    return v * U


# ------------------------------------------------------------------ 几何定义
GRAD_STOPS = [(0.0, (0x7F, 0xCC, 0xB8)),
              (0.55, (0x4A, 0xA0, 0x8C)),
              (1.0, (0x35, 0x79, 0x6A))]

HEART_C1 = ((32.0, 30.9), (26.6, 26.8), (24.9, 24.4), (24.9, 21.8))
ARC1 = ((28.45, 21.275), 3.587, math.radians(171.6), math.radians(351.6))
ARC2 = ((35.55, 21.275), 3.587, math.radians(188.4), math.radians(368.4))
HEART_C2 = ((39.1, 21.8), (39.1, 24.4), (37.4, 26.8), (32.0, 30.9))


def cubic_points(p0, p1, p2, p3, steps=90):
    pts = []
    for i in range(steps + 1):
        t = i / float(steps)
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def arc_points(center, r, a0, a1, steps=64):
    pts = []
    for i in range(steps + 1):
        a = a0 + (a1 - a0) * i / float(steps)
        pts.append((center[0] + r * math.cos(a), center[1] + r * math.sin(a)))
    return pts


def heart_outline():
    pts = []
    pts += cubic_points(*HEART_C1)
    pts += arc_points(*ARC1)
    pts += arc_points(*ARC2)
    pts += cubic_points(*HEART_C2)
    return [(u(x), u(y)) for x, y in pts]


# -------------------------------------------------------------------- 绘制
def gradient_image():
    """按 SVG 的 x1/y1→x2/y2 方向做线性渐变。"""
    ys, xs = np.mgrid[0:W, 0:W].astype(np.float32)
    p0 = np.array([u(6), u(2)], dtype=np.float32)
    p1 = np.array([u(58), u(62)], dtype=np.float32)
    d = p1 - p0
    t = ((xs - p0[0]) * d[0] + (ys - p0[1]) * d[1]) / float(d[0] ** 2 + d[1] ** 2)
    t = np.clip(t, 0.0, 1.0)

    out = np.zeros((W, W, 3), dtype=np.float32)
    for i in range(len(GRAD_STOPS) - 1):
        t0, c0 = GRAD_STOPS[i]
        t1, c1 = GRAD_STOPS[i + 1]
        m = (t >= t0) & (t <= t1)
        if not m.any():
            continue
        k = ((t[m] - t0) / (t1 - t0))[:, None]
        out[m] = (np.array(c0, dtype=np.float32) * (1 - k) + np.array(c1, dtype=np.float32) * k)
    out[t <= GRAD_STOPS[0][0]] = GRAD_STOPS[0][1]
    out[t >= GRAD_STOPS[-1][0]] = GRAD_STOPS[-1][1]
    return Image.fromarray(out.astype(np.uint8), "RGB")


def render():
    # 1. 圆角方块遮罩
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [u(2), u(2), u(62), u(62)], radius=u(19), fill=255)

    canvas = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    canvas.paste(gradient_image(), (0, 0), mask)

    d = ImageDraw.Draw(canvas)

    # 2. 枕头
    d.rounded_rectangle([u(10), u(29), u(54), u(53)], radius=u(12), fill=(0xC9, 0xE8, 0xDE, 255))

    # 3. 枕面水波：y = 38.5 + 2*cos(2π(x-12)/28)，x ∈ [12, 54]
    wave = []
    for i in range(241):
        x = 12.0 + 42.0 * i / 240.0
        y = 38.5 + 2.0 * math.cos(2 * math.pi * (x - 12.0) / 28.0)
        wave.append((u(x), u(y)))
    d.line(wave, fill=(0x8F, 0xCF, 0xC0, 255), width=int(round(u(2))), joint="curve")
    for p in (wave[0], wave[-1]):
        r = u(2) / 2.0
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(0x8F, 0xCF, 0xC0, 255))

    # 4. 心
    d.polygon(heart_outline(), fill=(0xFF, 0xFD, 0xF8, 255))

    return canvas


def main():
    if not os.path.isdir(OUT_DIR):
        os.makedirs(OUT_DIR)
    big = render()
    print("超采样画布 %dx%d" % (big.width, big.height))

    sizes = [1024, 512, 256, 192, 128, 64, 48, 32, 16]
    for s in sizes:
        img = big.resize((s, s), Image.LANCZOS)
        p = os.path.join(OUT_DIR, "icon-%d.png" % s)
        if s == 1024:
            img.convert("RGB").save(os.path.join(OUT_DIR, "icon-1024.jpg"), quality=94)
        img.save(p)
        print("  %-28s %6.1f KB" % (os.path.basename(p), os.path.getsize(p) / 1024.0))

    ico = big.resize((256, 256), Image.LANCZOS)
    ico_path = os.path.join(OUT_DIR, "favicon.ico")
    ico.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("  %-28s %6.1f KB" % (os.path.basename(ico_path), os.path.getsize(ico_path) / 1024.0))

    print("done → %s" % OUT_DIR)


if __name__ == "__main__":
    main()
