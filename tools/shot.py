#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
心枕 · 视觉自检
生成一批演示数据（立绘 / 头像 / 表情包 / 记忆 / 聊天），注入到临时页面里，
用 Edge 无头模式逐页截图，方便肉眼检查排版与配色。
只在开发时用，不影响最终产物。
"""
import base64
import io
import json
import math
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import http.server
import socketserver
import urllib.request

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "心枕.html")
SHOTS = os.path.join(ROOT, "tools", "shots")
TMP = os.path.join(ROOT, "tools", ".preview")

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

C_BG = (0x4A, 0xA0, 0x8C)
C_LIGHT = (0x8F, 0xCF, 0xC0)
C_PALE = (0xC9, 0xE8, 0xDE)
C_CREAM = (0xFF, 0xFD, 0xF8)
C_SKIN = (0xFA, 0xEF, 0xE0)
C_WARM = (0xE2, 0x8C, 0x7C)
C_HAIR = (0x3F, 0x7A, 0x6C)


def data_uri(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# ------------------------------------------------------------- 演示素材绘制
def draw_portrait():
    W, H = 480, 720
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    # 身体 / 裙子
    d.polygon([(150, 720), (185, 470), (295, 470), (330, 720)], fill=C_LIGHT + (255,))
    d.rounded_rectangle([170, 430, 310, 500], radius=34, fill=C_PALE + (255,))
    # 脖子
    d.rounded_rectangle([218, 392, 262, 452], radius=20, fill=C_SKIN + (255,))
    # 后发
    d.ellipse([118, 168, 362, 500], fill=C_HAIR + (255,))
    # 脸
    d.ellipse([172, 196, 308, 400], fill=C_SKIN + (255,))
    # 刘海
    d.pieslice([150, 150, 330, 320], 180, 360, fill=C_HAIR + (255,))
    d.ellipse([150, 214, 208, 400], fill=C_HAIR + (255,))
    d.ellipse([272, 214, 330, 400], fill=C_HAIR + (255,))
    d.pieslice([196, 168, 284, 250], 190, 350, fill=C_SKIN + (255,))
    # 闭着的眼
    d.arc([196, 268, 226, 292], 200, 340, fill=(70, 62, 54, 255), width=3)
    d.arc([254, 268, 284, 292], 200, 340, fill=(70, 62, 54, 255), width=3)
    # 腮红
    d.ellipse([188, 300, 216, 316], fill=C_WARM + (90,))
    d.ellipse([264, 300, 292, 316], fill=C_WARM + (90,))
    # 嘴
    d.arc([228, 310, 252, 328], 20, 160, fill=(196, 128, 116, 255), width=3)
    return im


def draw_avatar():
    p = draw_portrait()
    S = 256
    im = Image.new("RGBA", (S, S), C_PALE + (255,))
    crop = p.crop((140, 150, 340, 350)).resize((S, S), Image.LANCZOS)
    im.alpha_composite(crop)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, S - 1, S - 1], fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    return out


def draw_sticker(kind):
    S = 220
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([10, 10, S - 10, S - 10], fill=C_PALE + (255,))
    if kind == "smile":
        d.ellipse([70, 78, 92, 100], fill=C_HAIR + (255,))
        d.ellipse([128, 78, 150, 100], fill=C_HAIR + (255,))
        d.arc([68, 88, 152, 160], 20, 160, fill=C_HAIR + (255,), width=6)
        d.ellipse([48, 110, 74, 128], fill=C_WARM + (110,))
        d.ellipse([146, 110, 172, 128], fill=C_WARM + (110,))
    elif kind == "heart":
        pts = []
        for i in range(121):
            t = 2 * math.pi * i / 120
            x = 16 * math.sin(t) ** 3
            y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
            pts.append((S / 2 + x * 4.6, S / 2 - y * 4.6))
        d.polygon(pts, fill=C_WARM + (255,))
    else:  # sleepy
        d.arc([64, 78, 100, 104], 200, 340, fill=C_HAIR + (255,), width=6)
        d.arc([120, 78, 156, 104], 200, 340, fill=C_HAIR + (255,), width=6)
        d.ellipse([92, 128, 128, 152], fill=C_HAIR + (255,))
        d.text((152, 34), "z", fill=C_LIGHT + (255,))
        d.text((172, 14), "z", fill=C_LIGHT + (255,))
    return im


def demo_state():
    p = data_uri(draw_portrait())
    a = data_uri(draw_avatar())
    st = [data_uri(draw_sticker(k)) for k in ("smile", "heart", "sleepy")]
    now = int(time.time() * 1000)

    return {
        "settings": {
            "baseUrl": "https://api.deepseek.com/v1", "apiKey": "", "model": "deepseek-chat",
            "temperature": 0.9, "maxChars": 900, "timeout": 90, "stream": True, "extraSystem": "",
            "injKey": True, "injLight": True, "injKeywords": True, "injStickers": True,
            "lightCount": 6, "ctxTurns": 14, "splitMessages": True, "stickerAuto": True, "stickerChance": 35,
            "enterSend": True, "timestamps": True,
            "theme": "light", "font": "normal", "motion": "off"
        },
        "persona": {
            "name": "林知夏", "call": "你",
            "identity": "住在你隔壁的插画师，作息很乱，家里养了只叫「年年」的橘猫",
            "text": "你叫林知夏，26 岁，一个人住在老小区的六楼，靠接插画稿过日子。\n"
                    "你性格温和，说话不快，喜欢在句尾带一点点鼻音。你不擅长表达喜欢，"
                    "但会记住别人随口说过的小事。\n你画画的时候会忘记吃饭，压力大的时候会一个人"
                    "去楼下的便利店买关东煮。你怕黑，晚上画稿一定要把客厅的灯开着。",
            "tags": ["温柔", "细心", "慢热", "偶尔撒娇"],
            "catchphrase": "嗯……我想想",
            "greeting": "回来啦？我刚画完一张，眼睛有点花……你今天怎么样？",
            "temper": 32, "talky": 46, "active": 44, "sweet": 52,
            "speech": {
                "style": "literary",
                "likes": ["呀", "唔", "话说"],
                "avoids": ["亲", "么么哒", "作为一个AI"],
                "notes": "句尾常带「啊 / 吧」，少用感叹号，一句话不超过 20 字。"
            }
        },
        "me": {
            "avatar": "",
            "name": "陈屿",
            "text": "27 岁，做后端的，常年熬夜。不太会聊天，但愿意听她说。住在同一栋楼的四楼。"
        },
        "assets": {
            "portrait": p, "avatar": a,
            "stickers": [
                {"id": "s1", "name": "开心", "emotion": "开心", "data": st[0]},
                {"id": "s2", "name": "比心", "emotion": "亲亲", "data": st[1]},
                {"id": "s3", "name": "困了", "emotion": "困了", "data": st[2]}
            ]
        },
        "memory": {
            "key": [
                {"id": "k1", "title": "她的生日", "text": "3 月 12 日。她说不想过，但你最好还是记得。", "ts": now - 86400000 * 30},
                {"id": "k2", "title": "忌口", "text": "不吃香菜，闻到味道就会皱眉。", "ts": now - 86400000 * 12, "by": "ai"},
                {"id": "k3", "title": "猫", "text": "家里养了只橘猫叫「年年」，很胖，会踩她的数位板。", "ts": now - 86400000 * 5}
            ],
            "light": [
                {"id": "l1", "text": "昨天说想喝楼下那家的芋泥奶茶，但排了半小时队没买到。", "ts": now - 86400000 * 2, "by": "ai"},
                {"id": "l2", "text": "稿子被甲方退了两次，有点低落。", "ts": now - 86400000},
                {"id": "l3", "text": "今天画了一整天的海，说蓝色看多了眼睛疼。", "ts": now - 3600000 * 6},
                {"id": "l4", "text": "凌晨三点还在赶稿，说再画十分钟就睡（并没有）。", "ts": now - 3600000 * 2}
            ],
            "keywords": [
                {"id": "w1", "word": "年年", "note": "她养的橘猫，提到它她会话变多", "ts": now - 86400000 * 9},
                {"id": "w2", "word": "关东煮", "note": "她压力大时的固定宵夜，提这个代表她心情不好", "ts": now - 86400000 * 3, "by": "ai"}
            ]
        },
        "chat": {
            "messages": [
                {"id": "m1", "role": "assistant", "text": "回来啦？我刚画完一张，眼睛有点花……你今天怎么样？", "ts": now - 3600000 * 3},
                {"id": "m2", "role": "user", "text": "还行，就是开会开了一下午。你呢，那批稿子交了没", "ts": now - 3600000 * 3 + 60000},
                {"id": "m3", "role": "assistant", "text": "交了一半。甲方说「感觉不太对，再改改」，也没说哪儿不对。", "ts": now - 3600000 * 3 + 120000},
                {"id": "m4", "role": "assistant", "text": "我改了三个版本给他，他挑了最早那一版。", "ts": now - 3600000 * 3 + 130000},
                {"id": "m5", "role": "user", "text": "哈哈这不是常规操作嘛，别气了", "ts": now - 3600000 * 2},
                {"id": "m6", "role": "assistant", "text": "我没气。就是有点想咬人。", "ts": now - 3600000 * 2 + 40000},
                {"id": "m7", "role": "user", "text": "", "ts": now - 3600000, "sticker": "s3"},
                {"id": "m8", "role": "assistant", "text": "你也困啦？那就早点睡。我这儿还剩最后一张，画完就关灯。", "ts": now - 3600000 + 30000},
                {"id": "m9", "role": "assistant", "text": "对了，明天路过便利店帮我看看有没有芋泥味的……上次没买到。\n[[表情:比心]]", "ts": now - 3600000 + 40000}
            ]
        },
        "link": {
            "keywords": ["手作", "城市散步", "独立游戏"],
            "dailyCount": 3,
            "reportLevel": "full",
            "autoComment": False,
            "commentTarget": "",
            "commentMax": 1,
            "autoMode": "manual",
            "autoEvery": 6,
            "autoFrom": 9,
            "autoTo": 23,
            "commentEvery": 1,
            "lastRunAt": now - 3600000 * 2,
            "lastRunDay": time.strftime("%Y-%m-%d"),
            "reports": [{
                "day": time.strftime("%Y-%m-%d"),
                "at": now - 3600000 * 2,
                "scanned": 24,
                "subs": 6,
                "note": "今天这几条都偏「能上手做」的，明天换点别的口味。",
                "commented": [],
                "picks": [
                    {"bvid": "BV1xx411c7mD", "title": "把一间 12㎡ 的出租屋改成工作室，只花了 800 块",
                     "up": "阿七不加班", "dur": 1104, "play": 426000},
                    {"bvid": "BV1Ab4y1z7Kq", "title": "沿着这条线走完，才知道老城区为什么舍不得拆",
                     "up": "散步的人", "dur": 1520, "play": 218000},
                    {"bvid": "BV1cd4y1x7Wt", "title": "一个人做的小游戏，卖了两万份之后他辞了职",
                     "up": "独立游戏观察", "dur": 986, "play": 355000}
                ],
                "markdown": (
                    "## 今天挑了 3 条\n\n"
                    "我看了 24 条候选，读到了 6 条字幕。\n\n"
                    "### BV1xx411c7mD\n"
                    "**把一间 12㎡ 的出租屋改成工作室，只花了 800 块**  ·  阿七不加班  ·  18:24  ·  42.6 万播放\n\n"
                    "> 她把每一笔钱都摊开讲了：墙自己刷、桌子是二手市场淘的，连灯泡的色温都算过。看完能直接照着自己改，不是那种只拍结果的改造视频。\n\n"
                    "我看完第一个念头是：我们那个阳台，其实还能塞下一张桌子。\n\n"
                    "[去 B 站看](https://www.bilibili.com/video/BV1xx411c7mD)\n\n"
                    "### BV1Ab4y1z7Kq\n"
                    "**沿着这条线走完，才知道老城区为什么舍不得拆**  ·  散步的人  ·  25:20  ·  21.8 万播放\n\n"
                    "> 镜头一直没停，也没有配乐，就是走路和说话。讲到那家开了三十年的修表铺时，老板抬头笑了一下，那一段我看了两遍。\n\n"
                    "下次你休息，我们照着这条线走一遍吧，走到哪儿算哪儿。\n\n"
                    "[去 B 站看](https://www.bilibili.com/video/BV1Ab4y1z7Kq)\n\n"
                    "### BV1cd4y1x7Wt\n"
                    "**一个人做的小游戏，卖了两万份之后他辞了职**  ·  独立游戏观察  ·  16:26  ·  35.5 万播放\n\n"
                    "> 后半段全在讲他怎么把「不好玩」的地方一条条删掉，连失败的版本号都列出来了。做东西的人看了会安静一会儿。\n\n"
                    "他说「做完比做好重要」，我听到这句的时候想起你了。\n\n"
                    "[去 B 站看](https://www.bilibili.com/video/BV1cd4y1x7Wt)\n\n"
                    "---\n\n"
                    "今天这几条都偏「能上手做」的，明天换点别的口味。"
                )
            }, {
                "day": time.strftime("%Y-%m-%d", time.localtime(time.time() - 86400)),
                "at": now - 86400000 - 3600000 * 5,
                "scanned": 31,
                "subs": 4,
                "note": "昨天的几条偏长，留到今天睡前看。",
                "commented": ["BV1aa411c7mD"],
                "picks": [
                    {"bvid": "BV1aa411c7mD", "title": "凌晨四点的菜市场，和收摊的人聊了半小时",
                     "up": "晚饭之前", "dur": 1320, "play": 912000},
                    {"bvid": "BV1bb411c7mD", "title": "把奶奶的老缝纫机修好，花了三个周末",
                     "up": "修东西的人", "dur": 880, "play": 143000}
                ],
                "markdown": (
                    "## 昨天挑了 2 条\n\n"
                    "我看了 31 条候选，读到了 4 条字幕。\n\n"
                    "### BV1aa411c7mD\n"
                    "**凌晨四点的菜市场，和收摊的人聊了半小时**  ·  晚饭之前  ·  22:00  ·  91.2 万播放\n\n"
                    "> 没有旁白，全是摊主自己说。\n\n"
                    "[去 B 站看](https://www.bilibili.com/video/BV1aa411c7mD)\n")
            }]
        },
        "roster": {
            "master": {"uid": 2, "uname": "碧诗", "face": a, "at": now - 86400000 * 9},
            "people": [
                {"id": "p2", "uid": 9187654, "uname": "半夜改稿的甲方", "face": "", "nickname": "",
                 "affinity": 35, "list": "none", "addedAt": now - 86400000 * 2},
                {"id": "p3", "uid": 12345678, "uname": "杠精本精", "face": "", "nickname": "",
                 "affinity": 8, "list": "black", "addedAt": now - 86400000}
            ]
        },
        "memes": {"items": [
            {"id": "m1", "term": "电子榨菜", "meaning": "吃饭时配着看的视频，没它饭都不香。",
             "usage": "你说在吃饭，她会问「配的什么电子榨菜」", "tags": ["日常", "网络"],
             "source": "ai", "ts": now - 3600000},
            {"id": "m2", "term": "班味", "meaning": "上班上久了身上那股疲惫又麻木的劲儿。",
             "usage": "你下班回家，她会说「你这一身班味，先去洗澡」", "tags": ["打工人"],
             "source": "chat", "ts": now - 7200000},
            {"id": "m3", "term": "水灵灵地", "meaning": "莫名其妙又理所当然地做了某件事，带点自嘲。",
             "usage": "她做错事了会自嘲「我就这么水灵灵地忘了」", "tags": ["口头禅"],
             "source": "manual", "ts": now - 86400000}
        ]},
        "vitals": {"bpm": 96, "mood": "开心", "ts": now}
    }


CID = "cdemo"


def to_storage(data):
    """把一份角色数据摊成浏览器里的键值对（新的按角色分键的格式）"""
    out = {
        "xinzhen.v1.characters": [{"id": CID, "name": data.get("persona", {}).get("name") or "角色",
                                   "createdAt": 1700000000000, "updatedAt": 1700000000000}],
        "xinzhen.v1.active": CID,
        "xinzhen.v1.theme": data.get("settings", {}).get("theme", "light"),
        "xinzhen.v1.font": data.get("settings", {}).get("font", "normal"),
        "xinzhen.v1.lastPage": "persona",
    }
    for k, v in data.items():
        out["xinzhen.v1.c.%s.%s" % (CID, k)] = v
    return out


# ------------------------------------------------------------------- 服务器
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve(directory):
    handler = lambda *a, **kw: Quiet(*a, directory=directory, **kw)  # noqa
    srv = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, port


def find_edge():
    for p in EDGE_CANDIDATES:
        if os.path.exists(p):
            return p
    raise RuntimeError("找不到 Edge")


def build_page(html, data, page, subtab, noanim=True):
    state = to_storage(data)
    seed = "<script>(function(){var S=%s;for(var k in S){try{localStorage.setItem(k,JSON.stringify(S[k]))}catch(e){}}})();</script>" % json.dumps(
        state, ensure_ascii=False)
    # 无头虚拟时钟下 CSS 动画会卡在首帧，截图时干脆关掉，渲染成最终状态
    style = ("<style>*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;"
             "transition-duration:0s !important;}</style>") if noanim else ""
    # 开屏自己会在 1.65 秒后淡出；这里只做个兜底隐藏（保留元素，方便检查 DOM）
    pick = ("var r=document.querySelector('#railNav [data-page=\"%s\"]');if(r)r.click();%s" % (
        page, ("var t=document.querySelector('#personaTabs [data-subtab=\"%s\"]');if(t)t.click();" % subtab) if subtab else "")
    ) if page else ""
    click = ("<script>setTimeout(function(){var b=document.getElementById('booting');"
             "if(b)b.classList.add('is-done');" + pick + "},500);"
             "setTimeout(function(){var b=document.getElementById('booting');"
             "if(b)b.style.display='none';},3200);</script>")
    return html.replace("</head>", style + "</head>", 1) \
               .replace("<body>", "<body>\n" + seed, 1) \
               .replace("</body>", click + "\n</body>", 1)


def main():
    edge = find_edge()
    if not os.path.exists(APP):
        raise RuntimeError("先跑 tools/build.py 生成 心枕.html")
    html = open(APP, encoding="utf-8").read()
    state = demo_state()

    for d in (TMP, SHOTS):
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)

    jobs = [
        ("01-人设-形象", "persona", None, 1440, 940, None),
        ("02-人设-人设", "persona", "profile", 1440, 940, None),
        ("03-人设-记忆", "persona", "memory", 1440, 940, None),
        ("04-人设-表情包", "persona", "sticker", 1440, 940, None),
        ("05-对话", "chat", None, 1440, 940, None),
        ("06-外接-刷B站", "link", None, 1440, 940, {"_nolink": True}),
        ("07-外接-日报", "link", None, 1440, 940, None),
        ("08-设置", "settings", None, 1440, 940, None),
        ("09-对话-窄屏", "chat", None, 520, 900, None),
        ("10-人设-窄屏", "persona", None, 520, 900, None),
        ("11-暮色-对话", "chat", None, 1440, 940, {"theme": "night"}),
        ("12-暮色-人设", "persona", "memory", 1440, 940, {"theme": "night"}),
        ("13-空状态-对话", "chat", None, 1440, 940, {"_empty": True}),
        ("14-发送失败", "chat", None, 1440, 940, {"_err": True}),
        ("15-记忆-滚动吸顶", "persona", "memory", 1440, 940, {"_scroll": True}),
        ("16-设置-新选项", "settings", None, 1440, 940, {"_scroll": 620}),
        ("17-对话-心跳心情", "chat", None, 1440, 940, {"_feel": "害羞"}),
        ("18-人设-附加要求", "persona", "profile", 1440, 940, {"_scroll": 950}),
        ("19-字号-大", "settings", None, 1440, 940, {"font": "large", "_scroll": 300}),
        ("20-关于", "about", None, 1440, 940, None),
        ("21-对话-附件待发", "chat", None, 1440, 940, {"_atts": True}),
        ("22-设置-数据与存储", "settings", None, 1440, 940, {"_scroll": 900}),
        ("23-人设-话语规范", "persona", "profile", 1440, 940, {"_scroll": 990}),
        ("24-人设-我", "persona", "me", 1440, 940, None),
        ("25-角色切换", "chat", None, 1440, 940, {"_charpop": True}),
        ("26-开屏-凝脂", None, None, 1440, 940, {"_splash": "light"}),
        ("27-开屏-暮色", None, None, 1440, 940, {"_splash": "night"}),
        ("28-外接-窄屏", "link", None, 520, 900, None),
        ("29-外接-暮色", "link", None, 1440, 940, {"theme": "night"}),
        ("30-名单", "roster", None, 1440, 940, None),
        ("31-梗知识", "persona", "memes", 1440, 940, None),
        ("32-名单-窄屏", "roster", None, 520, 900, None),
        ("33-外接-私聊", "link", None, 1440, 940, {"_scroll": 640}),
        ("34-外接-日报窗口", "link", None, 1440, 940, {"_reportwin": True}),
        ("35-外接-自动刷", "link", None, 1440, 940, {"_auto": True, "_scroll": 300}),
        ("36-外接-QQ", "link", None, 1440, 940, {"_tab": "qq"}),
        ("37-名单-QQ", "roster", None, 1440, 940, {"_tab": "qq"}),
    ]

    srv, port = serve(TMP)
    base = "http://127.0.0.1:%d/" % port
    profile = tempfile.mkdtemp(prefix="xinzhen-shot-")
    results = []
    try:
        for idx, (name, page, subtab, w, h, override) in enumerate(jobs):
            st = json.loads(json.dumps(state))
            if override:
                if override.get("_empty"):
                    st["chat"] = {"messages": []}
                    st["persona"]["greeting"] = "回来啦？我刚画完一张，眼睛有点花……你今天怎么样？"
                if override.get("_err"):
                    msgs = st["chat"]["messages"][:4]
                    msgs.append({"id": "e1", "role": "user", "text": "明天要不要一起去看那个展", "ts": int(time.time() * 1000)})
                    msgs.append({"id": "e2", "role": "error", "ts": int(time.time() * 1000),
                                 "text": "连不上接口。常见三种原因：\n· Base URL 写错了\n· 电脑没联网，或这个地址本机访问不到\n· 该接口不允许网页直接调用（跨域 CORS）"})
                    st["chat"] = {"messages": msgs}
                if override.get("_splash"):
                    st["settings"]["theme"] = override["_splash"]
                if override.get("_nolink"):
                    st["link"]["reports"] = []
                for k, v in override.items():
                    if not k.startswith("_"):
                        st["settings"][k] = v
            fn = "p_%02d.html" % idx
            content = build_page(html, st, page, subtab, noanim=not (override and override.get("_splash")))
            if override and override.get("_tab"):
                attr = "linksub" if page == "link" else "rsub"
                content = content.replace("</body>",
                    "<script>setTimeout(function(){var b=document.querySelector('[data-%s=\"%s\"]');if(b)b.click();},900);</script></body>"
                    % (attr, override["_tab"]))
            if override and override.get("_auto"):
                content = content.replace('"autoMode": "manual"', '"autoMode": "auto"')
                content = content.replace('"autoEvery": 6', '"autoEvery": 4')
            if override and override.get("_reportwin"):
                content = content.replace("</body>", "<script>setTimeout(function(){var c=document.getElementById('linkTodayCard');if(c&&!c.disabled)c.click();},1400);</script></body>")
            if override and override.get("_scroll"):
                px = override["_scroll"] if override["_scroll"] is not True else 640
                # 注意：.stage-body 有 scroll-behavior:smooth，无头模式下平滑滚动不会推进，
                # 必须先压成 auto 再赋值，否则滚动等于没发生。
                content = content.replace("</body>",
                    "<script>setTimeout(function(){var b=document.getElementById('stageBody');"
                    "if(b){b.style.scrollBehavior='auto';b.scrollTop=%d;}},1500);</script></body>" % px, 1)
            if override and override.get("_feel"):
                content = content.replace("</body>",
                    "<script>setTimeout(function(){window.__xinzhen.feelEmotion('%s');},3300);</script></body>"
                    % override["_feel"], 1)
            if override and override.get("_atts"):
                content = content.replace("</body>",
                    "<script>setTimeout(function(){var X=window.__xinzhen;"
                    "X.pendingAtts.push({kind:'image',name:'参考图.png',mime:'image/png',size:184320,data:X.assets.avatar});"
                    "X.pendingAtts.push({kind:'file',name:'设定稿.md',mime:'text/markdown',size:2410,text:'x'});"
                    "X.renderAtts();},1600);</script></body>", 1)
            if override and override.get("_charpop"):
                content = content.replace("</body>",
                    "<script>setTimeout(function(){var b=document.getElementById('btnChar');if(b)b.click();},1900);</script></body>", 1)
            if override and override.get("_splash"):
                # 无头虚拟时钟下 CSS 动画不会推进，所以把动画定格在 0.75 秒处
                content = content.replace("</head>",
                    "<style>#booting *{animation-play-state:paused !important;animation-delay:-.75s !important;}"
                    "#booting{opacity:1 !important;visibility:visible !important;}</style></head>", 1)
            with open(os.path.join(TMP, fn), "w", encoding="utf-8") as f:
                f.write(content)
            out = os.path.join(SHOTS, name + ".png")
            # 开屏要停在动画中途，用短一点的预算，别让它自己淡出
            budget = 1400 if (override and override.get("_splash")) else 3500
            cmd = [
                edge, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check",
                "--user-data-dir=" + profile,
                "--window-size=%d,%d" % (w, h),
                "--virtual-time-budget=%d" % budget,
                "--screenshot=" + out,
                base + fn,
            ]
            r = subprocess.run(cmd, capture_output=True, timeout=120)
            ok = os.path.exists(out)
            results.append((name, ok, os.path.getsize(out) if ok else 0))
            print("  %-16s %s %s" % (name, "OK" if ok else "FAIL",
                                     "%.0f KB" % (os.path.getsize(out) / 1024.0) if ok else r.stderr.decode("utf-8", "ignore")[-200:]))
    finally:
        srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    print("\n截图目录：%s" % SHOTS)


if __name__ == "__main__":
    main()
