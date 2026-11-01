#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
心枕 · 交互冒烟测试
把导航、子页、模板、记忆增删、主题切换、表情弹层、接口报错路径都点一遍，
收集运行时报错与状态变化，确认脚本没有暗雷。
"""
import html as html_mod
import json
import os
import re
import shutil
import subprocess
import tempfile

from shot import demo_state, find_edge, serve, build_page, APP, TMP

SCRIPT = r"""
<script>
window.__ERR = [];
window.addEventListener('error', function(e){ window.__ERR.push('error: ' + (e.message||'') + ' @' + (e.filename||'') + ':' + (e.lineno||0)); });
window.addEventListener('unhandledrejection', function(e){ window.__ERR.push('reject: ' + ((e.reason && (e.reason.stack||e.reason.message)) || String(e.reason))); });
(function(){
  var ce = console.error, cw = console.warn;
  console.error = function(){ window.__ERR.push('console.error: ' + Array.prototype.join.call(arguments,' ')); ce.apply(console, arguments); };
  console.warn  = function(){ window.__ERR.push('console.warn: '  + Array.prototype.join.call(arguments,' ')); cw.apply(console, arguments); };
})();
</script>
"""

STEPS = r"""
<script>
var LOG = [];
function note(s){ LOG.push(s); }
function q(s, r){ return (r || document).querySelector(s); }
function qa(s, r){ return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function click(el){ if(el) el.click(); }

var seq = [
  ['rail:persona',  function(){ click(q('#railNav [data-page="persona"]')); }],
  ['subtab:profile',function(){ click(q('#personaTabs [data-subtab="profile"]')); }],
  ['subtab:memory', function(){ click(q('#personaTabs [data-subtab="memory"]')); }],
  ['subtab:sticker',function(){ click(q('#personaTabs [data-subtab="sticker"]')); }],
  ['subtab:figure', function(){ click(q('#personaTabs [data-subtab="figure"]')); }],

  ['模板:展开',     function(){ click(q('[data-act="preset-menu"]')); note('presets=' + qa('#profilePresets .preset').length + ' hidden=' + q('#profilePresets').hidden); }],
  ['模板:套用',     function(){ var b=qa('#profilePresets .preset')[1]; if(b) b.click(); note('name=' + q('#pName').value + ' tags=' + qa('#pTags .chip').length + ' hidden=' + q('#profilePresets').hidden); }],

  ['记忆:新增关键', function(){ click(q('[data-act="mem-add"][data-kind="key"]')); }],
  ['记忆:填写保存', function(){ var t=q('#edTitle'), x=q('#edText'); if(t)t.value='冒烟测试标题'; if(x)x.value='冒烟测试内容'; var b=q('.editor [data-ed="save"]'); if(b)b.click(); note('keyCount=' + qa('#memKeyList .mem').length); }],
  ['记忆:编辑',     function(){ var b=q('#memKeyList .mem [data-mem="edit"]'); if(b)b.click(); note('editorOpen=' + !!q('#memKeyList .editor')); var c=q('#memKeyList .editor [data-ed="cancel"]'); if(c)c.click(); }],
  ['记忆:新增关键词',function(){ click(q('[data-act="kw-add"]')); var w=q('#kwWord'), n=q('#kwNote'); if(w)w.value='测试词'; if(n)n.value='测试释义'; var b=q('#kwList .editor [data-ed="save"]'); if(b)b.click(); note('kwCount=' + qa('#kwList .mem').length); }],

  ['对话:切页',     function(){ click(q('#railNav [data-page="chat"]')); }],
  ['对话:表情弹层', function(){ click(q('#btnSticker')); note('popOpen=' + !q('#stickerPop').hidden + ' items=' + qa('#popStickers .pop-sticker').length); }],
  ['对话:发文字',   function(){ var i=q('#chatInput'); if(i){ i.value='你好呀，在忙吗'; } click(q('#btnSend')); }],

  ['设置:切页',     function(){ click(q('#railNav [data-page="settings"]')); }],
  ['设置:预设',     function(){ var b=qa('#apiPresets .preset')[2]; if(b)b.click(); note('base=' + q('#setBaseUrl').value); }],
  ['设置:密钥显示', function(){ click(q('#btnToggleKey')); note('keyType=' + q('#setApiKey').type); }],
  ['设置:预览提示词',function(){ click(q('#btnPreviewPrompt')); note('promptLen=' + (q('#layer textarea') ? q('#layer textarea').value.length : 0)); click(q('#layer [data-close]')); }],
  ['设置:暮色主题', function(){ var b=q('#themeSeg [data-theme-val="night"]'); if(b)b.click(); note('theme=' + document.documentElement.getAttribute('data-theme')); }],
  ['设置:字号大',   function(){ var b=q('#fontSeg [data-font-val="large"]'); if(b)b.click(); note('font=' + document.documentElement.getAttribute('data-fontsize')); }],
  ['设置:回凝脂',   function(){ var b=q('#themeSeg [data-theme-val="light"]'); if(b)b.click(); }],

  ['新:吸顶',       function(){ var bar=q('.subtabs-bar'); note('sticky=' + getComputedStyle(bar).position + ' z=' + getComputedStyle(bar).zIndex); q('#railNav [data-page="persona"]').click(); q('#personaTabs [data-subtab="memory"]').click(); }],
  ['新:记忆顺序',   function(){ note('卡片顺序=' + qa('.subpane[data-subpane="memory"] .card-title').map(function(t){return t.textContent.replace(/她记的/,'').trim();}).join(' / ')); }],
  ['新:指令解析',   function(){
      var r = window.__xinzhen.parseDirectives('好啊，那明天见。\n\n[[记忆]]\n关键|她的生日|3 月 12 日\n轻度|今天说想吃草莓蛋糕\n词|年年|橘猫\n忘|旧的错事\n[[/记忆]]\n[[情绪:疑惑]]');
      note('正文=[' + r.text + ']'); note('ops=' + r.ops.length + ' [' + r.ops.map(function(o){return o.type+':'+o.a;}).join(', ') + '] emotion=' + r.emotion);
  }],
  ['新:流式半截',   function(){ note('半截=[' + window.__xinzhen.stripDirectives('你好呀\n\n[[记忆]]\n关键|还没写完') + ']'); }],
  ['新:情绪半截',   function(){ note('半截=[' + window.__xinzhen.stripDirectives('诶？\n[[情绪:疑') + ']'); }],
  ['新:记忆落库',   function(){
      var X = window.__xinzhen;
      var a = X.applyMemoryOps([{type:'key',a:'冒烟生日',b:'3月12日'},{type:'light',a:'冒烟小事',b:''},{type:'word',a:'冒烟词',b:'释义'}]);
      note('新增=' + a.length + ' 关键=' + X.memory.key.length + ' 轻度=' + X.memory.light.length + ' 词=' + X.memory.keywords.length);
  }],
  ['新:同名更新',   function(){
      var X = window.__xinzhen;
      var a = X.applyMemoryOps([{type:'key',a:'冒烟生日',b:'改成 5 月 1 日'}]);
      note('结果=' + a.length + ' 首条=' + (a[0] ? a[0].label + '/' + (a[0].updated?'更新':'新增') : '无'));
      var b = X.applyMemoryOps([{type:'light',a:'冒烟小事',b:''}]);
      note('轻度重复添加=' + b.length + '（应为0）');
  }],
  ['新:忘掉',       function(){ var a = window.__xinzhen.applyMemoryOps([{type:'forget',a:'冒烟小事'}]); note('删了 ' + (a[0]?a[0].count:0) + ' 条，剩轻度=' + window.__xinzhen.memory.light.length); }],
  ['新:她记的标记', function(){ window.__xinzhen.render(); note('页面上「她记的」=' + qa('.by-ai').length + ' 个'); }],
  ['新:字数收口',   function(){
      var X = window.__xinzhen;
      note('句末收口=[' + X.clampChars('第一句话。第二句话。第三句话。第四句话。', 10) + ']');
      note('无标点收口长度=' + X.clampChars(new Array(601).join('字'), 300).length);
      note('未超限原样=' + X.clampChars('短句子。', 300));
  }],
  ['新:表情情绪',   function(){
      var X = window.__xinzhen;
      var s = X.assets.stickers[0]; s.emotion = '疑惑';
      X.settings.stickerAuto = true;
      X.settings.stickerChance = 100; note('100% 命中=' + (X.maybePickSticker('疑惑') ? '有' : '无'));
      X.settings.stickerChance = 0;   note('0% 命中=' + (X.maybePickSticker('疑惑') ? '有' : '无'));
      note('无匹配情绪=' + (X.maybePickSticker('生气') ? '有' : '无'));
      X.settings.stickerChance = 35;
  }],
  ['新:表情下拉',   function(){ note('下拉项=' + qa('.sticker-emotion option').length + ' 卡片=' + qa('.sticker-card').length); }],
  ['新:字数设置',   function(){ note('maxChars=' + window.__xinzhen.settings.maxChars + ' 输入框=' + q('#setMaxChars').value); }],
  ['新:提示词',     function(){ var p = window.__xinzhen.buildSystemPrompt(); note('长度=' + p.length + ' 含记忆段=' + /自己记东西/.test(p) + ' 含情绪段=' + /情绪标记/.test(p) + ' 含篇幅=' + /篇幅/.test(p)); }],
  ['新:非JSON响应', function(){
      var res = { status: 200, text: function(){ return Promise.resolve('<html><body>502 Bad Gateway</body></html>'); } };
      window.__xinzhen.readChatBody(res, 'https://example.com/v1/chat/completions').then(function(v){ note('意外成功=' + v); }, function(e){ note('提示=[' + String(e.message).replace(/\n/g,' ⏎ ') + ']'); });
  }],
  ['新:SSE当非流式', function(){
      var res = { status: 200, text: function(){ return Promise.resolve('data: {"choices":[{"delta":{"content":"你"}}]}\ndata: {"choices":[{"delta":{"content":"好"}}]}\ndata: [DONE]\n'); } };
      window.__xinzhen.readChatBody(res).then(function(v){ note('拼回=[' + v + ']'); }, function(e){ note('失败=' + e.message); });
  }],
  ['新:指令优先级', function(){
      var ops = [{type:'light',a:'1'},{type:'light',a:'2'},{type:'light',a:'3'},{type:'light',a:'4'},{type:'key',a:'重要'},{type:'forget',a:'忘掉'}];
      var r = window.__xinzhen.parseDirectives('[[记忆]]\n轻度|1\n轻度|2\n轻度|3\n轻度|4\n关键|重要\n忘|忘掉\n[[/记忆]]');
      note('6条输入→保留 ' + r.ops.length + ' 条，类型=' + r.ops.map(function(o){return o.type;}).join(','));
  }],

  ['改:字号生效', function(){
      var el = q('.stage-sub');
      var read = function(){ return parseFloat(getComputedStyle(el).fontSize).toFixed(2); };
      var set = function(v){ var b = q('#fontSeg [data-font-val="' + v + '"]'); if(b)b.click(); };
      set('normal'); var norm = read();
      set('small');  var small = read();
      set('large');  var large = read();
      set('normal');
      note('副标题 中=' + norm + 'px 小=' + small + 'px 大=' + large + 'px');
      note('根字号 中=' + getComputedStyle(document.documentElement).fontSize);
      set('large');
      note('根字号 大=' + getComputedStyle(document.documentElement).fontSize
           + '，大标题=' + parseFloat(getComputedStyle(q('#stageTitle')).fontSize).toFixed(2) + 'px');
      set('normal');
  }],
  ['改:导航顺序', function(){ note('侧边栏=' + qa('#railNav .rail-item .rail-label').map(function(x){return x.textContent;}).join(' > ')); }],
  ['改:附加要求位置', function(){ note('人设页有=' + !!q('#pExtraSystem') + '，设置页有=' + !!q('#setExtraSystem')); }],
  ['改:附加要求生效', function(){
      var t = q('#pExtraSystem');
      t.value = '冒烟：回复短一点'; t.dispatchEvent(new Event('input', {bubbles:true}));
      var p = window.__xinzhen.buildSystemPrompt();
      note('进了提示词=' + /冒烟：回复短一点/.test(p));
      t.value = ''; t.dispatchEvent(new Event('input', {bubbles:true}));
  }],
  ['改:心跳心情', function(){
      var X = window.__xinzhen;
      X.feelEmotion('害羞');
      note('害羞→ 心情=' + q('#herMood').textContent + ' 心跳=' + q('#herBpm').textContent
           + ' 节奏=' + q('#herBpmWrap').style.getPropertyValue('--beat')
           + ' 高亮=' + q('#herBpmWrap').classList.contains('is-excited'));
      X.feelEmotion('困了');
      note('困了→ 心情=' + q('#herMood').textContent + ' 心跳=' + q('#herBpm').textContent + '（回落一点）');
      X.nudgeVitals(30);
      note('再抬 +30 → ' + q('#herBpm').textContent);
  }],

  ['二:滑杆刻度', function(){
      var boxes = qa('.slider');
      var bad = boxes.filter(function(b){
        return !b.querySelector('.slider-head .slider-val') || b.querySelectorAll('.slider-num').length !== 2;
      });
      note('滑杆 ' + boxes.length + ' 根，缺刻度/当前值的 ' + bad.length + ' 根');
      note('样例：' + boxes.map(function(b){
        return b.getAttribute('data-left') + '/' + b.querySelector('.slider-val').textContent
             + '/' + b.getAttribute('data-right') + ' [' + qa('.slider-num', b).map(function(n){return n.textContent;}).join('-') + ']';
      }).slice(0,3).join('  |  '));
  }],
  ['二:滑杆联动', function(){
      var inp = q('#sTemper'), box = inp.closest('.slider');
      inp.value = 88; inp.dispatchEvent(new Event('input', {bubbles:true}));
      note('拖到 88 → 显示 ' + box.querySelector('.slider-val').textContent + '，persona.temper=' + window.__xinzhen.persona.temper);
      inp.value = 50; inp.dispatchEvent(new Event('input', {bubbles:true}));
  }],
  ['二:去掉思考块', function(){
      var X = window.__xinzhen;
      note('成对=[' + X.stripReasoning('<thinking>用户问的是天气</thinking>今天挺冷的。') + ']');
      note('半截=[' + X.stripReasoning('今天挺冷的。<thinking>还在想') + ']');
      note('标签残留=[' + X.stripReasoning('</thinking>好呀') + ']');
      note('英文变体=[' + X.stripReasoning('<analysis>x</analysis>在的') + ']');
  }],
  ['二:去首行空行', function(){
      var X = window.__xinzhen;
      note('首行空=[' + JSON.stringify(X.tidyText('\n\n  你好呀  \n\n\n\n 在吗')) + ']');
      note('整段解析=[' + JSON.stringify(X.parseDirectives('\n<thinking>嗯</thinking>\n你好呀\n[[情绪:开心]]').text) + ']');
  }],
  ['二:拆成几条', function(){
      var X = window.__xinzhen;
      var cases = [
        '嗯。',
        '好啊。那明天见。',
        '我今天画了一整天，眼睛都花了。你呢？',
        '第一段话在这里结束了。第二段话稍微长一点，也有它自己的意思。第三段就短了。',
        '我今天画了一整天，眼睛都花了，手也有点抖，不过总算把甲方要的那版交上去了，你呢？',
        '我今天画了一整天，眼睛都花了，手也有点抖，不过总算把甲方要的那版交上去了，心情还挺好的，你呢？',
        '这里是一句没有标点的话我就一直写下去写下去写下去写下去写下去写下去写下去写下去写下去写下去写下去写下去写下去写呀。'
      ];
      cases.forEach(function(c){
        var r = X.segmentReply(c);
        note(r.length + ' 条 ← ' + c.length + ' 字 ← ' + JSON.stringify(c.slice(0,14)) + ' → ' + JSON.stringify(r.map(function(p){return p.text;})));
      });
      note('表情标签不被切开=' + JSON.stringify(X.segmentReply('好的呀，那我等你。[[表情:比心]]').map(function(p){return p.text;})));
  }],
  ['二:关闭拆条', function(){
      window.__xinzhen.settings.splitMessages = false;
      var b = q('#setSplit');
      note('开关存在=' + !!b + ' 默认勾选=' + b.checked);
      b.checked = false; b.dispatchEvent(new Event('change', {bubbles:true}));
      note('关掉后 settings.splitMessages=' + window.__xinzhen.settings.splitMessages);
      b.checked = true; b.dispatchEvent(new Event('change', {bubbles:true}));
  }],
  ['二:关于页', function(){
      var r = q('#railNav [data-page="about"]');
      note('侧边栏有关于=' + !!r + ' 标签=' + (r ? r.textContent.trim() : '-'));
      r.click();
      note('标题=' + q('#stageTitle').textContent + ' 页面可见=' + (getComputedStyle(q('.page[data-page="about"]')).display !== 'none'));
      note('版本=' + q('#aboutVersion').textContent + ' 目录项=' + qa('#docsToc a').length + ' 章节=' + qa('#docsBody h2').length);
      note('代码块=' + qa('#docsBody pre').length + ' 提到QQ部署=' + /NapCat/.test(q('#docsBody').textContent));
  }],
  ['二:限制卡片', function(){
      q('#railNav [data-page="persona"]').click();
      q('#personaTabs [data-subtab="profile"]').click();
      note('卡片标题=' + qa('.subpane[data-subpane="profile"] .card-title').map(function(t){return t.textContent.trim();}).join(' / '));
      note('限制说明还在吗=' + /比上面所有人设都靠后/.test(q('.subpane[data-subpane="profile"]').textContent));
  }],
  ['二:删掉的提示', function(){
      q('#personaTabs [data-subtab="memory"]').click();
      note('记忆页提示数=' + qa('.subpane[data-subpane="memory"] .note').length + '（应为0）');
      q('#railNav [data-page="settings"]').click();
      var t = q('.page[data-page="settings"]').textContent;
      note('设置页残留提示：附加要求=' + /已经挪到/.test(t) + ' 表情概率=' + /比如一张表情设成/.test(t));
  }],
  ['二:立绘等高', function(){
      q('#railNav [data-page="persona"]').click();
      q('#personaTabs [data-subtab="figure"]').click();
      var cards = qa('.subpane[data-subpane="figure"] .card');
      var h1 = Math.round(cards[0].getBoundingClientRect().height);
      var h2 = Math.round(cards[1].getBoundingClientRect().height);
      var d1 = Math.round(q('#portraitDrop').getBoundingClientRect().height);
      var d2 = Math.round(q('#avatarDrop').getBoundingClientRect().height);
      note('立绘卡=' + h1 + 'px 头像卡=' + h2 + 'px 差=' + Math.abs(h1-h2) + 'px');
      note('立绘框=' + d1 + 'px 头像框=' + d2 + 'px');
  }],

  ['三:存储模式', function(){
      q('#railNav [data-page="settings"]').click();
      note('存储方式=' + q('#storageMode').textContent);
      note('已占用=' + q('#storageText').textContent);
      note('说明=' + (q('#storageNote').textContent || '').slice(0, 34));
  }],
  ['三:关于页可滚', function(){
      q('#railNav [data-page="about"]').click();
      var sb = q('#stageBody');
      var before = sb.scrollTop;
      sb.style.scrollBehavior = 'auto';
      sb.scrollTop = 99999;
      note('scrollH=' + sb.scrollHeight + ' clientH=' + sb.clientHeight + ' 滚到底=' + sb.scrollTop);
      note('能滚动=' + (sb.scrollTop > before));
      sb.scrollTop = 0;
  }],
  ['三:AI写人设要确认', function(){
      q('#railNav [data-page="persona"]').click();
      q('#personaTabs [data-subtab="profile"]').click();
      q('[data-act="ai-profile"]').click();
      note('弹窗=' + !!q('#layer .confirm') + ' 标题=' + ((q('#layer .confirm-title') || {}).textContent || '-'));
      var no = q('#layer [data-cf="0"]'); if (no) no.click();
      note('取消后弹窗已关=' + !q('#layer .confirm'));
  }],
  ['三:移除立绘要确认', function(){
      q('#personaTabs [data-subtab="figure"]').click();
      var had = !!window.__xinzhen.assets.portrait;
      q('[data-act="clear-portrait"]').click();
      note('弹窗=' + !!q('#layer .confirm') + ' 标题=' + ((q('#layer .confirm-title') || {}).textContent || '-'));
      var no = q('#layer [data-cf="0"]'); if (no) no.click();
      note('原本有立绘=' + had + '，取消后还在=' + !!window.__xinzhen.assets.portrait);
  }],
  ['三:移除头像要确认', function(){
      q('[data-act="clear-avatar"]').click();
      note('弹窗=' + !!q('#layer .confirm'));
      var no = q('#layer [data-cf="0"]'); if (no) no.click();
      note('取消后还有头像=' + !!window.__xinzhen.assets.avatar);
  }],
  ['三:删标签要确认', function(){
      q('#personaTabs [data-subtab="profile"]').click();
      var n0 = window.__xinzhen.persona.tags.length;
      var x = q('#pTags .chip-x'); if (x) x.click();
      note('弹窗=' + !!q('#layer .confirm') + ' 文案=' + ((q('#layer .confirm-text') || {}).textContent || '-'));
      var no = q('#layer [data-cf="0"]'); if (no) no.click();
      note('标签 ' + n0 + ' → ' + window.__xinzhen.persona.tags.length + '（取消后不变）');
  }],
  ['三:移除附件要确认', function(){
      q('#railNav [data-page="chat"]').click();
      var X = window.__xinzhen;
      X.pendingAtts.push({kind:'file', name:'冒烟测试.txt', mime:'text/plain', size:12, text:'hi'});
      X.renderAtts();
      note('附件区显示=' + !q('#attStrip').hidden + ' 计数=' + q('#attCount').textContent
           + ' 按钮=' + q('#attOnlyLabel').textContent);
      q('#attList .att-x').click();
      note('弹窗=' + !!q('#layer .confirm'));
      var no = q('#layer [data-cf="0"]'); if (no) no.click();
      note('取消后附件还在=' + X.pendingAtts.length);
      X.pendingAtts.length = 0; X.renderAtts();
      note('清空后隐藏=' + q('#attStrip').hidden);
  }],
  ['三:重新生成要确认', function(){
      q('#railNav [data-page="chat"]').click();
      var X = window.__xinzhen;
      var bak = X.chat.messages.slice();

      /* 情况一：最后一段回复由两条组成 —— 两条都算「这次回复」，重生成整段，不弹窗 */
      X.chat.messages.length = 0;
      X.chat.messages.push({id:'u1', role:'user', text:'在吗', ts:Date.now()});
      X.chat.messages.push({id:'a1', role:'assistant', text:'在的', ts:Date.now()});
      X.chat.messages.push({id:'a2', role:'assistant', text:'怎么了', ts:Date.now()});
      X.render();
      var acts = qa('#chatList .msg.is-her [data-mact="again"]');
      note('末尾两条回复 → 按钮 ' + acts.length + ' 个，提示分别是：' +
           acts.map(function(b){return b.getAttribute('title');}).join(' / '));

      /* 情况二：前面还有一段旧回复 —— 点它属于「从这里重来」，必须先问 */
      X.chat.messages.length = 0;
      X.chat.messages.push({id:'u1', role:'user', text:'在吗', ts:Date.now()});
      X.chat.messages.push({id:'a1', role:'assistant', text:'在的', ts:Date.now()});
      X.chat.messages.push({id:'u2', role:'user', text:'干嘛呢', ts:Date.now()});
      X.chat.messages.push({id:'a2', role:'assistant', text:'画图', ts:Date.now()});
      X.render();
      var acts2 = qa('#chatList .msg.is-her [data-mact="again"]');
      note('旧的一段：' + acts2[0].getAttribute('title'));
      note('最后一段：' + acts2[1].getAttribute('title'));

      acts2[0].click();
      note('点旧的那段 → 弹窗=' + !!q('#layer .confirm') + ' 文案=' + ((q('#layer .confirm-text') || {}).textContent || '-').slice(0, 42));
      var no = q('#layer [data-cf="0"]'); if (no) no.click();
      note('取消后消息数=' + X.chat.messages.length + '（应仍为 4）');

      X.chat.messages.length = 0;
      Array.prototype.push.apply(X.chat.messages, bak);
      X.render();
  }],
  ['三:分段上限', function(){
      var X = window.__xinzhen;
      note('MAX_PARTS=' + X.MAX_PARTS);
      note('提示词里写了上限=' + new RegExp('最多分成 ' + X.MAX_PARTS + ' 条').test(X.buildSystemPrompt()));
  }],
  ['四:迁移与角色', function(){
      var X = window.__xinzhen;
      note('角色数=' + X.characters.length + ' 名称=' + X.characters.map(function(c){return c.name;}).join(','));
      note('当前角色 id=' + X.activeId);
      note('人设名字=' + X.persona.name + '（老数据应该迁进来了）');
      note('聊天条数=' + X.chat.messages.length + ' 关键记忆=' + X.memory.key.length + ' 表情=' + X.assets.stickers.length);
      note('旧键还在吗=' + (localStorage.getItem('xinzhen.v1.persona') !== null) + '（应为 false）');
      note('新键有吗=' + (localStorage.getItem('xinzhen.v1.c.' + X.activeId + '.persona') !== null || window.__xinzhen.storeMode === 'idb'));
  }],
  ['四:关键记忆倒序', function(){
      q('#railNav [data-page="persona"]').click();
      q('#personaTabs [data-subtab="memory"]').click();
      var ts = qa('#memKeyList .mem .mem-meta').map(function(e){ return e.textContent; });
      note('页面上的时间（应为新→旧）=' + ts.join(' | '));
  }],
  ['四:话语规范', function(){
      q('#personaTabs [data-subtab="profile"]').click();
      var cards = qa('.subpane[data-subpane="profile"] .card-title').map(function(t){return t.textContent.trim();});
      note('卡片顺序=' + cards.join(' / '));
      note('偏向按钮=' + qa('#speechStyles .chip-btn').length + ' 个');
      var b = qa('#speechStyles .chip-btn')[2]; b.click();
      note('点了「' + b.textContent + '」→ persona.speech.style=' + window.__xinzhen.persona.speech.style);
      var p = window.__xinzhen.buildSystemPrompt();
      note('提示词含话语规范=' + /【话语规范】/.test(p) + ' 含偏向=' + /整体偏向/.test(p));
  }],
  ['四:我这一栏', function(){
      q('#personaTabs .subtab[data-subtab="me"]').click();
      note('我 tab 存在=' + !!q('.subpane[data-subpane="me"]'));
      var n = q('#meName'); n.value = '陈屿'; n.dispatchEvent(new Event('input', {bubbles:true}));
      var t = q('#meText'); t.value = '27 岁，做后端的，常年熬夜。'; t.dispatchEvent(new Event('input', {bubbles:true}));
      note('数据=' + JSON.stringify(window.__xinzhen.me));
      note('预览名字=' + q('#mePreviewName').textContent);
      var p = window.__xinzhen.buildSystemPrompt();
      note('提示词含对方是谁=' + /【对方是谁】/.test(p) + ' 含名字=' + /陈屿/.test(p));
  }],
  ['四:情绪推断', function(){
      var X = window.__xinzhen;
      [['哈哈那你可真行','开心'],['咦？你怎么知道','疑惑'],['抱抱，我想你了','亲亲'],
       ['哼！不理你了','生气'],['好困啊，我先睡了','困了'],['对不起，是我不好','委屈']].forEach(function(c){
        note(JSON.stringify(c[0]) + ' → ' + X.guessEmotion(c[0]) + '（期望 ' + c[1] + '）');
      });
      X.chat.messages.length = 0;
      X.feelEmotion('平静');
      note('平静时心跳=' + q('#herBpm').textContent);
      X.feelEmotion('亲亲');
      note('亲亲后心跳=' + q('#herBpm').textContent + ' 心情=' + q('#herMood').textContent);
      X.feelEmotion('难过');
      note('难过时心跳=' + q('#herBpm').textContent + ' 心情=' + q('#herMood').textContent + '（应有明显回落）');
  }],
  ['四:角色切换', function(){
      var X = window.__xinzhen;
      var before = { id: X.activeId, name: X.persona.name, msgs: X.chat.messages.length };
      note('切换前：' + before.name + ' / ' + before.msgs + ' 条');
      q('#btnChar').click();
      note('角色浮层打开=' + !q('#charPop').hidden + ' 列表项=' + qa('#charPopList .char-row').length);
      q('#charPop').hidden = true;
      return X.createCharacter('测试角色B').then(function(){
        note('新建后：角色数=' + X.characters.length + ' 当前=' + X.persona.name + ' 消息=' + X.chat.messages.length + ' 记忆=' + X.memory.key.length);
        note('接口沿用=' + (X.settings.baseUrl === 'https://dashscope.aliyuncs.com/compatible-mode/v1'));
        return X.switchCharacter(before.id);
      }).then(function(){
        note('切回后：当前=' + X.persona.name + ' 消息=' + X.chat.messages.length + ' 记忆=' + X.memory.key.length);
      });
  }],
  ['四:导出按角色', function(){
      q('#railNav [data-page="chat"]').click();
      note('对话页「导出对话」按钮=' + !!q('#actExportChat') + '（应为 false）');
      q('#railNav [data-page="settings"]').click();
      note('设置页按钮文案=' + q('#actExport').textContent.trim());
      note('角色数=' + window.__xinzhen.characters.length);
      q('#actExport').click();
      note('导出窗口出现=' + !!q('#layer [data-ex]') + ' 选项数=' + qa('#layer [data-ex]').length + '（应为 4：当前/全部 × json/md）');
      note('标题=' + ((q('#layer .confirm-title') || {}).textContent || '-'));
      var no = q('#layer [data-cf="0"]'); if (no) no.click();
      note('取消后浮层已关=' + !q('#layer [data-ex]'));
  }],
  ['四:关于页', function(){
      q('#railNav [data-page="about"]').click();
      note('版本=' + q('#aboutVersion').textContent);
      note('还记得「单文件版」吗=' + /单文件版/.test(q('.page[data-page="about"]').textContent));
      note('还有「开源许可」吗=' + /开源许可/.test(q('.page[data-page="about"]').textContent));
      note('更新日志块=' + qa('#changelog .log-block').length + ' 个（应为 3）');
      note('分类标签=' + qa('#changelog .log-tag').map(function(t){return t.textContent;}).join(','));
      note('简介长度=' + q('.docs-lede').textContent.length + ' 字');
      note('有部署教程吗=' + (/NapCat/.test(q('#docsBody').textContent) && /B 站/.test(q('#docsBody').textContent)));
  }],
  ['四:开屏元素', function(){
      var b = q('#booting');
      note('开屏存在=' + !!b + ' 已结束=' + (b ? b.classList.contains('is-done') : '-'));
      note('图标/名字/水波=' + !!q('.boot-icon') + '/' + !!q('.boot-name') + '/' + !!q('.boot-ripple'));
  }],
  ['四:消息整条出现', function(){
      var X = window.__xinzhen;
      note('打字机设置项已移除=' + !q('#setTypewriter'));
      note('settings.typewriter 仍在=' + ('typewriter' in X.settings) + '（无害，仅不再使用）');
  }],
  ['三:表情回退与冷却', function(){
      var X = window.__xinzhen;
      var bak = X.chat.messages.slice();
      var chance = X.settings.stickerChance, auto = X.settings.stickerAuto;
      X.settings.stickerAuto = true; X.settings.stickerChance = 100;
      X.assets.stickers[0].emotion = '疑惑';

      function trial(emotion, n) {
        var hit = 0;
        for (var k = 0; k < n; k++) { X.chat.messages.length = 0; if (X.maybePickSticker(emotion)) hit++; }
        return hit;
      }
      note('对得上(疑惑) 60 次命中 ' + trial('疑惑', 60) + '（应 60）');
      var mid = trial('生气', 60);
      note('对不上(生气) 60 次命中 ' + mid + '（应 0 < n < 60，约 27）');
      var none = trial(null, 60);
      note('她没给情绪 60 次命中 ' + none + '（应 0 < n < 60）');

      X.chat.messages.length = 0;
      X.chat.messages.push({id:'sm1', role:'assistant', text:'', sticker:'s1'});
      note('刚发过表情 → ' + (X.maybePickSticker('疑惑') ? '还发' : '跳过这一轮'));
      X.chat.messages.length = 0;
      X.settings.stickerChance = 0;
      note('概率 0 → ' + (X.maybePickSticker('疑惑') ? '还发' : '不发'));

      X.chat.messages.length = 0;
      Array.prototype.push.apply(X.chat.messages, bak);
      X.settings.stickerChance = chance; X.settings.stickerAuto = auto;
      X.render();
  }],

  ['外接:页面', function(){
      click(q('#railNav [data-page="link"]'));
click(q('#linkTabs [data-linksub="bili"]'));   /* 外接页默认落在 QQ 栏，B 站的按钮只在 B 站栏出现 */
      var pg = q('.page[data-page="link"]');
      note('可见=' + getComputedStyle(pg).display + '，卡片 ' + qa('.page[data-page="link"] .card').length + ' 张');
      note('徽章=' + q('#linkBadge').textContent + '，按钮禁用=' + q('#linkRun').disabled);
  }],
  ['外接:关键词不设上限', function(){
      var X = window.__xinzhen;
      for (var i = 0; i < 12; i++) X.link.keywords.push('词' + i);
      X.renderLink();
      note('12 个都留下了=' + (X.link.keywords.length >= 12) + '，界面 chips=' + qa('#linkKeywords .chip').length);
  }],
  ['外接:加关键词', function(){
      var i = q('#linkKw'); i.value = '测试词'; q('#linkKwAdd').click();
      note('关键词 ' + qa('#linkKeywords .chip').length + ' 个：' + window.__xinzhen.link.keywords.join('、'));
  }],
  ['外接:删关键词', function(){
      var x = q('#linkKeywords .chip .chip-x'); if (x) x.click();
      note('删完剩 ' + qa('#linkKeywords .chip').length + ' 个');
  }],
  ['外接:日报详略', function(){
      var b = qa('#linkLevel .seg-btn')[1]; if (b) b.click();
      note('切到=' + window.__xinzhen.link.reportLevel);
  }],
  ['外接:自动评论展开', function(){
      var c = q('#linkAutoComment'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
      note('面板展开=' + !q('#linkCommentPanel').hidden);
      var t = q('#linkTarget'); t.value = '小屿'; t.dispatchEvent(new Event('input', { bubbles: true }));
      note('目标=' + window.__xinzhen.link.commentTarget);
  }],
  ['外接:浏览器里点不动', function(){
      q('#linkRun').click();
      note('没桥时按钮仍禁用=' + q('#linkRun').disabled + '，页面还在=' + !!q('.page[data-page="link"].is-active'));
  }],
  ['外接:自动刷选项', function(){
      click(q('#linkMode [data-mode="auto"]'));
      note('模式=' + window.__xinzhen.link.autoMode +
        '，面板可见=' + !q('#linkAutoPanel').hidden +
        '，下次=' + q('#linkNext').textContent);
  }],
  ['外接:频率与时间范围', function(){
      var e = q('#linkEvery'); e.value = '3'; e.dispatchEvent(new Event('change', { bubbles: true }));
      var f = q('#linkFrom'); f.value = '22'; f.dispatchEvent(new Event('change', { bubbles: true }));
      note('每 ' + window.__xinzhen.link.autoEvery + ' 小时，' +
        window.__xinzhen.link.autoFrom + ' 点到 ' + window.__xinzhen.link.autoTo + ' 点，下次=' +
        q('#linkNext').textContent);
  }],
  ['外接:评论频率', function(){
      if (!q('#linkAutoComment').checked) click(q('#linkAutoComment'));
      click(q('#linkCommentEvery [data-every="2"]'));
      note('commentEvery=' + window.__xinzhen.link.commentEvery +
        '，面板可见=' + !q('#linkCommentPanel').hidden);
  }],
  ['名单:主人卡', function(){
      click(q('#railNav [data-page="roster"]'));
      note('主人=' + q('#masterName').textContent + '（' + q('#masterSub').textContent + '）');
      q('#masterEdit').click();
      note('表单可见=' + !q('#masterForm').hidden);
  }],
  ['外接:切到 QQ', function(){
      click(q('#railNav [data-page="link"]'));
click(q('#linkTabs [data-linksub="bili"]'));   /* 外接页默认落在 QQ 栏，B 站的按钮只在 B 站栏出现 */
      click(q('#linkTabs [data-linksub="qq"]'));
      var pane = q('.subpage[data-linkpane="qq"]');
      note('QQ 页=' + getComputedStyle(pane).display +
        '，宽=' + Math.round(pane.getBoundingClientRect().width) +
        '，有连接卡=' + !!q('#qqApi') +
        '，页头=' + q('#stageActions').textContent.trim());
  }],
  ['外接:QQ 设置', function(){
      var e = q('#qqCooldown'); e.value = '5'; e.dispatchEvent(new Event('change', { bubbles: true }));
      note('冷却=' + window.__xinzhen.qq.cooldownSec + '，地址=' + window.__xinzhen.qq.apiBase);
  }],
  ['外接:QQ 没桥不乱跑', function(){
      click(q('#qqTest'));
      note('点过测试连接，页面还在=' + !!q('#qqApi'));
  }],
  ['外接:部署器（浏览器里）', function(){
      note('部署状态=' + q('#napcatState').textContent);
  }],
  ['名单:切到 QQ', function(){
      click(q('#railNav [data-page="roster"]'));
      click(q('#rosterTabs [data-rsub="qq"]'));
      var pane = q('.subpage[data-rpane="qq"]');
      note('QQ 名单=' + getComputedStyle(pane).display +
        '，宽=' + Math.round(pane.getBoundingClientRect().width) +
        '，人数=' + qa('#qqRosterList .person').length);
  }],
  ['外接:日报小卡', function(){
      note('今日=' + (q('#linkTodayTitle') || {}).textContent +
        ' / 条数=' + (q('#linkTodayCount') || {}).textContent +
        ' / 历史=' + (q('#linkHistory') || {}).textContent);
  }],
  ['外接:私聊三开关', function(){
      var xs = qa('#dmWhite, #dmNone, #dmBlack');
      note('开关数=' + xs.length + ' 默认=' + xs.map(function (x) { return x.checked; }).join(','));
      var b = q('#dmBlack'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true }));
      note('黑名单勾上后 link.dmReply.black=' + window.__xinzhen.link.dmReply.black);
  }],
  ['名单:页面', function(){
      click(q('#railNav [data-page="roster"]'));
      note('可见=' + getComputedStyle(q('.page[data-page="roster"]')).display +
        '，名单 ' + qa('#rosterList .person').length + ' 人');
  }],
  ['名单:加一条', function(){
      var X = window.__xinzhen;
      X.roster.bili.people.push({ id: 'pt', uid: 4242, uname: '测试账号', face: '', nickname: '小测',
                             affinity: 60, list: 'white', addedAt: Date.now() });
      X.renderRoster();
      note('加完 ' + qa('#rosterList .person').length + ' 人');
  }],
  ['名单:切黑名单', function(){
      var b = q('#rosterList .person [data-set="black"]');
      if (b) b.click();
      var p0 = window.__xinzhen.roster.bili.people.filter(function (x) { return x.uid === 4242; })[0];
      note('list=' + (p0 && p0.list) + ' 好感度=' + (p0 && p0.affinity));
  }],
  ['名单:改称呼', function(){
      var inp = q('#rosterList .person [data-nick]');
      if (inp) { inp.value = '阿测'; inp.dispatchEvent(new Event('change', { bubbles: true })); }
      note('称呼=' + (window.__xinzhen.roster.bili.people[0] || {}).nickname);
  }],
  ['名单:无桥识别不炸', function(){
      var i = q('#rosterUid'); i.value = '2'; q('#rosterLookup').click();
      note('点过识别，页面还在=' + !!q('.page[data-page="roster"]'));
  }],
  ['梗知识:页签', function(){
      click(q('#railNav [data-page="persona"]'));
      click(q('#personaTabs [data-subtab="memes"]'));
      note('可见=' + getComputedStyle(q('.subpane[data-subpane="memes"]')).display +
        '，梗 ' + qa('#memeList .meme').length + ' 条');
  }],
  ['梗知识:手动加', function(){
      q('#memeAdd').click();
      q('#memeTerm').value = '测试梗';
      q('#memeMeaning').value = '就是拿来测试的';
      q('.confirm [data-cf="1"]').click();
      note('加完 ' + qa('#memeList .meme').length + ' 条');
  }],
  ['私聊:浏览器里只读', function(){
      click(q('#railNav [data-page="link"]'));
click(q('#linkTabs [data-linksub="bili"]'));   /* 外接页默认落在 QQ 栏，B 站的按钮只在 B 站栏出现 */
      note('提示=' + (q('#dmSessions .field-note') || {}).textContent);
  }],

  ['四:逐条送达与上限', async function(){
      var X = window.__xinzhen;
      var realFetch = window.fetch;
      var reply = '好呀。你怎么突然想起来问我这个，是不是今天不忙？'
                + '我这边刚把稿子交上去，甲方还没回我，估计又要改。'
                + '算了不想了。你晚上吃什么，要不我给你带一份？';
      /* 假的流式接口：一小片一小片地吐，模拟真实 SSE */
      var hits = 0, pushed = 0, streamErr = '';
      window.fetch = function(url, opt){
        if (String(url).indexOf('chat/completions') < 0) return realFetch.apply(this, arguments);
        hits++;
        var chunks = reply.match(/[\s\S]{1,3}/g) || [];
        var parts = chunks.map(function(c){
          return 'data: ' + JSON.stringify({choices:[{delta:{content:c}}]}) + '\n\n';
        });
        parts.push('data: [DONE]\n\n');
        var enc = new TextEncoder(), k = 0;
        var stream = new ReadableStream({ start: function(c){
          var t = setInterval(function(){
            try {
              if (k >= parts.length) { clearInterval(t); c.close(); return; }
              c.enqueue(enc.encode(parts[k++])); pushed++;
            } catch (e) { streamErr = e.message || String(e); clearInterval(t); }
          }, 18);
        }});
        return Promise.resolve(new Response(stream, {status:200, headers:{'Content-Type':'text/event-stream'}}));
      };

      try {
        X.settings.stream = true;
        X.chat.messages.length = 0;
        X.render();

        var samples = [], sawTyping = false;
        var sampler = setInterval(function(){
          /* 只统计已经定稿的消息气泡（「正在输入」那个没有 data-id，不算） */
          var snap = {};
          qa('#chatList .msg[data-id] .bubble').forEach(function(b){
            snap[b.closest('.msg').dataset.id] = b.textContent.length;
          });
          samples.push(snap);
          if (q('#chatList .typing')) sawTyping = true;
        }, 60);

        q('#chatInput').value = '在忙吗';
        await X.sendCurrent(false);
        clearInterval(sampler);
        window.fetch = realFetch;

        /* 同一条消息的字数一旦出现就不该再变 —— 变了就说明是逐字流式 */
        var seen = {}, grew = [], order = [];
        samples.forEach(function(snap){
          Object.keys(snap).forEach(function(id){
            if (seen[id] == null) { seen[id] = snap[id]; order.push(id); }
            else if (seen[id] !== snap[id]) { if (grew.indexOf(id) < 0) grew.push(id); }
          });
        });
        var counts = samples.map(function(s){ return Object.keys(s).length; });
        var jumps = 0;
        for (var a = 1; a < counts.length; a++) if (counts[a] - counts[a-1] > 1) jumps++;

        note('气泡数变化 = ' + counts.join('→'));
        note('同一条气泡的字数变过吗 = ' + (grew.length ? '变了！' + grew.length + ' 条' : 'false') + '（应为 false，说明是整条出现）');
        note('每次最多只多一条 = ' + (jumps === 0) + '（跳变 ' + jumps + ' 次）');
        note('过程中出现过「正在输入」= ' + sawTyping);
        note('最终气泡数 = ' + qa('#chatList .msg.is-her .bubble').length + '（应 ≤ 5）');
        note('每条落库长度 = ' + JSON.stringify(X.chat.messages.filter(function(m){return m.role==='assistant';}).map(function(m){return m.text.length;})));
        note('原文字数 = ' + reply.length + '，落到 ' + qa('#chatList .msg.is-her .bubble').length + ' 条');
        var errs = X.chat.messages.filter(function(m){ return m.role === 'error'; });
        if (errs.length) note('!! 报错内容 = ' + errs[0].text.slice(0, 220));
        note('假接口被调用 ' + hits + ' 次，推出 ' + pushed + ' 片' + (streamErr ? '，流内报错：' + streamErr : ''));
        note('stream 设置 = ' + X.settings.stream + ' baseUrl=' + X.settings.baseUrl);
      } finally {
        window.fetch = realFetch;
        X.settings.stream = true;
      }
  }],

  ['接口:测试连接', function(){ var b=q('#btnTest'); if(b)b.click(); note('测试已发起'); }],

  ['零:设置页开关没被挤扁', function(){
      /* ⚠️ 这条是给「新组件类名撞了老组件」那类事故立的岗。
         症状是：某个 width:38px 之类的新规则盖到了老的整行开关上，
         文字被挤成一列一个字 —— 不报错、不崩，只有截图才看得出。
         所以这里量几何：整行开关必须够宽，标题必须只占一行。 */
      q('#railNav [data-page="settings"]').click();
      var rows = qa('.page[data-page="settings"] .switch');
      note('设置页开关行=' + rows.length + ' 行');
      var bad = 0, worst = '';
      rows.forEach(function (r) {
        var w = Math.round(r.getBoundingClientRect().width);
        var nm = r.querySelector('.switch-name');
        var h = nm ? Math.round(nm.getBoundingClientRect().height) : 0;
        if (w < 200 || (nm && h > 40)) {
          bad++;
          if (!worst) worst = '宽' + w + ' 标题高' + h;
        }
      });
      note('  └ 被挤扁的=' + bad + ' 行（应为 0）' + (worst ? '，例如 ' + worst : ''));
      if (rows.length) {
        var r0 = rows[0], n0 = r0.querySelector('.switch-name');
        note('  └ 第一行宽=' + Math.round(r0.getBoundingClientRect().width) +
             'px，标题高=' + Math.round(n0.getBoundingClientRect().height) + 'px（一行约 20）');
      }
      note('设置页里的正文没有竖排=' + (bad === 0));
  }],

  ['收尾',          function(){
      note('chatMsgs=' + window.__xinzhen.chat.messages.length);
      note('memKey=' + window.__xinzhen.memory.key.length);
      note('testOut=' + (q('#testOut') ? q('#testOut').textContent.slice(0,180) : '(无)'));
      note('stickerPopHidden=' + q('#stickerPop').hidden);
      note('attStripHidden=' + q('#attStrip').hidden);
  }]
];

