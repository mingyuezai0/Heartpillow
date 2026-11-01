#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
心枕 · 外接 / 名单 / 私聊 联调测试
把 B 站桥和模型接口都换成假的，在无头 Edge 里真的跑一遍：
  · 刷 B 站：搜索 → 详情 → 字幕 → 挑 → 日报 → 评论（黑名单 UP 的视频要被滤掉）
  · 私聊：同步 → 白名单自动回一句 / 黑名单当没看见
  · 名单：UID 识别、称呼、好感度
  · 梗知识：写进提示词
产物：tools/.preview/linktest.png 与 linktest.dom.html
"""
import json
import shutil
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shot  # noqa: E402

TMP = shot.TMP

MOCK = r"""
<script>
window.__errs = [];
window.addEventListener('error', function(e){ window.__errs.push(String(e.message)); });
window.addEventListener('unhandledrejection', function(e){ window.__errs.push('reject:' + String(e.reason)); });
window.__comments = [];
window.__qqSent = [];
window.__dmSent = [];
window.__prompt = '';
window.__dmPrompts = [];

var FAKE = {
  'BV1aa411c7mD': { mid: 9001, aid: 1001, cid: 2001, title: '把 12㎡ 的出租屋改成工作室', up: '阿七不加班', dur: 1104, play: 426000, danmaku: 1200, tname: '生活', desc: '不到八百块，把墙和桌子都改了。' },
  'BV1bb411c7mD': { mid: 9002, aid: 1002, cid: 2002, title: '沿着这条线走完老城区', up: '散步的人', dur: 1520, play: 218000, danmaku: 640, tname: '生活', desc: '一条走了三十年的路。' },
  'BV1cc411c7mD': { mid: 9003, aid: 1003, cid: 2003, title: '一个人做的小游戏卖了两万份', up: '独立游戏观察', dur: 986, play: 355000, danmaku: 980, tname: '游戏', desc: '他辞了职，把所有失败版本都列了出来。' },
  'BV1blacklist': { mid: 1002, aid: 1999, cid: 2999, title: '黑名单那个人的视频', up: '杠精本精', dur: 600, play: 999000, danmaku: 3000, tname: '生活', desc: '不该出现在候选里。' }
};

var SESSIONS = [
  { talker_id: 1001, unread_count: 1, session_ts: Math.floor(Date.now()/1000) - 60,
    account_info: { name: '阿屿', face: '', mid: 1001 },
    last_msg: { content: JSON.stringify({ content: '在吗，今天那个视频你看了没' }) } },
  { talker_id: 1002, unread_count: 2, session_ts: Math.floor(Date.now()/1000) - 120,
    account_info: { name: '杠精本精', face: '', mid: 1002 },
    last_msg: { content: JSON.stringify({ content: '你怎么不回我' }) } },
  { talker_id: 1003, unread_count: 1, session_ts: Math.floor(Date.now()/1000) - 30,
    account_info: { name: '路人甲', face: '', mid: 1003 },
    last_msg: { content: JSON.stringify({ content: '在吗' }) } },
  { talker_id: 1009, unread_count: 1, session_ts: Math.floor(Date.now()/1000) - 10,
    account_info: { name: '测试主人', face: '', mid: 1009 },
    last_msg: { content: JSON.stringify({ content: '晚上吃什么' }) } }
];

var MSGS = {
  1001: [{ sender_uid: 1001, content: JSON.stringify({ content: '在吗，今天那个视频你看了没' }), timestamp: Math.floor(Date.now()/1000) - 60 }],
  1002: [{ sender_uid: 1002, content: JSON.stringify({ content: '你怎么不回我' }), timestamp: Math.floor(Date.now()/1000) - 120 }],
  1003: [{ sender_uid: 1003, content: JSON.stringify({ content: '在吗' }), timestamp: Math.floor(Date.now()/1000) - 30 }],
  1009: [{ sender_uid: 1009, content: JSON.stringify({ content: '晚上吃什么' }), timestamp: Math.floor(Date.now()/1000) - 10 }]
};

