#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
心枕 · 构建脚本
把 src/ 下的样式、结构、逻辑，加上子集化后的中文字体，打包成一个自包含的 HTML 文件。

用法：
    python tools/build.py            # 正常构建
    python tools/build.py --no-font  # 不嵌字体（省体积，用系统楷体兜底）
"""
import base64
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
OUT = os.path.join(ROOT, "心枕.html")
FONT_DIR = os.path.join(ROOT, "tools", "fontwork", "package")
FONT_FILES = os.path.join(FONT_DIR, "files")
FONT_CSS = os.path.join(FONT_DIR, "lxgwwenkailite-regular.css")
FONT_CACHE_DIR = os.path.join(ROOT, "tools", "fontwork")

ICON_SVG = os.path.join(ROOT, "assets", "icon.svg")

PLACEHOLDER_FONT = "/*__FONT_FACE__*/"
PLACEHOLDER_FAVICON = "__FAVICON__"


# --------------------------------------------------------------------- 读取源
def read(path):
    with io.open(path, "r", encoding="utf-8") as f:
        return f.read()


# --------------------------------------------------------------- 字体子集化
def parse_unicode_ranges(text):
    ranges = []
    for part in text.split(","):
        part = part.strip()
        m = re.match(r"^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$", part)
        if not m:
            continue
        lo = int(m.group(1), 16)
        hi = int(m.group(2), 16) if m.group(2) else lo
        ranges.append((lo, hi))
    return ranges


def parse_chunk_css(css_text):
    """返回 [(文件名, [(lo,hi), ...]), ...]，按 CSS 中的先后顺序。"""
    chunks = []
    for block in re.findall(r"@font-face\s*\{(.*?)\}", css_text, re.S):
        m = re.search(r"url\('\./files/([^']+)'\)", block)
        r = re.search(r"unicode-range:\s*([^;}]+)", block)
        if not m or not r:
            continue
        chunks.append((m.group(1), parse_unicode_ranges(r.group(1))))
    return chunks


def build_font_subset(chars):
    """合并需要的分片 → 子集化 → woff2 字节。失败时抛异常。"""
    import hashlib
    from fontTools.ttLib import TTFont
    from fontTools.merge import Merger
    from fontTools.subset import Subsetter, Options

    codepoints = sorted({ord(c) for c in chars if ord(c) > 31})
    tag = hashlib.sha1((",".join(str(c) for c in codepoints)).encode("utf-8")).hexdigest()[:12]
    cache = os.path.join(FONT_CACHE_DIR, "subset-wenkai-%s.woff2" % tag)
    if os.path.exists(cache):
        print("   使用已缓存的子集字体 %s" % os.path.basename(cache))
        with open(cache, "rb") as f:
            return f.read()

    chunks = parse_chunk_css(read(FONT_CSS))
    print("   字体分片 %d 个，待覆盖字符 %d 个" % (len(chunks), len(codepoints)))

    needed = []
    for name, ranges in chunks:
        for cp in codepoints:
            if any(lo <= cp <= hi for lo, hi in ranges):
                needed.append(name)
                break
    print("   命中分片 %d 个，开始合并…" % len(needed))

    paths = []
    for name in needed:
        p = os.path.join(FONT_FILES, name)
        if os.path.exists(p):
            paths.append(p)
    if not paths:
        raise RuntimeError("没有可用的字体分片")

    merged = Merger().merge(paths)
    print("   合并完成，开始子集化…")

    opts = Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.recalc_bounds = True
    opts.drop_tables = ["DSIG"]
    opts.desubroutinize = True
    opts.hinting = False      # 网页显示不需要 hinting，能显著减体积
    opts.glyph_names = False

    sub = Subsetter(options=opts)
    sub.populate(text="".join(sorted(set(chars))))
    sub.subset(merged)
    merged.flavor = "woff2"

    buf = io.BytesIO()
    merged.save(buf)
    data = buf.getvalue()
    with open(cache, "wb") as f:
        f.write(data)
    print("   子集字体 %.1f KB" % (len(data) / 1024.0))
    return data


def font_face_css(data):
    b64 = base64.b64encode(data).decode("ascii")
    return (
        "/* 霞鹜文楷 Lite（OFL 开源）· 已按本应用用到的字符做子集化 */\n"
        "@font-face{\n"
        "  font-family:'LXGW WenKai';\n"
        "  font-style:normal;\n"
        "  font-weight:400;\n"
        "  font-display:swap;\n"
        "  src:url(data:font/woff2;base64,%s) format('woff2');\n"
        "}\n" % b64
    )


# ------------------------------------------------------------------- 主流程
def main():
    no_font = "--no-font" in sys.argv

    css = read(os.path.join(SRC, "01-style.css"))
    body = read(os.path.join(SRC, "02-body.html"))
    js = read(os.path.join(SRC, "03-app.js"))

    payload = css + body + js

    # 字体：把整套资源里出现过的字符都覆盖到
    if no_font:
        face = "/* 未内嵌字体，使用系统楷体兜底 */\n"
    else:
        print("[1/3] 子集化中文字体…")
        extra = "，。、；：？！…—·（）《》「」『』【】“”‘’0123456789%+-=/\\|@#&*"
        try:
            data = build_font_subset(payload + extra)
            face = font_face_css(data)
        except Exception as e:  # noqa
            print("   !! 字体子集化失败：%s" % e)
            print("   !! 改为不嵌入字体，界面会退回系统楷体")
            face = "/* 字体子集化失败，使用系统楷体兜底 */\n"

    # 图标：内联为 favicon
    print("[2/3] 生成图标 favicon…")
    if os.path.exists(ICON_SVG):
        svg = read(ICON_SVG)
        svg = re.sub(r">\s+<", "><", svg.strip())
        import urllib.parse
        favicon = "data:image/svg+xml," + urllib.parse.quote(svg, safe="")
    else:
        favicon = ""

    print("[3/3] 组装单文件…")
    tpl = read(os.path.join(SRC, "00-shell.html"))
    html = (tpl
            .replace(PLACEHOLDER_FONT, face)
            .replace(PLACEHOLDER_FAVICON, favicon)
            .replace("/*__STYLE__*/", css)
            .replace("<!--__BODY__-->", body)
            .replace("/*__APP__*/", js))

    with io.open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    size = os.path.getsize(OUT)
    print("\n完成 → %s" % OUT)
    print("      %.1f KB" % (size / 1024.0))



if __name__ == "__main__":
    main()
