#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
心枕 · 字号改造（一次性脚本）
把样式表里硬编码的 font-size: Npx 全部换成 rem，
这样只要改 html 的根字号，整套界面的文字就跟着缩放。
"""
import io
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS = os.path.join(ROOT, "src", "01-style.css")


def px2rem(v):
    r = float(v) / 16.0
    s = ("%.4f" % r).rstrip("0").rstrip(".")
    return (s or "0") + "rem"


def main():
    css = io.open(CSS, encoding="utf-8").read()
    hits = []

    def conv(m):
        val, tail = m.group(1), m.group(2)
        new = re.sub(r"([\d.]+)px", lambda mm: px2rem(mm.group(1)), val)
        if new != val:
            hits.append((val.strip(), new.strip()))
        return "font-size:" + new + tail

    out = re.sub(r"font-size:([^;}]+)([;}])", conv, css)

    # vh 相关的高度也换成 rem，避免放大字号后溢出
    out = out.replace("height: calc(100vh - 150px);", "height: calc(100vh - 9.375rem);")
    out = out.replace("height: calc(100vh - 172px);", "height: calc(100vh - 10.75rem);")

    io.open(CSS, "w", encoding="utf-8", newline="\n").write(out)
    print("转换 %d 处 font-size：" % len(hits))
    for a, b in hits:
        print("   %-18s → %s" % (a, b))


if __name__ == "__main__":
    main()