function jsonResp(obj) { return Promise.resolve({ ok: true, status: 200, json: obj, text: '' }); }

window.xinzhenDesktop = {
  isDesktop: true,
  qq: {
    call: function (a) {
      var act = a.action;
      if (act === 'get_login_info') return Promise.resolve({ ok: true, status: 200, json: { status: 'ok', retcode: 0, data: { user_id: 999, nickname: '测试号' } } });
      if (act === 'get_stranger_info') return Promise.resolve({ ok: true, status: 200, json: { status: 'ok', retcode: 0, data: { nickname: '阿屿' } } });
      if (act === 'send_private_msg' || act === 'send_group_msg') {
        window.__qqSent.push({ action: act, params: a.params });
        return Promise.resolve({ ok: true, status: 200, json: { status: 'ok', retcode: 0, data: { message_id: 1 } } });
      }
      return Promise.resolve({ ok: true, status: 200, json: { status: 'ok', retcode: 0, data: {} } });
    }
  },
  bili: {
    status: function () { return Promise.resolve({ ok: true, login: true, uname: '测试号', mid: 77 }); },
    login: function () { return Promise.resolve({ ok: true }); },
    logout: function () { return Promise.resolve({ ok: true }); },
    comment: function (a) { window.__comments.push(a); return Promise.resolve({ ok: true, code: 0 }); },
    post: function (a) { window.__dmSent.push(a); return Promise.resolve({ ok: true, status: 200, json: { code: 0 } }); },
    get: function (url) {
      if (url.indexOf('search/type') >= 0) {
        var list = Object.keys(FAKE).map(function (b, i) {
          var v = FAKE[b];
          return { bvid: b, mid: v.mid, title: v.title, author: v.up, play: v.play, video_review: v.danmaku,
                   pubdate: Math.floor(Date.now() / 1000) - 3600 * (i + 1), duration: '18:24', description: v.desc };
        });
        return jsonResp({ code: 0, data: { result: list } });
      }
      if (url.indexOf('/x/web-interface/view') >= 0) {
        var bv = decodeURIComponent((url.match(/bvid=([^&]+)/) || [])[1] || '');
        var f = FAKE[bv];
        if (!f) return jsonResp({ code: -404 });
        return jsonResp({ code: 0, data: {
          aid: f.aid, cid: f.cid, title: f.title, pubdate: Math.floor(Date.now() / 1000) - 7200,
          desc: f.desc, duration: f.dur, tname: f.tname,
          owner: { name: f.up, mid: f.mid }, stat: { view: f.play, danmaku: f.danmaku }
        } });
      }
      if (url.indexOf('/x/player/v2') >= 0) {
        return jsonResp({ code: 0, data: { subtitle: { subtitles: [
          { lan: 'zh-CN', subtitle_url: 'https://aisubtitle.hdslb.com/sub.json' }
        ] } } });
      }
      if (url.indexOf('aisubtitle') >= 0) {
        return jsonResp({ body: [{ from: 0, to: 2, content: '这一期我们把每一笔开销都摊开讲了。' }] });
      }
      if (url.indexOf('web-interface/card') >= 0) {
        var mid = Number((url.match(/mid=(\d+)/) || [])[1] || 0);
        return jsonResp({ code: 0, data: { card: { mid: mid, name: '阿屿', face: '', sign: '', fans: 1200 } } });
      }
      if (url.indexOf('get_sessions') >= 0) return jsonResp({ code: 0, data: { session_list: SESSIONS } });
      if (url.indexOf('fetch_session_msgs') >= 0) {
        var talker = Number((url.match(/talker_id=(\d+)/) || [])[1] || 0);
        return jsonResp({ code: 0, data: { messages: MSGS[talker] || [] } });
      }
      return jsonResp({ code: -404 });
    }
  }
};