var i = 0;
function next(){
  if (i >= seq.length) { finish(); return; }
  var step = seq[i++];
  var done = function(){ setTimeout(next, 300); };
  try {
    var r = step[1]();
    if (r && typeof r.then === 'function') {
      r.then(function(){ note('OK  ' + step[0]); done(); },
             function(e){ note('FAIL ' + step[0] + ' :: ' + (e && e.message || e)); done(); });
    } else { note('OK  ' + step[0]); done(); }
  } catch (e) { note('FAIL ' + step[0] + ' :: ' + (e && e.message || e)); done(); }
}
var steps = seq.length;
function finish(){
  if (document.getElementById('SMOKE')) return;      /* 幂等：看门狗和正常收尾都会调 */
  var out = { log: LOG, errors: window.__ERR };
  /* 冒烟测试里把网络全部短路：不然任何一个没回来的请求都会让
   --virtual-time-budget 卡死（虚拟时间会停在待处理的请求上） */
(function () {
  var origFetch = window.fetch;
  window.fetch = function (url, opt) {
    var u = String(url);
    if (u.indexOf('/chat/completions') >= 0 || u.indexOf('/messages') >= 0) {
      var body = '{"choices":[{"message":{"role":"assistant","content":"嗯，我在。"}}]}';
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (u.indexOf('/qq/bridge/') >= 0 || u.indexOf('qqhealth.json') >= 0) {
      return Promise.resolve(new Response('{"ok":true,"items":[],"connected":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return origFetch.apply(window, arguments);
  };
})();

var pre = document.createElement('pre');
  pre.id = 'SMOKE';
  pre.textContent = 'SMOKESTART' + JSON.stringify(out) + 'SMOKEEND';
  document.body.appendChild(pre);
}

/* ⚠️ 看门狗。某一步要是返回了一个永远不 resolve 的 promise，
   整条链就停在那儿，最后连一行输出都没有 —— 看起来像"页面没启动"，
   其实只是某一步噎住了。到点无论如何把已跑到的结果吐出来。
   ⚠️ 这个数必须明显小于下面的 --virtual-time-budget，否则会变成
      "预算先耗尽、看门狗还没来得及报"，那就又看不到任何信息了。 */
setTimeout(function () {
  if (document.getElementById('SMOKE')) return;
  note('!! 看门狗触发：卡在第 ' + (i + 1) + ' 步「' + (seq[i] ? seq[i][0] : '收尾') + '」，已完成 ' + i + '/' + steps + ' 步');
  finish();
}, 120000);

setTimeout(next, 900);
</script>
"""


def main():
    edge = find_edge()
    html = open(APP, encoding="utf-8").read()
    state = demo_state()
    # 缩短超时，别让"测试连接"卡太久
    state["settings"]["timeout"] = 8

    if os.path.isdir(TMP):
        shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP)
    fn = "smoke.html"
    page = build_page(html, state, "persona", None)
    page = page.replace("<body>", "<body>\n" + SCRIPT, 1).replace("</body>", STEPS + "</body>", 1)
    with open(os.path.join(TMP, fn), "w", encoding="utf-8") as f:
        f.write(page)

    srv, port = serve(TMP)
    profile = tempfile.mkdtemp(prefix="xinzhen-smoke-")
    try:
        cmd = [
            edge, "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--user-data-dir=" + profile,
            "--window-size=1440,940", "--virtual-time-budget=150000",
            "--dump-dom", "http://127.0.0.1:%d/%s?smoke=1" % (port, fn),
        ]
        r = subprocess.run(cmd, capture_output=True, timeout=420)
        dom = r.stdout.decode("utf-8", "ignore")
        found = re.findall(r"SMOKESTART(.*?)SMOKEEND", dom, re.S)
        if not found:
            print("没取到结果")
            print(dom[-1500:])
            return
        d = json.loads(html_mod.unescape(found[-1]))
        print("── 步骤 ─────────────────────────────────────────")
        for line in d["log"]:
            print("  " + line)
        print("\n── 运行时报错 ────────────────────────────────")
        if d["errors"]:
            for e in d["errors"]:
                print("  !! " + e)
        else:
            print("  无")
    finally:
        srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
