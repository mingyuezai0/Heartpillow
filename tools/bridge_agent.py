#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
心枕 · 服务器常驻客户端（代替页面）

职责：
1. 常驻连 NapCat 的 OneBot11 WebSocket，页面关着也在收消息；
2. 收到消息落盘（/var/lib/xinzhen-bridge/inbox.jsonl，去重 + 限量）；
3. 页面不在时，用页面同步来的配置（人设 / 记忆 / 名单 / 模型）自己回消息；
4. 本机 HTTP 接口给页面用（nginx 反代 /qq/bridge/）：
     GET  /status                      连接状态 / 计数
     GET  /pull?since=<ts>&limit=200   拉取 since 之后的收发记录（kind: in / out）
     POST /ack?since=<ts>              记录游标
     POST /send                        代发一条消息
     POST /config                      页面同步配置
     GET  /config                      看当前配置（密钥打码）
     POST /lease                       页面上报「我在线」（ttl 秒）
     POST /selftest                    自检：给一句话，看提示词和模型回复（不发出去）
"""
import base64
import json
import os
import re
import socket
import ssl
import struct
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAPcat_WS = os.environ.get("XZ_WS", "ws://127.0.0.1:3001")
TOKEN = os.environ.get("XZ_TOKEN", "")
HTTP_API = os.environ.get("XZ_HTTP", "http://127.0.0.1:3000")
DATA_DIR = os.environ.get("XZ_DATA", "/var/lib/xinzhen-bridge")
INBOX = os.path.join(DATA_DIR, "inbox.jsonl")
OUTBOX = os.path.join(DATA_DIR, "outbox.jsonl")
OPS = os.path.join(DATA_DIR, "ops.jsonl")
RECALLED = os.path.join(DATA_DIR, "recalled.json")
STATE = os.path.join(DATA_DIR, "state.json")
CONFIG = os.path.join(DATA_DIR, "config.json")
PORT = int(os.environ.get("XZ_PORT", "9100"))

os.makedirs(DATA_DIR, exist_ok=True)

lock = threading.Lock()
stats = {
    "connected": False, "events": 0, "messages": 0, "replied": 0,
    "lastEventAt": 0, "lastMsgAt": 0, "lastReplyAt": 0, "lastError": "",
    "sinceStart": int(time.time()), "selfId": 0, "reconnects": 0,
}

lease_until = 0.0
last_reply_at = {}


def load_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default if default is not None else {}


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def append_line(path, rec):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


class WS:
    def __init__(self, url, timeout=10):
        u = urllib.parse.urlparse(url)
        self.host = u.hostname
        self.port = u.port or (443 if u.scheme == "wss" else 80)
        self.path = (u.path or "/") + (("?" + u.query) if u.query else "")
        self.tls = u.scheme == "wss"
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        self.sock.settimeout(None)
        if self.tls:
            self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=self.host)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            "GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
            % (self.path, self.host, self.port, key)
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("握手失败：连接被关闭")
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        line = head.split(b"\r\n")[0].decode("latin1")
        if "101" not in line:
            raise RuntimeError("握手失败：" + line)
        self.buf = rest
        self.buf_lock = threading.Lock()
        self.closed = False
        self._spawn_ping()

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("连接被关闭")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, data, opcode=0x1):
        if isinstance(data, str):
            data = data.encode()
        header = bytearray()
        header.append(0x80 | opcode)
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < (1 << 16):
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        with self.buf_lock:
            self.sock.sendall(bytes(header) + masked)

    def recv(self):
        while True:
            head = self._recv_exact(2)
            opcode = head[0] & 0x0F
            masked = head[1] & 0x80
            n = head[1] & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._recv_exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._recv_exact(8))[0]
            mask = self._recv_exact(4) if masked else None
            payload = self._recv_exact(n) if n else b""
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x9:
                self.send(payload, 0xA)
                continue
            if opcode == 0xA:
                continue
            if opcode == 0x8:
                raise RuntimeError("服务端关闭连接")
            return opcode, payload

    def _spawn_ping(self):
        def loop():
            while not self.closed:
                time.sleep(25)
                try:
                    self.send(b"", 0x9)
                except Exception:
                    return
        threading.Thread(target=loop, daemon=True).start()

    def close(self):
        self.closed = True
        try:
            self.sock.close()
        except Exception:
            pass


def seg_text(segs):
    out = []
    for s in segs or []:
        t = s.get("type")
        d = s.get("data") or {}
        if t == "text":
            out.append(str(d.get("text") or ""))
        elif t == "image":
            out.append("[图片]")
        elif t == "face":
            out.append("[表情]")
    return "".join(out).strip()


DEFAULT_PERSONA = "你叫心枕，是个安静、会注意到细节的人。说话短，不用客服腔。"


def cfg_or_empty():
    return load_json(CONFIG, {}) or {}


def people_map(cfg):
    out = {}
    for p in (cfg.get("roster") or []):
        try:
            out[int(p.get("uid"))] = p
        except Exception:
            pass
    return out


def who_of(cfg, uid):
    pm = people_map(cfg)
    p = pm.get(int(uid))
    master = cfg.get("masterUid")
    if master and int(uid) == int(master):
        person = p or {}
        return "white", person.get("uname") or "对方", True
    if not p:
        return "none", "对方", False
    return (p.get("list") or "none"), (p.get("uname") or "对方"), False


def memory_block(cfg):
    mem = cfg.get("memory") or {}
    lines = []
    for k in (mem.get("key") or [])[-20:]:
        t = (k.get("text") or "").strip()
        if t:
            lines.append("- " + ((k.get("title") + "：") if k.get("title") else "") + t)
    for l in (mem.get("light") or [])[-12:]:
        t = (l.get("text") or "").strip()
        if t:
            lines.append("- " + t)
    for w in (mem.get("keywords") or [])[-12:]:
        if w.get("word"):
            lines.append("- " + str(w["word"]) + ("：" + str(w.get("note")) if w.get("note") else ""))
    return "\n".join(lines)


WEEK_CN = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]


def now_text():
    t = time.time()
    lt = time.localtime(t)
    wd = WEEK_CN[lt.tm_wday]
    return time.strftime("%Y年%m月%d日", lt).replace("年0", "年").replace("月0", "月") + " " + wd + " " + time.strftime("%H:%M:%S", lt)


def ago_text(seconds):
    sec = max(0, int(seconds))
    if sec < 60:
        return "刚刚"
    if sec < 3600:
        return "%d 分钟前" % (sec // 60)
    if sec < 86400:
        h = sec // 3600
        m = (sec % 3600) // 60
        return "%d 小时%s前" % (h, (" %d 分钟" % m) if m else "")
    d = sec // 86400
    h = (sec % 86400) // 3600
    return "%d 天%s前" % (d, (" %d 小时" % h) if h else "")


def last_talk_age(uid, is_group=False, limit=400):
    """这个人上一次说话的 ts（不含刚刚这条），返回秒数差"""
    if not os.path.exists(INBOX):
        return 0
    last = 0
    try:
        with open(INBOX, "r", encoding="utf-8") as f:
            lines = f.readlines()[-limit:]
        for line in lines:
            try:
                r = json.loads(line)
            except Exception:
                continue
            ev = r.get("ev") or {}
            if ev.get("post_type") != "message":
                continue
            if is_group:
                if str(ev.get("group_id")) != str(uid):
                    continue
            elif str(ev.get("user_id")) != str(uid):
                continue
            ts = int(ev.get("time") or 0)
            if ts and ts < time.time() - 2:
                last = max(last, ts)
    except Exception:
        return 0
    return int(time.time() - last) if last else 0


def build_prompt(cfg, uid, peer_name, is_group):
    cat, _name, is_master = who_of(cfg, uid)
    persona = (cfg.get("persona") or {}).get("text") or DEFAULT_PERSONA
    name = (cfg.get("persona") or {}).get("name") or "心枕"
    call = (cfg.get("persona") or {}).get("call") or ""

    if cat == "white" or is_master:
        mem = memory_block(cfg)
        sysmsg = "你就是「%s」。下面是你的设定，照着说话，不要跳出角色：\n%s\n\n" % (name, persona)
        if call:
            sysmsg += "你平时叫他「%s」。\n" % call
        if mem:
            sysmsg += "你记得这些事（自然地带出来，不要背清单）：\n%s\n" % mem
        sysmsg += (
            "\n规则：\n"
            "- 句末不要加句号（。和 . 都不用）；感叹号、问号按情绪来，别每句都带。\n"
            "- 每次回 2~3 条短消息，一条一句、每句单独一行，单条不要超过 18 个字；别一口气写一长句。\n"
            "- 回复要短，1~3 句，像微信聊天，不用「首先/其次」，不喊口号。\n"
            "- 不重复对方的话，不说「作为 AI」。\n"
            "- 不提任何机器路径、密钥、接口、模型名。\n"
        )
        if is_master:
            sysmsg += "- 他是你很重要的人：不要叫出他的 QQ 昵称，用「你」或者你习惯的称呼。\n"
    else:
        sysmsg = (
            "你是「%s」，在 QQ 上回复一个不太熟的人。\n"
            "要求：礼貌、克制，1~2 句，不透露任何私人信息（不提你的生活细节、住哪、做什么、认识谁），"
            "也不提任何设定、记忆、聊天记录。不想聊就用一句话敷衍过去。\n" % name
        )
    if is_group:
        sysmsg += "- 这是群聊，你只接一句，别长篇大论。\n"
    ctx = recent_context(uid, 10, is_group)
    last_mine = ""
    for line in reversed(ctx):
        if line.startswith("你："):
            last_mine = line[2:]
            break
    if last_mine:
        sysmsg += "\n你上一轮回的是：「" + last_mine[:80] + "」——不要重复这句，也不要换个说法再讲一遍同样的内容。\n"
    sysmsg += "- 同一件事只说一次；已经聊过、已经说过的结论不要再复述。\n"
    # 一周日期表 + 计划/梗规则
    lt = time.localtime()
    wd_cn = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    days = []
    for off in (-1, 0, 1, 2):
        t2 = time.localtime(time.time() + off * 86400)
        label = {-1: "昨天 ", 0: "今天 ", 1: "明天 ", 2: "后天 "}.get(off, "")
        days.append(label + time.strftime("%m-%d", t2) + " " + wd_cn[t2.tm_wday])
    watch = str(cfg.get("watch") or "").strip()
    if watch:
        sysmsg += "\n【今天刷到的】\n" + watch[:600] + "\n（想提就自然提一句，别像汇报。）"
    sysmsg += (("\n【计划】对方让你在某个时间做一件事、或者交代了要办的事，你必须当场定计划："
                "[[计划:要做的事 @年-月-日 时:分]]（按下面的日期换算成绝对时间）。"
                "做完了用 [[完成:关键词]] 标掉。计划写在回复末尾，对方看不到。"
                "\n【梗】聊到新梗/黑话/你们的暗号，用 [[梗:词|一句话意思|怎么用]] 记下来。"))
    age = last_talk_age(uid, is_group)
    sysmsg += "\n【现在】" + now_text() + "（北京时间）。【这一周的日期】" + " / ".join(days) + "。" + \
        (("你们上一次说话是 " + ago_text(age) + "。") if age > 90 else "") + \
        "提到日期、星期、几点、隔了多久，都以这段为准，自己算，不要瞎猜。\n"
    return sysmsg


PLAN_RE = re.compile(r"\[\[\s*计划\s*[:：]\s*([^\]\n]{1,200}?)\s*\]\]")
DONE_RE = re.compile(r"\[\[\s*完成\s*[:：]\s*([^\]\n]{1,60}?)\s*\]\]")
MEME_RE = re.compile(r"\[\[\s*梗\s*[:：]\s*([^\]\n]{1,160}?)\s*\]\]")


def extract_ops(text):
    """把回复里的隐藏指令抽出来，交给页面去落库（服务端只做搬运）"""
    ops = []
    t = str(text or "")
    for m in PLAN_RE.finditer(t):
        raw = m.group(1).strip()
        due = ""
        dm = re.search(r"@\s*([^\]]{1,30})$", raw)
        if dm:
            due = dm.group(1).strip()
            raw = raw[:dm.start()].strip()
        if raw:
            ops.append({"type": "plan", "a": raw[:200], "b": due})
    for m in DONE_RE.finditer(t):
        if m.group(1).strip():
            ops.append({"type": "done", "a": m.group(1).strip()[:60]})
    for m in MEME_RE.finditer(t):
        parts = re.split(r"[|｜]", m.group(1))
        if parts and parts[0].strip():
            ops.append({"type": "meme", "a": parts[0].strip()[:30],
                        "b": (parts[1] if len(parts) > 1 else "").strip()[:120],
                        "c": (parts[2] if len(parts) > 2 else "").strip()[:120]})
    return ops


DIRECTIVE_RE = re.compile(r"\[\[\s*/?\s*(记忆|情绪|计划|完成)[^\]]*\]\]")


def strip_directives(text):
    """把 [[记忆]]…[[/记忆]] 这类隐藏指令整段去掉，只留要说的话"""
    t = str(text or "")
    t = re.sub(r"\[\[\s*记忆\s*\]\][\s\S]*?\[\[\s*/\s*记忆\s*\]\]", "", t)
    t = DIRECTIVE_RE.sub("", t)
    return t.strip()


def split_parts(text, cfg):
    """一句一条：按行 → 按句 → 实在太长按逗号，最后合并到 splitMax 条以内"""
    t = (text or "").strip()
    if not t:
        return []
    qq = cfg.get("qq") or {}
    max_chars = int(qq.get("maxChars") or 120)
    smax = max(1, min(5, int(qq.get("splitMax") or 3)))
    soft = 22

    # 1) 行
    segs = [x.strip() for x in re.split(r"\n+", t) if x.strip()] or [t]
    # 2) 句子
    sents = []
    for seg in segs:
        if re.search(r"https?://|\[CQ:", seg):
            sents.append(seg)
            continue
        sents.extend([x.strip() for x in re.split(r"(?<=[。！？!?…~～])", seg) if x.strip()])
    # 3) 只有一句且很长 → 按逗号
    if len(sents) == 1 and len(sents[0]) > soft:
        chunks = [x.strip() for x in re.split(r"(?<=[，,、；;])", sents[0]) if x.strip()]
        if len(chunks) > 1:
            sents = chunks
    # 4) 合并到 smax 条
    if len(sents) <= smax:
        groups = sents
    else:
        per = -(-len(sents) // smax)
        groups = ["".join(sents[i:i + per]).strip() for i in range(0, len(sents), per)]
    # 5) 句末句号去掉
    out = []
    for g in groups:
        g = re.sub(r"[。．.]+$", "", (g or "").strip()).strip()
        if g:
            out.append(g)
    if not out:
        return [t[:max_chars]]
    # 6) 单条特别长再硬切
    final = []
    for g in out:
        while len(g) > max_chars:
            final.append(g[:max_chars])
            g = g[max_chars:]
        if g:
            final.append(g)
    return final[:max(smax, 1)]


def recent_context(uid, limit=10, is_group=False):
    """这个人最近的对话：收件箱（对方说的）+ 发件箱（她自己说的）按时间合起来。
    之前只读收件箱，等于她看不见自己上一轮回了什么，于是老重复。"""
    rows = []
    mine = int(load_json(CONFIG, {}).get("selfUid") or 0)
    if os.path.exists(INBOX):
        with open(INBOX, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                ev = r.get("ev") or {}
                if ev.get("post_type") != "message":
                    continue
                if is_group:
                    if str(ev.get("group_id")) != str(uid):
                        continue
                elif str(ev.get("user_id")) != str(uid):
                    continue
                txt = ev.get("raw_message") or seg_text(ev.get("message"))
                if not txt:
                    continue
                rows.append((int(r.get("ts") or ev.get("time") or 0), "对方", str(txt)[:200]))
    if os.path.exists(OUTBOX):
        with open(OUTBOX, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if is_group:
                    if str(r.get("group")) != str(uid):
                        continue
                elif str(r.get("uid")) != str(uid):
                    continue
                txt = str(r.get("text") or "").strip()
                if not txt:
                    continue
                rows.append((int(r.get("ts") or 0), "你", txt[:200]))
    rows.sort(key=lambda x: x[0])
    return [(who + "：" + t) for _, who, t in rows[-limit:]]


SELF_HOSTS = set((os.environ.get("XZ_SELF_HOSTS") or "8.156.81.219").split(","))


def _localize(url):
    """服务器自己访问自己的公网 IP 会被 NAT 回环坑死（超时），换成 127.0.0.1"""
    try:
        u = urllib.parse.urlparse(url)
        if u.hostname and u.hostname in SELF_HOSTS:
            host = "127.0.0.1" + ((":" + str(u.port)) if u.port else "")
            return urllib.parse.urlunparse((u.scheme, host, u.path, u.params, u.query, u.fragment))
    except Exception:
        pass
    return url


def is_anthropic(base, model):
    b = (base or "").lower()
    mm = (model or "").lower()
    return ("anthropic" in b) or ("claude" in b) or mm.startswith("claude")


def call_model(cfg, messages, timeout=120):
    m = cfg.get("model") or {}
    base = (m.get("baseUrl") or "").rstrip("/")
    key = m.get("apiKey") or ""
    model = m.get("model") or ""
    if not base or not model:
        raise RuntimeError("没配置模型（baseUrl/model）")
    anth = is_anthropic(base, model)
    if anth:
        url = base if base.endswith("/messages") else base + "/messages"
    else:
        url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    url = _localize(url)
    body = {
        "model": model,
        "messages": messages,
        "stream": False,
        "max_tokens": int(m.get("maxTokens") or 300),
        "temperature": float(m.get("temperature") if m.get("temperature") is not None else 0.85),
    }
    if anth:
        sys_parts, msgs_a = [], []
        for msg in messages:
            if msg.get("role") == "system":
                sys_parts.append(str(msg.get("content") or ""))
            else:
                msgs_a.append({
                    "role": "assistant" if msg.get("role") == "assistant" else "user",
                    "content": [{"type": "text", "text": str(msg.get("content") or "")}],
                })
        body = {
            "model": model,
            "messages": msgs_a or [{"role": "user", "content": [{"type": "text", "text": "在吗"}]}],
            "max_tokens": int(m.get("maxTokens") or 300),
            "temperature": float(m.get("temperature") if m.get("temperature") is not None else 0.85),
        }
        if sys_parts:
            body["system"] = "\n\n".join(sys_parts)
        hdrs = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
        if key:
            hdrs["x-api-key"] = key
    else:
        hdrs = {"Content-Type": "application/json", "Authorization": "Bearer " + key}
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=data, headers=hdrs)
    last = None
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                d = json.loads(r.read() or b"{}")
            break
        except Exception as e:
            last = e
            if attempt == 2:
                raise
            time.sleep(1.5)
    else:
        raise last
    if anth:
        blocks = d.get("content") or []
        return "".join(str(b.get("text") or "") for b in blocks if isinstance(b, dict) and b.get("type") == "text").strip()
    ch = (d.get("choices") or [{}])[0]
    msg = ch.get("message") or {}
    return str(msg.get("content") or ch.get("text") or "").strip()


def napcat_post(action, params, timeout=15):
    data = json.dumps(params, ensure_ascii=False).encode()
    req = urllib.request.Request(
        HTTP_API + "/" + action, data=data,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


agg_lock = threading.Lock()
agg_buf = {}


def parse_due(due):
    """2026-11-01 20:00 / 11-01 20:00 / 20:00 都认，返回 epoch 秒，认不出给 0"""
    t = str(due or "").strip()
    if not t:
        return 0
    now = time.time()
    for fmt in ("%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            return time.mktime(time.strptime(t, fmt))
        except Exception:
            pass
    m = re.search(r"(\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?", t)
    if m:
        y = time.localtime().tm_year
        try:
            ts = time.mktime((y, int(m.group(1)), int(m.group(2)),
                              int(m.group(3) or 0), int(m.group(4) or 0), 0, 0, 0, -1))
            if ts < now - 180 * 86400:
                ts = time.mktime((y + 1, int(m.group(1)), int(m.group(2)),
                                  int(m.group(3) or 0), int(m.group(4) or 0), 0, 0, 0, -1))
            return ts
        except Exception:
            return 0
    m2 = re.match(r"^(\d{1,2}):(\d{2})$", t)
    if m2:
        lt = time.localtime()
        try:
            return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, int(m2.group(1)), int(m2.group(2)), 0, 0, 0, -1))
        except Exception:
            return 0
    return 0


HEALTH = "/opt/xinzhen/qqhealth.json"
QRFILE = "/opt/xinzhen/qqlogin.png"
OOB = "/usr/local/bin/xinzhen-napcat-oob.sh"      # root 帮手：重启容器 + 刷二维码
LASTFIX = os.path.join(DATA_DIR, "lastfix.json")


def probe_login():
    """返回 (是否登录, uid, 昵称)；顺带把状态写给页面看"""
    try:
        data = json.dumps({}).encode()
        req = urllib.request.Request(
            HTTP_API + "/get_login_info", data=data,
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN},
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            d = json.loads(r.read() or b"{}")
        info = d.get("data") or {}
        uid = str(info.get("user_id") or "")
        nick = str(info.get("nickname") or "")
        ok = bool(uid)
        return ok, uid, nick
    except Exception as e:
        stats["lastError"] = "login probe: %s" % e
        return False, "", ""


def write_health(ok, uid, nick, note=""):
    try:
        st = load_json(STATE, {}) or {}
        st["health"] = {"ok": ok, "uid": uid, "nickname": nick, "at": int(time.time()), "note": note}
        save_json(STATE, st)
        qr_at = int(os.path.getmtime(QRFILE)) if os.path.exists(QRFILE) else 0
        out = {"ok": 1 if ok else 0, "needLogin": 0 if ok else 1,
               "uid": uid, "nickname": nick, "at": int(time.time()), "qrAt": qr_at, "note": note}
        with open(HEALTH + ".tmp", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        os.replace(HEALTH + ".tmp", HEALTH)
    except Exception as e:
        stats["lastError"] = "health write: %s" % e


def health_loop():
    """机器人自己掉线（登录态失效）时：重启容器（密码登录会自动接上）+ 刷二维码"""
    time.sleep(8)
    while True:
        try:
            ok, uid, nick = probe_login()
            stats["loginOk"] = ok
            write_health(ok, uid, nick)
            if not ok:
                last = float(load_json(LASTFIX, 0) or 0)
                if time.time() - last > 120:
                    save_json(LASTFIX, time.time())
                    print("[bridge] 检测到掉线，重启 NapCat 尝试恢复", flush=True)
                    try:
                        subprocess.run(["sudo", "-n", OOB], timeout=180, capture_output=True)
                    except Exception as e:
                        stats["lastError"] = "oob: %s" % e
                    time.sleep(5)
                    ok2, uid2, nick2 = probe_login()
                    stats["loginOk"] = ok2
                    write_health(ok2, uid2, nick2, "auto-restart" if ok2 else "restart-failed")
                    if ok2:
                        print("[bridge] 重启后已恢复登录", flush=True)
        except Exception as e:
            stats["lastError"] = "health loop: %s" % e
        time.sleep(45)


BILI = os.path.join(DATA_DIR, "bili.json")
BILI_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def bili_cookies():
    d = load_json(BILI, {}) or {}
    return d.get("cookies") or {}


def bili_headers(referer="https://www.bilibili.com/"):
    ck = bili_cookies()
    h = {
        "User-Agent": BILI_UA,
        "Referer": referer,
        "Origin": "https://www.bilibili.com",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if ck:
        h["Cookie"] = "; ".join("%s=%s" % (k, v) for k, v in ck.items())
    return h


def bili_ensure_buvid():
    ck = bili_cookies()
    if ck.get("buvid3"):
        return
    j = bili_request_raw("https://api.bilibili.com/x/frontend/finger/spi")
    d = (j.get("json") or {}).get("data") or {}
    if d.get("b_3"):
        cur = load_json(BILI, {}) or {}
        c = cur.get("cookies") or {}
        c["buvid3"] = d.get("b_3")
        if d.get("b_4"):
            c["buvid4"] = d.get("b_4")
        cur["cookies"] = c
        save_json(BILI, cur)


def bili_request_raw(url, method="GET", form=None, timeout=25):
    return _bili_do(url, method, form, timeout)


def bili_request(url, method="GET", form=None, timeout=25):
    bili_ensure_buvid()
    r = _bili_do(url, method, form, timeout)
    code = ((r.get("json") or {}).get("code"))
    if code in (-412, -352, -401) and "buvid3" not in bili_cookies():
        bili_ensure_buvid()
        r = _bili_do(url, method, form, timeout)
    return r


def bili_video(bvid):
    """一次把「简介 + 评论区 + 字幕」都带上：没登录也不至于只看标题"""
    out = {"ok": True, "bvid": bvid}
    j = bili_request("https://api.bilibili.com/x/web-interface/view?bvid=" + urllib.parse.quote(bvid))
    v = (j.get("json") or {})
    if v.get("code") != 0:
        return {"ok": False, "why": "B 站没给这个视频：%s" % (v.get("message") or v.get("code"))}
    d = v.get("data") or {}
    aid = d.get("aid") or 0
    cid = d.get("cid") or 0
    out.update({
        "aid": aid, "cid": cid,
        "title": d.get("title") or "",
        "up": (d.get("owner") or {}).get("name") or "",
        "mid": (d.get("owner") or {}).get("mid") or 0,
        "desc": str(d.get("desc") or "")[:800],
        "pubdate": d.get("pubdate") or 0,
        "dur": d.get("duration") or 0,
        "play": (d.get("stat") or {}).get("view") or 0,
        "danmaku": (d.get("stat") or {}).get("danmaku") or 0,
        "tname": d.get("tname") or "",
        "pic": d.get("pic") or "",
    })

    # 评论区（热门排序），拿不到就空着，不影响整体
    comments = []
    try:
        rj = bili_request("https://api.bilibili.com/x/v2/reply?type=1&oid=%s&sort=2&ps=12&pn=1" % aid)
        rdata = (rj.get("json") or {}).get("data") or {}
        for r in (rdata.get("replies") or [])[:12]:
            msg = str((r.get("content") or {}).get("message") or "").replace("\n", " ").strip()
            if not msg:
                continue
            comments.append({"text": msg[:90], "like": r.get("like") or 0})
    except Exception:
        pass
    out["comments"] = comments

    # 字幕：没登录时大多数视频给不出，能拿到就带上
    sub = ""
    if cid:
        try:
            pj = bili_request("https://api.bilibili.com/x/player/v2?bvid=%s&cid=%s" % (urllib.parse.quote(bvid), cid))
            subs = (((pj.get("json") or {}).get("data") or {}).get("subtitle") or {}).get("subtitles") or []
            if subs:
                pick = next((x for x in subs if "zh" in str(x.get("lan") or "")), subs[0])
                u = str(pick.get("subtitle_url") or "")
                if u.startswith("//"):
                    u = "https:" + u
                if u:
                    sj = bili_request(u)
                    rows = (sj.get("json") or {}).get("body") or []
                    sub = " ".join(str(r.get("content") or "") for r in rows)
                    sub = " ".join(sub.split())[:1800]
        except Exception:
            pass
    out["subtitle"] = sub
    return out


def _bili_do(url, method="GET", form=None, timeout=25):
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(url, data=data, headers=bili_headers(), method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            try:
                return {"ok": True, "status": r.status, "json": json.loads(body.decode("utf-8", "ignore"))}
            except Exception:
                return {"ok": True, "status": r.status, "text": body.decode("utf-8", "ignore")[:2000]}
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read()
        except Exception:
            pass
        try:
            return {"ok": True, "status": e.code, "json": json.loads(body.decode("utf-8", "ignore"))}
        except Exception:
            return {"ok": False, "why": "B 站返回 %s" % e.code}
    except Exception as e:
        return {"ok": False, "why": "连不上 B 站：%s" % e}


def bili_status():
    j = bili_request("https://api.bilibili.com/x/web-interface/nav")
    d = (j.get("json") or {}).get("data") or {}
    if d.get("isLogin"):
        info = {"login": True, "uname": d.get("uname") or "", "mid": d.get("mid") or 0}
        cur = load_json(BILI, {}) or {}
        cur.update({"uname": info["uname"], "mid": info["mid"], "at": int(time.time())})
        save_json(BILI, cur)
        return info
    return {"login": False, "uname": "", "mid": 0}


def bili_qr_new():
    j = bili_request("https://passport.bilibili.com/x/passport-login/web/qrcode/generate")
    d = (j.get("json") or {}).get("data") or {}
    if not d.get("url"):
        return {"ok": False, "why": "拿不到登录二维码"}
    return {"ok": True, "key": d.get("qrcode_key") or "", "url": d.get("url")}


def bili_qr_poll(key):
    u = ("https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key="
         + urllib.parse.quote(key or ""))
    req = urllib.request.Request(u, headers=bili_headers())
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read().decode("utf-8", "ignore")
            j = json.loads(raw)
            setck = r.headers.get_all("Set-Cookie") or []
    except Exception as e:
        return {"ok": False, "why": "轮询失败：%s" % e}
    code = (j.get("data") or {}).get("code")
    if code == 0:
        ck = dict(bili_cookies())
        for line in setck:
            part = line.split(";")[0]
            if "=" in part:
                k, v = part.split("=", 1)
                if k.strip():
                    ck[k.strip()] = v.strip()
        save_json(BILI, {"cookies": ck, "at": int(time.time())})
        st = bili_status()
        return {"ok": True, "login": True, "uname": st.get("uname") or ""}
    if code == 86038:
        return {"ok": True, "login": False, "state": "expired", "why": "二维码过期了，刷新一下"}
    if code == 86090:
        return {"ok": True, "login": False, "state": "scanned", "why": "扫到了，在手机上点确认"}
    return {"ok": True, "login": False, "state": "wait", "why": "等你扫码"}


def plan_loop():
    """每分钟看一遍有没有到点的计划，到点就用她的口吻跟主人说一句"""
    while True:
        try:
            time.sleep(30)
            cfg = cfg_or_empty()
            if not cfg or not cfg.get("enabled", True):
                continue
            if time.time() < lease_until:
                continue
            master = int(cfg.get("masterUid") or 0)
            if not master:
                continue
            fired = load_json(os.path.join(DATA_DIR, "planfired.json"), {}) or {}
            now = time.time()
            for pl in (cfg.get("plans") or []):
                pid = str(pl.get("id") or "")
                if not pid or fired.get(pid):
                    continue
                ts = float(pl.get("dueAt") or 0) or parse_due(pl.get("due"))
                if ts > 1e11:      # 页面传的是毫秒，这里统一成秒
                    ts = ts / 1000.0
                if not ts or ts > now or now - ts > 6 * 3600:
                    continue
                text = str(pl.get("text") or "").strip()
                if not text:
                    continue
                try:
                    out = call_model(cfg, [
                        {"role": "system", "content": build_prompt(cfg, master, "", False)},
                        {"role": "user", "content": "你之前计划要做的事：" + text +
                         ("（约好 " + str(pl.get("due")) + "）" if pl.get("due") else "") +
                         "\n现在到时间了。用你自己的口吻跟我说一句，说你现在就去做/已经做了。一两句就好。"},
                    ])
                except Exception as e:
                    stats["lastError"] = "plan: %s" % e
                    continue
                msg = strip_directives(out)
                if not msg:
                    continue
                try:
                    napcat_post("send_private_msg", {"user_id": master, "message": msg[:200]})
                    append_line(OUTBOX, {"ts": int(time.time()), "uid": master, "group": 0, "text": msg[:200]})
                    stats["replied"] += 1
                    stats["lastReplyAt"] = int(time.time())
                except Exception as e:
                    stats["lastError"] = "plan send: %s" % e
                    continue
                fired[pid] = int(time.time())
                save_json(os.path.join(DATA_DIR, "planfired.json"), fired)
                print("[bridge] 计划到点：%s" % text[:30], flush=True)
        except Exception as e:
            stats["lastError"] = "plan loop: %s" % e


def mark_recalled(mid):
    if not mid:
        return
    d = load_json(RECALLED, {}) or {}
    d[str(mid)] = int(time.time())
    if len(d) > 500:
        for k in list(d)[: len(d) - 500]:
            d.pop(k, None)
    save_json(RECALLED, d)


def is_recalled(mid):
    if not mid:
        return False
    return str(mid) in (load_json(RECALLED, {}) or {})


def maybe_reply(ev):
    # 撤回的消息当没看到
    if ev.get("post_type") == "notice":
        nt = str(ev.get("notice_type") or "")
        if nt in ("friend_recall", "group_recall"):
            mark_recalled(ev.get("message_id"))
            print("[bridge] 撤回：%s" % ev.get("message_id"), flush=True)
        return
    if is_recalled(ev.get("message_id")):
        return
    """先过一道「连发攒起来」的闸，再决定什么时候真的回"""
    cfg = cfg_or_empty()
    if not cfg or not cfg.get("enabled", True):
        return
    if time.time() < lease_until:
        return
    uid = int(ev.get("user_id") or 0)
    if not uid or uid == int(ev.get("self_id") or 0):
        return
    qq = cfg.get("qq") or {}
    # 没配置时按 6 秒算（和页面默认一致），别默认秒回
    wait = float(qq["firstWait"] if qq.get("firstWait") is not None else 6)
    if wait <= 0:
        return reply_now(ev, [])
    key = str(uid)
    burst = int(qq.get("burstMax") or 5)

    def flush(k):
        with agg_lock:
            buf = agg_buf.pop(k, None)
        if not buf:
            return
        reply_now(buf["ev"], buf["texts"])

    with agg_lock:
        buf = agg_buf.get(key)
        if buf is None:
            buf = agg_buf[key] = {"texts": [], "ev": ev, "timer": None}
            t = threading.Timer(wait, flush, args=(key,))
            t.daemon = True
            buf["timer"] = t
            t.start()
        buf["texts"].append(str(ev.get("raw_message") or seg_text(ev.get("message")) or "")[:300])
        buf["ev"] = ev
        ready = len(buf["texts"]) >= burst
        if ready:
            if buf.get("timer"):
                buf["timer"].cancel()
            agg_buf.pop(key, None)
            texts = buf["texts"]
    if ready:
        threading.Thread(target=lambda: reply_now(ev, texts), daemon=True).start()


def reply_now(ev, texts):
    cfg = cfg_or_empty()
    if not cfg or not cfg.get("enabled", True):
        return
    if time.time() < lease_until:
        return
    uid = int(ev.get("user_id") or 0)
    is_group = ev.get("message_type") == "group"
    if not uid or uid == int(ev.get("self_id") or 0):
        return
    age = time.time() - float(ev.get("time") or time.time())
    if age > float((cfg.get("qq") or {}).get("staleMin") or 10):
        return
    cat, peer, is_master = who_of(cfg, uid)
    qq = cfg.get("qq") or {}
    auto = qq.get("autoReply") or {}
    if is_group and not qq.get("groupAt"):
        return
    if not is_master and not auto.get("white" if cat == "white" else cat):
        return
    now = time.time()
    if now - last_reply_at.get(uid, 0) < float(qq.get("cooldownSec") or 8):
        return
    text = ev.get("raw_message") or seg_text(ev.get("message"))
    if not text:
        return
    lines = recent_context(uid, 8, is_group) or ["对方：" + str(text)[:200]]
    if texts and len(texts) > 1:
        lines = lines + ["（对方刚才连着发了几条，这算一轮，合起来回一次）"]
    elif texts:
        lines = lines
    sysmsg = build_prompt(cfg, uid, peer, is_group)
    try:
        out = call_model(cfg, [
            {"role": "system", "content": sysmsg},
            {"role": "user", "content": "最近的对话：\n" + "\n".join(lines) + "\n\n回他一句。"},
        ])
    except Exception as e:
        stats["lastError"] = "model: %s" % e
        return
    ops_found = extract_ops(out)
    if ops_found:
        for o in ops_found:
            o["ts"] = int(time.time())
            append_line(OPS, o)
    parts = split_parts(strip_directives(out), cfg)
    if not parts:
        return
    last_reply_at[uid] = now
    target = {"group_id": int(ev.get("group_id") or 0)} if is_group else {"user_id": uid}
    for i, p in enumerate(parts):
        try:
            napcat_post("send_group_msg" if is_group else "send_private_msg", dict(target, message=p))
            append_line(OUTBOX, {
                "ts": int(time.time()), "uid": uid,
                "group": int(ev.get("group_id") or 0) if is_group else 0, "text": p,
            })
            stats["replied"] += 1
            stats["lastReplyAt"] = int(time.time())
        except Exception as e:
            stats["lastError"] = "send: %s" % e
            break
        if i < len(parts) - 1:
            time.sleep(float(qq.get("splitGap") or 0.6))
    print("[bridge] 回了 %s：%s" % (uid, "".join(parts)[:60]), flush=True)


def reader_loop():
    backoff = 3
    while True:
        try:
            url = NAPcat_WS + ("&" if "?" in NAPcat_WS else "?") + "access_token=" + urllib.parse.quote(TOKEN)
            ws = WS(url)
            stats["connected"] = True
            stats["lastError"] = ""
            stats["reconnects"] += 1
            print("[bridge] 连上了 %s" % url.split("?")[0], flush=True)
            backoff = 3
            while True:
                op, payload = ws.recv()
                stats["lastEventAt"] = int(time.time())
                stats["events"] += 1
                if op != 0x1:
                    continue
                try:
                    ev = json.loads(payload.decode("utf-8", "replace"))
                except Exception:
                    continue
                if ev.get("self_id"):
                    stats["selfId"] = int(ev["self_id"])
                if ev.get("post_type") != "message":
                    continue
                rec = {"ts": int(ev.get("time") or time.time()), "id": ev.get("message_id"), "ev": ev}
                with lock:
                    append_line(INBOX, rec)
                    stats["messages"] += 1
                    stats["lastMsgAt"] = int(time.time())
                threading.Thread(target=maybe_reply, args=(ev,), daemon=True).start()
        except Exception as e:
            stats["connected"] = False
            stats["lastError"] = str(e)
            print("[bridge] 断开：%s（%ds 后重连）" % (e, backoff), flush=True)
            time.sleep(backoff)
            backoff = min(30, backoff * 2)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw or b"{}")
        except Exception:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _bili(self, u, body):
        path = u.path
        q = urllib.parse.parse_qs(u.query)
        if path == "/bili/get":
            return self._json(bili_request(str(body.get("url") or "")))
        if path == "/bili/post":
            return self._json(bili_request(str(body.get("url") or ""), "POST", body.get("form") or {}))
        if path == "/bili/video":
            return self._json(bili_video(str(body.get("bvid") or (q.get("bvid") or [""])[0])))
        if path == "/bili/status":
            st = bili_status()
            st["ok"] = True
            return self._json(st)
        if path == "/bili/login/qr":
            return self._json(bili_qr_new())
        if path == "/bili/login/poll":
            key = body.get("key") or (q.get("key") or [""])[0]
            return self._json(bili_qr_poll(key))
        if path == "/bili/comment":
            ck = bili_cookies()
            csrf = ck.get("bili_jct") or ""
            form = {"oid": str(body.get("aid") or ""), "type": "1",
                    "message": str(body.get("message") or "")[:900], "csrf": csrf,
                    "plat": "1", "csrf_token": csrf}
            return self._json(bili_request("https://api.bilibili.com/x/v2/reply/add", "POST", form))
        if path == "/bili/logout":
            save_json(BILI, {"cookies": {}, "at": int(time.time())})
            return self._json({"ok": True})
        return self._json({"ok": False, "why": "不认识的 B 站接口"})


    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/bili/"):
            return self._bili(u, {})
        q = urllib.parse.parse_qs(u.query)
        if u.path.startswith("/status"):
            out = dict(stats)
            out["leaseLeft"] = max(0, int(lease_until - time.time()))
            try:
                with open(INBOX, "r", encoding="utf-8") as f:
                    out["inboxCount"] = sum(1 for _ in f)
            except Exception:
                out["inboxCount"] = 0
            cfg = cfg_or_empty()
            out["hasConfig"] = bool(cfg)
            out["loginOk"] = bool(stats.get("loginOk"))
            out["configAt"] = cfg.get("at") or 0
            out["autoReply"] = bool(cfg.get("enabled", True))
            return self._json(out)
        if u.path.startswith("/config"):
            cfg = dict(cfg_or_empty())
            if cfg.get("model"):
                cfg["model"] = dict(cfg["model"])
                if cfg["model"].get("apiKey"):
                    cfg["model"]["apiKey"] = "***"
            return self._json({"ok": True, "config": cfg})
        if u.path.startswith("/pull"):
            try:
                since = int(q.get("since", ["0"])[0])
            except Exception:
                since = 0
            try:
                limit = min(500, int(q.get("limit", ["200"])[0]))
            except Exception:
                limit = 200
            items = []
            if os.path.exists(INBOX):
                for line in open(INBOX, "r", encoding="utf-8"):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    if int(r.get("ts") or 0) > since:
                        items.append({"ts": r.get("ts") or 0, "id": r.get("id"), "kind": "in", "ev": r.get("ev")})
            if os.path.exists(OUTBOX):
                for line in open(OUTBOX, "r", encoding="utf-8"):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    if int(r.get("ts") or 0) > since:
                        items.append({"ts": r.get("ts") or 0, "id": None, "kind": "out", "out": r})
            if os.path.exists(OPS):
                for line in open(OPS, "r", encoding="utf-8"):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    if int(r.get("ts") or 0) > since:
                        items.append({"ts": r.get("ts") or 0, "id": None, "kind": "op", "op": r})
            items.sort(key=lambda x: x.get("ts") or 0)
            items = items[-limit:]
            return self._json({"ok": True, "items": items, "count": len(items), "now": int(time.time())})
        return self._json({"ok": False, "why": "not found"}, 404)

    def do_POST(self):
        global lease_until
        u = urllib.parse.urlparse(self.path)
        if self.path.startswith("/bili/"):
            return self._bili(u, self._body())
        q = urllib.parse.parse_qs(u.query)
        body = self._body()
        if u.path.startswith("/config"):
            body["at"] = int(time.time())
            old = cfg_or_empty()
            # 合并而不是整个覆盖：新配置里空掉的字段沿用旧的，别把主人/记忆冲成空
            for k in ("masterUid", "roster", "persona", "memory", "plans"):
                nv = body.get(k)
                if k == "masterUid":
                    if not nv and old.get(k):
                        body[k] = old[k]
                elif isinstance(nv, list):
                    if not nv and isinstance(old.get(k), list) and old.get(k):
                        body[k] = old[k]
                elif isinstance(nv, dict):
                    if old.get(k):
                        merged = dict(old[k])
                        merged.update(nv)
                        body[k] = merged
            save_json(CONFIG, body)
            return self._json({"ok": True, "at": body["at"]})
        if u.path.startswith("/lease"):
            ttl = int(body.get("ttl") or 60)
            on = body.get("on", True)
            lease_until = (time.time() + ttl) if on else 0
            return self._json({"ok": True, "leaseLeft": max(0, int(lease_until - time.time()))})
        if u.path.startswith("/send"):
            action = "send_group_msg" if body.get("group_id") else "send_private_msg"
            params = {}
            if body.get("group_id"):
                params["group_id"] = int(body["group_id"])
            else:
                params["user_id"] = int(body.get("user_id") or 0)
            params["message"] = body.get("message") or ""
            try:
                return self._json({"ok": True, "resp": napcat_post(action, params)})
            except Exception as e:
                return self._json({"ok": False, "why": str(e)}, 502)
        if u.path.startswith("/ack"):
            st = load_json(STATE, {})
            st["since"] = int(body.get("since") or q.get("since", ["0"])[0] or 0)
            st["ackAt"] = int(time.time())
            save_json(STATE, st)
            return self._json({"ok": True, "since": st["since"]})
        if u.path.startswith("/selftest"):
            cfg = cfg_or_empty()
            uid = int(body.get("uid") or cfg.get("masterUid") or 0)
            text = str(body.get("text") or "在吗")
            is_group = bool(body.get("group"))
            sysmsg = build_prompt(cfg, uid, "对方", is_group)
            ctx = recent_context(uid, 6, is_group) or ["对方：" + text]
            prompt_user = "最近的对话：\n" + "\n".join(ctx) + "\n\n回他一句。"
            out = {"ok": True, "uid": uid, "cat": who_of(cfg, uid), "system": sysmsg, "user": prompt_user}
            try:
                reply = call_model(cfg, [
                    {"role": "system", "content": sysmsg},
                    {"role": "user", "content": prompt_user},
                ])
                out["reply"] = reply
                out["parts"] = split_parts(reply, cfg)
            except Exception as e:
                out["ok"] = False
                out["why"] = str(e)
            return self._json(out)
        return self._json({"ok": False, "why": "not found"}, 404)


if __name__ == "__main__":
    st = load_json(STATE, {})
    if not st.get("since"):
        save_json(STATE, {"since": int(time.time()), "ackAt": int(time.time())})
    threading.Thread(target=reader_loop, daemon=True).start()
    threading.Thread(target=plan_loop, daemon=True).start()
    threading.Thread(target=health_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("[bridge] HTTP 127.0.0.1:%d  data=%s" % (PORT, DATA_DIR), flush=True)
    srv.serve_forever()