var realFetch = window.fetch;
window.fetch = function (url, opt) {
  if (String(url).indexOf('chat/completions') >= 0) {
    var body = JSON.parse(opt.body);
    var sys = String((body.messages[0] || {}).content || '');
    var payload;
    if (sys.indexOf('QQ 上') >= 0) {
      payload = JSON.stringify({ choices: [{ message: { content: '在的，刚看到。\n\n等我一下，我去倒杯水。\n\n你说吧。' } }] });
    } else if (sys.indexOf('私信') >= 0) {
      window.__dmPrompts.push(sys);
      payload = JSON.stringify({ choices: [{ message: { content: '看过啦，正想跟你说这个。' } }] });
    } else if (sys.indexOf('网络梗') >= 0) {
      payload = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memes: [
        { term: '电子榨菜', meaning: '吃饭配的视频', usage: '问配的什么榨菜' }
      ] }) } }] });
    } else {
      window.__prompt = body.messages[body.messages.length - 1].content;
      var answer = {
        picks: [
          { bvid: 'BV1aa411c7mD', why: '每一笔开销都摊开讲了，看完能直接照着自己改。', line: '我们那个阳台其实还能塞下一张桌子。', comment: '这个改造思路真能抄，收藏了。' },
          { bvid: 'BV1bb411c7mD', why: '镜头一直没停，讲到修表铺老板抬头笑那一段，我看了两遍。', line: '下次休息我们照着这条线走一遍吧。', comment: '' },
          { bvid: 'BV1cc411c7mD', why: '后半段全在讲怎么把「不好玩」的地方删掉。', line: '他说做完比做好重要。', comment: '' }
        ],
        note: '今天这几条都偏「能上手做」的。'
      };
      payload = JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] });
    }
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(payload); } });
  }
  return realFetch ? realFetch.apply(window, arguments) : Promise.reject(new Error('no fetch'));
};
</script>
"""

START = r"""
<script>
setTimeout(function () {
  var nav = document.querySelector('#railNav [data-page="link"]');
  if (nav) nav.click();
  /* 外接页默认落在 QQ 栏，B 站的「刷一轮」按钮只在 B 站栏的头部出现 */
  var bili = document.querySelector('#linkTabs [data-linksub="bili"]');
  if (bili) bili.click();
  var run = document.getElementById('linkRun');
  if (run) run.click();
}, 1000);
setTimeout(function () {
  if (!window.__xinzhen.link.reports.length) {
    var r = document.getElementById('linkRun');
    if (r && !r.disabled) r.click();
  }
}, 3000);
setTimeout(function () {
  /* 日报窗口：点今天的卡打开，看完关掉，别挡住后面的操作 */
  var card = document.getElementById('linkTodayCard');
  if (card && !card.disabled) card.click();
}, 5000);
setTimeout(function () {
  var close = document.querySelector('.report-panel [data-close]');
  if (close) close.click();
}, 6200);
setTimeout(function () {
  /* 刷完一圈之后再同步私聊：白名单要回、黑名单要无视 */
  window.__xinzhen.dmSync(true);
}, 7000);
setTimeout(function () {
  /* QQ：白名单要回，黑名单不理 */
  var ev = function (uid, name) {
    return { post_type: 'message', message_type: 'private', self_id: 999, user_id: uid,
             raw_message: '在吗', sender: { nickname: name },
             message: [{ type: 'text', data: { text: '在吗' } }] };
  };
  window.__xinzhen.qqOnMessage(ev(1001, '阿屿'));
  window.__xinzhen.qqOnMessage(ev(1002, '杠精本精'));
  setTimeout(function () { window.__xinzhen.qqOnMessage(ev(1003, '路人甲')); }, 2200);
}, 7800);
setTimeout(function () {
  /* 名单：填 UID → 识别 → 加进名单 */
  document.querySelector('#railNav [data-page="roster"]').click();
  document.getElementById('rosterUid').value = '3333';
  document.getElementById('rosterLookup').click();
}, 8200);
setTimeout(function () {
  var add = document.getElementById('rosterAdd');
  if (add && !document.getElementById('rosterFound').hidden) add.click();
}, 10000);
setTimeout(function () {
  var rep = window.__xinzhen.link.reports[0] || {};
  var picks = rep.picks || [];
  document.title = 'LINKTEST errs=' + window.__errs.length +
    ' comments=' + window.__comments.length +
    ' dm=' + window.__dmSent.length +
    ' roster=' + window.__xinzhen.roster.bili.people.length +
    ' memes=' + window.__xinzhen.memes.items.length +
    ' picks=' + picks.length +
    ' blackInPicks=' + (picks.some(function (p) { return p.bvid === 'BV1blacklist'; }) ? 1 : 0) +
    ' blackInPrompt=' + (String(window.__prompt || '').indexOf('BV1blacklist') >= 0 ? 1 : 0) +
    ' md=' + (rep.markdown ? rep.markdown.length : 0) +
    ' dmPrompts=' + window.__dmPrompts.length +
    ' whiteHasMemory=' + ((window.__dmPrompts[0] || '').indexOf('必须牢记的事') >= 0 ? 1 : 0) +
    ' normalLeaks=' + ((window.__dmPrompts[1] || '').indexOf('必须牢记的事') >= 0 ? 1 : 0) +
    ' master=' + (window.__dmPrompts.some(function (x) { return x.indexOf('那个人本人') >= 0; }) ? 1 : 0) +
    ' nextInH=' + ((window.__xinzhen.linkNextRunAt(Date.now()) - Date.now()) / 3600000).toFixed(2) +
    ' qqSent=' + window.__qqSent.length +
    ' qqTo=' + window.__qqSent.map(function (x) { return x.params.user_id || x.params.group_id; }).join('-') +
    ' dmTo=' + window.__dmSent.map(function (a) {
      var mm = String(a.form || '').match(/receiver_id%5D=(\d+)/);
      return mm ? mm[1] : '?';
    }).join('-');
}, 22000);
</script>
"""


def build():
    html = open(shot.APP, encoding="utf-8").read()
    st = shot.demo_state()
    st["link"]["reports"] = []
    st["link"]["autoComment"] = True
    st["link"]["commentTarget"] = "小屿"
    st["link"]["commentMax"] = 5
    st["link"]["commentEvery"] = 2
    st["link"]["dailyCount"] = 3
    st["link"]["dmReply"] = {"white": True, "none": True, "black": False}
    st["qq"] = {"apiBase": "http://127.0.0.1:3000", "wsUrl": "ws://127.0.0.1:3001", "token": "",
                "autoReply": {"white": True, "none": True, "black": False}, "groupAt": True,
                "cooldownSec": 0, "maxChars": 120, "splitMin": 3, "splitMax": 3, "splitGap": 0.2, "seeImages": True, "collectStickers": True,
                "splitWhiteOnly": True, "me": {"uid": 999, "name": "测试号"}, "sessions": [], "lastAt": 0}
    st["link"]["autoMode"] = "auto"
    st["link"]["autoEvery"] = 4
    st["link"]["autoFrom"] = 0
    st["link"]["autoTo"] = 23
    st["roster"] = {"people": [
        {"id": "p1", "uid": 1001, "uname": "阿屿", "face": "", "nickname": "阿屿",
         "affinity": 70, "list": "white", "addedAt": 1},
        {"id": "p2", "uid": 1002, "uname": "杠精本精", "face": "", "nickname": "",
         "affinity": 5, "list": "black", "addedAt": 2}
    ]}
    st["roster"]["master"] = {"uid": 1009, "uname": "测试主人", "face": "", "at": 1}
    st["roster"]["qq"] = {"master": None, "people": [
        {"id": "q1", "uid": 1001, "uname": "阿屿", "face": "", "nickname": "", "affinity": 70,
         "list": "white", "addedAt": 1},
        {"id": "q2", "uid": 1002, "uname": "杠精本精", "face": "", "nickname": "", "affinity": 5,
         "list": "black", "addedAt": 2},
        {"id": "q3", "uid": 1003, "uname": "路人甲", "face": "", "nickname": "", "affinity": 50,
         "list": "none", "addedAt": 3}
    ]}
    st["memes"] = {"items": [
        {"id": "m1", "term": "电子榨菜", "meaning": "吃饭配着看的视频", "usage": "问配的什么",
         "tags": ["日常"], "source": "ai", "ts": 1}
    ]}

    page = shot.build_page(html, st, "link", None, noanim=True)
    page = page.replace("<body>", "<body>\n" + MOCK, 1)
    page = page.replace("</body>", START + "\n</body>", 1)
    if not os.path.isdir(TMP):
        os.makedirs(TMP)
    path = os.path.join(TMP, "linktest.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(page)
    return path


def main():
    edge = shot.find_edge()
    page = build()
    srv, port = shot.serve(TMP)
    url = "http://127.0.0.1:%d/%s" % (port, os.path.basename(page))
    profile = os.path.join(TMP, "profile-shot")
    profile2 = os.path.join(TMP, "profile-dom")
    shot_on = os.path.join(TMP, "linktest.png")
    try:
        base = [edge, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check",
                "--user-data-dir=" + profile, "--window-size=1440,940"]

        print("[1/2] 截图…")
        shutil.rmtree(profile, ignore_errors=True)
        subprocess.run(base + ["--virtual-time-budget=26000", "--screenshot=" + shot_on, url],
                       capture_output=True, timeout=180)

        print("[2/2] 取 DOM…")
        shutil.rmtree(profile2, ignore_errors=True)
        base2 = [x.replace(profile, profile2) for x in base]
        r = subprocess.run(base2 + ["--virtual-time-budget=26000", "--dump-dom", url],
                           capture_output=True, timeout=180)
        dom = r.stdout.decode("utf-8", "ignore")
        with open(os.path.join(TMP, "linktest.dom.html"), "w", encoding="utf-8") as f:
            f.write(dom)

        ok = True

        def check(name, cond, detail=""):
            nonlocal ok
            ok = ok and bool(cond)
            print(("  ok   " if cond else " FAIL  ") + name + (("  — " + str(detail)) if detail else ""))

        m = re.search(r"LINKTEST errs=(\d+) comments=(\d+) dm=(\d+) roster=(\d+) memes=(\d+) "
                      r"picks=(\d+) blackInPicks=(\d+) blackInPrompt=(\d+) md=(\d+) dmPrompts=(\d+) "
                      r"whiteHasMemory=(\d+) normalLeaks=(\d+) master=(\d+) nextInH=([\d.]+) qqSent=(\d+) qqTo=([\d-]*) dmTo=([\d?-]+)", dom)
        print("  title:", m.group(0) if m else "（没拿到计数）")

        def g(i):
            return m.group(i) if m else ""

        check("日报生成了并挑出 3 条", g(6) == "3" and int(g(9) or 0) > 100, "picks=%s md=%s" % (g(6), g(9)))
        check("黑名单 UP 的视频没进候选", g(7) == "0" and g(8) == "0", "prompt里出现=%s" % g(8))
        check("日报卡片显示条数", "3 条" in dom)
        check("梗进了提示词", "电子榨菜" in dom)
        check("评论隔一条（3 挑 2 评）", g(2) == "2", g(2))
        check("白名单 + 普通 + 主人各回 1 条", g(3) == "3", g(3))
        check("黑名单没被回复", "1002" not in g(17) and "1001" in g(17), g(17))
        check("自动刷排期有下一次时间", 0.3 <= float(g(14) or 0) <= 26, g(14) + "h")  # 排期随当天窗口/上次运行时间变化，只校验“有个合理值”
        check("QQ 白名单拆成 3 条", g(15) == "4" and g(16) == "1001-1001-1001-1003", g(15) + " / " + g(16))
        check("白名单的提示词带记忆", g(11) == "1", g(11))
        check("普通人拿不到人设与记忆", g(12) == "0", "leaks=" + g(12))
        check("主人被认出来了", g(13) == "1", g(13))
        check("名单加人成功（2 → 3）", g(4) == "3", g(4))
        check("梗 1 条", g(5) == "1", g(5))
        check("页面没有运行时报错", g(1) == "0", "errs=" + g(1))

        print("\n截图：%s" % shot_on)
        print("DOM ：%s" % os.path.join(TMP, "linktest.dom.html"))
        if not ok:
            sys.exit(1)
    finally:
        srv.shutdown()


if __name__ == "__main__":
    main()
