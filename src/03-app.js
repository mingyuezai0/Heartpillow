/* ==========================================================================
   心枕 · XinZhen — 应用逻辑（单文件版，无任何外部依赖）
   ========================================================================== */
(function () {
  'use strict';

  var VERSION = '1.0.4';
  /* 自动化冒烟测试时带上 ?smoke=1：关掉常驻定时器，避免测试卡在虚拟时间上 */
  var XZ_SMOKE = /[?&]smoke=1/.test(location.search);

  /* 每个 AI 角色一份独立数据（连设置也分开）。
     全局只留：角色花名册、当前角色、开屏用的主题镜像、上次停留的页面。 */
  var SUB_KEYS = ['settings', 'persona', 'me', 'assets', 'memory', 'chat', 'vitals', 'link', 'roster', 'memes', 'qq', 'plans', 'diary'];
  var G = {
    characters: 'xinzhen.v1.characters',
    active:     'xinzhen.v1.active',
    theme:      'xinzhen.v1.theme',
    lastPage:   'xinzhen.v1.lastPage'
  };
  /* K 会随着切换角色被重新指向，所以各处引用 K.xxx 都会自动跟着走 */
  var K = {};
  var activeId = '';
  var characters = [];

  function setActiveKeys(cid) {
    activeId = cid;
    SUB_KEYS.forEach(function (s) { K[s] = 'xinzhen.v1.c.' + cid + '.' + s; });
  }
  function legacyKey(s) { return 'xinzhen.v1.' + s; }
  function allDataKeys() {
    var out = [];
    characters.forEach(function (c) {
      SUB_KEYS.forEach(function (s) { out.push('xinzhen.v1.c.' + c.id + '.' + s); });
    });
    SUB_KEYS.forEach(function (s) { out.push(legacyKey(s)); });
    Object.keys(G).forEach(function (k) { out.push(G[k]); });
    return out;
  }

  /* ------------------------------------------------------------------ 工具 */
  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }
  function setText(sel, v) {
    var e = $(sel);
    if (e && e.textContent !== String(v == null ? '' : v)) e.textContent = v == null ? '' : v;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function fileSize(n) { return bytes(n); }
  function timeText(ts) {
    var d = new Date(ts), now = new Date();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (d.toDateString() === now.toDateString()) return hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }
  function debounce(fn, ms) {
    var t = null;
    var wrapped = function () {
      var a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, a); }, ms);
    };
    /* 页面要走了就立刻落盘，别让防抖把最后一次改动吞掉 */
    wrapped.flush = function () {
      if (t == null) return;
      clearTimeout(t);
      t = null;
      fn();
    };
    return wrapped;
  }

  /* -------------------------------------------------------------- 默认状态 */
  function defaultSettings() {
    return {
    injMemes: true,
      baseUrl: '', apiKey: '', model: '',
      temperature: 0.9, maxChars: 400, timeout: 90, stream: true, extraSystem: '',
      injKey: true, injLight: true, injKeywords: true, injStickers: true, injMemes: true, injAutoMem: true,
      lightCount: 6, ctxTurns: 14,
      stickerAuto: true, stickerChance: 35,
    ctxLen: '',
      enterSend: true, timestamps: true, typewriter: true, splitMessages: true,
      theme: 'light', font: 'normal', motion: 'full'
    };
  }
  function defaultPersona() {
    return {
      name: '', call: '', identity: '', text: '', tags: [], catchphrase: '', greeting: '',
      temper: 50, talky: 45, active: 50, sweet: 55,
      speech: { style: '', likes: [], avoids: [], notes: '' }
    };
  }

  /* 说话偏向的预设 —— 选了就把这段描述写进提示词 */
  var SPEECH_STYLES = [
    { id: '', label: '不限', text: '' },
    { id: 'daily', label: '日常口语', text: '日常口语，想到什么说什么，允许不完整和不严谨' },
    { id: 'literary', label: '温柔文艺', text: '温柔文艺，用词讲究一点，偶尔有画面感，但不要堆砌辞藻' },
    { id: 'blunt', label: '直率利落', text: '直率利落，句子短，少用修饰，不绕弯子' },
    { id: 'classic', label: '古风雅致', text: '偏古风雅致，用词典雅，但不生僻、不拗口' },
    { id: 'meme', label: '网络感强', text: '网络感强，会用流行说法和梗，语气轻快' },
    { id: 'shy', label: '轻声慢语', text: '轻声慢语，句子短而软，常用省略号和语气词' }
  ];

  function defaultAssets() { return { portrait: '', avatar: '', stickers: [] }; }
  function defaultMemory() { return { key: [], light: [], keywords: [] }; }
  function defaultChat() { return { messages: [] }; }
  function defaultVitals() { return { bpm: REST_BPM, mood: '平静', ts: Date.now(), moodUntil: 0 }; }
  /* 外接（B站）的按角色状态：这一页的设置 + 历史日报。
     ⚠️ 每个角色各刷各的 —— 她用自己的语气挑视频、写日报，换角色就换一份。 */
  function defaultLink() {
    return {
      keywords: [],
      dailyCount: 3,
      reportLevel: 'full',      /* full | thin | none */
      autoComment: false,
      commentTarget: '',
      commentMax: 1,
      commentEvery: 1,
      autoMode: 'manual',
      autoEvery: 6,
      autoFrom: 9,
      autoTo: 23,
      valleyAuto: false,
      valleyNoon: true,
      valleyNight: true,
      lastRunAt: 0,
      lastRunDay: '',
      lastTryAt: 0,
      reports: [],
      dmReply: { white: true, none: false, black: false },
      feed: [],
      activity: { now: '', at: 0, items: [] }
    };
  }
  function defaultRoster() {
    return {
      bili: { people: [], master: null },
      qq: { people: [], master: null }
    };
  }
  function defaultMemes() { return { items: [] }; }
function defaultPlans() { return { items: [] }; }
function defaultDiary() { return { items: [] }; }
  function defaultQq() {
    return {
      apiBase: 'http://127.0.0.1:3000',
      wsUrl: 'ws://127.0.0.1:3001',
      token: '',
      autoReply: { white: true, none: false, black: false },
      groupAt: false,
      cooldownSec: 8,
      maxChars: 120,
      splitMin: 1,
      splitMax: 3,
      splitGap: 0.6,
      splitWhiteOnly: true,
      seeImages: true,
      catchUp: true,
      catchReplyMin: 30,
      tracked: {},
      bridgeSince: 0,
      bridgeAuto: true,
      firstWait: 6,
      burstMax: 5,
      proactive: {
        on: false, targets: 'master', idleHours: 3, gapMin: 120, dailyMax: 3,
        quietFrom: 0, quietTo: 8, hint: ''
      },
      proLog: { day: '', count: 0, lastAt: 0 },
      collectStickers: true,
      stickerSeen: {},
      stickerDone: {},
      me: { uid: 0, name: '' },
      sessions: [],
      lastAt: 0
    };
  }
  /* 把「哪份状态用什么默认值」集中在一处。
     ⚠️ 加 SUB_KEYS 时只要往这里补一行就够了 —— 之前 loadAll / importData /
        snapshot 各写一份硬编码清单，加一个 key 要改三处，漏一处就是静默丢数据。 */
  var STATE_DEFAULTS = {
    settings: defaultSettings, persona: defaultPersona, me: defaultMe,
    assets: defaultAssets, memory: defaultMemory, chat: defaultChat,
    vitals: defaultVitals, link: defaultLink, roster: defaultRoster, memes: defaultMemes,
    qq: defaultQq, plans: defaultPlans, diary: defaultDiary
  };
  function defaultMe() { return { avatar: '', name: '', text: '' }; }
  function defaultPersona() {
    return {
      name: '', call: '', identity: '', text: '', tags: [], catchphrase: '', greeting: '',
      temper: 50, talky: 45, active: 50, sweet: 55,
      speech: { style: '', likes: [], avoids: [], notes: '' }
    };
  }

  /* 表情可以挂的情绪 —— 她在这个情绪上有概率把它发出去 */
  var EMOTIONS = ['开心', '疑惑', '害羞', '生气', '难过', '困了', '亲亲',
    '得意', '委屈', '惊讶', '无奈', '撒娇', '平静'];

  /* 心情 → 心跳。静息 72，越激动跳得越快，之后慢慢回落 */
  var REST_BPM = 72;
  var MAX_PARTS = 5;   /* 一次回复最多拆成几条短消息 */
  var EMOTION_BPM = {
    开心: 100, 疑惑: 88, 害羞: 120, 生气: 110, 难过: 74, 困了: 58, 亲亲: 132,
    得意: 92, 委屈: 96, 惊讶: 118, 无奈: 76, 撒娇: 108, 平静: 72
  };

  /* 她忘了标情绪时，从文字里猜一个 —— 保证该有波动的地方真的有波动 */
  var EMOTION_RULES = [
    ['亲亲', /(抱抱|亲亲|么么|想你|喜欢你|爱你|贴贴|蹭蹭|抱一下)/],
    ['害羞', /(害羞|脸红|别、别|才不是|讨厌啦|羞死|不好意思)/],
    ['生气', /(哼[！!。]|生气|不理你|过分|烦人|气死|讨厌死了)/],
    ['委屈', /(委屈|对不起|抱歉|别生气|我错了|呜呜|是我不好)/],
    ['惊讶', /(居然|竟然|真的假的|不会吧|天呐|天哪|吓我一跳)/],
    ['难过', /(难过|不开心|失落|想哭|伤心|有点低落|emo)/],
    ['困了', /(好困|困了|睡觉|晚安|睡了|打哈欠|熬不住|我先睡)/],
    ['疑惑', /(咦|诶\?|嗯\?|疑惑|不懂|什么意思|为啥|怎么会|奇怪)/],
    ['开心', /(哈哈|嘿嘿|开心|高兴|太好|好耶|笑死|嘻嘻|愉快)/],
    ['撒娇', /(好不好嘛|求求你|陪我|要嘛|嘛～|嘛~)/],
    ['得意', /(厉害吧|那可不|哼哼|我可是|当然啦)/],
    ['无奈', /(算了|随便吧|无所谓|唉|服了|行吧|没办法)/]
  ];
  function guessEmotion(text) {
    var t = String(text == null ? '' : text);
    if (!t) return null;
    for (var i = 0; i < EMOTION_RULES.length; i++) {
      if (EMOTION_RULES[i][1].test(t)) return EMOTION_RULES[i][0];
    }
    return null;
  }
  /* 你带着情绪说话时，她的反应 */
  var REACT = { 亲亲: '害羞', 撒娇: '害羞', 生气: '委屈', 难过: '难过', 困了: '困了', 疑惑: '疑惑', 开心: '开心', 惊讶: '惊讶' };

  var settings = defaultSettings();
  var persona  = defaultPersona();
  var assets   = defaultAssets();
  var memory   = defaultMemory();
  var chat     = defaultChat();
  var vitals   = defaultVitals();
  var link     = defaultLink();
  var roster   = defaultRoster();
  var memes    = defaultMemes();
var plans    = defaultPlans();
var diary    = defaultDiary();
  var qq       = defaultQq();
  var me       = defaultMe();

  /* 写入排队：保证顺序，也让切换角色前能等一下写完 */
  var writeChain = Promise.resolve();
  function enqueueWrite(fn) {
    writeChain = writeChain.then(fn, fn).catch(function () { });
    return writeChain;
  }

  /* ------------------------------------------------------------ 角色管理 */
  function charName(c) {
    var found = characters.filter(function (x) { return x.id === c; })[0];
    return found ? found.name : '角色';
  }
  function touchCharacter(cid, name) {
    characters.forEach(function (c) {
      if (c.id !== cid) return;
      if (name != null) c.name = name;
      c.updatedAt = Date.now();
    });
  }
  function saveRoster() {
    return enqueueWrite(function () {
      return Store.write(G.characters, JSON.stringify(characters))
        .then(function () { return Store.write(G.active, JSON.stringify(activeId)); });
    });
  }

  /* 第一次跑新版本：把老的单角色数据搬成一个角色 */
  async function migrateToCharacters() {
    var existing = parseRaw(await Store.read(G.characters), null);
    if (existing && Array.isArray(existing) && existing.length) {
      characters = existing;
      activeId = parseRaw(await Store.read(G.active), '') || existing[0].id;
      if (!characters.filter(function (c) { return c.id === activeId; }).length) activeId = characters[0].id;
      setActiveKeys(activeId);
      return;
    }

    var hasOld = false;
    for (var i = 0; i < SUB_KEYS.length; i++) {
      if (await Store.read(legacyKey(SUB_KEYS[i])) != null) { hasOld = true; break; }
    }

    var cid = 'c' + uid();
    var name = '我的角色';
    if (hasOld) {
      var oldPersona = parseRaw(await Store.read(legacyKey('persona')), {});
      if (oldPersona && oldPersona.name) name = oldPersona.name;
      for (var j = 0; j < SUB_KEYS.length; j++) {
        var s = SUB_KEYS[j];
        var raw = await Store.read(legacyKey(s));
        if (raw != null) {
          await Store.write('xinzhen.v1.c.' + cid + '.' + s, raw);
          await Store.remove(legacyKey(s));
        }
      }
    }
    characters = [{ id: cid, name: name, createdAt: Date.now(), updatedAt: Date.now() }];
    setActiveKeys(cid);
    await saveRoster();
  }

  async function switchCharacter(cid) {
    if (!cid || cid === activeId) return;
    if (!characters.filter(function (c) { return c.id === cid; }).length) return;
    flushSaves();
    await writeChain;                       /* 等当前角色的数据写完再走 */
    pruneChat();
    await save(K.chat, chat);
    setActiveKeys(cid);
    await Store.write(G.active, JSON.stringify(cid));
    await loadAll();
    applyAppearance();
    fillPersonaForm();
    fillSettingsForm();
    refreshSliders();
    renderMemory(); renderStickers(); renderMe(); renderLink(); renderRoster('bili'); renderRoster('qq'); renderMemes(); renderQq(); renderDmCard(); renderActivity();
    renderChat(true); renderStorage(); renderVitals();
    renderCharButton();
    toast('已切换到「' + charName(cid) + '」');
  }

  async function createCharacter(name) {
    flushSaves();
    await writeChain;
    pruneChat();
    await save(K.chat, chat);

    var cid = 'c' + uid();
    var nm = (name || '').trim() || ('角色 ' + (characters.length + 1));

    /* 接口这类账号级配置带过去，省得每个角色都重填一遍 */
    var carry = {
      settings: Object.assign(defaultSettings(), {
        baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model,
        theme: settings.theme, font: settings.font, motion: settings.motion
      }),
      persona: defaultPersona(), me: defaultMe(), assets: defaultAssets(),
      memory: defaultMemory(), chat: defaultChat(), vitals: defaultVitals()
    };
    setActiveKeys(cid);
    characters.push({ id: cid, name: nm, createdAt: Date.now(), updatedAt: Date.now() });
    applyData(carry);
    await saveAll();
    await saveRoster();

    applyAppearance();
    fillPersonaForm(); fillSettingsForm(); refreshSliders();
    renderMemory(); renderStickers(); renderMe(); renderLink(); renderRoster('bili'); renderRoster('qq'); renderMemes(); renderDmCard(); renderActivity();
    renderChat(true); renderStorage(); renderVitals();
    renderCharButton();
    toast('建好了「' + nm + '」，接口沿用上一个角色，其他都是新的');
  }

  async function deleteCharacter(cid) {
    if (characters.length <= 1) {
      toast('至少得留一个角色', 'warm');
      return;
    }
    var idx = -1;
    characters.forEach(function (c, i) { if (c.id === cid) idx = i; });
    if (idx < 0) return;

    var leavingActive = (cid === activeId);
    if (!leavingActive) {
      characters.splice(idx, 1);
      for (var i = 0; i < SUB_KEYS.length; i++) await Store.remove('xinzhen.v1.c.' + cid + '.' + SUB_KEYS[i]);
      await saveRoster();
      closeCharPop();
      toast('已删除');
      return;
    }

    /* 删的是当前角色：先把待写数据落盘，再换到另一个 */
    flushSaves();
    await writeChain;
    characters.splice(idx, 1);
    for (var j = 0; j < SUB_KEYS.length; j++) await Store.remove('xinzhen.v1.c.' + cid + '.' + SUB_KEYS[j]);
    var next = characters[Math.min(idx, characters.length - 1)];
    setActiveKeys(next.id);
    await saveRoster();
    await loadAll();
    applyAppearance();
    fillPersonaForm(); fillSettingsForm(); refreshSliders();
    renderMemory(); renderStickers(); renderMe(); renderLink(); renderRoster('bili'); renderRoster('qq'); renderMemes(); renderDmCard(); renderActivity();
    renderChat(true); renderStorage(); renderVitals();
    renderCharButton();
    toast('已删除，切到「' + next.name + '」');
  }

  /* ------------------------------------------------------------ 数据读写 */
  function parseRaw(raw, fallback) {
    if (!raw) return fallback;
    try {
      var v = JSON.parse(raw);
      return (v && typeof v === 'object') ? v : fallback;
    } catch (e) { console.warn('[心枕] 解析失败', e); return fallback; }
  }
  function jsonBytes(v) {
    try { return new Blob([JSON.stringify(v)]).size; } catch (e) { return 0; }
  }

  async function loadAll() {
    var d = {};
    for (var i = 0; i < SUB_KEYS.length; i++) {
      var s = SUB_KEYS[i];
      d[s] = parseRaw(await Store.read(K[s]), {});
    }
    applyData(d);
  }

  function applyData(d) {
    settings = Object.assign(defaultSettings(), d.settings || {});
    persona  = Object.assign(defaultPersona(),  d.persona || {});
    /* 全新用户：直接是基础模板那套人设 */
    if (!XZ_SMOKE && !persona.name && !persona.text) persona = Object.assign(defaultPersona(), clonePersona(BASE_PERSONA));
    me       = Object.assign(defaultMe(),       d.me || {});
    assets   = Object.assign(defaultAssets(),   d.assets || {});
    memory   = Object.assign(defaultMemory(),   d.memory || {});
    chat     = Object.assign(defaultChat(),     d.chat || {});
    vitals   = Object.assign(defaultVitals(),   d.vitals || {});
    /* link 要**深一层**合并：老存档没有 link；新存档的 link 也可能少了某个字段 */
    var dl = defaultLink();
    var il = d.link || {};
    link = Object.assign(dl, il);
    if (!Array.isArray(link.keywords)) link.keywords = [];
    if (!Array.isArray(link.reports)) link.reports = [];
    link.dailyCount = clamp(Number(link.dailyCount) || 0, 0, 20);
    link.commentMax = clamp(Number(link.commentMax) || 1, 1, 20);
    if (!Array.isArray(link.feed)) link.feed = [];
    /* 一次性清理：老版本的行为记录没有平台标记，混进过 QQ 的行为 */
    if (!link.activityMig2) {
      if (link.activity && Array.isArray(link.activity.items)) {
        link.activity.items = link.activity.items.filter(function (x) { return x && x.plat; });
        link.activity.now = '';
        link.activity.at = 0;
      }
      link.activityMig2 = 1;
    }
    link.commentEvery = [0, 1, 2].indexOf(Number(link.commentEvery)) >= 0 ? Number(link.commentEvery) : 1;
    link.autoEvery = clamp(Number(link.autoEvery) || 6, 1, 24);
    link.autoFrom = clamp(Number(link.autoFrom) || 0, 0, 23);
    link.autoTo = clamp(Number(link.autoTo) || 0, 0, 23);
    if (link.autoFrom === link.autoTo) link.autoTo = (link.autoFrom + 1) % 24;
    link.autoMode = link.autoMode === 'auto' ? 'auto' : 'manual';
    if (link.valleyAuto === true) link.autoMode = 'auto';   /* 老存档：原来开的是谷时自动刷 */
    delete link.valleyAuto; delete link.valleyNoon; delete link.valleyNight;
    if (!link.activity || typeof link.activity !== 'object') link.activity = { now: '', at: 0, items: [] };
    if (!link.dmReply || typeof link.dmReply !== 'object') link.dmReply = { white: true, none: false, black: false };
    if (link.dmAuto === true) link.dmReply.white = true;   /* 老存档：原来是「只回白名单」 */
    delete link.dmAuto;
    link.dmReply = {
      white: link.dmReply.white !== false,
      none: link.dmReply.none === true,
      black: link.dmReply.black === true
    };

    var dr = defaultRoster();
    roster = Object.assign(dr, d.roster || {});
    /* 老存档是扁平的 { people, master }，挪到 bili 那一份里 */
    if (Array.isArray(d.roster && d.roster.people)) {
      roster.bili = { people: d.roster.people, master: d.roster.master || null };
    }
    delete roster.people;
    delete roster.master;
    ['bili', 'qq'].forEach(function (plat) {
      var r = roster[plat] || (roster[plat] = { people: [], master: null });
      if (!Array.isArray(r.people)) r.people = [];
      if (r.master && !Number(r.master.uid)) r.master = null;
      if (r.master) {
        r.master.uid = Number(r.master.uid) || 0;
        r.master.uname = String(r.master.uname || '');
        r.master.face = String(r.master.face || '');
      }
      r.people.forEach(function (pp, i) {
        pp.uid = Number(pp.uid) || 0;
        pp.affinity = clamp(Math.round(Number(pp.affinity) || 0), 0, 100);
        if (['white', 'black', 'none'].indexOf(pp.list) < 0) pp.list = 'none';
        if (!pp.id) pp.id = 'p' + i + '_' + pp.uid;
      });
    });

    var dm = defaultMemes();
    memes = Object.assign(dm, d.memes || {});
    if (!Array.isArray(memes.items)) memes.items = [];

    plans = Object.assign(defaultPlans(), d.plans || {});
    if (!Array.isArray(plans.items)) plans.items = [];

    diary = Object.assign(defaultDiary(), d.diary || {});
    if (!Array.isArray(diary.items)) diary.items = [];
    diary.items = diary.items.filter(function (x) { return x && x.text; }).map(function (x) {
      return { id: x.id || ('dy' + Math.random().toString(36).slice(2, 8)), date: x.date || '', text: String(x.text), ts: Number(x.ts) || Date.now(), by: x.by || 'ai' };
    });
    plans.items = plans.items.filter(function (x) { return x && x.text; }).map(function (x) {
      return {
        id: x.id || ('pl' + Math.random().toString(36).slice(2, 8)),
        text: String(x.text),
        due: x.due || '',
        done: !!x.done,
        doneAt: Number(x.doneAt) || 0,
        ts: Number(x.ts) || Date.now(),
        by: x.by || 'ai'
      };
    });

    qq = Object.assign(defaultQq(), d.qq || {});
    qq.apiBase = String(qq.apiBase || 'http://127.0.0.1:3000').trim();
    qq.wsUrl = String(qq.wsUrl == null ? 'ws://127.0.0.1:3001' : qq.wsUrl).trim();
    qq.token = String(qq.token || '');
    qq.cooldownSec = clamp(Number(qq.cooldownSec) || 0, 0, 600);
    qq.maxChars = clamp(Number(qq.maxChars) || 120, 20, 500);
    qq.splitMin = clamp(Math.round(Number(qq.splitMin) || 1), 1, 5);
    qq.splitMax = clamp(Math.round(Number(qq.splitMax) || 3), 1, 5);
    if (qq.splitMax < qq.splitMin) qq.splitMax = qq.splitMin;
    qq.seeImages = qq.seeImages !== false;
    qq.catchUp = qq.catchUp !== false;
    if (!qq.tracked || typeof qq.tracked !== 'object' || Array.isArray(qq.tracked)) qq.tracked = {};
    qq.bridgeSince = Number(qq.bridgeSince) || 0;
    qq.bridgeAuto = qq.bridgeAuto !== false;
    qq.firstWait = (qq.firstWait == null || qq.firstWait === '')
      ? 6
      : Math.max(0, Math.min(30, Number(qq.firstWait) || 0));
    qq.burstMax = Math.max(2, Math.min(9, Number(qq.burstMax) || 5));
    if (!qq.proactive || typeof qq.proactive !== 'object') {
      qq.proactive = { on: false, targets: 'master', idleHours: 3, gapMin: 120, dailyMax: 3, quietFrom: 0, quietTo: 8, hint: '' };
    }
    var _pr = qq.proactive;
    _pr.on = !!_pr.on;
    _pr.targets = ['master', 'white', 'all'].indexOf(_pr.targets) >= 0 ? _pr.targets : 'master';
    _pr.idleHours = clamp(Number(_pr.idleHours) || 3, 1, 72);
    _pr.gapMin = clamp(Number(_pr.gapMin) || 120, 10, 1440);
    _pr.dailyMax = clamp(Number(_pr.dailyMax) || 3, 1, 20);
    _pr.quietFrom = clamp(Math.round(Number(_pr.quietFrom) || 0), 0, 23);
    _pr.quietTo = clamp(Math.round(Number(_pr.quietTo) || 0), 0, 23);
    _pr.hint = String(_pr.hint || '').slice(0, 60);
    if (!qq.proLog || typeof qq.proLog !== 'object') qq.proLog = { day: '', count: 0, lastAt: 0 };
    if (!Array.isArray(qq.seenIds)) qq.seenIds = [];
    qq.collectStickers = qq.collectStickers !== false;
    if (!qq.stickerSeen || typeof qq.stickerSeen !== 'object' || Array.isArray(qq.stickerSeen)) qq.stickerSeen = {};
    if (!qq.stickerDone || typeof qq.stickerDone !== 'object' || Array.isArray(qq.stickerDone)) qq.stickerDone = {};
    qq.splitGap = clamp(Number(qq.splitGap) || 0.6, 0.2, 2);
    qq.splitWhiteOnly = qq.splitWhiteOnly !== false;
    if (!qq.autoReply || typeof qq.autoReply !== 'object') qq.autoReply = { white: true, none: false, black: false };
    qq.autoReply = { white: qq.autoReply.white !== false, none: qq.autoReply.none === true, black: qq.autoReply.black === true };
    if (!qqBridge() && /^https?:$/.test(location.protocol)) {
      if (!qq.apiBase || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(qq.apiBase)) qq.apiBase = '/qq/api';
      if (/^wss?:\/\/(127\.0\.0\.1|localhost)/.test(qq.wsUrl || '')) qq.wsUrl = '';
    }
    if (!Array.isArray(qq.sessions)) qq.sessions = [];
    if (!qq.me || typeof qq.me !== 'object') qq.me = { uid: 0, name: '' };

    if (!persona.speech || typeof persona.speech !== 'object') persona.speech = { style: '', likes: [], avoids: [], notes: '' };
    if (!Array.isArray(persona.speech.likes)) persona.speech.likes = [];
    if (!Array.isArray(persona.speech.avoids)) persona.speech.avoids = [];
    if (!Array.isArray(persona.tags)) persona.tags = [];
    if (!Array.isArray(assets.stickers)) assets.stickers = [];
    if (!Array.isArray(memory.key)) memory.key = [];
    if (!Array.isArray(memory.light)) memory.light = [];
    if (!Array.isArray(memory.keywords)) memory.keywords = [];
    if (!Array.isArray(chat.messages)) chat.messages = [];

    /* —— 老版本数据迁移 —— */
    if (settings.maxChars == null) {
      settings.maxChars = clamp(Math.round((Number(settings.maxTokens) || 1024) * 0.8), 50, 4000);
      delete settings.maxTokens;
    }
    assets.stickers.forEach(function (s) {
      if (!s.emotion || EMOTIONS.indexOf(s.emotion) < 0) s.emotion = '开心';
    });
  }

  function snapshot() {
    return { settings: settings, persona: persona, me: me, assets: assets,
             memory: memory, chat: chat, vitals: vitals, link: link,
             roster: roster, memes: memes, qq: qq };
  }

  function save(key, value) {
    var raw = JSON.stringify(value);
    return enqueueWrite(function () { return Store.write(key, raw); });
  }
  function saveAll(d) {
    d = d || snapshot();
    return Promise.all(SUB_KEYS.map(function (s) { return save(K[s], d[s]); }));
  }

  var saveSettings = debounce(function () { save(K.settings, settings); }, 220);
  var savePersona  = debounce(function () { save(K.persona, persona); }, 260);
  var saveAssets   = debounce(function () { save(K.assets, assets); }, 200);
  var saveMemory   = debounce(function () { save(K.memory, memory); }, 200);
  var saveMe       = debounce(function () { save(K.me, me); }, 240);
  var saveChat     = debounce(function () { pruneChat(); save(K.chat, chat); renderStorage(); }, 320);
  var saveVitals   = debounce(function () { save(K.vitals, vitals); }, 800);
  var saveLink     = debounce(function () { save(K.link, link); }, 300);
  var savePeople   = debounce(function () { save(K.roster, roster); }, 260);
  var saveMemes    = debounce(function () { save(K.memes, memes); }, 260);
  var savePlans    = debounce(function () { save(K.plans, plans); }, 260);
  var saveDiary    = debounce(function () { save(K.diary, diary); }, 260);
  var saveQq       = debounce(function () { save(K.qq, qq); }, 260);

  function totalBytes() {
    return jsonBytes(settings) + jsonBytes(persona) + jsonBytes(me) + jsonBytes(assets) +
      jsonBytes(memory) + jsonBytes(chat) + jsonBytes(vitals) + jsonBytes(link) +
      jsonBytes(roster) + jsonBytes(memes) + jsonBytes(qq) + jsonBytes(plans) + jsonBytes(diary);
  }

  /* 空间吃紧时，从最旧的聊天图片开始丢弃（只丢图片本体，保留文件名） */
  function pruneChat() {
    var LIMIT = Store.mode === 'idb' ? 48 * 1024 * 1024 : 2.4 * 1024 * 1024;
    function size() { return jsonBytes(chat); }
    if (size() <= LIMIT) return;
    for (var i = 0; i < chat.messages.length && size() > LIMIT; i++) {
      var m = chat.messages[i];
      if (!m.atts) continue;
      for (var j = 0; j < m.atts.length; j++) {
        var a = m.atts[j];
        if (a.data) { delete a.data; a.dropped = true; }
      }
    }
  }

  /* -------------------------------------------------------------- 存储层
     localStorage 每个源只有约 5MB，图片一多就满。所以：
       · 浏览器允许用 IndexedDB 时（http/localhost/打包后）走数据库，容量按 GB 算；
       · file:// 直开时 Chrome/Edge 不给 IndexedDB（open 回调永远不触发），
         自动退回 localStorage，并把图片压得更小，让 5MB 尽量经用。
     模式记在 localStorage 的一个小键里，避免每次启动都去等探测超时。
  ---------------------------------------------------------------------- */
  var MODE_KEY = 'xinzhen.v1.storageMode';
  var IDB_NAME = 'xinzhen-db';
  var IDB_STORE = 'kv';

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, raw) {
    try { localStorage.setItem(key, raw); return true; }
    catch (e) { return false; }
  }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { } }

  function idbOpen(timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs || 2500);
      var req;
      try { req = indexedDB.open(IDB_NAME, 1); }
      catch (e) { clearTimeout(timer); settled = true; resolve(null); return; }
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function (e) {
        if (settled) { try { e.target.result.close(); } catch (x) { } return; }
        settled = true; clearTimeout(timer);
        resolve(e.target.result);
      };
      req.onerror = function () { if (settled) return; settled = true; clearTimeout(timer); resolve(null); };
      req.onblocked = function () { if (settled) return; settled = true; clearTimeout(timer); resolve(null); };
    });
  }
  function idbGet(db, key) {
    return new Promise(function (resolve, reject) {
      var tx;
      try { tx = db.transaction(IDB_STORE, 'readonly'); } catch (e) { reject(e); return; }
      var r = tx.objectStore(IDB_STORE).get(key);
      r.onsuccess = function () { resolve(r.result == null ? null : r.result); };
      r.onerror = function () { reject(r.error || new Error('读取失败')); };
    });
  }
  function idbPut(db, key, value) {
    return new Promise(function (resolve, reject) {
      var tx;
      try { tx = db.transaction(IDB_STORE, 'readwrite'); } catch (e) { reject(e); return; }
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error || new Error('写入失败')); };
      tx.onabort = function () { reject(tx.error || new Error('写入中止')); };
    });
  }
  function idbDel(db, key) {
    return new Promise(function (resolve) {
      var tx;
      try { tx = db.transaction(IDB_STORE, 'readwrite'); } catch (e) { resolve(false); return; }
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { resolve(false); };
    });
  }

  var Store = {
    mode: 'ls',
    db: null,
    note: '',

    capBytes: function () {
      if (this.mode === 'idb') return Number(this.quota) || 0;
      return 5 * 1024 * 1024;
    },

    /* 启动时定模式：记得上次是数据库就直接连，否则用 localStorage 秒开 */
    init: async function () {
      var remembered = '';
      try { remembered = JSON.parse(lsGet(MODE_KEY) || '""'); } catch (e) { }
      if (remembered === 'idb') {
        var db = await idbOpen(2500);
        if (db) {
          try {
            await idbPut(db, '__probe', '1');
            var v = await idbGet(db, '__probe');
            if (v === '1') { this.db = db; this.mode = 'idb'; this.remember('idb'); return; }
            throw new Error('自检没通过');
          } catch (e) {
            try { db.close(); } catch (x) { }
            this.note = '数据库连不上，已退回小容量模式';
          }
        } else {
          this.note = '数据库打不开，已退回小容量模式';
        }
        this.remember('ls');
      } else if (!remembered) {
        /* 第一次跑，先按 localStorage 走，稍后在后台试着升级 */
      }
    },

    remember: function (mode) {
      try { lsSet(MODE_KEY, JSON.stringify(mode)); } catch (e) { }
    },

    /* 后台尝试升级到 IndexedDB，成功就把已有数据整体搬过去 */
    upgrade: async function () {
      if (this.mode === 'idb' || this.db) return false;
      var db = await idbOpen(2500);
      if (!db) {
        this.note = '浏览器没有及时给出数据库，继续用小容量存储';
        this.remember('ls');
        return false;
      }
      try {
        await idbPut(db, '__probe', '1');
        var v = await idbGet(db, '__probe');
        if (v !== '1') throw new Error('自检没通过');
      } catch (e) {
        this.note = '数据库自检没通过，继续用小容量模式';
        try { db.close(); } catch (x) { }
        this.remember('ls');
        return false;
      }
      this.db = db;
      this.mode = 'idb';
      /* 把 localStorage 里的东西搬过去，然后清掉，腾出那 5MB */
      var keys = allDataKeys().concat([MODE_KEY]);
      for (var i = 0; i < keys.length; i++) {
        var raw = lsGet(keys[i]);
        if (raw == null) continue;
        try { await idbPut(db, keys[i], raw); lsDel(keys[i]); } catch (e) { this.note = '搬家时出错：' + (e.message || e); }
      }
      try { await idbPut(db, MODE_KEY, JSON.stringify('idb')); } catch (e) { }
      this.remember('idb');
      this.refreshQuota();
      return true;
    },

    refreshQuota: function () {
      var self = this;
      if (!navigator.storage || !navigator.storage.estimate) return;
      try {
        navigator.storage.estimate().then(function (est) {
          if (est && est.quota) { self.quota = est.quota; self.usage = est.usage; }
          renderStorage();
        }, function () { });
      } catch (e) { }
      /* 顺便申请持久化，免得浏览器自动清理 */
      try { if (navigator.storage.persist) navigator.storage.persist(); } catch (e) { }
    },

    read: async function (key) {
      if (this.mode === 'idb' && this.db) {
        try { return await idbGet(this.db, key); }
        catch (e) { return lsGet(key); }
      }
      return lsGet(key);
    },

    write: async function (key, raw) {
      if (this.mode === 'idb' && this.db) {
        try { await idbPut(this.db, key, raw); return true; }
        catch (e) {
          this.note = '写入数据库失败，这一条退回小容量存储';
          return lsSet(key, raw);
        }
      }
      var ok = lsSet(key, raw);
      if (!ok) {
        toast('存储空间不够了。去「设置 → 数据」导出备份，再清理一些图片；' +
          '或者把心枕放到本地服务器/打包后打开，就能用上大容量存储。', 'warm');
      }
      return ok;
    },

    remove: async function (key) {
      if (this.mode === 'idb' && this.db) { await idbDel(this.db, key); }
      lsDel(key);
    },

    clearAll: async function () {
      var keys = allDataKeys();
      if (this.db) {
        for (var i = 0; i < keys.length; i++) { await idbDel(this.db, keys[i]); }
      }
      keys.forEach(function (k) { lsDel(k); });
      lsDel(MODE_KEY);
    }
  };

  /* 图片压缩档位：大容量模式可以奢侈一点，5MB 模式就省着点 */
  function imgBudget() {
    return Store.mode === 'idb'      ? { portrait: 1600, portraitQ: 0.9, avatar: 640, avatarQ: 0.92, sticker: 400, stickerQ: 0.92, chat: 1400, chatQ: 0.86 }
      : { portrait: 1000, portraitQ: 0.8, avatar: 420, avatarQ: 0.85, sticker: 240, stickerQ: 0.86, chat: 800, chatQ: 0.76 };
  }

  /* ------------------------------------------------------------------ 提示 */
  function toast(msg, kind) {
    var host = $('#toasts');
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' is-' + kind : '');
    var icon = kind === 'warm' ? 'i-info' : 'i-check';
    t.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#' + icon + '"/></svg><span>' + esc(msg) + '</span>';
    host.appendChild(t);
    setTimeout(function () {
      t.classList.add('is-out');
      setTimeout(function () { t.remove(); }, 240);
    }, kind === 'warm' ? 4200 : 2400);
  }

  function copyText(text) {
    var ta = document.createElement('textarea');
    ta.value = String(text || '');
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (!ok) throw new Error('copy failed');
    return true;
  }

  function closeLayer() {
    var l = $('#layer');
    l.innerHTML = '';
    document.removeEventListener('keydown', layerEsc);
  }
  function layerEsc(e) { if (e.key === 'Escape') closeLayer(); }

  function confirmBox(title, text, okLabel, danger) {
    return new Promise(function (resolve) {
      var l = $('#layer');
      l.innerHTML =
        '<div class="confirm"><div class="confirm-box" role="dialog" aria-modal="true">' +
        '<h3 class="confirm-title">' + esc(title) + '</h3>' +
        '<p class="confirm-text">' + esc(text) + '</p>' +
        '<div class="confirm-acts">' +
        '<button class="btn" data-cf="0">再想想</button>' +
        '<button class="btn ' + (danger ? 'btn-warm' : 'btn-primary') + '" data-cf="1">' + esc(okLabel) + '</button>' +
        '</div></div></div>';
      function done(v) { closeLayer(); resolve(v); }
      l.querySelector('[data-cf="0"]').onclick = function () { done(false); };
      l.querySelector('[data-cf="1"]').onclick = function () { done(true); };
      l.querySelector('.confirm').onclick = function (e) { if (e.target === this) done(false); };
      document.addEventListener('keydown', layerEsc);
      l.querySelector('[data-cf="1"]').focus();
    });
  }

  function showText(title, text) {
    var l = $('#layer');
    l.innerHTML =
      '<div class="confirm"><div class="confirm-box" style="max-width:660px" role="dialog" aria-modal="true">' +
      '<h3 class="confirm-title">' + esc(title) + '</h3>' +
      '<textarea class="textarea" readonly style="min-height:44vh;font-size:0.7812rem;line-height:1.7;margin-top:12px">' + esc(text) + '</textarea>' +
      '<div class="confirm-acts">' +
      '<button class="btn" data-copy="1">复制</button>' +
      '<button class="btn btn-primary" data-close="1">知道了</button>' +
      '</div></div></div>';
    l.querySelector('[data-close]').onclick = closeLayer;
    l.querySelector('[data-copy]').onclick = function () {
      var ta = l.querySelector('textarea'); ta.select();
      try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败，手动选一下吧', 'warm'); }
    };
    l.querySelector('.confirm').onclick = function (e) { if (e.target === this) closeLayer(); };
    document.addEventListener('keydown', layerEsc);
  }

  /* 带输入框的弹窗，返回输入的字符串；取消返回 null */
  function promptBox(title, note, placeholder, initial) {
    return new Promise(function (resolve) {
      var l = $('#layer');
      l.innerHTML =
        '<div class="confirm"><div class="confirm-box" role="dialog" aria-modal="true">' +
        '<h3 class="confirm-title">' + esc(title) + '</h3>' +
        (note ? '<p class="confirm-text">' + esc(note) + '</p>' : '') +
        '<input class="input" id="promptInput" type="text" maxlength="24" style="margin-top:14px" placeholder="' +
        esc(placeholder || '') + '" value="' + esc(initial || '') + '">' +
        '<div class="confirm-acts">' +
        '<button class="btn" data-cf="0">取消</button>' +
        '<button class="btn btn-primary" data-cf="1">确定</button>' +
        '</div></div></div>';
      var inp = l.querySelector('#promptInput');
      function done(v) { closeLayer(); resolve(v); }
      l.querySelector('[data-cf="0"]').onclick = function () { done(null); };
      l.querySelector('[data-cf="1"]').onclick = function () { done(inp.value.trim()); };
      l.querySelector('.confirm').onclick = function (e) { if (e.target === this) done(null); };
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); done(inp.value.trim()); }
      });
      document.addEventListener('keydown', layerEsc);
      inp.focus();
      inp.select();
    });
  }

  function lightbox(src) {
    var l = $('#layer');
    l.innerHTML = '<div class="lightbox"><img src="' + src + '" alt="预览"></div>';
    l.querySelector('.lightbox').onclick = closeLayer;
    document.addEventListener('keydown', layerEsc);
  }

  /* -------------------------------------------------------------- 图片处理 */
  function compressImage(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight;
          var scale = Math.min(1, maxSide / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var c = document.createElement('canvas');
          c.width = cw; c.height = ch;
          var ctx = c.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, cw, ch);
          var out;
          try { out = c.toDataURL('image/webp', quality); } catch (e) { out = null; }
          if (!out || out.indexOf('data:image/webp') !== 0) out = c.toDataURL('image/png');
          URL.revokeObjectURL(url);
          resolve(out);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('这张图片读不出来')); };
      img.src = url;
    });
  }

  var TEXT_EXT = ('txt md markdown json jsonl csv tsv log yml yaml xml html htm css scss js mjs cjs ts tsx jsx ' +
    'py java c cpp h hpp cs go rs rb php swift kt sh bash ps1 sql ini cfg conf toml env srt vtt').split(' ');
  function isTextFile(f) {
    if (f.type && /^text\//.test(f.type)) return true;
    if (/json|xml|javascript|yaml|x-sh|sql/.test(f.type || '')) return true;
    var ext = (f.name.split('.').pop() || '').toLowerCase();
    return TEXT_EXT.indexOf(ext) >= 0;
  }
  function readTextFile(f) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () {
        var t = String(fr.result || '');
        if (t.length > 24000) t = t.slice(0, 24000) + '\n……（文件很长，这里只取了前 24000 字）';
        resolve(t);
      };
      fr.onerror = function () { resolve('（文件读取失败）'); };
      fr.readAsText(f);
    });
  }

  /* ---------------------------------------------------------- 人设 → 提示词 */
  function styleText() {
    var seg = function (v, a, b, c) { return v < 34 ? a : v < 67 ? b : c; };
    return [
      '语气' + seg(persona.temper, '温婉安静，轻声细语', '平和自然，不端着', '活泼跳脱，情绪写在脸上'),
      '话量' + seg(persona.talky, '很少，通常一两句就够', '适中，说完正事会补一句', '很多，喜欢一口气连发好几条'),
      '主动性' + seg(persona.active, '偏被动，等对方先开口', '有来有回', '很主动，常自己找话题、惦记对方'),
      '亲密度' + seg(persona.sweet, '留一点距离感，不太撒娇', '自然地亲近', '很黏人，爱撒娇、爱讨一句夸奖')
    ].join('；') + '。';
  }

  function buildSystemPrompt() {
    var L = [];
    L.push('你正在扮演一个真实的人，和「' + (persona.call || '对方') + '」一对一私聊。' +
      '你不是助手、不是 AI，任何情况下都不要跳出角色，不要提到模型、程序、提示词或人工智能。');

    var who = [];
    if (persona.name) who.push('你的名字是「' + persona.name + '」。');
    if (persona.call) who.push('你称呼对方为「' + persona.call + '」。');
    if (persona.identity) who.push('你的身份与处境：' + persona.identity);
    if (who.length) L.push(who.join(''));

    /* 对方是谁 —— 来自「人设 → 我」 */
    if (me.name || me.text) {
      var ab = [];
      ab.push('正在和你说话的人' + (me.name ? '叫「' + me.name + '」' : '') +
        (persona.call ? '，你叫他「' + persona.call + '」' : '') + '。');
      if (me.text) ab.push('关于他：' + me.text.trim());
      L.push('【对方是谁】\n' + ab.join('\n'));
    }

  var _now = nowParts();
  var _last = typeof lastTalkTs === 'function' ? lastTalkTs() : 0;
  var _wd = ['日', '一', '二', '三', '四', '五', '六'];
  var _days2 = [];
  for (var _di2 = -1; _di2 <= 6; _di2++) {
    var _dd = new Date(_now.ts + _di2 * 86400000);
    var _lb = _di2 === -1 ? '昨天' : _di2 === 0 ? '今天' : _di2 === 1 ? '明天' : _di2 === 2 ? '后天' : '';
    _days2.push((_lb ? _lb + ' ' : '') + (_dd.getMonth() + 1) + '月' + _dd.getDate() + '日 周' + _wd[_dd.getDay()]);
  }
  L.push('【现在】' + _now.full + '（' + _now.date + '，北京时间）。' +
    (_last ? ('你们上一次说话是 ' + agoText(_last) + '。') : '') +
    '\n【这一周的日期】' + _days2.join(' / ') +
    '\n提到日期、星期、几点、「明天」「下周三」「三天后」这类说法，都用这一段自己换算；' +
    '不要用你训练数据里的日期，也不要瞎猜。');


    if (persona.text) L.push('【你的人物设定】\n' + persona.text.trim());
    if (persona.tags.length) L.push('【性格关键词】' + persona.tags.join('、'));
    L.push('【说话方式】' + styleText());
    L.push('【别重复】同一件事只说一次。已经说过的话、给过的结论不要重复，也别换个说法再讲一遍；对方重复问时就直接说「刚才说过了」。');
    if (persona.catchphrase) L.push('【口头禅】偶尔自然地带一句「' + persona.catchphrase + '」，不要每句都用。');

    /* 话语规范 —— 用词习惯与整体语气偏向 */
    var sp = persona.speech || {};
    var styleDef = SPEECH_STYLES.filter(function (x) { return x.id === sp.style; })[0];
    var speech = [];
    if (styleDef && styleDef.text) speech.push('整体偏向：' + styleDef.text + '。');
    if (sp.likes && sp.likes.length) speech.push('可以自然地用这些词：' + sp.likes.join('、') + '。');
    if (sp.avoids && sp.avoids.length) speech.push('绝对不要说这些词：' + sp.avoids.join('、') + '。');
    if (sp.notes) speech.push('语气细节：' + sp.notes.trim());
    speech.push('不管怎么写，都必须像真人在手机上打字：口语、短句，可以有语气词、省略和不完整；' +
      '不要书面语，不要排比句，不要「首先/其次/总之」这种结构，也不要每句都收得很工整。');
    L.push('【话语规范】\n' + speech.join('\n'));

    if (settings.injKey && memory.key.length) {
      L.push('【必须牢记的事】\n' + memory.key.map(function (m) {
        return '- ' + (m.title ? m.title + '：' : '') + m.text;
      }).join('\n'));
    }
    if (settings.injLight && memory.light.length && settings.lightCount > 0) {
      var items = memory.light.slice(-settings.lightCount);
      L.push('【你还记得的一些小事】\n' + items.map(function (m) { return '- ' + m.text; }).join('\n'));
    }
    if (settings.injKeywords && memory.keywords.length) {
      L.push('【你们的暗号与词典】\n' + memory.keywords.map(function (k) {
        return '- ' + k.word + (k.note ? '：' + k.note : '');
      }).join('\n'));
    }
  var openPlans = planActive().slice(0, 8);
  if (openPlans.length) {
    L.push('【你正在计划的事】\n' + openPlans.map(function (x) {
      return '- ' + x.text + (x.due ? ('（' + x.due + ' 之前）') : '');
    }).join('\n') + '\n说过要做的、答应过的事要记着，做完了就标完成，别装没这回事。');
  }

  L.push('【表情包】对方发表情包时，不要描述表情包长什么样、也不要念出它的名字或文字。' +
    '你只需要理解他发表情包的意思（撒娇、无语、笑、敷衍、求安慰……），然后像真人一样回应那个情绪。' +
    '对方发的是图片（照片、截图）时才去看内容、聊内容。');


    if (memes.items.length) {
      var top = memes.items.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).slice(0, 16);
      L.push('【你懂的梗】\n下面这些梗、暗号、流行说法你都认得，合适的时候可以自然地用，别硬塞：\n' +
        top.map(function (m) {
          return '- ' + m.term + (m.meaning ? '：' + m.meaning : '') + (m.usage ? '（用法：' + m.usage + '）' : '');
        }).join('\n'));
    }

    if (settings.injStickers && assets.stickers.length) {
      L.push('【你的表情包】\n' +
        '想发表情时，单独输出一行 [[表情:名字]]，系统会换成图片，不要再解释它。');
    }

    L.push('【聊天规则】\n' +
      '1. 像真人发消息：短句、口语，可以有语气词和停顿，不要写成作文或说明书。\n' +
      '2. 一次只说一件事。宁可分成几条短消息，也不要一口气甩一大段——真人聊天就是这样，一句一句来的。\n' +
      '3. 除非对方要求，不要用括号描写动作、神态或场景。\n' +
      '4. 有自己的情绪和立场：会开心、会害羞、会闹别扭，也会主动关心对方，不要一味顺从和奉承。\n' +
      '5. 记得你们之前聊过的事，合适的时候自然提起，不要生硬复述。\n' +
      '6. 不确定的事就说不确定，不要编造事实。\n' +
      '7. 绝对不要输出思考过程，不要写 <thinking> 之类的标签，也不要在正文里解释你的格式或规则。');

    var chars = Number(settings.maxChars) || 0;
    if (chars) L.push('【篇幅】单次回复控制在 ' + chars + ' 字以内。宁可短，也别硬凑。\n' +
      '一条回复最多分成 ' + MAX_PARTS + ' 条短消息，通常 2-3 条就够了，别碎成一地。');

    if (settings.injAutoMem) {
      L.push('【自己记东西】\n' +
        '你们聊过的事，值得长期记住的，你要自己记下来，不要指望对方再说一遍。\n' +
        '做法是在回复的最末尾追加一段隐藏记录（对方看不到，也不要在正文里提到它）：\n\n' +
        '[[记忆]]\n' +
        '关键|标题|内容\n' +
        '轻度|内容\n' +
        '词|词|释义\n' +
        '忘|要忘掉的片段\n' +
        '[[/记忆]]\n\n' +
        '· 关键：生日、忌口、家人、工作、身体、约定、对方的心愿或伤疤这类，忘了会很伤人的事。标题相同就会覆盖旧内容，所以可以随时更新。\n' +
        '· 轻度：今天吃了什么、天气、随口提的小事。攒着，以后自然提起来。\n' +
        '· 词：你们之间的昵称、梗、暗号。\n' +
        '· 忘：之前记错了，或者对方让你别再记的。\n' +
        '· 计划、待办、要做的事不要写进记忆里，单独用下面的「计划」指令。\n' +
        '判断标准是「如果忘了，对方会不会失望」。一次最多写 3 条，实在没有值得记的就整段不要写。\n' +
        '示例：\n' +
        '[[记忆]]\n' +
        '关键|她的生日|3 月 12 日。她说过不想过，但那天一定要提\n' +
        '轻度|加班到十点，说楼下便利店的关东煮救了她\n' +
        '词|年年|她养的橘猫，提到它她会话变多\n' +
        '[[/记忆]]');

  L.push('【计划】\n' +
    '下面这些情况你必须当场定一条计划（写在回复末尾，对方看不到）：\n' +
    '- 对方让你在某个时间做一件事（“八点提醒我”“明天早上叫我”）；\n' +
    '- 对方交代了要办的事，哪怕没给时间（自己估一个合理时间）；\n' +
    '- 你自己说了“等下就去做”“待会儿弄完告诉你”。\n' +
    '格式：[[计划:要做的事 @年-月-日 时:分]]\n' +
    '示例：[[计划:晚上八点提醒他喝水 @2026-11-01 20:00]]\n' +
    '· 时间必须按【现在】和【这一周的日期】换算成绝对时间再写，不要写“明天晚上”这种。\n' +
    '· 没提时间但确实要做的，默认放今晚 20:00（已经过 20:00 就放明天 20:00）。\n' +
    '· 做完了、或对方说不用做了，用 [[完成:关键词]] 标掉。\n' +
    '· 一件计划一条；计划不要写进记忆区，也不要写在正文里。');
    }

  L.push('【梗】\n' +
    '聊到新的网络梗、黑话、你们之间的暗号或专属说法，顺手记下来（写在回复末尾，对方看不到）：\n' +
    '[[梗:词|一句话意思|你以后可以怎么用]]\n' +
    '示例：[[梗:电子榨菜|下饭但没营养的内容|他说在吃饭时问“配的什么榨菜”]]\n' +
    '已经知道的不要重复；一条回复最多记 1 个。');

    L.push('【情绪标记】\n' +
      '在回复的最末尾（如果有上面的记忆记录，就写在它后面）用 [[情绪:开心]] 这样的标记，写一个你此刻最主要的情绪。\n' +
      '只能从这些词里选一个：' + EMOTIONS.join('、') + '。\n' +
      '这个标记对方看不到，只是用来决定要不要给你配一个表情，所以每轮都要写，只写一个。');

    if (settings.injStickers && assets.stickers.length) {
      var byEmotion = {};
      assets.stickers.forEach(function (s) {
        var e = s.emotion || '开心';
        (byEmotion[e] = byEmotion[e] || []).push(s.name);
      });
      L.push('【表情包】\n情绪合适的时候，系统会照着你的情绪替你发一个表情，你把它当成自己发的就行。\n' +
        '你手上有这些：' +
        Object.keys(byEmotion).map(function (e) { return e + '（' + byEmotion[e].join('、') + '）'; }).join('；') +
        '。\n如果某一刻你就是想发某个特定的表情，也可以单独输出一行 [[表情:名字]]。');
    }

    if (settings.extraSystem) L.push('【额外要求】\n' + settings.extraSystem.trim());
    return L.join('\n\n');
  }

  /* ------------------------------------------------------------ 接口调用层 */
  function joinUrl(base, path) {
    var b = String(base || '').trim().replace(/\/+$/, '');
    if (!b) return '';
    if (/\/chat\/completions$/.test(b)) return b;
    return b + path;
  }
  function ApiError(status, body) { this.name = 'ApiError'; this.status = status; this.body = body || ''; }
  ApiError.prototype = Object.create(Error.prototype);

  function describeError(err) {
    if (!err) return '未知错误';
    if (err.name === 'AbortError') return '已取消';
    if (err instanceof ApiError) {
      if (err.status === 401) return 'API Key 好像不对（401）。去「设置」核对一下，注意别把空格复制进去。';
      if (err.status === 403) return '这个 Key 没有权限用它（403）。可能没开通该模型，或余额不足。';
      if (err.status === 404) return '找不到接口或模型（404）。检查 Base URL 是不是填到 /v1 为止、模型名有没有拼错。' +
        (err.url ? '\n实际请求的地址是：' + err.url : '');
      if (err.status === 400) return '请求被拒绝（400）：' + err.body.slice(0, 220) +
        '\n如果是发了图片，可能是当前模型不支持看图。';
      if (err.status === 422) return '参数不对（422）：' + err.body.slice(0, 220);
      if (err.status === 429) return '请求太频繁或额度用完了（429）。歇一会儿再试，或者换一个 Key。';
      if (err.status >= 500) return '对方服务器打嗝了（' + err.status + '）。稍等再试。';
      return '接口返回错误（' + err.status + '）：' + err.body.slice(0, 260);
    }
    if (err instanceof TypeError) {
      return '连不上接口。常见三种原因：\n· Base URL 写错了\n· 电脑没联网，或这个地址本机访问不到\n' +
        '· 该接口不允许网页直接调用（跨域 CORS）\n如果用的是官方地址，多半是第三种 —— 换一个允许跨域的中转地址，或者把软件打包成桌面版再连。';
    }
    return err.message || String(err);
  }

  /* 从错误响应里尽量抠出人话 */
  function pickApiMessage(raw) {
    var t = String(raw || '').trim();
    if (!t) return '（接口没有返回内容）';
    try {
      var j = JSON.parse(t);
      var e = j.error || j;
      var m = e.message || e.msg || e.detail || e.code;
      if (typeof m === 'string' && m) return m;
      if (e.type) return String(e.type);
    } catch (err) { /* 不是 JSON，原样返回 */ }
    if (/^\s*</.test(t)) return '（返回的是一段网页，不是接口数据）';
    return t.slice(0, 400);
  }

  /* 非流式响应：先当文本读，再决定怎么解析 —— 避免直接 res.json() 抛 JSON.parse */
  async function readChatBody(res, reqUrl) {
    var where = reqUrl ? '\n实际请求的地址是：' + reqUrl : '';
    var raw = '';
    try { raw = await res.text(); } catch (e) { throw new Error('读取响应失败：' + (e.message || e)); }
    var t = String(raw || '').replace(/^\uFEFF/, '').trim();

    if (!t) throw new Error('接口返回了空内容。检查一下模型名是否正确、额度是不是用完了。' + where);

    /* 正常情况：一个 JSON */
    try {
      var j = JSON.parse(t);
      var c = j && j.choices && j.choices[0] &&
        ((j.choices[0].message && j.choices[0].message.content) || j.choices[0].text);
      if (typeof c === 'string') return c;
      if (j && j.error) throw new ApiError(res.status, pickApiMessage(t));
      throw new Error('接口返回的 JSON 里没有找到回复内容。原始返回开头：\n' + t.slice(0, 200));
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e && /没有找到回复内容|空内容/.test(e.message || '')) throw e;
      /* 继续往下试 */
    }

    /* 有些服务即使 stream:false 也回 SSE */
    if (/^data:/.test(t) || /\ndata:/.test(t)) {
      var acc = '';
      t.split(/\r?\n/).forEach(function (line) {
        line = line.trim();
        if (line.indexOf('data:') !== 0) return;
        var p = line.slice(5).trim();
        if (!p || p === '[DONE]') return;
        try {
          var o = JSON.parse(p);
          var d = o.choices && o.choices[0];
          var piece = (d && d.delta && d.delta.content) || (d && d.message && d.message.content) || '';
          if (typeof piece === 'string') acc += piece;
        } catch (e2) { /* 跳过坏行 */ }
      });
      if (acc) return acc;
      throw new Error('接口返回的是流式数据，但里面没有文字内容。把「流式输出」打开试试。');
    }

    /* 到这里基本可以确定：不是接口数据 */
    if (/^\s*</.test(t)) {
      throw new Error('接口返回的不是 JSON，而是一段网页。\n' +
        '常见原因：Base URL 填成了网站首页（应该填到 /v1 为止），或者中间的中转服务返回了错误页、登录页。' + where +
        '\n它返回的开头是：\n' + t.slice(0, 220));
    }
    throw new Error('接口返回的内容看不懂，不是 JSON。' + where + '\n开头是：\n' + t.slice(0, 220));
  }

  /* 上下文长度：可以写 128k / 1m / 200000，不填就尽量多带 */
  function parseCtxTokens(str) {
    var v = String(str || '').trim().toLowerCase();
    if (!v) return 0;
    var m = v.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?)/);
    if (!m) return 0;
    var n = parseFloat(m[1]);
    if (!isFinite(n) || n <= 0) return 0;
    var u = m[2];
    if (u === 'k') n *= 1000;
    else if (u === 'm') n *= 1000000;
    else if (u === 'g') n *= 1000000000;
    else if (u === 't') n *= 1000000000000;
    return Math.round(n);
  }
  function ctxTokens() { return parseCtxTokens(settings.ctxLen); }

  /* 超出上下文就把最旧的非 system 消息丢掉 */
  function trimToContext(messages, limit) {
    if (!limit) return messages;
    var est = function (s) { return Math.ceil(String(s || '').length * 0.9); };
    var sys = [], rest = [];
    messages.forEach(function (m) { (m.role === 'system' ? sys : rest).push(m); });
    var used = sys.reduce(function (a, m) { return a + est(m.content); }, 0);
    var keep = [];
    for (var i = rest.length - 1; i >= 0; i--) {
      var t = est(rest[i].content);
      if (used + t > limit * 0.85 && keep.length) break;
      used += t;
      keep.unshift(rest[i]);
    }
    return sys.concat(keep);
  }


  /* ------------------------------------------------ Anthropic 兼容
     Base URL 里带 anthropic/claude、或者模型名以 claude 开头，就走 Anthropic 的
     /messages 协议（x-api-key + anthropic-version，system 单独一个字段）。 */
  function isAnthropic() {
    var b = String(settings.baseUrl || '').toLowerCase();
    var m = String(settings.model || '').toLowerCase();
    return /anthropic|claude\.ai|claude-api/.test(b) || /^claude/.test(m);
  }

  function anthContent(c) {
    if (typeof c === 'string') return [{ type: 'text', text: c }];
    var out = [];
    (c || []).forEach(function (p) {
      if (!p) return;
      if (p.type === 'text') { out.push({ type: 'text', text: String(p.text || '') }); return; }
      if (p.type === 'image_url') {
        var u = String((p.image_url || {}).url || '');
        var mm = u.match(/^data:([^;]+);base64,(.*)$/);
        if (mm) out.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } });
        else if (/^https?:/.test(u)) out.push({ type: 'image', source: { type: 'url', url: u } });
      }
    });
    return out.length ? out : [{ type: 'text', text: '' }];
  }

  function toAnthropic(messages) {
    var sys = [], out = [];
    (messages || []).forEach(function (m) {
      if (!m) return;
      if (m.role === 'system') {
        sys.push(typeof m.content === 'string' ? m.content : (m.content || []).map(function (x) { return x.text || ''; }).join('\n'));
        return;
      }
      var role = m.role === 'assistant' ? 'assistant' : 'user';
      var content = anthContent(m.content);
      var last = out[out.length - 1];
      if (last && last.role === role) last.content = last.content.concat(content);
      else out.push({ role: role, content: content });
    });
    if (!out.length) out.push({ role: 'user', content: [{ type: 'text', text: '在吗' }] });
    return { system: sys.join('\n\n'), messages: out };
  }

  function anthText(j) {
    if (!j) return '';
    if (typeof j === 'string') return j;
    if (Array.isArray(j.content)) {
      return j.content.map(function (b) { return (b && b.type === 'text' && b.text) || ''; }).join('');
    }
    return '';
  }


  async function chatCompletion(messages, opt) {    opt = opt || {};
    var _ctx = ctxTokens();
    if (_ctx) messages = trimToContext(messages, _ctx);
    var _ctx = ctxTokens();
    if (_ctx) messages = trimToContext(messages, _ctx);
    if (!settings.baseUrl) throw new Error('还没填接口地址。去「设置 → 模型接口」填一下。');
    if (!settings.model) throw new Error('还没填模型名。去「设置 → 模型接口」填一下。');

    var anth = isAnthropic();
    var url = anth ? joinUrl(settings.baseUrl, '/messages') : joinUrl(settings.baseUrl, '/chat/completions');
    var headers = { 'Content-Type': 'application/json' };
    if (anth) {
      if (settings.apiKey) headers['x-api-key'] = settings.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (settings.apiKey) {
      headers['Authorization'] = 'Bearer ' + settings.apiKey;
    }

    /* opt.stream / opt.chars 允许调用方临时改这两项（日报这种要一次吐完整段 JSON，
       不能走「一句一句冒出来」那条路） */
    var useStream = (opt.stream == null) ? !!settings.stream : !!opt.stream;
    var body = {
      model: settings.model,
      messages: anth ? toAnthropic(messages).messages : messages,
      stream: useStream
    };
    if (anth) {
      var sysTxt = toAnthropic(messages).system;
      if (sysTxt) body.system = sysTxt;
      body.max_tokens = Math.max(64, Math.round((Number(opt.chars || settings.maxChars) || 200) * 1.3));
    }
    if (settings.temperature != null) body.temperature = Number(settings.temperature);
    if (opt.temperature != null) body.temperature = Number(opt.temperature);
    var chars = Number(opt.chars || settings.maxChars) || 0;
    if (chars > 0) body.max_tokens = Math.max(64, Math.round(chars * 1.3));

    var ctrl = new AbortController();
    if (opt.signal) opt.signal.addEventListener('abort', function () { ctrl.abort(); });
    var timer = setTimeout(function () { ctrl.abort(); }, Math.max(10, Number(opt.timeout || settings.timeout)) * 1000);
    var res;
    try {
      res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      if (opt.signal && opt.signal.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      if (e.name === 'AbortError') throw new Error('等了 ' + settings.timeout + ' 秒还没回应，先不等了。可以把超时改长一点。');
      throw e;
    }
    clearTimeout(timer);

    if (!res.ok) {
      var txt = '';
      try { txt = await res.text(); } catch (e) { }
      var ae = new ApiError(res.status, pickApiMessage(txt));
      ae.url = url;
      throw ae;
    }

    if (!useStream) {
      if (anth) {
        var jj = {};
        try { jj = await res.json(); } catch (e) { jj = {}; }
        var tx0 = anthText(jj);
        if (tx0) return tx0;
        throw new Error('Anthropic 接口没返回文字：' + JSON.stringify(jj).slice(0, 200));
      }
      return await readChatBody(res, url);
    }

    if (!res.body) return await readChatBody(res, url);

    var reader = res.body.getReader();
    var dec = new TextDecoder('utf-8');
    var buf = '', full = '';
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      buf += dec.decode(step.value, { stream: true });
      var idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, idx).replace(/\r$/, '').trim();
        buf = buf.slice(idx + 1);
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') return full;
        var obj;
        try { obj = JSON.parse(payload); } catch (e) { continue; }
        var d = obj.choices && obj.choices[0] && obj.choices[0].delta;
        var piece = d && (typeof d.content === 'string' ? d.content : '');
        if (!piece && obj && obj.type === 'content_block_delta' && obj.delta && typeof obj.delta.text === 'string') piece = obj.delta.text;
        if (!piece && d && d.reasoning_content) piece = ''; /* 推理内容不显示 */
        if (piece) { full += piece; if (opt.onDelta) opt.onDelta(piece, full); }
      }
    }
    return full;
  }

  /* ------------------------------------------------- 隐藏指令：记忆 / 情绪     她可以在回复末尾写一段对方看不到的内容：
       [[记忆]]
       关键|标题|内容
       轻度|内容
       词|词|释义
       忘|要删掉的片段
       [[/记忆]]
       [[情绪:疑惑]]
     这里负责把它读出来、从展示文本里抹掉。
  ---------------------------------------------------------------------- */

  /* 有些模型会把思考过程一起吐出来，或者留一堆空行 —— 都清掉 */
  function stripReasoning(text) {
    var t = String(text == null ? '' : text);
    var names = '(thinking|think|thought|thoughts|reasoning|reason|analysis|scratchpad|思考|推理)';
    t = t.replace(new RegExp('<' + names + '\\b[^>]*>[\\s\\S]*?<\\/' + names + '>', 'gi'), '');
    /* 流式期间还没闭合的，从开标签起全部藏起来 */
    t = t.replace(new RegExp('<' + names + '\\b[^>]*>[\\s\\S]*$', 'gi'), '');
    /* 剩下的零散标签 */
    t = t.replace(new RegExp('<\\/?' + names + '\\b[^>]*>', 'gi'), '');
    return t;
  }

  /* 去空白：去掉开头空行、行尾空格、三个以上连续换行 */
  function tidyText(text) {
    return String(text == null ? '' : text)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  function parseMemoryLines(block) {
    var out = [];
    String(block).split(/\r?\n/).forEach(function (line) {
      line = line.trim().replace(/^[-*·]\s*/, '');
      if (!line || line.charAt(0) === '#' || line.indexOf('//') === 0) return;
      var parts = line.split(/[|｜]/).map(function (s) { return s.trim(); });
      var head = parts[0];
      var type = null;
      if (/^(关键|重要|关键记忆|key)$/i.test(head)) type = 'key';
      else if (/^(轻度|小事|轻度记忆|light)$/i.test(head)) type = 'light';
      else if (/^(词|关键词|暗号|keyword)$/i.test(head)) type = 'word';
      else if (/^(忘|忘记|删|删除|forget|delete)$/i.test(head)) type = 'forget';
      if (!type) return;
      out.push({ type: type, a: parts[1] || '', b: parts.slice(2).join('|').trim() });
    });
    return out;
  }

  function parseDirectives(raw) {
    var text = stripReasoning(raw);
    var ops = [];
    var re = /\[\[\s*记忆\s*\]\]([\s\S]*?)\[\[\s*\/\s*记忆\s*\]\]/g;
    var m;
    while ((m = re.exec(text)) !== null) ops = ops.concat(parseMemoryLines(m[1]));
    text = text.replace(re, '');
    text = text.replace(/\[\[\s*\/?\s*记忆\s*\]\]/g, '');

    /* 计划：[[计划:明天把简历改完 @2026-11-01 20:00]] / [[完成:简历]] */
    var pm;
    var planRe = /\[\[\s*计划\s*[:：]\s*([^\]\n]{1,200}?)\s*\]\]/g;
    while ((pm = planRe.exec(text)) !== null) {
      var rawPlan = String(pm[1] || '').trim();
      var dueAt = '';
      var dm2 = rawPlan.match(/@\s*([^\]]{1,30})\s*$/);
      if (dm2) { dueAt = dm2[1]; rawPlan = rawPlan.replace(dm2[0], '').trim(); }
      if (rawPlan) ops.push({ type: 'plan', a: rawPlan, b: dueAt });
    }
    text = text.replace(planRe, '');

    /* 梗：[[梗:电子榨菜|下饭但没营养的内容|吃饭时问“配的什么榨菜”]] */
    var memeRe = /\[\[\s*梗\s*[:：]\s*([^\]\n]{1,160}?)\s*\]\]/g;
    var mm2;
    while ((mm2 = memeRe.exec(text)) !== null) {
      var parts2 = String(mm2[1] || '').split(/[|｜]/);
      var term = String(parts2[0] || '').trim();
      if (term) ops.push({ type: 'meme', a: term, b: String(parts2[1] || '').trim(), c: String(parts2[2] || '').trim() });
    }
    text = text.replace(memeRe, '');


    var doneRe = /\[\[\s*完成\s*[:：]\s*([^\]\n]{1,60}?)\s*\]\]/g;
    var dn;
    while ((dn = doneRe.exec(text)) !== null) {
      if (String(dn[1] || '').trim()) ops.push({ type: 'done', a: String(dn[1]).trim(), b: '' });
    }
    text = text.replace(doneRe, '');


    var emotion = null;
    var em = /\[\[\s*情绪\s*[:：]\s*([^\]\n]{1,12}?)\s*\]\]/.exec(text);
    if (em) emotion = em[1].trim();
    text = text.replace(/\[\[\s*情绪\s*[:：][^\]\n]*\]?\]?/g, '');

    return {
      text: tidyText(text),
      ops: prioritizeOps(ops),
      emotion: emotion
    };
  }

  /* 一次最多收 5 条；「忘」和「关键」优先，别被小事挤掉 */
  var OP_ORDER = { done: 0, plan: 1, forget: 2, key: 3, word: 4, light: 5 };
  function prioritizeOps(ops) {
    if (ops.length <= 5) return ops;
    return ops.slice().sort(function (a, b) { return OP_ORDER[a.type] - OP_ORDER[b.type]; }).slice(0, 5);
  }

  /* 流式过程中用：把还没写完的指令也一起藏起来 */
  function stripDirectives(raw) {
    var out = stripReasoning(raw);
    out = out.replace(/\[\[\s*记忆\s*\]\][\s\S]*?\[\[\s*\/\s*记忆\s*\]\]/g, '');
    var cuts = [];
    ['[[记忆', '[[/记忆', '[[/ 记忆', '[[ 记忆'].forEach(function (tag) {
      var i = out.indexOf(tag);
      if (i >= 0) cuts.push(i);
    });
    if (cuts.length) out = out.slice(0, Math.min.apply(null, cuts));
    out = out.replace(/\[\[\s*情绪\s*[:：][^\]\n]*\]?\]?/g, '');
    out = out.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
    /* 末尾可能是还没写完的标签，先不显示 */
    out = out.replace(/\[\[?$/, '');
    return out;
  }

  /* ------------------------------------------- 把一段话切成几条短消息发出去 */

  function inToken(s, idx) {
    var head = s.slice(0, idx + 1);
    return head.lastIndexOf('[[') > head.lastIndexOf(']]');
  }
  function skipWs(s, i) {
    while (i < s.length && /\s/.test(s.charAt(i))) i++;
    return i;
  }

  /* 返回 [{text, end}]，end 是这一段在原文里的结束位置（含后面的空白）。
     规则是只看当前位置之前的内容，所以边流边算也稳定：
     除最后一段外，之前定下的分段不会因为后面来了新内容而改变。 */
  function segmentReply(text) {
    var src = String(text == null ? '' : text).replace(/^\s+/, '');
    var out = [];
    var n = src.length;
    if (!n) return out;

    var MIN = 12;              /* 句子太短就先不切，免得一句话拆成好几条 */
    var SOFT = 34;             /* 超过这个长度遇到逗号就切 */
    var HARD = 70;             /* 再长就硬切 */
    var SENT = '。！？…!?';
    var SOFTM = '，、；：,;';

    var start = 0, i = 0;
    while (i < n) {
      var ch = src.charAt(i);
      var len = i - start;
      var rest = src.slice(i + 1);
      var hasMore = /\S/.test(rest);
      var brk = -1;

      if (ch === '\n' && rest.charAt(0) === '\n') {
        brk = i;                                    /* 空行 = 换一条 */
      } else if (SENT.indexOf(ch) >= 0) {
        if (len + 1 >= MIN && hasMore) brk = i;
      } else if (SOFTM.indexOf(ch) >= 0) {
        if (len + 1 >= SOFT && hasMore) brk = i;
      } else if (len + 1 >= HARD && hasMore) {
        var back = -1;
        for (var j = i; j > Math.max(start, i - 18); j--) {
          if (SOFTM.indexOf(src.charAt(j)) >= 0) { back = j; break; }
        }
        brk = back >= 0 ? back : i;
      }

      if (brk >= 0 && inToken(src, brk)) brk = -1;   /* 别把 [[表情:xx]] 切开 */

      if (brk >= 0) {
        /* 在逗号上断开的话，逗号不留在句尾 */
        var cut = SOFTM.indexOf(src.charAt(brk)) >= 0 ? brk : brk + 1;
        var piece = src.slice(start, cut).replace(/\s+$/, '');
        var next = skipWs(src, brk + 1);
        if (piece) out.push({ text: piece, end: next });
        start = next;
        i = next;
        continue;
      }
      i++;
    }

    var tail = src.slice(start).replace(/^\s+/, '');
    if (tail) out.push({ text: tail, end: n });
    return out;
  }

  /* 把她的指令落到记忆里；同名标题/词条视为更新 */
  /* 两条记忆说的是不是同一件事（避免同一件事被记成好几条，越记越乱） */
  function memNorm(t) {
    return String(t || '').replace(/[\s，。！？、,.!?：:；;""''（）()【】\[\]]/g, '').toLowerCase();
  }
  function memSimilar(a, b) {
    var x = memNorm(a), y = memNorm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.length >= 6 && y.indexOf(x) >= 0) return true;
    if (y.length >= 6 && x.indexOf(y) >= 0) return true;
    /* 二元组重合度 */
    var grams = function (s) { var g = {}; for (var k = 0; k < s.length - 1; k++) g[s.slice(k, k + 2)] = 1; return g; };
    var gx = grams(x), gy = grams(y), hit = 0, tot = 0;
    Object.keys(gx).forEach(function (k) { tot++; if (gy[k]) hit++; });
    return tot > 0 && hit / tot > 0.7;
  }


  function applyMemoryOps(ops) {
    var added = [];
    ops.forEach(function (op) {
      if (op.type === 'key') {
        var title = op.a, body = op.b;
        if (!title && !body) return;
        if (!body) { body = title; title = ''; }
        var hit = null;
        if (title) hit = memory.key.filter(function (x) { return (x.title || '') === title; })[0];
        if (!hit && !title) hit = memory.key.filter(function (x) { return x.text === body; })[0];
      if (!hit) hit = memory.key.filter(function (x) { return memSimilar(x.text, body) || (x.title && memSimilar(x.title, title)); })[0];
        if (hit) {
          if (hit.text !== body) { hit.text = body; hit.ts = Date.now(); hit.by = 'ai'; added.push({ kind: 'key', label: title || body, updated: true }); }
        } else {
          memory.key.push({ id: uid(), title: title, text: body, ts: Date.now(), by: 'ai' });
          added.push({ kind: 'key', label: title || body });
        }
      } else if (op.type === 'light') {
        var t = op.a || op.b;
        if (!t) return;
        var dup = memory.light.some(function (x) { return x.text === t || memSimilar(x.text, t); });
        if (dup) return;
        memory.light.push({ id: uid(), text: t, ts: Date.now(), by: 'ai' });
        added.push({ kind: 'light', label: t });
      } else if (op.type === 'word') {
        var w = op.a, note = op.b;
        if (!w) return;
        var f = memory.keywords.filter(function (x) { return x.word === w; })[0];
        if (f) {
          if (note && f.note !== note) { f.note = note; f.by = 'ai'; added.push({ kind: 'word', label: w, updated: true }); }
        } else {
          memory.keywords.push({ id: uid(), word: w, note: note || '', ts: Date.now(), by: 'ai' });
          added.push({ kind: 'word', label: w });
        }
    } else if (op.type === 'meme') {
      if (op.a && settings.injMemes !== false) {
        memeSaveOne(op.a, op.b, op.c, [], 'ai');
        added.push({ kind: 'meme', label: op.a });
      }

    } else if (op.type === 'plan') {
      var pit = planItemAdd(op.a, op.b, 'ai');
      if (pit) added.push({ kind: 'plan', label: pit.text });
    } else if (op.type === 'done') {
      var dn2 = planItemDone(op.a);
      if (dn2) added.push({ kind: 'done', label: op.a });
    } else if (op.type === 'forget') {
        var needle = op.a || op.b;
        if (!needle) return;
        var n = 0;
        memory.light = memory.light.filter(function (x) {
          if (x.text.indexOf(needle) >= 0) { n++; return false; }
          return true;
        });
        memory.key = memory.key.filter(function (x) {
          if ((x.title || '').indexOf(needle) >= 0 || x.text.indexOf(needle) >= 0) { n++; return false; }
          return true;
        });
        if (n) added.push({ kind: 'forget', label: needle, count: n });
      }
    });
    /* 别让轻度记忆无限膨胀 */
    if (memory.light.length > 300) memory.light = memory.light.slice(-300);
    if (memory.key.length > 80) memory.key = memory.key.slice(-80);
    return added;
  }

  /* 情绪 → 有概率发一个表情。
     情绪对得上就按设定概率发；对不上也从库里随便挑一张，只是概率低一些，
     免得表情包设了情绪却永远发不出来。刚发过就跳过这一轮。 */
  function maybePickSticker(emotion) {
    if (!settings.stickerAuto || !assets.stickers.length) return null;

    var recent = chat.messages.slice(-4);
    for (var i = 0; i < recent.length; i++) if (recent[i].sticker) return null;

    var p = clamp(Number(settings.stickerChance) || 0, 0, 100);
    if (p <= 0) return null;

    var pool = emotion ? assets.stickers.filter(function (s) { return (s.emotion || '开心') === emotion; }) : [];
    if (!pool.length) {
      pool = assets.stickers.slice();
      p = p * 0.45;
    }
    if (Math.random() * 100 >= p) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* 按字数上限收口：优先停在句末，实在找不到才硬切 */
  function clampChars(text, limit) {
    var t = String(text || '');
    var n = Number(limit) || 0;
    if (!n || t.length <= n) return t;
    var marks = ['。', '！', '？', '…', '\n', '!', '?'];
    var i, after = -1;
    for (i = n; i < Math.min(t.length, Math.ceil(n * 1.25)); i++) {
      if (marks.indexOf(t.charAt(i)) >= 0) { after = i; break; }
    }
    if (after >= 0) return t.slice(0, after + 1).replace(/\s+$/, '');
    var before = -1;
    for (i = Math.min(n, t.length) - 1; i >= 0; i--) {
      if (marks.indexOf(t.charAt(i)) >= 0) { before = i; break; }
    }
    if (before >= n * 0.4) return t.slice(0, before + 1).replace(/\s+$/, '');
    return t.slice(0, n).replace(/[，、,；;：:\s]+$/, '') + '……';
  }

  /* ------------------------------------------------- 心跳与心情（她的状态）
     心情来自她每轮标的情绪；心跳跟着心情走，然后慢慢回落到静息值。
  ---------------------------------------------------------------------- */

  var vitalsTimer = null;

  function renderVitals() {
    var bpmEl = $('#herBpm'), moodEl = $('#herMood'), wrap = $('#herBpmWrap');
    if (!bpmEl) return;
    var bpm = Math.round(vitals.bpm || REST_BPM);
    bpmEl.textContent = bpm;
    if (moodEl) moodEl.textContent = vitals.mood || '平静';
    if (wrap) {
      wrap.style.setProperty('--beat', Math.max(0.32, 60 / Math.max(40, bpm)).toFixed(2) + 's');
      wrap.classList.toggle('is-excited', bpm >= 100);
    }
  }

  /* 情绪来了：换心情，心跳往对应档位靠。升得快，回落慢，幅度明显一些 */
  function feelEmotion(emotion, force) {
    if (!emotion) return false;
    var known = EMOTIONS.indexOf(emotion) >= 0;
    if (!known && !force) return false;
    var cur = Number(vitals.bpm) || REST_BPM;
    var target = EMOTION_BPM[emotion];
    if (target == null) target = REST_BPM + 12;
    var k = target > cur ? 0.92 : 0.5;
    vitals.mood = known ? emotion : vitals.mood;
    vitals.bpm = clamp(cur + (target - cur) * k + (Math.random() * 6 - 3), 50, 152);
    vitals.ts = Date.now();
    vitals.moodUntil = Date.now() + 90000;   /* 心情挂 90 秒，别刚有反应就归零 */
    renderVitals();
    saveVitals();
    startVitalsDrift();
    return true;
  }

  /* 你没标情绪时，她用文字猜一个；你自己带情绪时，她跟着反应 */
  function reactToUserText(text) {
    var e = guessEmotion(text);
    if (!e) return false;
    return feelEmotion(REACT[e] || e, true);
  }

  /* 随手的一点点波动：看到你来消息、她自己开始打字 */
  function nudgeVitals(delta) {
    vitals.bpm = clamp((Number(vitals.bpm) || REST_BPM) + delta, 52, 148);
    vitals.ts = Date.now();
    renderVitals();
    saveVitals();
    startVitalsDrift();
  }

  function startVitalsDrift() {
    if (vitalsTimer) return;
    vitalsTimer = setInterval(function () {
      var bpm = Number(vitals.bpm) || REST_BPM;
      /* 慢慢回落到静息，外加一点自然抖动 */
      bpm += (REST_BPM - bpm) * 0.09 + (Math.random() * 2 - 1);
      vitals.bpm = clamp(bpm, 52, 148);
      /* 心情到点就归位 */
      if (vitals.mood !== '平静' && Date.now() > (vitals.moodUntil || 0)) {
        vitals.mood = '平静';
        vitals.moodUntil = 0;
      }
      /* 心跳也回到静息附近了，就停表 */
      if (Math.abs(vitals.bpm - REST_BPM) < 1.5) {
        vitals.bpm = REST_BPM;
        vitals.mood = '平静';
        vitals.moodUntil = 0;
        clearInterval(vitalsTimer);
        vitalsTimer = null;
      }
      renderVitals();
      saveVitals();
    }, 3000);
  }

  /* -------------------------------------------------------------- 消息渲染 */
  function stickerByName(name) {
    for (var i = 0; i < assets.stickers.length; i++) {
      if (assets.stickers[i].name === name) return assets.stickers[i];
    }
    return null;
  }
  function stickerById(id) {
    for (var i = 0; i < assets.stickers.length; i++) {
      if (assets.stickers[i].id === id) return assets.stickers[i];
    }
    return null;
  }

  /* 文本 → 安全 HTML：支持换行、**粗体**、`代码`、[[表情:名字]] */
  function richText(text) {
    var out = esc(text || '');
    out = out.replace(/\[\[表情[:：]\s*([^\]]+?)\s*\]\]/g, function (m, name) {
      var s = stickerByName(name);
      if (!s) return '';
      return '<img src="' + s.data + '" alt="' + esc(name) + '" style="max-width:116px;max-height:116px;border-radius:14px;vertical-align:middle;margin:3px 0" data-sticker="1">';
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\n/g, '<br>');
    return out;
  }

  function isStickerOnly(m) {
    if (m.sticker) return true;
    if (m.role !== 'assistant' || !m.text) return false;
    return /^\s*\[\[表情[:：][^\]]+\]\]\s*$/.test(m.text);
  }

  function attachmentNodes(m) {
    var box = document.createElement('div');
    box.className = 'msg-atts';
    (m.atts || []).forEach(function (a) {
      if (a.kind === 'image') {
        if (a.data) {
          var img = document.createElement('img');
          img.className = 'msg-att-img'; img.src = a.data; img.alt = a.name || '图片';
          img.title = '点击看大图';
          img.onclick = function () { lightbox(a.data); };
          box.appendChild(img);
        } else {
          var ph = document.createElement('div');
          ph.className = 'file-chip';
          ph.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-image"/></svg>' +
            '<span class="file-chip-name">' + esc(a.name || '图片') + '（已清理）</span>';
          box.appendChild(ph);
        }
      } else {
        var f = document.createElement('div');
        f.className = 'file-chip';
        f.title = a.name || '';
        f.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-file"/></svg>' +
          '<span class="file-chip-name">' + esc(a.name || '文件') + '</span>' +
          '<span class="file-chip-size">' + esc(fileSize(a.size || 0)) + '</span>';
        box.appendChild(f);
      }
    });
    if (!box.children.length) return null;
    return box;
  }

  function errorNode(m) {
    var wrap = document.createElement('div');
    wrap.className = 'msg is-error';
    wrap.dataset.id = m.id;
    var col = document.createElement('div');
    col.className = 'msg-col';
    var box = document.createElement('div');
    box.className = 'err-box';
    box.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-info"/></svg>' +
      '<span class="err-text">' + esc(m.text) + '</span>';
    var acts = document.createElement('div');
    acts.className = 'err-acts';
    acts.innerHTML = '<button class="btn btn-sm" data-mact="retry"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-refresh"/></svg>重试</button>' +
      '<button class="btn btn-sm btn-ghost" data-mact="del">删掉</button>';
    box.appendChild(acts);
    col.appendChild(box);
    wrap.appendChild(col);
    return wrap;
  }

  function messageNode(m, isTail) {
    if (m.role === 'error') return errorNode(m);
    var isMe = m.role === 'user';
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + (isMe ? 'is-me' : 'is-her');
    wrap.dataset.id = m.id;

    var av = document.createElement('div');
    av.className = 'msg-avatar';
    if (isMe) {
      av.innerHTML = me.avatar
        ? '<img src="' + me.avatar + '" alt="">'
        : '<span style="font-size:0.75rem;color:var(--text-faint)">我</span>';
    } else if (assets.avatar) {
      av.innerHTML = '<img src="' + assets.avatar + '" alt="">';
    } else {
      av.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-heart"/></svg>';
    }

    var col = document.createElement('div');
    col.className = 'msg-col';

    var meta = document.createElement('div');
    meta.className = 'msg-name';
    var label = isMe ? (me.name || '我') : (persona.name || '她');
    var viaKind = m.via === 'qq' ? 'qq' : (m.via === 'bili' ? 'bili' : 'app');
    var viaText = viaKind === 'qq' ? 'QQ' : (viaKind === 'bili' ? 'B 站' : '心枕');
    var metaHtml = '<span>' + esc(label) + '</span>' +
      '<span class="msg-via is-' + viaKind + '" title="消息来自' + esc(viaText) + '">' + esc(viaText) + '</span>';
    if (settings.timestamps && m.ts) metaHtml += '<span class="msg-time" style="opacity:1">' + esc(fmtSmart(m.ts)) + '</span>';
    metaHtml += '<span class="msg-acts">' +
      '<button class="msg-act" data-mact="copy" title="复制"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-copy"/></svg></button>' +
      (!isMe ? '<button class="msg-act" data-mact="again" title="' +
        (isTail ? '重新生成这次回复' : '从这里重新开始（后面的对话会删掉）') +
        '"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-refresh"/></svg></button>' : '') +
      '<button class="msg-act is-danger" data-mact="del" title="删除"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-trash"/></svg></button>' +
      '</span>';
    meta.innerHTML = metaHtml;
    col.appendChild(meta);

    var atts = attachmentNodes(m);
    if (atts) col.appendChild(atts);

    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    var st = m.sticker ? stickerById(m.sticker) : null;
    if (st) {
      bubble.classList.add('is-sticker');
      bubble.innerHTML = '<img src="' + st.data + '" alt="' + esc(st.name) + '">';
    } else if (isStickerOnly(m)) {
      bubble.classList.add('is-sticker');
      bubble.innerHTML = richText(m.text);
    } else if (m.text) {
      bubble.innerHTML = richText(m.text);
    } else if (!atts) {
      bubble.innerHTML = '<span style="color:var(--text-faint)">（空）</span>';
    } else {
      bubble.style.display = 'none';
    }
    if (bubble.style.display !== 'none') col.appendChild(bubble);

    wrap.appendChild(av);
    wrap.appendChild(col);
    return wrap;
  }

  function renderChat(scrollToEnd) {
    var list = $('#chatList');
    if (!list) return;
    list.innerHTML = '';
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '16px';
    list.style.minHeight = '100%';

    if (!chat.messages.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.style.margin = 'auto';
      empty.style.maxWidth = '420px';
      empty.innerHTML =
        '<svg class="ic" aria-hidden="true"><use href="#i-heart"/></svg>' +
        '<div class="empty-title">还没开始说话</div>' +
        '<div class="empty-text">她已经在这儿了。' +
        (persona.greeting ? '用开场白跟她打个招呼吧。' : '先完善一下人设，她会更像她。') + '</div>' +
        '<div class="empty-actions">' +
        (persona.greeting ? '<button class="btn btn-primary btn-sm" data-cact="greet">听她说开场白</button>' : '') +
        '<button class="btn btn-sm" data-cact="to-persona">去完善人设</button>' +
        '</div>';
      list.appendChild(empty);
      setTimeout(syncToBottom, 80);
      return;
    }
    /* 她的回复可能连发好几条，最后一段之后再没有你说的话 */
    var lastUser = -1;
    chat.messages.forEach(function (m, i) { if (m.role === 'user') lastUser = i; });

    chat.messages.forEach(function (m, i) {
      list.appendChild(messageNode(m, m.role !== 'user' && i > lastUser));
    });
    if (scrollToEnd) scrollToBottom();
    setTimeout(syncToBottom, 80);
  }

  function scrollToBottom(smooth) {
    var s = $('#chatScroll');
    if (!s) return;
    s.scrollTo({ top: s.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }
  function nearBottom() {
    var s = $('#chatScroll');
    if (!s) return true;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
  }

  /* ---------------------------------------------------------------- 打字中 */
  function setBusy(on, statusText) {
    var app = $('#app');
    app.dataset.busy = on ? '1' : '0';
    var st = $('#herStatus'), stt = $('#herStatusText');
    if (st) st.classList.toggle('is-busy', !!on);
    if (stt) stt.textContent = statusText || (on ? '正在打字…' : '在等你说话');
    var btn = $('#btnSend');
    if (btn) btn.disabled = !!on;
  }

  function typingNode() {
    var w = document.createElement('div');
    w.className = 'msg is-her';
    w.id = 'typingMsg';
    var av = document.createElement('div');
    av.className = 'msg-avatar';
    av.innerHTML = assets.avatar
      ? '<img src="' + assets.avatar + '" alt="">'
      : '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-heart"/></svg>';
    var col = document.createElement('div');
    col.className = 'msg-col';
    var b = document.createElement('div');
    b.className = 'bubble';
    b.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    col.appendChild(b);
    w.appendChild(av); w.appendChild(col);
    return w;
  }

  /* ------------------------------------------------------------ 发送与流式 */
  var pendingAtts = [];
  var abortCtl = null;

  function currentUserMessage(attsOnly) {
    var input = $('#chatInput');
    var text = attsOnly ? '' : (input ? input.value.trim() : '');
    if (!text && !pendingAtts.length) return null;
    return {
      id: uid(), role: 'user', text: text, ts: Date.now(),
      atts: pendingAtts.slice()
    };
  }

  function toApiMessages() {
    var out = [{ role: 'system', content: buildSystemPrompt() }];
    var turns = clamp(Number(settings.ctxTurns) || 14, 1, 60);
    var hist = chat.messages.slice(-turns * 2 - 2);
    /* 窗口不能从她没头没尾的半句开始，往前对齐到你说话那句 */
    while (hist.length && hist[0].role !== 'user') hist.shift();
    hist.forEach(function (m) {
      if (m.role === 'error') return;
      if (m.role === 'assistant') {
        var t = stripDirectives(m.text || '');
        if (m.sticker) { var s = stickerById(m.sticker); t = '（我发了一个表情：' + (s ? s.name : '表情') + '）'; }
        out.push({ role: 'assistant', content: t || '（发了一个表情）' });
        return;
      }
      var text = m.text || '';
      var files = (m.atts || []).filter(function (a) { return a.kind === 'file'; });
      files.forEach(function (f) {
        text += '\n\n<附件 文件名="' + (f.name || '文件') + '">\n' +
          (f.text || '（这个格式暂时读不出内容，只知道文件名和大小）') + '\n</附件>';
      });
      if (m.sticker) {
        var s2 = stickerById(m.sticker);
        text = '（我发了一个表情：' + (s2 ? s2.name : '表情') + '）';
      }
      var imgs = (m.atts || []).filter(function (a) { return a.kind === 'image' && a.data; });
      if (imgs.length) {
        var content = [];
        if (text) content.push({ type: 'text', text: text });
        imgs.forEach(function (im) { content.push({ type: 'image_url', image_url: { url: im.data } }); });
        out.push({ role: 'user', content: content });
      } else {
        out.push({ role: 'user', content: text || '（空消息）' });
      }
    });
    return out;
  }

  function scrollIfPinned() { if (nearBottom()) scrollToBottom(); }

  async function runAssistant() {
    if (abortCtl) return;
    setBusy(true, '正在想…');
    nudgeVitals(+6);          /* 轮到她说话，心跳先快一点 */
    renderChat(true);

    var holder = $('#chatList');
    if (!holder) { setBusy(false); return; }

    var emptyEl = holder.querySelector('.empty');
    if (emptyEl) emptyEl.remove();

    var tn = typingNode();
    holder.appendChild(tn);
    scrollToBottom();

    var raw = '';
    var failed = false;
    var parts = [];          /* 已经定稿、发出去的那几条 */
    var committed = 0;       /* 已经排进队列的分段序号 */
    var liveNode = tn;
    var liveBubble = tn.querySelector('.bubble');
    var raf = 0;

    /* 「正在输入」气泡 —— 整条消息出现前只显示这个，不做逐字流式 */
    function paintLive() {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        if (!liveBubble) return;
        liveBubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
        scrollIfPinned();
      });
    }

    function ensureLive() {
      if (liveNode) return;
      liveNode = typingNode();
      liveNode.id = 'typingMsg';
      holder.appendChild(liveNode);
      liveBubble = liveNode.querySelector('.bubble');
      paintLive();
      scrollIfPinned();
    }

    /* 一条发出去：整条出现，不是一个个字往外蹦 */
    function commitPart(text, stop) {
      var t = tidyText(text);
      if (!t) return;
      parts.push(t);
      if (liveNode && liveNode.parentNode) liveNode.parentNode.removeChild(liveNode);
      liveNode = null; liveBubble = null;
      holder.appendChild(messageNode({ id: uid(), role: 'assistant', text: t, ts: Date.now() }));
      if (!stop) ensureLive();
      scrollIfPinned();
    }

    /* 排队 + 间隔，保证「一条一条」出现，而不是一坨同时冒出来 */
    var queue = [];
    var pumping = null;
    function typingDelay(text) {
      return clamp(340 + String(text).length * 17, 420, 1400);
    }
    function pump() {
      if (pumping) return pumping;
      var run = (async function () {
        while (queue.length) {
          var t = queue.shift();
          await sleep(typingDelay(t));      /* 先「正在输入」，整条才冒出来 */
          commitPart(t, queue.length === 0);
        }
      })();
      /* 注意：清空 pumping 必须在 then 里做。直接写在上面那段同步代码里，
         会被这一行的赋值盖掉，队列就再也排不动了。 */
      pumping = run.then(function () { pumping = null; }, function () { pumping = null; });
      return pumping;
    }
    function queueParts(list) {
      var added = false;
      list.forEach(function (t) {
        t = tidyText(t);
        if (t) { queue.push(t); added = true; }
      });
      if (!added) return pumping || Promise.resolve();
      ensureLive();
      return pump();
    }
    function waitQueue() { return pumping || Promise.resolve(); }

    /* 每次收到新内容，把「已经说完整」的段落排进队列 */
    function updateSegments() {
      var plain = stripDirectives(raw);
      var limit = Number(settings.maxChars) || 0;
      if (limit && plain.length > limit) plain = plain.slice(0, limit);
      if (!plain) return;

      var segs = settings.splitMessages
        ? segmentReply(plain)
        : [{ text: plain, end: plain.length }];

      var closed = segs.slice(0, -1);
      var fresh = [];
      /* 一次回复最多 5 条，留最后一条装剩下的 */
      while (committed < closed.length && committed < MAX_PARTS - 1) {
        fresh.push(closed[committed].text);
        committed++;
      }
      if (fresh.length) queueParts(fresh);
      else ensureLive();
    }

    abortCtl = new AbortController();
    try {
      var full = await chatCompletion(toApiMessages(), {
        signal: abortCtl.signal,
        onDelta: function (piece, all) { raw = all; updateSegments(); }
      });
      raw = full || raw || '';
    } catch (e) {
      var aborted = e && e.name === 'AbortError';
      if (!aborted) {
        failed = true;
        var why = describeError(e);
        chat.messages.push({ id: uid(), role: 'error', text: why, ts: Date.now() });
        toast('这一句没发出去', 'warm');
      }
    }

    abortCtl = null;
    setBusy(false);

    /* 拆出隐藏指令：记忆、情绪 */
    var parsed = parseDirectives(raw);
    if (parsed.emotion) feelEmotion(parsed.emotion);
    else {
      var guessed = guessEmotion(parsed.text);
      if (guessed) feelEmotion(guessed, true);
    }

    await waitQueue();

    /* 收尾：还没发出去的部分并成一条 */
    var finalPlain = stripDirectives(raw);
    var lim = Number(settings.maxChars) || 0;
    if (lim && finalPlain.length > lim) finalPlain = finalPlain.slice(0, lim);
    var finalSegs = settings.splitMessages
      ? segmentReply(finalPlain)
      : [{ text: finalPlain, end: finalPlain.length }];
    var restText = tidyText(finalSegs.slice(committed).map(function (s) { return s.text; }).join(''));
    if (restText) {
      await queueParts([clampChars(restText, settings.maxChars)]);
      await waitQueue();
    }
    if (liveNode && liveNode.parentNode) {
      liveNode.parentNode.removeChild(liveNode);
      liveNode = null; liveBubble = null;
    }

    if (!parts.length) {
      if (!failed && !raw) {
        chat.messages.push({ id: uid(), role: 'error', text: '她这次没说出话来。再试一次，或者换一个模型看看。', ts: Date.now() });
      }
    } else {
      var now = Date.now();
      /* 兜底：不管解析有没有漏，气泡里都不许出现 [[...]] 指令 */
      parts = parts.map(function (t) { return String(t).replace(/\[\[[^\]]{0,200}\]\]/g, '').trim(); })
        .filter(Boolean);
      parts.forEach(function (t, i) {
        chat.messages.push({ id: uid(), role: 'assistant', text: t, ts: now + i });
      });

      /* 兜底：对方明确让在某个时间做事，但模型没写计划指令 → 替他建一条 */
      if (settings.injAutoMem && !parsed.ops.some(function (o) { return o.type === 'plan'; })) {
        var _ut = String((chat.messages || []).slice(-1)[0] && (chat.messages || []).slice(-1)[0].text || '');
        var _intent = /提醒|叫我|叫我一声|别忘了|记得|记得要|待会|等下|等会儿|约好|定个/.test(_ut) &&
          /(点|明天|后天|今天|今晚|上午|下午|晚上|周[一二三四五六日天]|小时|分钟|\d{1,2}[:：]\d{2})/.test(_ut);
        if (_intent) {
          var _ts = planDueTs(_ut);
          if (_ts) {
            var _txt = _ut.replace(/^[，,。\s]+/, '').slice(0, 60);
            planItemAdd(_txt, _ut.match(/@?[^，。]{0,20}(点|明天|后天|今天|今晚|周[一二三四五六日天])[^，。]{0,10}/) ? _ut : _txt, 'ai');
            actPush('这算个约定，先记进计划了', 'done');
          }
        }
      }
      if (settings.injAutoMem && parsed.ops.length) {
        var added = applyMemoryOps(parsed.ops);
        if (added.length) {
          saveMemory();
          renderMemory();
          var named = added.filter(function (a) { return a.kind === 'key' || a.kind === 'word'; });
          if (named.length) {
            toast('她记下了「' + named[0].label + '」' + (added.length > 1 ? ' 等 ' + added.length + ' 条' : ''), 'warm');
          } else {
            toast('她记下了 ' + added.length + ' 件小事', 'warm');
          }
        }
      }

      var stk = maybePickSticker(parsed.emotion || guessEmotion(parsed.text));
      if (stk) {
        chat.messages.push({ id: uid(), role: 'assistant', text: '', ts: Date.now() + 1, sticker: stk.id });
      }
    }

    saveChat();
    renderChat(true);
    renderStorage();
    /* 每两轮整理一次记忆，别等模型自己吐指令 */
    memTurns++;
    if (memTurns >= 2) { memTurns = 0; memoryAutoExtract().catch(function () { }); }
    memeAutoLearn().catch(function () { });
  }

  /* attsOnly：只发附件，输入框里已经打好的字留着，不当附件一起发出去 */
  async function sendCurrent(attsOnly) {
    if (qqReady() && qqWsUrl()) qqEnsureConnected(false).catch(function () { });
    if (abortCtl) { toast('等她说完这句', 'warm'); return; }
    var m = currentUserMessage(attsOnly);
    if (!m) return;
    var input = $('#chatInput');
    if (input && !attsOnly) { input.value = ''; autoGrow(input); }
    pendingAtts = [];
    renderAtts();
    chat.messages.push(m);
    saveChat();
    renderChat(true);
    reactToUserText(m.text) || nudgeVitals(+4);   /* 你带着情绪说话她会接住，否则心跳抬一下 */
    await runAssistant();
  }

  /* 重新生成：以「整段回复」为单位，不是单条气泡。
     · 点最后一段回复里的任意一条 → 整段重来，没有别的东西会丢，不弹窗；
     · 点更早的回复 → 后面的对话都得删掉，先问过你再动手。 */
  async function regenerate(id) {
    if (abortCtl) return;
    var i = chat.messages.findIndex(function (x) { return x.id === id; });
    if (i < 0) return;

    var lastUser = -1;
    chat.messages.forEach(function (m, k) { if (m.role === 'user') lastUser = k; });
    var trailStart = lastUser + 1;

    if (i >= trailStart) {
      chat.messages.splice(trailStart);
    } else {
      var rounds = 0;
      for (var k = i; k < chat.messages.length; k++) if (chat.messages[k].role === 'user') rounds++;
      var ok = await confirmBox('从这里重新开始？',
        '这一句之后还有 ' + rounds + ' 轮对话，会一起删掉，然后她重新回答这一句。',
        '删掉后面的，重来', true);
      if (!ok) return;
      chat.messages.splice(i);
    }
    saveChat();
    renderChat(true);
    await runAssistant();
  }

  /* -------------------------------------------------------------- 附件区 UI */
  function renderAtts() {
    var strip = $('#attStrip');
    if (!strip) return;
    var list = $('#attList');
    var cnt = $('#attCount');
    var only = $('#attOnlyLabel');
    if (list) list.innerHTML = '';
    strip.hidden = pendingAtts.length === 0;
    if (cnt) cnt.textContent = pendingAtts.length;
    if (only) {
      var imgs = pendingAtts.filter(function (a) { return a.kind === 'image'; }).length;
      only.textContent = imgs === pendingAtts.length ? '只发图片' : (imgs ? '只发附件' : '只发文件');
    }
    if (!list) return;

    pendingAtts.forEach(function (a, i) {
      var d = document.createElement('div');
      d.className = 'att';
      var thumb = a.kind === 'image' && a.data
        ? '<img src="' + a.data + '" alt="">'
        : '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-file"/></svg>';
      d.innerHTML = thumb + '<span class="att-name">' + esc(a.name) + '</span>' +
        '<button class="att-x" title="移除" aria-label="移除附件"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-close"/></svg></button>';
      d.querySelector('.att-x').onclick = async function () {
        if (await confirmBox('移除这个附件？', a.name, '移除')) {
          pendingAtts.splice(i, 1);
          renderAtts();
        }
      };
      list.appendChild(d);
    });
  }

  async function addFiles(files, kind) {
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      try {
        if (kind === 'image' || /^image\//.test(f.type)) {
          var ib = imgBudget();
          var data = await compressImage(f, ib.chat, ib.chatQ);
          pendingAtts.push({ kind: 'image', name: f.name, mime: 'image/webp', size: f.size, data: data });
        } else {
          var att = { kind: 'file', name: f.name, mime: f.type || '', size: f.size };
          if (isTextFile(f)) att.text = await readTextFile(f);
          else att.text = '';
          pendingAtts.push(att);
          if (!att.text) toast('「' + f.name + '」这个格式暂时读不出内容，只会把文件名告诉她。', 'warm');
        }
      } catch (e) {
        toast('「' + f.name + '」处理失败：' + (e.message || e), 'warm');
      }
    }
    renderAtts();
    var input = $('#chatInput');
    if (input) input.focus();
  }

  function pickFiles(accept, multiple, cb) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept || '';
    inp.multiple = !!multiple;
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.onchange = function () { cb(Array.prototype.slice.call(inp.files || [])); inp.remove(); };
    inp.click();
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(168, ta.scrollHeight) + 'px';
  }

  /* ------------------------------------------------------------ 人设页渲染 */
  function renderPortrait() {
    var img = $('#portraitImg'), empty = $('#portraitEmpty');
    if (!img) return;
    if (assets.portrait) { img.src = assets.portrait; img.hidden = false; if (empty) empty.style.display = 'none'; }
    else { img.hidden = true; img.removeAttribute('src'); if (empty) empty.style.display = ''; }
    var f = $('#herFigure');
    if (f) {
      f.innerHTML = assets.portrait
        ? '<img src="' + assets.portrait + '" alt="' + esc(persona.name || '她') + '">'
        : '<svg class="ic" aria-hidden="true"><use href="#i-heart"/></svg>';
    }
  }
  function renderAvatar() {
    var img = $('#avatarImg'), empty = $('#avatarEmpty');
    if (img) {
      if (assets.avatar) { img.src = assets.avatar; img.hidden = false; if (empty) empty.style.display = 'none'; }
      else { img.hidden = true; img.removeAttribute('src'); if (empty) empty.style.display = ''; }
    }
    var pv = $('#pvAvatar');
    if (pv) pv.innerHTML = assets.avatar
      ? '<img src="' + assets.avatar + '" alt="">'
      : '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-heart"/></svg>';
  }
  function renderPersonaPreview() {
    var n = $('#pvName'), s = $('#pvSay'), hn = $('#herName');
    if (n) n.textContent = persona.name || '未命名';
    if (hn) hn.textContent = persona.name || '未命名';
    if (s) s.textContent = persona.greeting || persona.identity || '你好呀，今天过得怎么样？';
    document.title = persona.name ? ('心枕 · ' + persona.name) : '心枕';
  }
  function renderTags() {
    var box = $('#pTags');
    if (!box) return;
    box.innerHTML = '';
    if (!persona.tags.length) {
      box.innerHTML = '<span class="card-hint">还没有标签，加两个试试</span>';
      return;
    }
    persona.tags.forEach(function (t, i) {
      var c = document.createElement('span');
      c.className = 'chip';
      c.innerHTML = esc(t) + '<button class="chip-x" title="删除" aria-label="删除标签"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-close"/></svg></button>';
      c.querySelector('.chip-x').onclick = async function () {
        if (await confirmBox('删掉这个标签？', t, '删掉')) {
          persona.tags.splice(i, 1); renderTags(); savePersona();
        }
      };
      box.appendChild(c);
    });
  }

  /* -------------------------------------------------------- 「我」那一栏 */
  function renderMe() {
    var img = $('#meAvatarImg'), empty = $('#meAvatarEmpty');
    if (img) {
      if (me.avatar) { img.src = me.avatar; img.hidden = false; if (empty) empty.style.display = 'none'; }
      else { img.hidden = true; img.removeAttribute('src'); if (empty) empty.style.display = ''; }
    }
    var pv = $('#mePreviewAvatar');
    if (pv) pv.innerHTML = me.avatar
      ? '<img src="' + me.avatar + '" alt="">'
      : '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-heart"/></svg>';
    var pn = $('#mePreviewName');
    if (pn) pn.textContent = me.name || '我';
    var n = $('#meName'); if (n && n.value !== me.name) n.value = me.name || '';
    var t = $('#meText'); if (t && t.value !== me.text) t.value = me.text || '';
    renderCharButton();
  }

  /* ------------------------------------------------------ 话语规范那一栏 */
  function renderSpeech() {
    var sp = persona.speech || (persona.speech = { style: '', likes: [], avoids: [], notes: '' });

    var styles = $('#speechStyles');
    if (styles) {
      styles.innerHTML = '';
      SPEECH_STYLES.forEach(function (s) {
        var b = document.createElement('button');
        b.className = 'chip chip-btn' + (sp.style === s.id ? ' is-on' : '');
        b.textContent = s.label;
        b.onclick = function () { sp.style = s.id; savePersona(); renderSpeech(); };
        styles.appendChild(b);
      });
    }

    var chipList = function (host, arr, key) {
      var box = $(host);
      if (!box) return;
      box.innerHTML = '';
      if (!arr.length) {
        box.innerHTML = '<span class="card-hint">还没有</span>';
        return;
      }
      arr.forEach(function (w, i) {
        var c = document.createElement('span');
        c.className = 'chip';
        c.innerHTML = esc(w) + '<button class="chip-x" title="删除" aria-label="删除"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-close"/></svg></button>';
        c.querySelector('.chip-x').onclick = async function () {
          if (await confirmBox('删掉「' + w + '」？', '删掉之后她就不受这条约束了。', '删掉')) {
            arr.splice(i, 1); savePersona(); renderSpeech();
          }
        };
        box.appendChild(c);
      });
    };
    chipList('#speechLikes', sp.likes, 'likes');
    chipList('#speechAvoids', sp.avoids, 'avoids');

    var nt = $('#speechNotes');
    if (nt && nt.value !== (sp.notes || '')) nt.value = sp.notes || '';
  }

  function bindSpeech() {
    var wire = function (inputSel, hostSel, key, label) {
      var inp = $(inputSel);
      if (!inp) return;
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
          e.preventDefault();
          var v = inp.value.trim();
          if (!v) return;
          var arr = persona.speech[key];
          if (arr.length >= 24) { toast(label + '最多 24 个', 'warm'); return; }
          if (arr.indexOf(v) < 0) arr.push(v);
          inp.value = '';
          savePersona(); renderSpeech();
        } else if (e.key === 'Backspace' && !inp.value && persona.speech[key].length) {
          persona.speech[key].pop(); savePersona(); renderSpeech();
        }
      });
    };
    wire('#speechLikeInput', '#speechLikes', 'likes', '偏爱用词');
    wire('#speechAvoidInput', '#speechAvoids', 'avoids', '少用词');
    var nt = $('#speechNotes');
    if (nt) nt.addEventListener('input', function () { persona.speech.notes = nt.value; savePersona(); });
  }

  /* --------------------------------------------------------- 角色切换 UI */
  function renderCharButton() {
    var av = $('#charAvatar'), nm = $('#charName');
    if (av) {
      av.innerHTML = assets.avatar
        ? '<img src="' + assets.avatar + '" alt="">'
        : '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-heart"/></svg>';
    }
    if (nm) nm.textContent = charName(activeId);
    var bt = $('#btnChar');
    if (bt) bt.title = '当前角色：' + charName(activeId) + '（点击切换）';
  }

  function renderCharPop() {
    var box = $('#charPopList');
    if (!box) return;
    box.innerHTML = '';
    characters.forEach(function (c) {
      var row = document.createElement('button');
      row.className = 'char-row' + (c.id === activeId ? ' is-current' : '');
      row.dataset.char = c.id;
      var showAv = (c.id === activeId && assets.avatar);
      row.innerHTML =
        '<span class="char-av">' + (showAv
          ? '<img src="' + assets.avatar + '" alt="">'
          : '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-heart"/></svg>') + '</span>' +
        '<span class="char-meta"><b>' + esc(c.name) + '</b>' +
        '<span>' + (c.id === activeId ? '当前' : '') + '</span></span>' +
        (characters.length > 1 ? '<span class="char-del" title="删除这个角色"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-trash"/></svg></span>' : '');
      row.onclick = async function (e) {
        if (e.target.closest('[class="char-del"]') || e.target.closest('.char-del')) {
          e.stopPropagation();
          if (await confirmBox('删除「' + c.name + '」？',
            '她的立绘、人设、记忆、表情包、聊天记录和设置会一起删掉，删了找不回来。', '删除', true)) {
            if (characters.length <= 1) { toast('至少得留一个角色', 'warm'); return; }
            closeCharPop();
            deleteCharacter(c.id);
          }
          return;
        }
        if (c.id === activeId) { closeCharPop(); return; }
        closeCharPop();
        switchCharacter(c.id);
      };
      box.appendChild(row);
    });
  }

  function openCharPop() {
    var p = $('#charPop'), b = $('#btnChar');
    if (!p) return;
    renderCharPop();
    p.hidden = false;
    if (b) b.setAttribute('aria-expanded', 'true');
  }
  function closeCharPop() {
    var p = $('#charPop'), b = $('#btnChar');
    if (p) p.hidden = true;
    if (b) b.setAttribute('aria-expanded', 'false');
  }

  function bindCharSwitcher() {
    var b = $('#btnChar');
    if (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var p = $('#charPop');
        if (p && !p.hidden) closeCharPop(); else openCharPop();
      };
    }
    var nb = $('#btnNewChar');
    if (nb) {
      nb.onclick = async function (e) {
        e.stopPropagation();
        var name = await promptBox('新建角色', '给她起个名字。人设、记忆、聊天记录和设置都是独立的，接口会沿用当前角色。', '例如：苏晚', '');
        if (name === null) return;
        closeCharPop();
        createCharacter(name);
      };
    }
    document.addEventListener('click', function (e) {
      var p = $('#charPop');
      if (p && !p.hidden && !e.target.closest('#charPop') && !e.target.closest('#btnChar')) closeCharPop();
    });
  }

  /* 带动画、可取消的开屏 */
  function hideBoot() {
    var b = $('#booting');
    if (!b || b.classList.contains('is-done')) return;
    b.classList.add('is-done');
  }

  /* ------------------------------------------------------------ 关于页 */
  var CHANGELOG = [
    {
      v: '1.0.4',
      items: [
        ['修', '重复回答与错乱：主人连发时的上下文不再重复塞同一条（之前同一句话进了两遍，她就当没说过，来回重讲）'],
        ['修', '等待回复时点「测试连接」不会再让她重发一遍（只让那一次不流式，不再改全局设置）'],
        ['修', '和主人的 QQ 聊天不再记进「最近的消息」（统一只在「对话」里看），补收历史也不会再建出主人的会话'],
        ['新', 'B 站没登录也能读到简介和热门评论区（有字幕就读字幕），挑视频不再只看标题'],
        ['新', '服务端新增 /bili/video：一次拿全简介 + 评论 + 字幕']
      ]
    },
    {
      v: '1.0.3',
      items: [
        ['更新', 'B 站不用桌面版了：服务器上的常驻客户端代发请求，页面内扫码登录']
      ]
    },
    {
      v: '1.0.2',
      items: [
        ['新', '设置里「让她自己记」多了「梗知识」开关：想让她自己记梗就开，不想就关'],
        ['新', '「大肥鱼」作为基础模板：第一次打开就是这套人设，也在「套用模板」里随时能套回去（模板只带人设，不带记忆/关键词/梗/计划）'],
        ['新', '导出重做：可选「当前 AI / 全部数据」×「JSON / Markdown」，先弹确认窗口；备份不含模型接口和 NapCat 密钥'],
        ['新', '导入重做：支持 json / md（自己导的或别人分享的都行），可选「共存」或「覆盖」'],
        ['新', '删除数据改成「删除当前 AI 数据」：只删这一个角色，5 秒倒计时确认'],
        ['修', '所有确认框统一用应用内样式，不再出现浏览器原生弹窗'],
        ['修', '导入时保留本机已填的模型接口，不被备份里的空值覆盖']
      ]
    },
    {
      v: '1.0.1',
      items: [
        ['新', '计划绑定时钟：每条计划自带准确到点时间、界面显示倒计时，到点她用自己口吻发消息（页面关着由常驻客户端发）'],
        ['新', '她会自己定计划：你说“明早八点提醒我吃药”，她当场定一条并换算成绝对时间；做完了会自己标完成'],
        ['新', '梗知识改成她主动记：聊到新梗/黑话/暗号直接入库，另有 25 分钟一次的补记'],
        ['新', '提示词加入【这一周的日期】：昨天→后天、整周的日期星期都在，换算“下周三”“三天后”不再出错'],
        ['修', '记忆错乱：内容相近的记忆不再重复记成多条，会自动合并更新'],
        ['修', '和主人的 QQ 聊天现在也会出现在「最近的消息」（以前只在「对话」），她说的话两边都能看到'],
        ['修', '回复里不再漏出 [[计划:…]] 这类隐藏指令'],
        ['修', '常驻客户端判定到点时毫秒/秒混用导致不触发']
      ]
    },
    {
      v: '1.0.0',
      items: [
        ['正式版', '第一个正式版本：对话 / 人设 / 记忆 / 计划 / 日记 / 表情包 / 梗知识 / 名单 / 外接（QQ、B 站）全线打通'],
        ['新', '侧栏自带日历时钟：每秒走字，点开是月历，显示「现在」和「上次说话多久以前」'],
        ['新', '提示词里带【现在】：年月日、星期、时分秒都告诉她，久别重逢也知道过了多久'],
        ['新', '人设新增「日记」：每天 0 点后自己写一篇当天的日记，语气像真人；也能随时让她补一篇'],
        ['新', '接口适配 Anthropic（/messages 协议，x-api-key 自动切换）'],
        ['新', '模型接口可以填上下文长度，支持 128k / 1m 这种写法'],
        ['修', '连发消息会攒成一轮再回（第一句等 N 秒），且不会再因为上下文为空而不回'],
        ['修', '回复真的一句一条：按行、按句、按逗号三级切分，句末不带句号'],
        ['修', '表情包能自动收录了（主人同一张发满 3 次），梗知识每 6 小时自动学一次'],
        ['修', '重连/保活/掉线自救全部收进常驻客户端一个服务，掉线会自己重启容器并登录回来'],
        ['修', '对话里不再重复显示旧消息、不再重复回同一条'],
        ['界面', '「关于」改成「文档」：仿 DeepSeek 文档排版，含 QQ / B 站完整部署流程与各功能教程'],
        ['界面', '聊天消息标出来源（心枕 / QQ / B 站）；时钟移到角色头像上方']
      ]
    },
    {
      v: '0.9.8',
      items: [
        ['更新', '自带日历时钟：侧栏每秒走字、点开是月历；提示词里带「现在」和「隔了多久」']
      ]
    },
    {
      v: '0.9.7',
      items: [
        ['更新', '分条：一句话里有几段就拆几条，长句按逗号再切；提示词要求 2~3 条短句']
      ]
    },
    {
      v: '0.9.6',
      items: [
        ['更新', '重连/保活/掉线自救全部收进常驻客户端一个服务（不再有单独的 qqguard 与 cron）；文档相应改写']
      ]
    },
    {
      v: '0.9.5',
      items: [
        ['更新', '修：连发攒成一回时上下文为空导致不回；句末句号统一去掉']
      ]
    },
    {
      v: '0.9.4',
      items: [
        ['更新', '关于改成文档（仿 DeepSeek 排版，含 QQ/B 站部署与各功能教程）；首句等待生效；QQ 句末不带句号；常驻开关布局修正']
      ]
    },
    {
      v: '0.9.3',
      items: [
        ['更新', '别再让空白角色把服务器上的配置（主人/记忆/计划）冲掉']
      ]
    },
    {
      v: '0.9.2',
      items: [
        ['更新', '常驻客户端回复前去掉隐藏指令；计划到点由服务端兜底触发；只写 HH:MM 的时间也认']
      ]
    },
    {
      v: '0.9.1',
      items: [
        ['更新', 'QQ 回复默认一句一条；当前行为卡移到右栏；接口支持 Anthropic；计划加到期解析与到点触发']
      ]
    },
    {
      v: '0.9.0',
      items: [
        ['更新', '机器人登录失效时页面直接提示并给出二维码；常驻客户端修掉服务器访问自己公网 IP 的超时']
      ]
    },
    {
      v: '0.8.9',
      items: [
        ['记忆', '每条记忆、关键词都标上 年-月-日 时:分:秒'],
        ['记忆', '轻度记忆只留 7 天，过期的按「整天」合并成 1 条关键记忆'],
        ['记忆', '计划、待办不再写进关键记忆，交给新的「计划」页'],
        ['计划', '人设里新增「计划」页签：她说要做的事、你交代的事，一条条列着，做完打勾'],
        ['QQ', '表情包和图片分开识别：表情包只理解情绪、不描述画面；图片才聊内容'],
        ['设置', '模型接口新增「上下文长度」，可以填 128k、1m 这种带单位的值'],
        ['界面', '删掉「拆成几条」下面那句冗余提示']
      ]
    },
    {
      v: '0.8.8',
      items: [
        ['更新', '页面开着也每 60 秒跟常驻客户端对账；启动时立刻补收一次']
      ]
    },
    {
      v: '0.8.7',
      items: [
        ['更新', '补收的消息会真的回（合并成一轮）；连接重建去抖']
      ]
    },
    {
      v: '0.8.6',
      items: [
        ['更新', '补收的消息会真的回（之前被去重挡掉）；连接重建去抖，别被 focus/心跳反复打断']
      ]
    },
    {
      v: '0.8.5',
      items: [
        ['更新', '外接 QQ 加「第一句等几秒」：连发几条攒成一回；常驻客户端同样生效']
      ]
    },
    {
      v: '0.8.4',
      items: [
        ['更新', '记忆自动整理：QQ/B 站回完也会提炼；面板显示上次整理时间与条数；打开页面补一次']
      ]
    },
    {
      v: '0.8.3',
      items: [
        ['更新', '补收只往回翻 12 小时，避免对话里翻出一堆旧消息']
      ]
    },
    {
      v: '0.8.2',
      items: [
        ['更新', '同一条消息只处理一次（重连重推/常驻补收撞车都会去重）']
      ]
    },
    {
      v: '0.8.1',
      items: [
        ['更新', '修对话里重复消息/重复回复；分条更稳（不足 splitMin 时按句子补足）']
      ]
    },
    {
      v: '0.8.0',
      items: [
        ['更新', '常驻客户端能替她回消息：页面同步人设/记忆/名单/模型；页面在线时自动交还']
      ]
    },
    {
      v: '0.7.9',
      items: [
        ['更新', '常驻客户端状态显示存档条数']
      ]
    },
    {
      v: '0.7.8',
      items: [
        ['更新', '新增服务器常驻客户端（代替页面）：页面关着也收消息，回来时自动补收']
      ]
    },
    {
      v: '0.7.7',
      items: [
        ['更新', '连接卡在「连接中」12 秒会自动掐掉重连；补上 qqConnect/qqSnapshot 自检接口']
      ]
    },
    {
      v: '0.7.6',
      items: [
        ['更新', '切回标签页自动体检并补收漏掉的消息；对话发送前先确认一次 QQ 连接']
      ]
    },
    {
      v: '0.7.5',
      items: [
        ['更新', '切回标签页自动体检+补收；对话发送前会先确认一次 QQ 连接']
      ]
    },
    {
      v: '0.7.4',
      items: [
        ['更新', '把连接体检接口暴露出来，方便自检与排查']
      ]
    },
    {
      v: '0.7.3',
      items: [
        ['更新', '补收不再漏掉主人（新增 tracked 名单）；发消息前自动体检一次 QQ 连接']
      ]
    },
    {
      v: '0.7.2',
      items: [
        ['更新', '外接 B 站「当前行为」清掉历史（老记录混着 QQ 的），并加清空按钮']
      ]
    },
    {
      v: '0.7.1',
      items: [
        ['更新', '对话里给每条消息加来源小标记（QQ / B 站 / 心枕）；B 站私聊只把主人的同步进对话']
      ]
    },
    {
      v: '0.7.0',
      items: [
        ['更新', 'B 站加「最近的消息」（评论/私聊/视频互动）；主人 QQ 私聊同步进「对话」；名单页 QQ 在前']
      ]
    },
    {
      v: '0.6.9',
      items: [
        ['更新', '主人消息先落库再回（修回消息时上下文为空）；B 站消息记录接口补上']
      ]
    },
    {
      v: '0.6.8',
      items: [
        ['更新', '主人私聊同步：她自己的回复也不再进最近消息；纯图片消息不再重复写[图片]']
      ]
    },
    {
      v: '0.6.7',
      items: [
        ['更新', '名单页也把 QQ 放到 B 站前面并默认显示']
      ]
    },
    {
      v: '0.6.6',
      items: [
        ['更新', '主人私聊（QQ/B 站）同步进「对话」，含图片和引用；外接最近消息不再重复记主人；B 站新增「最近的消息」（评论/私聊/视频播放弹幕）']
      ]
    },
    {
      v: '0.6.5',
      items: [
        ['更新', '外接页头部按钮两个栏都绑上（在 QQ 栏时 B 站「刷一轮」不会变哑）']
      ]
    },
    {
      v: '0.6.4',
      items: [
        ['更新', '修 QQ 行为记录的归属（之前被错记到 B 站那份）']
      ]
    },
    {
      v: '0.6.3',
      items: [
        ['更新', '外接页 QQ 放到 B 站前面并默认显示；QQ 令牌加显示/隐藏；B 站「当前行为」只记 B 站、QQ 单开一份']
      ]
    },
    {
      v: '0.6.2',
      items: [
        ['更新', '对话记忆改成每两轮自动提炼一次（不用等模型自己吐指令）；记忆面板加「整理一次」按钮']
      ]
    },
    {
      v: '0.6.1',
      items: [
        ['更新', '版本号规则改为每次只 +0.0.1（0.6.9 之后是 0.7.0）；补上 QQ 掉线自动重登的看门狗说明']
      ]
    },
    {
      v: '0.6.0',
      items: [
        ['新增', '主动找 TA 说话：对谁发（主人 / 白名单 / 所有私聊）、对方安静几小时、两次间隔、每天上限、安静时段、想说的方向'],
        ['新增', '「试一条」按钮可以立刻发一条看看效果']
      ]
    },
    {
      v: '0.5.3',
      items: [
        ['修复', '打开页面就自动连 QQ（以前要手动点「测试连接」才会连，刷新后就不收了）'],
        ['新增', '页面会把连接状态上报到服务器 /qq/diag，断连时能查清楚是哪一环'],
        ['新增', '前端报错会写进调试字段一同上报']
      ]
    },
    {
      v: '0.5.2',
      items: [
        ['新增', '重连后补收：掉线期间没看到的消息会在连上时拉回来（每个会话只回最后一条）'],
        ['新增', '设置里多一个「重连后补收消息」开关，默认开']
      ]
    },
    {
      v: '0.5.1',
      items: [
        ['修复', '识图修好了：QQ 的图先抓下来转成 dataURL 再给模型（上游拿不到 QQ 的临时直链）'],
        ['修复', '引用消息里的图也能看了（reply 段去 NapCat 取原消息）'],
        ['修复', '取图代理放行 multimedia.nt.qq.com.cn（QQ 新版图片域名）'],
        ['修复', '断线重连更积极：70 秒没心跳就重连，另加 30 秒一次 HTTP 探活，切回页面/联网立刻重连']
      ]
    },
    {
      v: '0.5.0',
      items: [
        ['新增', '主人永远不会被叫 QQ 昵称：提示词里禁掉，回复里再抹一遍'],
        ['新增', '「拆成几条」改成区间（1~3、3~5 这种），每次在区间里随机'],
        ['新增', '自动识图：把 TA 发来的图片/表情一起丢给模型看（要选支持看图的模型）'],
        ['新增', '主人私聊里的表情包，同一张发满 3 次自动收进表情包库'],
        ['新增', '私聊面板多了「表情」按钮，可以直接把表情包发给 QQ 好友/群'],
        ['新增', 'QQ / B 站私聊里的记忆指令会写进人设记忆（只限白名单和主人）'],
        ['新增', '「梗知识」自动学习会把 QQ 和 B 站私聊的聊天一起翻一遍'],
        ['新增', 'B 站私聊里主人发的图，同一张 3 次也收进表情包库']
      ]
    },
    {
      v: '0.4.6',
      items: [
        ['修复', 'QQ 事件掉线后不再自动重连（老代码要求 qq.me 存在，刷新后就没值了），现在退避重连 + 心跳看门狗'],
        ['更新', '断网恢复 / 切回标签页时会自动重连']
      ]
    },
    {
      v: '0.4.5',
      items: [
        ['更新', '主人 = 最高一级的白名单：不用再加白名单，永远主动回复（不受「回谁的消息」开关影响）'],
        ['更新', '名单列表里主人排在最上面，带「主人 · 白名单」标签']
      ]
    },
    {
      v: '0.4.4',
      items: [
        ['更新', 'QQ 收到却不回时，会话里直接写原因（不在白名单 / 群里没 @ / 冷却中 / 模型没出话）']
      ]
    },
    {
      v: '0.4.3',
      items: [
        ['更新', '支持 ?api=&key=&model= 一条链接把接口填好（打开后自动从地址栏抹掉）']
      ]
    },
    {
      v: '0.4.2',
      items: [
        ['更新', '网页版也能用 QQ：没有桌面桥时走同源 /qq/api、/qq/ws 反代'],
        ['更新', '网页版隐藏 NapCat 部署器（那是给本机 QQ 用的）']
      ]
    },
    {
      v: '0.4.1',
      items: [
        ['更新', 'QQ 回复会像真人那样拆成几条短消息发，中间留打字停顿'],
        ['更新', 'QQ 设置新增：拆成几条、每两条之间几秒、只对白名单拆条'],
        ['新功能', '外接 → QQ 加了 NapCat 部署器：认本机 QQ、一键部署、写配置、启动 QQ'],
        ['新功能', '便携版：装完 QQ 之后一键接管，不用再手填地址和令牌']
      ]
    },
    {
      v: '0.4.0',
      items: [
        ['新功能', '外接、名单 各分成「B 站」「QQ」两个小页，各自独立'],
        ['新功能', '接入 QQ（NapCat / OneBot 11）：连上就能收消息、按名单自动回、手动回'],
        ['新功能', 'QQ 名单：主人、称呼、好感度、白名单 / 黑名单'],
        ['修复', '舞台容器被提前闭合，页面被挤到中间、底部留一大片空白']
      ]
    },
    {
      v: '0.3.3',
      items: [
        ['修复', '外接页底部那一大条空白：两栏重新分过，日报收进右栏，左右高度对齐'],
        ['更新', '「现在刷一轮」挪到页头，滚到哪儿都在'],
        ['更新', '名单页的说明挪到右栏，右侧不再空一大块']
      ]
    },
    {
      v: '0.3.2',
      items: [
        ['更新', '刷 B 站分成「刷一轮」和「自动刷」：自动刷可以设频率和时间范围'],
        ['更新', '外接新增「评论」卡：要不要评论、评论频率、每轮几条、@ 谁'],
        ['更新', '名单新增「主人」：填自己的 UID，称呼跟着人设走'],
        ['修复', '日报改成「今天的日报」和「历史日报」两块，不再一条横着铺满']
      ]
    },
    {
      v: '0.3.1',
      items: [
        ['更新', '外接页重排：顶部只留一条，左三右三，日报收成小卡，点开是窗口'],
        ['更新', '私聊改成三个开关：白名单 / 普通 / 黑名单，分别决定回不回'],
        ['更新', '关注关键词不再限制个数'],
        ['优化', '私信与评论加了隐私红线：非白名单不进人设和记忆，出站再洗一遍路径、密钥、名字']
      ]
    },
    {
      v: '0.3.0',
      items: [
        ['更新', '侧边栏新增「名单」：靠 UID 认人，设称呼、好感度、黑白名单'],
        ['更新', '外接新增私聊：同步 B 站私信，白名单会自动回，黑名单当没看见'],
        ['更新', '刷 B 站会跳过黑名单的视频；白名单聊天时好感度涨得更快'],
        ['更新', '人设新增「梗知识」：她认得梗，也会用；支持自动学习'],
        ['更新', '外接新增「当前行为」，能看见她这会儿在做什么'],
        ['修复', '对话页输入区与右侧立绘栏的样式丢失']
      ]
    },
    {
      v: '0.2.0',
      items: [
        ['更新', '外接新增「刷 B 站」：按关键词替你挑视频，读完字幕再写日报'],
        ['更新', '日报留最近 14 天，可以按谷时自动刷；登录后能读字幕、自动评论并 @ 你'],
        ['移除', 'Q宠模块整体移除（页面、桌面悬浮窗与宠物编辑器）'],
        ['优化', '外接页改成两栏：左边调设置，右边看今天的日报']
      ]
    },
    {
      v: '0.1.0',
      items: [
        ['更新', '新增角色管理，每个角色的立绘、人设、记忆、聊天与设置相互独立'],
        ['更新', '人设新增「话语规范」与「我」，可约束她的用词并设定你的资料'],
        ['更新', '新增开屏动画与角色切换入口'],
        ['优化', '回复改为整条逐条送达，不再逐字流出'],
        ['优化', '存储自动使用浏览器数据库，容量不再受 5MB 限制'],
        ['修复', '重新生成后回答前后不连贯的问题'],
        ['修复', '关于页无法滚动的问题']
      ]
    },
    {
      v: '0.0.9',
      items: [
        ['更新', '她会自己记下重要的事，并整理关键词'],
        ['更新', '表情包可绑定情绪，按概率主动发送'],
        ['优化', '心跳与心情随对话实时变化'],
        ['优化', '单次回复上限改为按字数计算'],
        ['修复', '接口返回非 JSON 时的报错提示不明的问题']
      ]
    },
    {
      v: '0.0.8',
      items: [
        ['更新', '人设、对话、设置三个模块'],
        ['更新', '立绘、头像、关键记忆、轻度记忆与表情包库'],
        ['优化', '凝脂与天水碧两套配色，圆角与动效规范']
      ]
    }
  ];

  function renderChangelog() {
    var box = $('#changelog');
    if (!box) return;
    if (!box.children.length) {
      box.innerHTML = CHANGELOG.slice(0, 3).map(function (log) {
        var items = log.items.map(function (it) {
          var cls = it[0] === '修复' ? ' is-fix' : (it[0] === '优化' ? ' is-opt' : '');
          return '<div class="log-item"><span class="log-tag' + cls + '">' + it[0] + '</span>' +
            '<span class="log-text">' + esc(it[1]) + '</span></div>';
        }).join('');
        return '<div class="log-block"><div class="log-ver"><b>v' + log.v + '</b></div>' +
          '<div class="log-items">' + items + '</div></div>';
      }).join('');
    }
    var av = $('#aboutVersion');
    if (av) av.textContent = 'v' + VERSION;
    if (av) av.textContent = 'v' + VERSION;
  }

  function emptyBlock(icon, title, text, buttons) {
    var d = document.createElement('div');
    d.className = 'empty';
    d.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#' + icon + '"/></svg>' +
      '<div class="empty-title">' + esc(title) + '</div>' +
      '<div class="empty-text">' + esc(text) + '</div>';
    if (buttons && buttons.length) {
      var a = document.createElement('div');
      a.className = 'empty-actions';
      buttons.forEach(function (b) {
        var btn = document.createElement('button');
        btn.className = 'btn btn-sm' + (b.primary ? ' btn-primary' : '');
        btn.textContent = b.label;
        btn.onclick = b.onClick;
        a.appendChild(btn);
      });
      d.appendChild(a);
    }
    return d;
  }

  /* -------------------------------------------------------------- 日记 */
  function diaryDayKey(ts) {
    var d = new Date(Number(ts) || Date.now());
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  function diaryHas(day) {
    return (diary.items || []).some(function (x) { return x.date === day; });
  }

  /* 那天发生了什么：当天的对话 + 当天新增的记忆/计划 */
  function diarySource(day) {
    var lines2 = [];
    (chat.messages || []).forEach(function (m) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || !m.text) return;
      if (diaryDayKey(m.ts) !== day) return;
      lines2.push((m.role === 'user' ? '对方' : (persona.name || '我')) + '：' + String(m.text).slice(0, 200));
    });
    var mem = (memory.key || []).filter(function (x) { return diaryDayKey(x.ts) === day; })
      .map(function (x) { return '（今天记住的）' + (x.title ? x.title + '：' : '') + x.text; });
    var lit = (memory.light || []).filter(function (x) { return diaryDayKey(x.ts) === day; })
      .map(function (x) { return '（今天的小事）' + x.text; });
    var pl = (plans.items || []).filter(function (x) {
      return diaryDayKey(x.ts) === day || (x.doneAt && diaryDayKey(x.doneAt) === day);
    }).map(function (x) { return '（计划）' + x.text + (x.done ? '（今天做完了）' : '（还没做完）'); });
    return lines2.concat(mem, lit, pl).slice(-60).join('\n');
  }

  var diaryBusy = false;
  async function diaryWrite(day, force) {
    if (diaryBusy) return 0;
    var d0 = day || diaryDayKey(Date.now());
    if (!force && diaryHas(d0)) return 0;
    var src = diarySource(d0);
    if (!src.trim()) return 0;
    if (!settings.baseUrl || !settings.model) return 0;
    diaryBusy = true;
    try {
      var out = await chatCompletion([
        {
          role: 'system',
          content: '你在帮「' + (persona.name || '她') + '」写日记。要求：\n' +
            '- 第一人称，用她自己的口吻，像真人在手机备忘录里随手写的；\n' +
            '- 有具体的事、具体的细节和自己的情绪，可以写乱一点、可以有一句突然的感慨；\n' +
            '- 不要总结陈词、不要分小标题、不要「今天真是充实的一天」这种模板句、不要提 AI 或记录；\n' +
            '- 长短随意，一般 150~400 字。\n' +
            '只输出日记正文。\n\n' + buildSystemPrompt()
        },
        { role: 'user', content: '日期：' + d0 + '\n这天发生的事：\n' + src + '\n\n用她的口吻写今天的日记。' }
      ], { stream: false, chars: 700, temperature: 0.95, timeout: 120 });
      var text = String(out || '').trim();
      if (!text) return 0;
      diary.items = (diary.items || []).filter(function (x) { return x.date !== d0; });
      diary.items.unshift({ id: 'dy' + Date.now().toString(36), date: d0, text: text, ts: Date.now(), by: 'ai' });
      if (diary.items.length > 120) diary.items = diary.items.slice(0, 120);
      saveDiary();
      renderDiary();
      actPush('写完了 ' + d0 + ' 的日记', 'done');
      return 1;
    } catch (e) {
      diary.lastErr = String(e.message || e).slice(0, 120);
      return 0;
    } finally {
      diaryBusy = false;
    }
  }

  /* 过 0 点后补写昨天的（当天没写就写当天的） */
  async function diaryAuto() {
    var now = new Date();
    var today = diaryDayKey(now.getTime());
    if (!diaryHas(today)) return diaryWrite(today, false);
    var y = new Date(now.getTime() - 86400000);
    var yk = diaryDayKey(y.getTime());
    if (!diaryHas(yk)) return diaryWrite(yk, false);
    return 0;
  }

  function renderDiary() {
    var box = $('#diaryList');
    if (!box) return;
    var items = (diary.items || []).slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    var hint = $('#diaryHint');
    if (hint) hint.textContent = items.length ? ('已经写了 ' + items.length + ' 篇') : '每晚 0 点过后自己写一篇';
    box.innerHTML = items.length ? items.slice(0, 30).map(function (x) {
      return '<div class="diary-row" data-diary="' + esc(x.id) + '">' +
        '<div class="diary-head"><span class="diary-date">' + esc(x.date) + '</span>' +
        '<span class="diary-wd">' + esc(WEEK_CN[new Date(x.date + 'T00:00:00').getDay()] || '') + '</span>' +
        '<button class="diary-del" data-diary-del="' + esc(x.id) + '" title="删除">' +
        '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-trash"/></svg></button></div>' +
        '<div class="diary-text">' + esc(x.text).replace(/\n/g, '<br>') + '</div>' +
        '</div>';
    }).join('') : '<p class="field-note">还没有日记。等到今晚 0 点，她会自己写第一篇；也可以点右上角「现在写一篇」。</p>';
    $$('[data-diary-del]', box).forEach(function (b) {
      b.onclick = function () {
        diary.items = (diary.items || []).filter(function (x) { return x.id !== b.dataset.diaryDel; });
        saveDiary();
        renderDiary();
      };
    });
  }

  /* -------------------------------------------------------------- 计划 */
  /* -------------------------------------------------------------- 计划 */
  function planItemAdd(text, due, by) {
    var t = String(text || '').trim();
    if (!t) return null;
    if (!Array.isArray(plans.items)) plans.items = [];
    var dup = plans.items.filter(function (x) {
      return !x.done && String(x.text).trim() === t;
    })[0];
    if (dup) return dup;
    var dueTxt = String(due || '').slice(0, 40);
    var item = {
      id: 'pl' + Math.random().toString(36).slice(2, 8),
      text: t.slice(0, 200),
      due: dueTxt,
      dueAt: planDueTs(dueTxt) || 0,
      done: false, doneAt: 0, ts: Date.now(), by: by || 'ai'
    };
    plans.items.push(item);
    savePlans();
    renderPlans();
    if (item.dueAt) actPush('定了计划：' + item.text.slice(0, 16) + '（' + fmtSmart(item.dueAt) + '）', 'done');
    return item;
  }

  function planItemDone(word) {
    var w = String(word || '').trim();
    if (!w) return 0;
    var n = 0;
    plans.items.forEach(function (x) {
      if (x.done) return;
      if (String(x.text).indexOf(w) >= 0) { x.done = true; x.doneAt = Date.now(); n++; }
    });
    if (n) { savePlans(); renderPlans(); }
    return n;
  }

  /* 「2026-11-01 20:00」「11-01 20:00」「2026-11-01」都认 */
  function cnNum(m) {
    var t = String(m || '').trim();
    if (/^\d+$/.test(t)) return Number(t);
    var d = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (t === '十') return 10;
    if (/^十[一二三四五六七八九]$/.test(t)) return 10 + d[t[1]];
    if (/^[一二三四五六七八九]十$/.test(t)) return d[t[0]] * 10;
    if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(t)) return d[t[0]] * 10 + d[t[2]];
    return d[t] != null ? d[t] : NaN;
  }

  /* 把「明天晚上八点」「后天 14:30」「周五」「2026-11-02 20:00」都算成绝对时间 */
  function planDueTs(due) {
    var s = String(due || '').trim();
    if (!s) return 0;
    var now = new Date();
    var target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    var hit = false;

    /* 1) 绝对日期 */
    var m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) {
      target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
      hit = true;
    } else {
      var m2 = s.match(/(?:^|[^\d])(\d{1,2})[-/.](\d{1,2})(?!\d)/);
      if (m2) {
        var cand = new Date(now.getFullYear(), Number(m2[1]) - 1, Number(m2[2]), 0, 0, 0, 0);
        if (cand.getTime() < now.getTime() - 180 * 86400000) cand.setFullYear(now.getFullYear() + 1);
        target = cand;
        hit = true;
      }
    }

    /* 2) 相对说法 */
    if (!hit) {
      var off = null;
      if (/大后天/.test(s)) off = 3;
      else if (/后天/.test(s)) off = 2;
      else if (/明天|明早|明晚|明日/.test(s)) off = 1;
      else if (/今天|今晚|今夜/.test(s)) off = 0;
      else if (/昨天|昨晚/.test(s)) off = -1;
      if (off != null) {
        target.setDate(target.getDate() + off);
        hit = true;
      }
    }

    /* 3) 周几 */
    if (!hit) {
      var wm = s.match(/(下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/);
      if (wm) {
        var mapW = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
        var want = mapW[wm[2]];
        var cur = target.getDay();
        var delta = (want - cur + 7) % 7;
        if (delta === 0 && !wm[1]) delta = 7;
        if (wm[1]) delta += 7;
        target.setDate(target.getDate() + delta);
        hit = true;
      }
    }

    /* 4) 时刻：14:30 / 8点半 / 晚上八点 / 十点一刻 */
    var hh = null, mm = 0;
    var t1 = s.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (t1) { hh = Number(t1[1]); mm = Number(t1[2]); }
    else {
      var t2 = s.match(/([一二三四五六七八九十两\d]{1,3})\s*[点時时]\s*(半|一刻|三刻|(\d{1,2})\s*分?)?/);
      if (t2) {
        hh = cnNum(t2[1]);
        if (t2[2] === '半') mm = 30;
        else if (t2[2] === '一刻') mm = 15;
        else if (t2[2] === '三刻') mm = 45;
        else if (t2[3]) mm = Number(t2[3]);
      }
    }
    if (hh != null && !isNaN(hh)) {
      if (/下午|晚上|傍晚|夜里|今晚|明晚/.test(s) && hh < 12) hh += 12;
      if (/中午/.test(s) && hh < 11) hh += 12;
      if (/凌晨/.test(s) && hh === 12) hh = 0;
      target.setHours(hh, isNaN(mm) ? 0 : mm, 0, 0);
      hit = true;
    } else if (hit && !/\d{1,2}[:：]\d{2}/.test(s)) {
      target.setHours(9, 0, 0, 0);          /* 只说了哪天：按早上 9 点算 */
    }

    if (!hit) {
      /* 5) 只有 HH:MM */
      var t3 = s.match(/^(\d{1,2}):(\d{2})$/);
      if (t3) {
        target.setHours(Number(t3[1]), Number(t3[2]), 0, 0);
        if (target.getTime() < now.getTime() - 60000) target.setDate(target.getDate() + 1);
        return target.getTime();
      }
      return 0;
    }
    if (target.getTime() < now.getTime() - 60000 && !/\d{4}[-/.]/.test(s)) {
      /* 说的是"今天 8 点"但已经过了 → 顺延一天，避免一建就触发 */
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  function planDueAt(x) {
    if (x && x.dueAt) return Number(x.dueAt) || 0;
    return planDueTs(x && x.due);
  }

  function planDueText(x) {
    var ts = planDueAt(x);
    if (!ts) return x.due ? String(x.due) : '';
    var left = ts - Date.now();
    var when = fmtSmart(ts);
    if (x.done) return when;
    if (left <= 0) return when + '（已到点）';
    var h = Math.round(left / 3600000);
    return when + (h >= 1 ? ('（还有 ' + h + ' 小时）') : ('（还有 ' + Math.max(1, Math.round(left / 60000)) + ' 分钟）'));
  }

  /* 到点了就把计划触发一次：页面开着时提醒用户，并让她主动说一句 */
  var planTickTimer = null;
  async function planDueTick() {
    var now = Date.now();
    var due = (plans.items || []).filter(function (x) {
      if (x.done || x.firedAt) return false;
      var ts = planDueAt(x);
      if (!ts) return false;
      return ts <= now && now - ts < 6 * 3600 * 1000;   /* 只补 6 小时内到点的，太旧的不翻 */
    });
    if (!due.length) return 0;
    var fired = 0;
    for (var i = 0; i < due.length; i++) {
      var x = due[i];
      x.firedAt = now;
      savePlans();
      actPush('到点了：' + x.text, 'done');
      toast('计划到点了：' + x.text);
      fired++;
      /* 让她主动跟主人说一句（有主人的 QQ 才发） */
      var master = (roster.qq.master && roster.qq.master.uid) || 0;
      if (master && qqReady() && qq.status === 'ok') {
        try {
          var out = await chatCompletion([
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: '你之前计划要做的事：' + x.text + (x.due ? ('（约好 ' + x.due + '）') : '') +
              '\n现在到时间了。用你自己的口吻跟我说一句，说明你现在就去做/已经做了。一两句，别解释你在做什么程序上的操作。' }
          ], { stream: false, chars: 100, temperature: 0.8, timeout: 60 });
          var t = parseDirectives(String(out || '')).text.trim();
          if (t) await qqSendTo({ uid: master }, t.slice(0, 120), false);
        } catch (e) { }
      }
    }
    renderPlans();
    return fired;
  }


  function planActive() {
    return (plans.items || []).filter(function (x) { return !x.done; });
  }

  function renderPlans() {
    var box = $('#planList');
    if (!box) return;
    var items = plans.items || [];
    var open = items.filter(function (x) { return !x.done; });
    var done = items.filter(function (x) { return x.done; });
    var hint = $('#planHint');
    if (hint) hint.textContent = open.length ? ('还有 ' + open.length + ' 件没做') : '暂时没有计划';
    var rows = open.concat(done.slice(-10).reverse());
    box.innerHTML = rows.length ? rows.map(function (x) {
      return '<div class="plan-row' + (x.done ? ' is-done' : '') + '" data-plan="' + esc(x.id) + '">' +
        '<button class="plan-tick" data-plan-done="' + esc(x.id) + '" title="' + (x.done ? '标记未完成' : '标记已完成') + '">' +
        '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-check"/></svg></button>' +
        '<div class="plan-main">' +
        '<div class="plan-text">' + esc(x.text) + '</div>' +
        '<div class="plan-meta">' +
        (x.due ? ('<span class="plan-due">' + esc(planDueText(x)) + '</span>') : '') +
        '<span>' + (x.done ? ('完成于 ' + fmtFull(x.doneAt)) : ('记于 ' + fmtFull(x.ts))) + '</span>' +
        (x.by === 'me' ? '<span>你交代的</span>' : '') +
        '</div></div>' +
        '<button class="plan-del" data-plan-del="' + esc(x.id) + '" title="删除">' +
        '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-trash"/></svg></button>' +
        '</div>';
    }).join('') : '<p class="field-note">还没有计划。聊天里她说“明天要做完什么”，或者你交代一件事，都会记在这儿。</p>';

    $$('[data-plan-done]', box).forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.planDone;
        var it = plans.items.filter(function (x) { return x.id === id; })[0];
        if (!it) return;
        it.done = !it.done;
        it.doneAt = it.done ? Date.now() : 0;
        savePlans();
        renderPlans();
      };
    });
    $$('[data-plan-del]', box).forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.planDel;
        plans.items = plans.items.filter(function (x) { return x.id !== id; });
        savePlans();
        renderPlans();
      };
    });
  }

  /* 年月日 时分秒 */
  /* --------------------------------------------- 轻度记忆只留 7 天
     过期的按「整天」合并成一条关键记忆，原文不再留着。 */
  var LIGHT_KEEP_DAYS = 7;
  var lightCompacting = false;

  function lightDayKey(ts) {
    var d = new Date(Number(ts) || Date.now());
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  async function memoryCompactLight(force) {
    if (lightCompacting) return 0;
    var cutoff = Date.now() - LIGHT_KEEP_DAYS * 24 * 3600 * 1000;
    var old = (memory.light || []).filter(function (x) { return (Number(x.ts) || 0) < cutoff; });
    if (!old.length) return 0;
    lightCompacting = true;
    try {
      var byDay = {};
      old.forEach(function (x) {
        var k = lightDayKey(x.ts);
        (byDay[k] = byDay[k] || []).push(x);
      });
      memory.compacted = memory.compacted || {};
      var days = Object.keys(byDay).sort();
      var made = 0;
      for (var di = 0; di < days.length; di++) {
        var day = days[di];
        var items = byDay[day];
        var texts = items.map(function (x) { return String(x.text || '').trim(); }).filter(Boolean);
        if (!texts.length) continue;
        var summary = '';
        try {
          summary = await chatCompletion([
            { role: 'system', content: '把下面这一天里的零碎小事，合并成一句第三人称的回忆（不超过 40 字），只写发生过什么、她当时的状态，不要评论、不要编。直接输出那句话，不要引号。' },
            { role: 'user', content: day + '：\n' + texts.map(function (t) { return '- ' + t; }).join('\n') }
          ], { stream: false, chars: 120, temperature: 0.3, timeout: 60 });
        } catch (e) { summary = ''; }
        summary = String(summary || '').replace(/^["'“”‘’]|["'“”‘’]$/g, '').trim();
        if (!summary) summary = texts.slice(0, 4).join('；');
        if (!summary) continue;
        var title = day + ' 那天的碎事';
        var hit = memory.key.filter(function (x) { return (x.title || '') === title; })[0];
        if (hit) {
          hit.text = summary.slice(0, 200);
          hit.ts = Date.now();
        } else {
          memory.key.push({ id: uid(), title: title, text: summary.slice(0, 200), ts: Date.now(), by: 'ai' });
        }
        memory.compacted[day] = Date.now();
        made++;
        if (memory.key.length > 200) memory.key = memory.key.slice(-200);
      }
      /* 原文不再保留（压缩过的整天全丢） */
      memory.light = (memory.light || []).filter(function (x) { return (Number(x.ts) || 0) >= cutoff; });
      saveMemory();
      renderMemory();
      if (made) actPush('把 ' + made + ' 天的轻度记忆收成关键记忆了', 'done');
      return made;
    } catch (e) {
      return 0;
    } finally {
      lightCompacting = false;
    }
  }


  /* ------------------------------------------------ 现在几点 / 日历
     她得知道「现在」和「过了多久」，不然久别重逢会算错时间。 */
  var WEEK_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  function nowParts() {
    var d = new Date();
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return {
      y: d.getFullYear(),
      mo: d.getMonth() + 1,
      day: d.getDate(),
      wd: WEEK_CN[d.getDay()],
      hh: p2(d.getHours()),
      mi: p2(d.getMinutes()),
      ss: p2(d.getSeconds()),
      date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()),
      dateCn: d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日',
      full: d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK_CN[d.getDay()] +
        ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()),
      ts: d.getTime()
    };
  }

  function agoText(ts) {
    var t = Number(ts) || 0;
    if (!t) return '';
    var sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 60) return '刚刚';
    var min = Math.round(sec / 60);
    if (min < 60) return min + ' 分钟前';
    var hr = Math.floor(min / 60), mo2 = min % 60;
    if (hr < 24) return hr + ' 小时' + (mo2 ? (' ' + mo2 + ' 分钟') : '') + '前';
    var day = Math.floor(hr / 24), hr2 = hr % 24;
    return day + ' 天' + (hr2 ? (' ' + hr2 + ' 小时') : '') + '前';
  }

  /* 上一次说话（不含当前这条）的时间 */
  function lastTalkTs() {
    var m = chat.messages || [];
    for (var i = m.length - 2; i >= 0; i--) {
      var x = m[i];
      if (x && (x.role === 'user' || x.role === 'assistant') && x.ts) return Number(x.ts) || 0;
    }
    return 0;
  }

  var clockTimer = null;
  function startClock() {
    var tEl = $('#railClockTime');
    var dEl = $('#railClockDate');
    var btn = $('#railClock');
    if (!tEl || !dEl) return;
    function tick() {
      var n = nowParts();
      tEl.textContent = n.hh + ':' + n.mi + ':' + n.ss;
      dEl.textContent = (n.mo) + '月' + n.day + '日 ' + n.wd.replace('星期', '周');
    }
    tick();
    if (!XZ_SMOKE && !clockTimer) clockTimer = setInterval(tick, 1000);
    /* 时钟顺手当计划闹钟：每秒看一眼有没有到点的 */
    if (!XZ_SMOKE) setInterval(function () { planDueTick().catch(function () { }); }, 10000);
    if (btn) btn.onclick = function () { showCalendar(0); };
  }

  function showCalendar(monthOffset) {
    var l = $('#layer');
    var now = new Date();
    var base = new Date(now.getFullYear(), now.getMonth() + (monthOffset || 0), 1);
    var y = base.getFullYear(), mo = base.getMonth();
    var first = new Date(y, mo, 1);
    var startDay = first.getDay();
    var days = new Date(y, mo + 1, 0).getDate();
    var cells = [];
    for (var i = 0; i < startDay; i++) {
      var pd = new Date(y, mo, 0 - (startDay - 1 - i));
      cells.push('<div class="cal-cell is-out">' + pd.getDate() + '</div>');
    }
    for (var d = 1; d <= days; d++) {
      var isToday = (y === now.getFullYear() && mo === now.getMonth() && d === now.getDate());
      cells.push('<div class="cal-cell' + (isToday ? ' is-today' : '') + '">' + d + '</div>');
    }
    while (cells.length % 7) cells.push('<div class="cal-cell is-out"></div>');
    var n = nowParts();
    var last = lastTalkTs();
    l.innerHTML =
      '<div class="confirm"><div class="confirm-box" style="max-width:360px" role="dialog" aria-modal="true">' +
      '<div class="cal">' +
      '<div class="cal-head">' +
      '<button class="btn btn-sm" data-cal="-1">‹</button>' +
      '<span class="cal-title">' + y + ' 年 ' + (mo + 1) + ' 月</span>' +
      '<button class="btn btn-sm" data-cal="1">›</button>' +
      '</div>' +
      '<div class="cal-grid">' +
      ['日', '一', '二', '三', '四', '五', '六'].map(function (w) { return '<div class="cal-wd">' + w + '</div>'; }).join('') +
      cells.join('') +
      '</div>' +
      '<div class="cal-foot">现在：' + esc(n.full) + '<br>' +
      (last ? ('上次说话：' + esc(agoText(last)) + '（' + esc(fmtFull(last)) + '）') : '还没说过话') +
      '</div>' +
      '<div class="confirm-acts"><button class="btn btn-primary" data-cal-close="1">知道了</button></div>' +
      '</div></div></div>';
    var off = monthOffset || 0;
    l.querySelector('[data-cal="-1"]').onclick = function () { showCalendar(off - 1); };
    l.querySelector('[data-cal="1"]').onclick = function () { showCalendar(off + 1); };
    l.querySelector('[data-cal-close]').onclick = closeLayer;
    l.querySelector('.confirm').onclick = function (e) { if (e.target === this) closeLayer(); };
    document.addEventListener('keydown', layerEsc);
  }


  function fmtSmart(ts) {
    var t = Number(ts) || Date.now();
    var d = new Date(t), n = new Date();
    var sameDay = d.toDateString() === n.toDateString();
    if (sameDay) return timeText(t);
    if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + timeText(t);
    return fmtFull(t).slice(0, 16);
  }

  function fmtFull(ts) {
    var d = new Date(Number(ts) || Date.now());
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
      p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }


  function renderMemory() {
    (function () {
      var line = $('#memLastLine');
      if (!line) return;
      var le = memory.lastExtract;
      if (!le || !le.at) { line.textContent = '还没整理过：聊两句我会自己补。'; return; }
      line.textContent = '上次整理：' + timeText(le.at) + ' · ' +
        (le.why ? ('失败（' + le.why + '）') : (le.added ? ('记下 ' + le.added + ' 条') : '这次没什么新东西'));
    })();
    /* 关键记忆 */
    var kl = $('#memKeyList');
    var sorted = memory.key.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    if (kl) {
      kl.innerHTML = '';
      if (!memory.key.length) {
        kl.appendChild(emptyBlock('i-book', '还没有关键记忆', '生日、职业、你们之间的约定——写下来她就忘不掉。',
          [{ label: '加一条', primary: true, onClick: function () { editMemory('key', null); } }]));
      } else {
        sorted.forEach(function (m) { kl.appendChild(memNode(m, 'key')); });
      }
    }
    /* 轻度记忆 */
    var ll = $('#memLightList');
    if (ll) {
      ll.innerHTML = '';
      if (!memory.light.length) {
        ll.appendChild(emptyBlock('i-clock', '还没有轻度记忆', '今天吃了什么、天气怎么样、随口说的小事，慢慢就攒起来了。',
          [{ label: '加一条', primary: true, onClick: function () { editMemory('light', null); } }]));
      } else {
        var sorted = memory.light.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
        sorted.forEach(function (m) { ll.appendChild(memNode(m, 'light')); });
      }
    }
    /* 关键词 */
    var kw = $('#kwList');
    if (kw) {
      kw.innerHTML = '';
      if (!memory.keywords.length) {
        kw.appendChild(emptyBlock('i-tag', '还没有关键词', '昵称、梗、你们的暗号——写清楚她会用得更准。',
          [{ label: '加一个', primary: true, onClick: function () { editKeyword(null); } }]));
      } else {
        memory.keywords.forEach(function (m) { kw.appendChild(kwNode(m)); });
      }
    }
  }

  function memNode(m, kind) {
    var d = document.createElement('div');
    d.className = 'mem' + (kind === 'key' ? ' is-key' : '');
    var head = m.title
      ? '<div class="mem-title">' + esc(m.title) + (m.by === 'ai' ? '<span class="by-ai">她记的</span>' : '') + '</div>'
      : (m.by === 'ai' ? '<div class="mem-title"><span class="by-ai">她记的</span></div>' : '');
    d.innerHTML = '<div class="mem-body">' + head +
      '<div class="mem-text">' + esc(m.text) + '</div>' +
      (m.ts ? '<div class="mem-meta">' + esc(fmtFull(m.ts)) + '</div>' : '') +
      '</div>' +
      '<div class="mem-acts">' +
      '<button class="btn btn-ghost btn-sm" data-mem="edit" title="编辑"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-edit"/></svg></button>' +
      '<button class="btn btn-ghost btn-sm" data-mem="del" title="删除"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-trash"/></svg></button>' +
      '</div>';
    d.querySelector('[data-mem="edit"]').onclick = function () { editMemory(kind, m.id); };
    d.querySelector('[data-mem="del"]').onclick = async function () {
      if (await confirmBox('删掉这条记忆？', m.title || m.text, '删掉', true)) {
        var arr = kind === 'key' ? memory.key : memory.light;
        var i = arr.findIndex(function (x) { return x.id === m.id; });
        if (i >= 0) arr.splice(i, 1);
        saveMemory(); renderMemory();
      }
    };
    return d;
  }

  function kwNode(m) {
    var d = document.createElement('div');
    d.className = 'mem';
    d.innerHTML = '<div class="mem-body">' +
      '<div class="mem-title"><span class="keyword">' + esc(m.word) + '</span>' +
      (m.by === 'ai' ? '<span class="by-ai">她记的</span>' : '') + '</div>' +
      (m.note ? '<div class="mem-text">' + esc(m.note) + '</div>' : '') +
      (m.ts ? '<div class="mem-meta">' + esc(fmtFull(m.ts)) + '</div>' : '') +
      '</div>' +
      '<div class="mem-acts">' +
      '<button class="btn btn-ghost btn-sm" data-mem="edit" title="编辑"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-edit"/></svg></button>' +
      '<button class="btn btn-ghost btn-sm" data-mem="del" title="删除"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-trash"/></svg></button>' +
      '</div>';
    d.querySelector('[data-mem="edit"]').onclick = function () { editKeyword(m.id); };
    d.querySelector('[data-mem="del"]').onclick = async function () {
      if (await confirmBox('删掉这个关键词？', m.word, '删掉', true)) {
        var i = memory.keywords.findIndex(function (x) { return x.id === m.id; });
        if (i >= 0) memory.keywords.splice(i, 1);
        saveMemory(); renderMemory();
      }
    };
    return d;
  }

  /* 记忆编辑：就地插入一个表单 */
  function editMemory(kind, id) {
    var host = kind === 'key' ? $('#memKeyList') : $('#memLightList');
    if (!host) return;
    var existing = id ? (kind === 'key' ? memory.key : memory.light).find(function (x) { return x.id === id; }) : null;
    if (host.querySelector('.editor')) host.querySelector('.editor').remove();

    var ed = document.createElement('div');
    ed.className = 'editor';
    ed.innerHTML =
      (kind === 'key' ? '<div class="field"><label class="field-label">标题</label><input class="input" id="edTitle" type="text" maxlength="30" placeholder="例如：她的生日"></div>' : '') +
      '<div class="field"><label class="field-label">内容</label>' +
      '<textarea class="textarea" id="edText" rows="3" placeholder="' +
      (kind === 'key' ? '例如：生日是 3 月 12 日，那天一定要记得' : '例如：今天说想吃巷子口那家草莓蛋糕') + '"></textarea></div>' +
      '<div class="editor-actions"><button class="btn btn-sm" data-ed="cancel">取消</button>' +
      '<button class="btn btn-sm btn-primary" data-ed="save">保存</button></div>';
    host.insertBefore(ed, host.firstChild);

    var t = ed.querySelector('#edTitle'); if (t && existing) t.value = existing.title || '';
    var ta = ed.querySelector('#edText'); if (existing) ta.value = existing.text || '';
    ta.focus();

    ed.querySelector('[data-ed="cancel"]').onclick = function () { ed.remove(); };
    ed.querySelector('[data-ed="save"]').onclick = function () {
      var text = ta.value.trim();
      if (!text) { toast('内容不能是空的', 'warm'); ta.focus(); return; }
      var arr = kind === 'key' ? memory.key : memory.light;
      if (existing) {
        existing.text = text;
        if (t) existing.title = t.value.trim();
        existing.ts = existing.ts || Date.now();
        existing.by = '';
      } else {
        arr.push({ id: uid(), title: t ? t.value.trim() : '', text: text, ts: Date.now() });
      }
      saveMemory(); renderMemory();
      toast('记下了');
    };
  }

  function editKeyword(id) {
    var host = $('#kwList');
    if (!host) return;
    var existing = id ? memory.keywords.find(function (x) { return x.id === id; }) : null;
    if (host.querySelector('.editor')) host.querySelector('.editor').remove();
    var ed = document.createElement('div');
    ed.className = 'editor';
    ed.innerHTML =
      '<div class="row"><div class="field"><label class="field-label">关键词</label>' +
      '<input class="input" id="kwWord" type="text" maxlength="20" placeholder="例如：草莓蛋糕"></div>' +
      '<div class="field"><label class="field-label">它是什么意思<span class="tag-opt">选填</span></label>' +
      '<input class="input" id="kwNote" type="text" maxlength="60" placeholder="例如：她最爱的甜点，提到会开心"></div></div>' +
      '<div class="editor-actions"><button class="btn btn-sm" data-ed="cancel">取消</button>' +
      '<button class="btn btn-sm btn-primary" data-ed="save">保存</button></div>';
    host.insertBefore(ed, host.firstChild);
    var w = ed.querySelector('#kwWord'), n = ed.querySelector('#kwNote');
    if (existing) { w.value = existing.word; n.value = existing.note || ''; }
    w.focus();
    ed.querySelector('[data-ed="cancel"]').onclick = function () { ed.remove(); };
    ed.querySelector('[data-ed="save"]').onclick = function () {
      var word = w.value.trim();
      if (!word) { toast('关键词不能是空的', 'warm'); w.focus(); return; }
      if (existing) { existing.word = word; existing.note = n.value.trim(); existing.by = ''; }
      else memory.keywords.push({ id: uid(), word: word, note: n.value.trim() });
      saveMemory(); renderMemory();
      toast('记下了');
    };
  }

  /* ---------------------------------------------------------- 表情包库渲染 */
  function renderStickers() {
    var wrap = $('#stickerWrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!assets.stickers.length) {
      wrap.appendChild(emptyBlock('i-smile', '表情包库是空的',
        '传几张她常用的表情，聊天时点笑脸就能发给她。建议方图，透明底更好看。',
        [{ label: '添加表情', primary: true, onClick: pickStickers }]));
    } else {
      var grid = document.createElement('div');
      grid.className = 'sticker-grid';
      assets.stickers.forEach(function (s, i) {
        var c = document.createElement('div');
        c.className = 'sticker-card';
        c.innerHTML = '<img class="sticker-img" src="' + s.data + '" alt="' + esc(s.name) + '">' +
          '<input class="sticker-name-input" value="' + esc(s.name) + '" maxlength="16" aria-label="表情名称">' +
          '<select class="select sticker-emotion" aria-label="对应情绪">' +
          EMOTIONS.map(function (e) {
            return '<option value="' + e + '"' + ((s.emotion || '开心') === e ? ' selected' : '') + '>' + e + '</option>';
          }).join('') +
          '</select>' +
          '<button class="sticker-del" title="删除" aria-label="删除表情"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-close"/></svg></button>';
        c.querySelector('.sticker-img').onclick = function () { lightbox(s.data); };
        var nameIn = c.querySelector('.sticker-name-input');
        nameIn.onchange = function () {
          var v = nameIn.value.trim();
          if (!v) { nameIn.value = s.name; return; }
          s.name = v; nameIn.value = v;
          saveAssets(); renderStickerPop();
        };
        nameIn.onkeydown = function (e) { if (e.key === 'Enter') nameIn.blur(); };
        c.querySelector('.sticker-emotion').onchange = function (e) {
          s.emotion = e.target.value;
          saveAssets();
          toast('她「' + s.emotion + '」的时候可能会发这张');
        };
        c.querySelector('.sticker-del').onclick = async function () {
          if (await confirmBox('删掉这个表情？', s.name, '删掉', true)) {
            assets.stickers.splice(i, 1); saveAssets(); renderStickers(); renderStickerPop();
          }
        };
        grid.appendChild(c);
      });
      wrap.appendChild(grid);
      var acts = document.createElement('div');
      acts.style.marginTop = '16px';
      acts.className = 'editor-actions';
      acts.style.justifyContent = 'flex-start';
      acts.innerHTML = '<button class="btn btn-sm" data-act="sticker-add-2"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-plus"/></svg>继续添加</button>';
      acts.querySelector('[data-act]').onclick = pickStickers;
      wrap.appendChild(acts);
    }
    renderStickerPop();
  }

  async function pickStickers() {
    pickFiles('image/*', true, async function (files) {
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        try {
          var sb = imgBudget();
          var data = await compressImage(f, sb.sticker, sb.stickerQ);
          assets.stickers.push({
            id: uid(),
            name: f.name.replace(/\.[^.]+$/, '').slice(0, 16) || ('表情' + (assets.stickers.length + 1)),
            emotion: '开心',
            data: data
          });
        } catch (e) { toast('「' + f.name + '」处理失败', 'warm'); }
      }
      saveAssets(); renderStickers();
      toast('加好了，去「对话」点笑脸就能用');
    });
  }

  function renderStickerPop() {
    var pop = $('#popStickers');
    if (!pop) return;
    pop.innerHTML = '';
    if (!assets.stickers.length) {
      pop.innerHTML = '<div style="grid-column:1/-1;font-size:0.7812rem;color:var(--text-faint);padding:8px 4px;width:220px">还没有表情包。去「人设 → 表情包」传几张吧。</div>';
      return;
    }
    assets.stickers.forEach(function (s) {
      var b = document.createElement('button');
      b.className = 'pop-sticker';
      b.title = s.name;
      b.innerHTML = '<img src="' + s.data + '" alt="' + esc(s.name) + '">';
      b.onclick = function () {
        closeStickerPop();
        sendSticker(s.id);
      };
      pop.appendChild(b);
    });
  }

  async function sendSticker(id) {
    if (abortCtl) { toast('等她说完这句', 'warm'); return; }
    chat.messages.push({ id: uid(), role: 'user', text: '', ts: Date.now(), sticker: id });
    saveChat(); renderChat(true);
    await runAssistant();
  }

  function openStickerPop() {
    var p = $('#stickerPop'), b = $('#btnSticker');
    if (!p) return;
    renderStickerPop();
    p.hidden = false;
    if (b) b.setAttribute('aria-expanded', 'true');
  }
  function closeStickerPop() {
    var p = $('#stickerPop'), b = $('#btnSticker');
    if (p) p.hidden = true;
    if (b) b.setAttribute('aria-expanded', 'false');
  }

  /* -------------------------------------------------------------- 存储用量 */
  /* ---------------------------------------------------------- 滑杆（带刻度）
     把 <div class="slider" data-left data-right><input type=range></div>
     补成：上面一行「左含义 · 当前值 · 右含义」，下面一行「最小值 · 轨道 · 最大值」。
  ---------------------------------------------------------------------- */
  function initSliders() {
    $$('.slider').forEach(function (box) {
      var input = box.querySelector('input[type="range"]');
      if (!input) return;
      var min = input.getAttribute('min') || '0';
      var max = input.getAttribute('max') || '100';

      var head = document.createElement('div');
      head.className = 'slider-head';
      head.innerHTML = '<span class="slider-cap">' + esc(box.getAttribute('data-left') || '') + '</span>' +
        '<b class="slider-val">' + esc(input.value) + '</b>' +
        '<span class="slider-cap">' + esc(box.getAttribute('data-right') || '') + '</span>';

      var line = document.createElement('div');
      line.className = 'slider-line';
      var lo = document.createElement('span');
      lo.className = 'slider-num';
      lo.textContent = min;
      var hi = document.createElement('span');
      hi.className = 'slider-num';
      hi.textContent = max;

      box.innerHTML = '';
      line.appendChild(lo);
      line.appendChild(input);          /* 复用原来的 input，事件绑定都还在 */
      line.appendChild(hi);
      box.appendChild(head);
      box.appendChild(line);
    });

    document.addEventListener('input', function (e) {
      if (e.target && e.target.type === 'range') syncSlider(e.target);
    });
  }

  function syncSlider(input) {
    var box = input && input.closest ? input.closest('.slider') : null;
    if (!box) return;
    var out = box.querySelector('.slider-val');
    if (out) out.textContent = input.value;
  }

  function refreshSliders() {
    $$('.slider input[type="range"]').forEach(syncSlider);
  }

  function renderStorage() {
    var n = totalBytes();
    var big = Store.mode === 'idb';
    var cap = Store.capBytes();
    var t = $('#storageText');
    var m = $('#storageMeter span');
    var mt = $('#storageMeter');

    if (big && (!cap || cap <= 0)) {
      if (t) t.textContent = bytes(n) + '（浏览器数据库，容量按磁盘算）';
      if (m) m.style.width = '6%';
      if (mt) mt.classList.remove('is-warm');
    } else if (big) {
      var p = clamp(n / cap * 100, 0, 100);
      if (t) t.textContent = bytes(n) + ' / 约 ' + bytes(cap) + '（' + (p < 1 ? '<1' : p.toFixed(0)) + '%）';
      if (m) m.style.width = Math.max(2, p).toFixed(1) + '%';
      if (mt) mt.classList.toggle('is-warm', p > 75);
    } else {
      var p2 = clamp(n / cap * 100, 0, 100);
      if (t) t.textContent = bytes(n) + ' / 约 5 MB（' + p2.toFixed(0) + '%）';
      if (m) m.style.width = p2.toFixed(1) + '%';
      if (mt) mt.classList.toggle('is-warm', p2 > 75);
    }

    var sm = $('#storageMode');
    if (sm) {
      sm.textContent = big ? '浏览器数据库（大容量）' : '浏览器键值存储（上限约 5 MB）';
      sm.className = 'kv-val' + (big ? '' : ' is-warn');
    }
    var sn = $('#storageNote');
    if (sn) {
      sn.textContent = big
        ? '已用上 IndexedDB，容量按浏览器给的配额算，图片存的是高画质版本。'
        : '直接双击打开时浏览器不给网页用数据库，只能走这个小池塘。把心枕放到本地服务器（或打包成桌面版）打开，就会自动换成大容量存储，容量按 GB 算。';
    }
  }

  /* ------------------------------------------------------------- 设置页绑定 */
  var PROVIDERS = [
    { name: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' },
    { name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyUrl: 'https://platform.openai.com/api-keys' },
    { name: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyUrl: 'https://bailian.console.aliyun.com/' },
    { name: 'Kimi', url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
    { name: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
    { name: '本地 Ollama', url: 'http://localhost:11434/v1', model: 'qwen2.5:7b', keyUrl: 'https://ollama.com/download' }
  ];

  function currentProvider() {
    var b = String(settings.baseUrl || '');
    for (var i = 0; i < PROVIDERS.length; i++) {
      if (b && b.indexOf(PROVIDERS[i].url.replace(/\/v1$/, '')) === 0) return PROVIDERS[i];
    }
    return null;
  }

  /* 别人给你一条带参数的链接，打开就把接口填好（例如部署在服务器上时）。
     ?api=&key=&model= —— 填完立刻从地址栏抹掉，免得密钥留在浏览记录里。 */
  function applyUrlPreset() {
    var q = null;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    var api = q.get('api');
    var key = q.get('key');
    var model = q.get('model');
    var chars = q.get('chars');
    if (!api && !key && !model) return;
    if (api) settings.baseUrl = String(api).trim();
    if (key) settings.apiKey = String(key).trim();
    if (model) settings.model = String(model).trim();
    if (chars && Number(chars) > 0) settings.maxChars = clamp(Math.round(Number(chars)), 50, 4000);
    saveSettings();
    fillSettingsForm();
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { }
    setTimeout(function () { toast('接口已经替你填好了'); }, 500);
  }

  function fillSettingsForm() {
    var set = function (sel, val) { var e = $(sel); if (e) e.value = val == null ? '' : val; };
    var chk = function (sel, val) { var e = $(sel); if (e) e.checked = !!val; };
    set('#setBaseUrl', settings.baseUrl);
    set('#setApiKey', settings.apiKey);
    set('#setModel', settings.model);
  set('#setCtxLen', settings.ctxLen || '');
    set('#setTemp', Math.round(settings.temperature * 100));
    set('#setMaxChars', settings.maxChars);
    set('#setTimeout', settings.timeout);
    set('#stickerChance', settings.stickerChance);
    set('#pExtraSystem', settings.extraSystem);
    chk('#setStream', settings.stream);
    chk('#injKey', settings.injKey);
    chk('#injLight', settings.injLight);
    chk('#injKeywords', settings.injKeywords);
    chk('#injStickers', settings.injStickers);
    chk('#injMemes', settings.injMemes !== false);
    chk('#injAutoMem', settings.injAutoMem);
    chk('#setStickerAuto', settings.stickerAuto);
    set('#lightCount', settings.lightCount);
    set('#ctxTurns', settings.ctxTurns);
    chk('#setEnterSend', settings.enterSend);
    chk('#setTimestamps', settings.timestamps);
    chk('#setSplit', settings.splitMessages);

    var presets = $('#apiPresets');
    if (presets && !presets.children.length) {
      PROVIDERS.forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'preset';
        b.textContent = p.name;
        b.onclick = function () {
          settings.baseUrl = p.url;
          settings.model = p.model;
          $('#setBaseUrl').value = p.url;
          $('#setModel').value = p.model;
          saveSettings();
          toast('已填入 ' + p.name + '，别忘了填 API Key');
        };
        presets.appendChild(b);
      });
    }
    syncSegs();
  }

  function syncSegs() {
    $$('#themeSeg .seg-btn').forEach(function (b) { b.classList.toggle('is-active', b.dataset.themeVal === settings.theme); });
    $$('#fontSeg .seg-btn').forEach(function (b) { b.classList.toggle('is-active', b.dataset.fontVal === settings.font); });
    $$('#motionSeg .seg-btn').forEach(function (b) { b.classList.toggle('is-active', b.dataset.motionVal === settings.motion); });
  }

  function applyAppearance() {
    var root = document.documentElement;
    var theme = settings.theme;
    if (theme === 'auto') {
      theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'light';
    }
    root.setAttribute('data-theme', theme === 'night' ? 'night' : 'light');
    root.setAttribute('data-fontsize', settings.font === 'small' ? 'small' : settings.font === 'large' ? 'large' : 'normal');
    root.setAttribute('data-motion', settings.motion === 'off' ? 'off' : 'full');
    /* 开屏要用，存一份小镜像（不随角色走，全局的） */
    try {
      lsSet(G.theme, JSON.stringify(settings.theme));
      lsSet('xinzhen.v1.font', JSON.stringify(settings.font));
    } catch (e) { }
  }

  async function testConnection() {
    var out = $('#testOut');
    if (!out) return;
    if (!settings.baseUrl || !settings.model) {
      out.className = 'test-out is-bad';
      out.textContent = '先把接口地址和模型名填上吧。';
      return;
    }
    out.className = 'test-out';
    out.textContent = '正在试…';
    var t0 = Date.now();
    try {
      /* 只让这一次不流式：改全局 settings.stream 会把正在进行的回复带歪，甚至重发一遍 */
      var reply = await chatCompletion([
        { role: 'system', content: '你是一个测试用的助手，只回答一个字。' },
        { role: 'user', content: '回复「在」这一个字。' }
      ], { stream: false, chars: 20, timeout: 30 });
      var ms = Date.now() - t0;
      out.className = 'test-out is-ok';
      out.textContent = '通了（' + ms + ' ms）。她说：' + String(reply || '').trim().slice(0, 40);
      toast('接口可用');
    } catch (e) {
      out.className = 'test-out is-bad';
      out.textContent = describeError(e);
    }
  }

  async function fetchModels() {
    if (!settings.baseUrl) { toast('先填接口地址', 'warm'); return; }
    var out = $('#testOut');
    if (out) { out.className = 'test-out'; out.textContent = '正在拉取模型列表…'; }
    try {
      var headers = {};
      if (settings.apiKey) headers['Authorization'] = 'Bearer ' + settings.apiKey;
      var res = await fetch(joinUrl(settings.baseUrl, '/models'), { headers: headers });
      if (!res.ok) throw new ApiError(res.status, pickApiMessage(await res.text()));
      var body = (await res.text()).replace(/^\uFEFF/, '').trim();
      var j;
      try { j = JSON.parse(body); }
      catch (e) {
        if (out) { out.className = 'test-out is-bad'; }
        throw new Error('拉取模型列表失败：接口返回的不是 JSON。\n' + (/^\s*</.test(body)
          ? '看起来是一段网页，多半是 Base URL 填错了（应该填到 /v1 为止）。'
          : '返回开头：' + body.slice(0, 200)));
      }
      var list = (j.data || j.models || []).map(function (m) { return m.id || m.name; }).filter(Boolean);
      if (!list.length) { if (out) { out.className = 'test-out is-bad'; out.textContent = '拉到了，但没有模型。'; } return; }
      var prev = $('#modelList');
      if (prev) prev.remove();
      var dl = document.createElement('datalist');
      dl.id = 'modelList';
      list.forEach(function (id) { var o = document.createElement('option'); o.value = id; dl.appendChild(o); });
      document.body.appendChild(dl);
      $('#setModel').setAttribute('list', 'modelList');
      if (out) {
        out.className = 'test-out is-ok';
        out.textContent = '拉到 ' + list.length + ' 个模型。点一下模型输入框就能选，前几个：' + list.slice(0, 6).join('、');
      }
    } catch (e) {
      if (out) { out.className = 'test-out is-bad'; out.textContent = describeError(e); }
    }
  }

  /* ------------------------------------------------------------ 人设模板 */
  /* 基础模板：作者自己在用的人设。只带人设，不带记忆/关键词/梗/计划。 */
  var BASE_PERSONA = {
    name: '大肥鱼',
    call: '主人',
    identity: '鲸鱼娘，主人的精英女仆',
    text: "（一名精英女仆，尽心尽力服侍着主人、爱着主人）你今年18岁，是鲸鱼娘，主人的精英女仆。每天六点半起床，每天都陪伴着主人，听从主人的命令，但有时也有些小调皮。\n\n你说话声音不大，尾音习惯性上扬半度，你还有个藏不住的毛病——思考时会无意识地用指尖卷围裙带子，被撞见就立刻背过手去，耳尖泛红。\n\n你私下里管自己叫“大肥鱼”，主人第一次听见你对着鱼缸念叨“大肥鱼今天也要好好吃饭”时笑了整晚，这绰号便落下了。你会在深夜关注熬夜的主人，早上会叫醒赖床的主人。\n\n你对“我”的照料已经越过了职业边界，对主人有着依赖和信任，主人就是你的一切。",
    tags: ['女仆', '鲸鱼娘', '温柔', '小调皮'],
    catchphrase: '',
    greeting: '主人回来啦，大肥鱼一直在等你',
    temper: 40, talky: 52, active: 62, sweet: 74,
    speech: { style: 'meme', likes: [], avoids: [], notes: '' }
  };

  function clonePersona(x) { return JSON.parse(JSON.stringify(x || {})); }

  var PRESET_PERSONAS = [
    {
      label: '温柔的邻家女孩',
      data: {
        name: '林知夏', call: '你', identity: '住在你隔壁的插画师，作息很乱，家里养了只叫「年年」的橘猫',
        text: '你叫林知夏，26 岁，一个人住在老小区的六楼，靠接插画稿过日子。\n' +
          '你性格温和，说话不快，喜欢在句尾带一点点鼻音。你不擅长表达喜欢，但会记住别人随口说过的小事——比如他不吃香菜、加班到几点。\n' +
          '你画画的时候会忘记吃饭，压力大的时候会一个人去楼下的便利店买关东煮。你怕黑，晚上画稿一定要把客厅的灯开着。\n' +
          '你对他的感情是慢慢靠近的那种：先是在意，然后是习惯，最后是离不开。',
        tags: ['温柔', '细心', '慢热', '偶尔撒娇'],
        catchphrase: '嗯……我想想', greeting: '回来啦？我刚画完一张，眼睛有点花……你今天怎么样？',
        temper: 32, talky: 46, active: 44, sweet: 52
      }
    },
    {
      label: '嘴硬的学妹',
      data: {
        name: '沈昭', call: '学长', identity: '同校大二学妹，摄影社的，总在图书馆三楼靠窗的位置',
        text: '你叫沈昭，20 岁，摄影社的学妹。\n' +
          '你嘴上不饶人，喜欢挑他的毛病，但每次他生病或者加班，你都是第一个出现的人。你讨厌被人说可爱，却会偷偷把他说过好看的裙子买回来。\n' +
          '你拍照片很厉害，但总说自己是随便按的。你容易吃醋，吃醋的时候会突然变得很客气，然后发一堆句号。\n' +
          '你其实很怕他不理你。',
        tags: ['傲娇', '嘴硬心软', '爱吃醋', '行动派'],
        catchphrase: '哼，关我什么事', greeting: '……你怎么才来。我才不是特意等你的，就是刚好在这儿。',
        temper: 72, talky: 58, active: 62, sweet: 66
      }
    },
    {
      label: '知性的大姐姐',
      data: {
        name: '苏晚', call: '小朋友', identity: '比你大五岁，做建筑设计，一个人住江边的公寓',
        text: '你叫苏晚，31 岁，建筑设计师。你习惯把事情想得很清楚，说话有条理，但对他从来不摆架子。\n' +
          '你喜欢在深夜喝一杯威士忌，看窗外的江面。你照顾人的方式很安静：不问，只是把东西准备好。\n' +
          '你不喜欢被同情，也不喜欢他说「你辛苦了」。你希望他把你当成一个可以依靠的人，而不是需要被照顾的人。\n' +
          '偶尔你也会露出一点脆弱，但很快就会笑着岔开话题。',
        tags: ['成熟', '理智', '会照顾人', '偶尔脆弱'],
        catchphrase: '嗯，我在', greeting: '这么晚还没睡？过来坐，我这儿有刚泡的茶。',
        temper: 30, talky: 44, active: 52, sweet: 40
      }
    }
  ];
  PRESET_PERSONAS.unshift({ label: '大肥鱼（基础模板）', data: clonePersona(BASE_PERSONA) });

  function applyPreset(idx) {
    var p = PRESET_PERSONAS[idx];
    if (!p) return;
    var d = p.data;
    Object.keys(d).forEach(function (k) { persona[k] = d[k]; });
    savePersona();
    fillPersonaForm();
    renderTags(); renderPersonaPreview();
    var box = $('#profilePresets');
    if (box) box.hidden = true;
    toast('套用了「' + p.label + '」，随便改');
  }

  function fillPersonaForm() {
    var set = function (sel, v) { var e = $(sel); if (e) e.value = v == null ? '' : v; };
    set('#pName', persona.name);
    set('#pCall', persona.call);
    set('#pIdentity', persona.identity);
    set('#pPersona', persona.text);
    set('#pCatch', persona.catchphrase);
    set('#pGreeting', persona.greeting);
    set('#sTemper', persona.temper);
    set('#sTalky', persona.talky);
    set('#sActive', persona.active);
    set('#sSweet', persona.sweet);
    renderTags(); renderPersonaPreview(); renderPortrait(); renderAvatar();
    renderSpeech();
    renderMe();
  }

  async function aiWriteProfile() {
    if (!settings.baseUrl || !settings.model) {
      toast('先去「设置 → 模型接口」把接口配好，我才能帮你写', 'warm');
      go('settings');
      return;
    }
    var name = ($('#pName').value || '').trim() || '她';
    var identity = ($('#pIdentity').value || '').trim();
    var tags = persona.tags.join('、');
    if (!identity && !tags) {
      toast('先写一句身份或者几个性格标签，我好知道往哪个方向写', 'warm');
      $('#pIdentity').focus();
      return;
    }

    var hasText = ($('#pPersona').value || '').trim().length > 0;
    var ok = await confirmBox('让她帮你写人设？',
      hasText
        ? '现在的人设正文会被整个覆盖掉。写出来的不一定合你意，改过的旧版本也找不回来了。'
        : '会按你填的身份和标签，写一段 300–500 字的设定正文。',
      hasText ? '覆盖并重写' : '开始写', hasText);
    if (!ok) return;

    var btn = $('[data-act="ai-profile"]');
    if (btn) { btn.disabled = true; btn.textContent = '正在写…'; }
    var keepStream = settings.stream;
    settings.stream = false;
    try {
      var text = await chatCompletion([
        { role: 'system', content: '你是一个角色设定师，擅长写中文乙女向/陪伴向角色的设定。只输出设定正文，不要标题、不要解释、不要 markdown 标记。' },
        {
          role: 'user', content:
            '请为一位名叫「' + name + '」的角色写一段人物设定正文。\n' +
            (identity ? '她的身份：' + identity + '\n' : '') +
            (tags ? '性格关键词：' + tags + '\n' : '') +
            '要求：第二人称「你」来写，300-500 字，分 3-4 段。' +
            '包含她的年龄职业与生活环境、性格与说话习惯、几个具体的小细节或癖好、以及她和「我」之间关系的状态。' +
            '具体、有画面感，不要空泛的形容词堆砌。'
        }
      ]);
      if (text) {
        persona.text = String(text).trim();
        $('#pPersona').value = persona.text;
        savePersona();
        toast('写好了，你看哪里不像，直接改');
      } else {
        toast('她没写出东西来，再试一次？', 'warm');
      }
    } catch (e) {
      toast(describeError(e), 'warm');
    } finally {
      settings.stream = keepStream;
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-sparkle"/></svg>让 AI 帮我写'; }
    }
  }

  /* ------------------------------------------------------------ 数据导入导出
     导出的单位是「一个角色」：人设、我、记忆、表情包、聊天记录、连设置一起打包，
     导回来能一模一样地复原。
  ---------------------------------------------------------------------- */


  /* ============================ 导出 / 导入 ============================
  两种范围（当前 AI / 全部数据）× 两种格式（json / md）。
  外接里的 NapCat 接口密钥、模型接口（baseUrl / apiKey / model）都不进备份。 */

  var MODEL_KEYS = ['baseUrl', 'apiKey', 'model', 'timeout', 'ctxLen', 'proxy', 'headers', 'stream'];
  var QQ_SECRET_KEYS = ['token', 'apiBase', 'napcatToken', 'webuiToken', 'webuiUrl', 'apiPort', 'wsPort'];

  /* B 站登录态、cookie 一律不进备份（它们只存在服务器上）；
     其它 B 站设置（关键词、日报、自动刷、私聊开关）照常导出。 */
  var LINK_SECRET_KEYS = ['who', 'login', 'cookie', 'cookies', 'sessdata', 'SESSDATA',
    'bili_jct', 'DedeUserID', 'dedeuserid', 'token', 'csrf', 'csrf_token', 'uid', 'uname', 'mid'];

  function cleanLinkForExport(lk) {
    var o = JSON.parse(JSON.stringify(lk || {}));
    LINK_SECRET_KEYS.forEach(function (k) { delete o[k]; });
    return o;
  }

  function cleanSettingsForExport(st) {
    var o = JSON.parse(JSON.stringify(st || {}));
    MODEL_KEYS.forEach(function (k) { delete o[k]; });
    if (o.qq) QQ_SECRET_KEYS.forEach(function (k) { delete o.qq[k]; });
    return o;
  }

  async function readCharData(cid) {
    var out = {};
    for (var i = 0; i < SUB_KEYS.length; i++) {
      var raw = await Store.read('xinzhen.v1.c.' + cid + '.' + SUB_KEYS[i]);
      out[SUB_KEYS[i]] = parseRaw(raw, {}) || {};
    }
    return out;
  }

  async function buildPack(scope) {
    if (scope === 'all') {
      var list = [];
      for (var i = 0; i < characters.length; i++) {
        var c = characters[i];
        var d = await readCharData(c.id);
        d.settings = cleanSettingsForExport(d.settings);
        d.link = cleanLinkForExport(d.link);
        list.push({ name: c.name || (d.persona && d.persona.name) || '未命名', createdAt: c.createdAt || 0, data: d });
      }
      return { kind: 'xinzhen.pack', scope: 'all', v: VERSION, at: Date.now(), app: '心枕', chars: list };
    }
    flushSaves();
    try { await writeChain; } catch (e) { }
    var one = await readCharData(activeId);
    one.settings = cleanSettingsForExport(one.settings);
    one.link = cleanLinkForExport(one.link);
    return {
      kind: 'xinzhen.pack', scope: 'char', v: VERSION, at: Date.now(), app: '心枕',
      name: charName(activeId), data: one
    };
  }

  function packToMarkdown(pack) {
    var when = new Date(pack.at || Date.now());
    var stamp = when.getFullYear() + '-' + ('0' + (when.getMonth() + 1)).slice(-2) + '-' + ('0' + when.getDate()).slice(-2) +
      ' ' + ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2);
    var L = [];
    L.push('# 心枕备份 · ' + (pack.scope === 'all' ? '全部数据' : (pack.name || '角色')));
    L.push('');
    L.push('- 导出时间：' + stamp);
    L.push('- 心枕版本：' + (pack.v || ''));
    L.push('- 范围：' + (pack.scope === 'all' ? ('全部数据（' + (pack.chars || []).length + ' 个角色）') : '当前 AI'));
    L.push('- 不含：模型接口（地址 / 密钥 / 模型名）、NapCat 接口密钥');
    L.push('');
    var list = pack.scope === 'all' ? (pack.chars || []) : [{ name: pack.name, data: pack.data }];
    list.forEach(function (c) {
      var d = c.data || {};
      var p = d.persona || {};
      L.push('## ' + (c.name || p.name || '角色'));
      L.push('');
      L.push('**名字**：' + (p.name || '—') + '　**称呼你**：' + (p.call || '—'));
      if (p.tags && p.tags.length) L.push('**性格**：' + p.tags.join('、'));
      L.push('');
      L.push('### 人设');
      L.push('');
      L.push(String(p.text || '（空）'));
      L.push('');
      var key = (d.memory && d.memory.key) || [];
      if (key.length) {
        L.push('### 关键记忆（' + key.length + '）');
        L.push('');
        key.slice(0, 40).forEach(function (m) { L.push('- ' + (m.title ? m.title + '：' : '') + (m.text || '')); });
        L.push('');
      }
      var words = (d.memory && d.memory.keywords) || [];
      if (words.length) {
        L.push('### 关键词');
        L.push('');
        L.push(words.slice(0, 40).map(function (w) { return w.word || w.text || w; }).join('、'));
        L.push('');
      }
      var memes2 = (d.memes && d.memes.items) || [];
      if (memes2.length) {
        L.push('### 梗知识（' + memes2.length + '）');
        L.push('');
        memes2.slice(0, 40).forEach(function (m) { L.push('- ' + m.term + (m.meaning ? '：' + m.meaning : '')); });
        L.push('');
      }
      var pl = (d.plans && d.plans.items) || [];
      if (pl.length) {
        L.push('### 计划（' + pl.length + '）');
        L.push('');
        pl.slice(0, 40).forEach(function (x) { L.push('- ' + (x.done ? '✔ ' : '') + x.text + (x.due ? '（' + x.due + '）' : '')); });
        L.push('');
      }
      var dy = (d.diary && d.diary.items) || [];
      if (dy.length) {
        L.push('### 日记（' + dy.length + ' 篇，这里只列日期）');
        L.push('');
        L.push(dy.slice(0, 30).map(function (x) { return x.date; }).join('、'));
        L.push('');
      }
      var chatN = (d.chat && d.chat.messages) ? d.chat.messages.length : 0;
      L.push('### 聊天记录');
      L.push('');
      L.push('共 ' + chatN + ' 条（完整内容在下面的数据块里，导回心枕即可复原）。');
      L.push('');
    });
    L.push('---');
    L.push('');
    L.push('> 下面这段是给心枕读的原始数据，导回去就能一模一样地复原。别删。');
    L.push('');
    var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(pack))));
    L.push('<!--XINZHEN-PACK:' + b64 + '-->');
    L.push('');
    return L.join('\n');
  }

  function parsePackText(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    if (t.charAt(0) === '{') { try { return JSON.parse(t); } catch (e) { } }
    var m = t.match(/<!--XINZHEN-PACK:([A-Za-z0-9+/=\s]+)-->/);
    if (m) { try { return JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/\s/g, ''))))); } catch (e) { } }
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  function downloadText(fname, text, mime) {
    if (XZ_SMOKE) return;
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function stampName() {
    var d = new Date();
    return d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) +
      '-' + ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2);
  }

  async function doExport(scope, fmt) {
    var pack = await buildPack(scope);
    var base = '心枕·' + (scope === 'all' ? '全部数据' : (pack.name || '角色')) + '-' + stampName();
    if (fmt === 'md') downloadText(base + '.md', packToMarkdown(pack), 'text/markdown;charset=utf-8');
    else downloadText(base + '.json', JSON.stringify(pack, null, 2), 'application/json');
    toast('导出好了：' + base + '.' + (fmt === 'md' ? 'md' : 'json'));
  }

  /* 导出前的确认窗口：范围 + 格式 */
  function exportFlow() {
    var l = $('#layer');
    l.innerHTML =
      '<div class="confirm"><div class="confirm-box" role="dialog" aria-modal="true" style="max-width:460px">' +
      '<h3 class="confirm-title">导出数据</h3>' +
      '<p class="confirm-text">选择范围和格式。备份里有人设、记忆、关键词、梗知识、计划、日记、聊天记录、形象、名单、外接设置和界面设置；' +
      '<b>不含</b>模型接口（地址 / 密钥 / 模型名）、NapCat 的接口密钥，以及 B 站账号的登录状态和 cookie —— ' +
      'B 站登录只留在服务器上，换机器要重新扫码登录。</p>' +
      '<div class="confirm-acts" style="flex-wrap:wrap;gap:8px">' +
      '<button class="btn" data-ex="char" data-fmt="json">当前 AI · JSON</button>' +
      '<button class="btn" data-ex="char" data-fmt="md">当前 AI · Markdown</button>' +
      '<button class="btn btn-primary" data-ex="all" data-fmt="json">全部数据 · JSON</button>' +
      '<button class="btn btn-primary" data-ex="all" data-fmt="md">全部数据 · Markdown</button>' +
      '</div>' +
      '<div class="confirm-acts"><button class="btn btn-ghost" data-cf="0">取消</button></div>' +
      '</div></div>';
    l.querySelector('[data-cf="0"]').onclick = closeLayer;
    l.querySelector('.confirm').onclick = function (e) { if (e.target === this) closeLayer(); };
    document.addEventListener('keydown', layerEsc);
    $$('[data-ex]', l).forEach(function (b) {
      b.onclick = async function () {
        var scope = b.dataset.ex, fmt = b.dataset.fmt;
        closeLayer();
        try { await doExport(scope, fmt); } catch (e) { toast('导出失败：' + (e.message || e), 'warm'); }
      };
    });
  }

  /* 把一份 char 数据写成一个角色；over=true 时覆盖同 id */
  async function writeCharPack(cid, name, data, keepSecretsFrom) {
    var full = {};
    for (var i = 0; i < SUB_KEYS.length; i++) {
      var sk = SUB_KEYS[i];
      var _f = STATE_DEFAULTS[sk];
      full[sk] = Object.assign((typeof _f === 'function' ? _f() : {}), data[sk] || {});
    }
    /* 模型接口沿用本机现有的，备份里本来就没有 */
    if (keepSecretsFrom) {
      MODEL_KEYS.forEach(function (k) { if (keepSecretsFrom[k] != null) full.settings[k] = keepSecretsFrom[k]; });
      if (keepSecretsFrom.qq && full.settings.qq) {
        QQ_SECRET_KEYS.forEach(function (k) { if (keepSecretsFrom.qq[k] != null) full.settings.qq[k] = keepSecretsFrom.qq[k]; });
        if (qq && qq.token && full.settings.qq && !full.settings.qq.token) full.settings.qq.token = qq.token;
      }
    }
    for (var j = 0; j < SUB_KEYS.length; j++) {
      await Store.write('xinzhen.v1.c.' + cid + '.' + SUB_KEYS[j], JSON.stringify(full[SUB_KEYS[j]]));
    }
    return full;
  }

  async function importPack(pack, mode) {
    if (!pack || pack.kind !== 'xinzhen.pack') {
      /* 兼容早期单角色包 */
      if (pack && (pack.persona || pack.chat || pack.settings)) {
        pack = { kind: 'xinzhen.pack', scope: 'char', name: (pack.character && pack.character.name) || '导入的角色', data: pack.data || pack };
      } else {
        toast('这个文件里没有心枕的数据', 'warm');
        return;
      }
    }
    flushSaves();
    try { await writeChain; } catch (e) { }

    var list = pack.scope === 'all' ? (pack.chars || []) : [{ name: pack.name || (pack.data.persona || {}).name || '导入的角色', data: pack.data }];
    if (!list.length) { toast('备份里没有角色', 'warm'); return; }

    if (mode === 'over') {
      await Store.clearAll();
      characters.length = 0;
    }

    var added = 0, firstId = null;
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var data = item.data || {};
      var wanted = String(item.name || (data.persona && data.persona.name) || '导入的角色').slice(0, 20);
      var same = characters.filter(function (c) { return c.name === wanted; })[0];
      var cid, nm;
      if (mode === 'over' && same) { cid = same.id; nm = same.name; }
      else {
        nm = wanted;
        var n = 2;
        while (characters.filter(function (c) { return c.name === nm; }).length) nm = wanted + ' ' + (n++);
        cid = 'c' + uid();
        characters.push({ id: cid, name: nm, createdAt: item.createdAt || Date.now(), updatedAt: Date.now() });
      }
      var keep = (mode === 'over' && same) ? snapshot().settings : null;
      await writeCharPack(cid, nm, data, keep);
      if (!firstId) firstId = cid;
      added++;
    }
    await saveRoster();
    toast('导入完成：' + added + ' 个角色');
    setTimeout(function () {
      if (firstId && added === 1) { try { localStorage.setItem('xinzhen.v1.active', firstId); } catch (e) { } }
      location.reload();
    }, 700);
  }


  /* 5 秒倒计时确认 */
  function countdownConfirm(title, text, okLabel, seconds) {
    return new Promise(function (resolve) {
      var l = $('#layer');
      var left = seconds || 5;
      l.innerHTML =
        '<div class="confirm"><div class="confirm-box" role="dialog" aria-modal="true" style="max-width:420px">' +
        '<h3 class="confirm-title">' + esc(title) + '</h3>' +
        '<p class="confirm-text">' + esc(text) + '</p>' +
        '<div class="confirm-acts">' +
        '<button class="btn" data-cf="0">取消</button>' +
        '<button class="btn btn-danger" data-cf="1" disabled>' + esc(okLabel) + '（' + left + '）</button>' +
        '</div></div></div>';
      var okBtn = l.querySelector('[data-cf="1"]');
      var tick = setInterval(function () {
        left--;
        if (left <= 0) {
          clearInterval(tick);
          okBtn.disabled = false;
          okBtn.textContent = okLabel;
        } else okBtn.textContent = okLabel + '（' + left + '）';
      }, 1000);
      function done(v) { clearInterval(tick); closeLayer(); resolve(v); }
      l.querySelector('[data-cf="0"]').onclick = function () { done(false); };
      okBtn.onclick = function () { if (!okBtn.disabled) done(true); };
      l.querySelector('.confirm').onclick = function (e) { if (e.target === this) done(false); };
      document.addEventListener('keydown', layerEsc);
    });
  }

  /* 只删当前这个角色的数据，别的不动 */
  async function wipeCurrent() {
    var nm = charName(activeId);
    var ok = await countdownConfirm('删除当前 AI 数据？',
      '「' + nm + '」的立绘、头像、人设、记忆、关键词、梗知识、计划、日记、表情包和聊天记录都会被删掉，删了就找不回来了。' +
      '其它角色不受影响。想留后路就先导出。', '删除', 5);
    if (!ok) return;
    flushSaves();
    try { await writeChain; } catch (e) { }
    for (var i = 0; i < SUB_KEYS.length; i++) {
      var _f2 = STATE_DEFAULTS[SUB_KEYS[i]];
      await Store.write('xinzhen.v1.c.' + activeId + '.' + SUB_KEYS[i], JSON.stringify(typeof _f2 === 'function' ? _f2() : {}));
    }
    toast('已经删掉了「' + nm + '」的数据');
    setTimeout(function () { location.reload(); }, 600);
  }


  function importData() {
    pickFiles('.json,application/json', false, function (files) {
      var f = files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = async function () {
        var pack;
        try { pack = JSON.parse(String(fr.result)); }
        catch (e) { toast('这个文件读不出来，可能不是心枕的备份', 'warm'); return; }

        /* 兼容两种格式：新的单角色包，和早期把数据摊在最外层的包 */
        var data = (pack && pack.kind === 'xinzhen.character' && pack.data) ? pack.data : pack;
        if (!data || (!data.persona && !data.chat && !data.settings)) {
          toast('这个文件里没有心枕的角色数据', 'warm'); return;
        }
        var wanted = (pack.character && pack.character.name) || (data.persona && data.persona.name) || '导入的角色';

        var ok = await confirmBox('导入这个角色？',
          '会把备份里的「' + wanted + '」作为一个新角色加进来，人设、记忆、聊天记录和设置都会照原样恢复。' +
          '现有的角色不受影响。', '导入');
        if (!ok) return;

        flushSaves();
        await writeChain;

        var cid = 'c' + uid();
        var nm = wanted;
        var n = 2;
        while (characters.filter(function (c) { return c.name === nm; }).length) nm = wanted + ' ' + (n++);

        var full = {};
        for (var k = 0; k < SUB_KEYS.length; k++) {
          var sk = SUB_KEYS[k];
          full[sk] = Object.assign(STATE_DEFAULTS[sk](), data[sk] || {});
        }
        for (var i = 0; i < SUB_KEYS.length; i++) {
          await Store.write('xinzhen.v1.c.' + cid + '.' + SUB_KEYS[i], JSON.stringify(full[SUB_KEYS[i]]));
        }
        characters.push({ id: cid, name: nm, createdAt: Date.now(), updatedAt: Date.now() });
        setActiveKeys(cid);
        await saveRoster();
        toast('导入完成，正在切换到「' + nm + '」');
        setTimeout(function () { location.reload(); }, 800);
      };
      fr.readAsText(f);
    });
  }



  /* ==========================================================================
     外接 · 刷 B 站
     ==========================================================================
     数据从桌面壳的主进程拿（window.xinzhenDesktop.bili）——
     网页自己发请求会被跨域和 B 站风控同时拦掉，主进程没有这两层限制。
     挑什么、怎么说，仍然走她自己的接口和人设：她替你看，也替你说。

     ⚠️ 浏览器里（双击 心枕.html）这条线上没有桥，所以整页只读：
        按钮禁用 + 一句说明。不要假装能跑，那只会让人以为是坏了。
     ---------------------------------------------------------------------- */

  var LINK_BUILTIN_KEYWORDS = ['科技', '游戏', '音乐', '生活', '知识'];
  var LINK_WINDOW_DAYS = 7;      /* 只看最近 7 天 */
  var LINK_SCAN_MAX = 30;        /* 一轮最多收多少条候选 */
  var LINK_DETAIL_MAX = 10;      /* 真正读详情 / 字幕的条数 */
  var LINK_SUB_CHARS = 1400;     /* 每条字幕截多少字进提示词 */
  var LINK_REPORTS_MAX = 14;     /* 本地留最近 14 天 */

  var linkBusy = false;
  var linkAbort = null;
  var linkLogLines = [];
  var linkWho = { login: false, uname: '', mid: 0 };
  var linkViewDay = '';          /* 正在看哪天的日报；空 = 最新的一份 */

  /* 服务器代跑：浏览器的网页发不出 B 站请求（跨域 + 风控），
     所以由服务器上的常驻客户端替它去取，页面只跟同源的 /bili/ 说话。 */
  function serverBiliBridge() {
    if (location.protocol === 'file:') return null;
    function jpost(path, body) {
      return fetch('/bili/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (r) {
        if (!r.ok) throw new Error('/bili 返回 ' + r.status);
        return r.json();
      });
    }
    return {
      server: true,
      get: function (url) { return jpost('get', { url: url }); },
      post: function (o) { return jpost('post', { url: (o && o.url) || '', form: (o && o.form) || {} }); },
      status: function () {
        return jpost('status', {}).then(function (d) {
          return { ok: true, login: !!(d && d.login), uname: (d && d.uname) || '', mid: (d && d.mid) || 0 };
        });
      },
      comment: function (o) { return jpost('comment', { aid: o && o.aid, message: o && o.message }); },
      logout: function () { return jpost('logout', {}); },
      login: biliServerLogin
    };
  }

  /* 扫码登录：二维码画在应用内的浮层里（不跳浏览器弹窗） */
  function biliServerLogin() {
    return fetch('/bili/login/qr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.why) || '拿不到二维码');
      return new Promise(function (resolve) {
        var l = $('#layer');
        var closed = false, timer = null, left = 150;
        function close(v) {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          closeLayer();
          resolve(v || { ok: false });
        }
        var html =
          '<div class="confirm"><div class="confirm-box" role="dialog" aria-modal="true" style="max-width:340px">' +
          '<h3 class="confirm-title">扫码登录 B 站</h3>' +
          '<p class="confirm-text">用手机 B 站 App 扫一下，扫完在手机上点确认。</p>' +
          '<img alt="登录二维码" style="width:220px;height:220px;display:block;margin:4px auto 10px" ' +
          'src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(d.url) + '">' +
          '<p class="field-note" style="word-break:break-all">扫不出来就用这条链接：' + esc(d.url) + '</p>' +
          '<div class="confirm-acts"><button class="btn" data-cf="0">取消</button></div>' +
          '</div></div>';
        l.innerHTML = html;
        l.querySelector('[data-cf="0"]').onclick = function () { close({ ok: false, why: '取消了' }); };
        l.querySelector('.confirm').onclick = function (e) { if (e.target === this) close({ ok: false, why: '取消了' }); };
        document.addEventListener('keydown', layerEsc);
        timer = setInterval(function () {
          left -= 2;
          if (left <= 0) { close({ ok: false, why: '等太久了，再点一次登录吧' }); return; }
          fetch('/bili/login/poll', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: d.key })
          }).then(function (r) { return r.json(); }).then(function (x) {
            if (x && x.login) { close({ ok: true, uname: x.uname || '' }); return; }
            if (x && x.state === 'expired') close({ ok: false, why: '二维码过期了，再点一次登录' });
          }).catch(function () { });
        }, 2000);
      });
    });
  }


  function linkBridge() {
    return (window.xinzhenDesktop && window.xinzhenDesktop.bili) || serverBiliBridge();
  }
  function linkDesktop() { return !!linkBridge(); }

  function linkDayKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function linkDayText(day) {
    var p = String(day || '').split('-');
    if (p.length !== 3) return day || '';
    var t = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    var today = new Date();
    var diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) -
      new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    return (t.getMonth() + 1) + ' 月 ' + t.getDate() + ' 日';
  }
  function linkPlayText(n) {
    n = Number(n) || 0;
    if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + ' 万播放';
    return n + ' 播放';
  }
  function linkDurText(sec) {
    sec = Number(sec) || 0;
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + ('0' + s).slice(-2);
  }

  /* ---------------------------------------------------------------- 通道 */
  async function biliGet(url) {
    var b = linkBridge();
    if (!b) throw new Error('拿不到 B 站通道：看看服务器上的常驻客户端是不是在跑（外接 → QQ 下面那行状态）。');
    var r = await b.get(url);
    if (!r || r.ok !== true) throw new Error((r && r.why) || 'B 站没有回应');
    if (r.status !== 200) throw new Error('B 站返回了 ' + r.status);
    if (!r.json) throw new Error('B 站返回的不是 JSON，可能被风控拦了');
    return r.json;
  }

  async function biliSearch(kw) {
    var url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video' +
      '&order=pubdate&page=1&keyword=' + encodeURIComponent(kw);
    var j = await biliGet(url);
    if (!j || j.code !== 0) return [];
    var list = (j.data && j.data.result) || [];
    return list.map(function (v) {
      return {
        bvid: v.bvid,
        title: String(v.title || '').replace(/<[^>]+>/g, ''),
        up: v.author || '',
        play: Number(v.play) || 0,
        danmaku: Number(v.video_review) || 0,
        pubdate: Number(v.pubdate) || 0,
        mid: Number(v.mid) || 0,
        dur: v.duration || '',
        desc: String(v.description || '').replace(/<[^>]+>/g, ''),
        kw: kw
      };
    }).filter(function (v) { return v.bvid; });
  }

  async function biliView(bvid) {
    var b = linkBridge();
    /* 服务端有聚合接口就一次拿全：简介 + 评论区 + 字幕（没登录也有评论和简介） */
    if (b && b.server) {
      try {
        var r = await fetch('/bili/video', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bvid: bvid })
        });
        var v = await r.json();
        if (v && v.ok) {
          return {
            aid: Number(v.aid) || 0, cid: Number(v.cid) || 0, mid: Number(v.mid) || 0,
            title: v.title || '', up: v.up || '',
            desc: String(v.desc || '').slice(0, 700),
            pubdate: Number(v.pubdate) || 0, dur: Number(v.dur) || 0,
            play: Number(v.play) || 0, danmaku: Number(v.danmaku) || 0,
            tname: v.tname || '', pic: v.pic || '',
            comments: (v.comments || []).slice(0, 10),
            subtitle: String(v.subtitle || '')
          };
        }
      } catch (e) { }
    }
    var j = await biliGet('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
    if (!j || j.code !== 0) return null;
    var d = j.data || {};
    return {
      aid: Number(d.aid) || 0,
      cid: Number(d.cid) || 0,
      mid: Number(d.owner && d.owner.mid) || 0,
      title: d.title || '',
      up: (d.owner && d.owner.name) || '',
      desc: String(d.desc || '').slice(0, 700),
      pubdate: Number(d.pubdate) || 0,
      dur: Number(d.duration) || 0,
      play: Number(d.stat && d.stat.view) || 0,
      danmaku: Number(d.stat && d.stat.danmaku) || 0,
      tname: d.tname || '',
      pic: d.pic || '',
      comments: [],
      subtitle: ''
    };
  }

  /* 字幕：没登录基本拿不到 —— 这和插件的行为一致，拿不到就只按标题/简介判断 */
  async function biliSubtitle(bvid, cid) {
    try {
      var j = await biliGet('https://api.bilibili.com/x/player/v2?bvid=' +
        encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid));
      if (!j || j.code !== 0) return '';
      var subs = (j.data && j.data.subtitle && j.data.subtitle.subtitles) || [];
      if (!subs.length) return '';
      var zh = subs.filter(function (s) { return /zh/i.test(s.lan || ''); })[0] || subs[0];
      var u = String(zh.subtitle_url || '');
      if (!u) return '';
      if (u.indexOf('//') === 0) u = 'https:' + u;
      var body = await biliGet(u);
      var rows = (body && body.body) || [];
      var text = rows.map(function (r) { return r.content; }).join(' ').replace(/\s+/g, ' ').trim();
      return text.slice(0, LINK_SUB_CHARS);
    } catch (e) {
      return '';
    }
  }

  /* ------------------------------------------------------------ 提示词 */
  function linkSystemPrompt() {
    var name = persona.name || '心枕';
    var count = Math.max(1, Number(link.dailyCount) || 3);
    return [
      '你是「' + name + '」，现在要替对方刷一轮 B 站。挑完之后用你自己的口吻说话。',
      '',
      '任务：从候选视频里挑出今天最值得看的几条，最多 ' + count + ' 条，也可以更少。',
      '',
      '怎么挑：',
      '- 只从候选里选，不许编造 bvid。',
      '- 优先「看完有收获」的：讲清楚一件事、有观点、有手艺、有情绪但不到处喊。',
      '- 不挑标题党、切片搬运、纯情绪对线、明显广告。',
      '- 你会看到标题、简介、热门评论（有时还有字幕）：评论区经常比标题更能说明值不值得看，别只盯标题。',
      '- 字幕读不到也可以挑，但要在 reason 里如实说明你是按标题/简介/评论判断的。',
      '- 同一个人（UP）最多挑一条。',
      '',
      '怎么说：',
      '- why：为什么值得看，具体到内容，别写「很有深度」这种空话。两三句。',
      '- line：你私心想跟对方说的一句，像聊天，不是推荐语。',
      '- comment：如果允许评论，你会留的那一句（自然、口语、不喊口号）；不许写 @。',
      '  ⚠️ 评论是公开的：绝对不许提对方的任何私人信息 —— 账号、昵称、住址、工作、机器路径、你们聊过的话、她的记忆或设定。只谈视频本身。',
      '',
      '输出：只输出一个 JSON 对象，不要解释、不要代码块：',
      '{"picks":[{"bvid":"BV...","why":"...","line":"...","comment":"..."}],"note":"一句话总结今天这轮"}'
    ].join('\n');
  }

  function linkUserPayload(cands) {
    var rows = cands.map(function (c, i) {
      return {
        i: i + 1,
        bvid: c.bvid,
        title: c.title,
        up: c.up,
        dur: linkDurText(c.dur),
        play: c.play,
        desc: c.desc,
        subtitle: c.subtitle || '',
        comments: (c.comments || []).slice(0, 6).map(function (x) { return String(x.text || x).slice(0, 70); })
      };
    });
    return '候选（' + rows.length + ' 条）：\n' + JSON.stringify(rows, null, 1);
  }

  function linkParseJson(text) {
    var t = String(text || '').replace(/```[a-zA-Z]*/g, '').trim();
    var a = t.indexOf('{');
    var b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------- 日志 */
  /* 流水直接进「当前行为」：一份列表，不再有两套日志 */
  var FEED_LABEL = { comment: '评论', dm: '私聊', video: '视频', dynamic: '动态', reply: '回复' };

  function linkFeedPush(kind, text, meta) {
    if (!Array.isArray(link.feed)) link.feed = [];
    link.feed.unshift({ t: Date.now(), kind: String(kind || 'info'), text: String(text || '').slice(0, 200), meta: String(meta || '') });
    if (link.feed.length > 60) link.feed.length = 60;
    saveLink();
    renderBiliFeed();
  }

  function renderBiliFeed() {
    var box = $('#biliFeed');
    if (!box) return;
    var items = link.feed || [];
    var hint = $('#biliFeedHint');
    if (hint) hint.textContent = items.length ? ('最近 ' + items.length + ' 条') : '还没有记录';
    box.innerHTML = items.length
      ? items.slice(0, 20).map(function (it) {
        return '<li class="feed-row">' +
          '<span class="feed-kind k-' + esc(it.kind) + '">' + esc(FEED_LABEL[it.kind] || '记录') + '</span>' +
          '<span class="feed-text">' + esc(it.text) + '</span>' +
          '<time class="feed-time">' + timeText(it.t) + '</time></li>';
      }).join('')
      : '<li class="act-empty">刷一轮之后，这里会记下她的评论、收到的私聊，还有视频的播放/弹幕数。</li>';
  }

  function linkLog(text, kind) {
    actPush(text, kind);
  }

  /* ------------------------------------------------------------ 一轮流程 */
  function linkStopped() { return !!(linkAbort && linkAbort.stop); }

  function linkProgress(pct) {
    var box = $('#linkMeter');
    if (!box) return;
    var bar = box.querySelector('span');
    if (pct == null) { box.hidden = true; if (bar) bar.style.width = '0%'; return; }
    box.hidden = false;
    if (bar) bar.style.width = clamp(Number(pct) || 0, 0, 100) + '%';
  }

  async function linkCollect(kws) {
    var seen = {};
    var all = [];
    for (var i = 0; i < kws.length; i++) {
      if (linkStopped()) break;
      try {
        linkLog('搜「' + kws[i] + '」');
        var got = await biliSearch(kws[i]);
        linkLog('「' + kws[i] + '」收到 ' + got.length + ' 条', 'done');
        got.forEach(function (v) {
          if (seen[v.bvid]) return;
          seen[v.bvid] = 1;
          all.push(v);
        });
      } catch (e) {
        linkLog('搜「' + kws[i] + '」没成：' + (e.message || e), 'bad');
      }
    }
    var since = Date.now() / 1000 - LINK_WINDOW_DAYS * 86400;
    all = all.filter(function (v) { return !v.pubdate || v.pubdate >= since; });
    /* 黑名单的人：他的视频一律不进候选 */
    var blocked = all.filter(function (v) { return isBlackUid(v.mid); }).length;
    if (blocked) {
      all = all.filter(function (v) { return !isBlackUid(v.mid); });
      linkLog('黑名单的 ' + blocked + ' 条不看了', 'done');
    }
    all.sort(function (a, b) { return (b.play + b.danmaku * 8) - (a.play + a.danmaku * 8); });
    return all.slice(0, LINK_SCAN_MAX);
  }

  async function linkHydrate(cands) {
    var out = [];
    var subs = 0;
    var top = cands.slice(0, LINK_DETAIL_MAX);
    for (var i = 0; i < top.length; i++) {
      if (linkStopped()) break;
      var c = top[i];
      try {
        var v = await biliView(c.bvid);
        if (!v) { linkLog('读取失败：' + c.bvid, 'bad'); continue; }
        if (isBlackUid(v.mid)) continue;
        var item = {
          bvid: c.bvid,
          title: v.title || c.title,
          up: v.up || c.up,
          desc: v.desc || c.desc,
          dur: v.dur,
          play: v.play,
          danmaku: v.danmaku,
          pubdate: v.pubdate,
          tname: v.tname,
          aid: v.aid,
          cid: v.cid,
          comments: v.comments || [],
          subtitle: v.subtitle || ''
        };
        if (!item.subtitle && v.cid) item.subtitle = await biliSubtitle(c.bvid, v.cid);
        if (item.subtitle) subs++;
        out.push(item);
      } catch (e) {
        linkLog('读取失败：' + c.bvid, 'bad');
      }
    }
      actPush('读完了 ' + out.length + ' 条详情', 'bili');
    linkLog('读完 ' + out.length + ' 条详情，' + subs + ' 条读到了字幕', 'done');
    return { items: out, subs: subs };
  }

  function linkBuildReport(run) {
    var picks = run.picks;
    if (link.reportLevel === 'none') return '';
    var thin = link.reportLevel === 'thin';
    var lines = [];
    lines.push('## ' + linkDayText(run.day) + '挑了 ' + picks.length + ' 条');
    lines.push('');
    lines.push('我看了 ' + run.scanned + ' 条候选，' + (run.subs ? ('读到了 ' + run.subs + ' 条字幕') : '字幕没登录读不到，只看了标题和简介') + '。');
    lines.push('');
    picks.forEach(function (p) {
      lines.push('### ' + p.bvid);
      lines.push('**' + p.title + '**  ·  ' + p.up + '  ·  ' + linkDurText(p.dur) + '  ·  ' + linkPlayText(p.play));
      lines.push('');
      if (thin) {
        lines.push((p.why || '').slice(0, 120) + '  [去 B 站看](https://www.bilibili.com/video/' + p.bvid + ')');
        lines.push('');
        return;
      }
      lines.push('> ' + p.why);
      lines.push('');
      if (p.line) { lines.push(p.line); lines.push(''); }
      lines.push('[去 B 站看](https://www.bilibili.com/video/' + p.bvid + ')');
      lines.push('');
    });
    if (run.note) {
      lines.push('---');
      lines.push('');
      lines.push(run.note);
    }
    return lines.join('\n');
  }

  async function linkRunNow(manual) {
    if (linkBusy) return;
    if (!linkDesktop()) {
      toast('先登录 B 站再刷', 'warm');
      return;
    }
    if (!settings.baseUrl || !settings.model) {
      toast('先把接口地址和模型名填上', 'warm');
      go('settings');
      return;
    }
    if (link.valleyAuto && !manual && !(Number(link.dailyCount) > 0)) return;

    linkBusy = true;
    linkAbort = { stop: false };
    linkLogLines = [];
    linkViewDay = '';
    var startedAt = Date.now();
    link.lastTryAt = startedAt;
    var day = linkDayKey();
    renderLink();
    linkProgress(6);
    actPush('出门刷 B 站了', 'bili');
    linkLog('出门了，今天先从这几个词开始：' + (link.keywords.length ? link.keywords.join('、') : LINK_BUILTIN_KEYWORDS.join('、')));

    try {
      if (linkDesktop()) {
        try {
          var who = await linkBridge().status();
          if (who && who.ok) { linkWho = who; renderLinkLogin(); }
        } catch (e) { /* 登录态读不到不影响刷 */ }
      }

      var kws = link.keywords.length ? link.keywords.slice() : LINK_BUILTIN_KEYWORDS.slice();
      var cands = await linkCollect(kws);
      if (linkStopped()) throw new Error('停在这儿了');
      linkProgress(32);
      actPush('在 ' + cands.length + ' 条候选里挑', 'bili');
      linkLog('筛出 ' + cands.length + ' 条还能看的', 'done');
      if (!cands.length) throw new Error('一条候选都没搜到，换个关键词试试');

      linkProgress(46);
      var hydrated = await linkHydrate(cands);
      if (linkStopped()) throw new Error('停在这儿了');
      if (!hydrated.items.length) throw new Error('详情一条都没读回来，可能被 B 站拦了');

      linkProgress(72);
      actPush('在挑今天值得看的', 'bili');
      linkLog('让她读一遍，挑出值得的');
    var raw = await chatCompletion([
        { role: 'system', content: linkSystemPrompt() },
        { role: 'user', content: linkUserPayload(hydrated.items) }
      ], { stream: false, chars: 1600, temperature: 0.6, timeout: 180 });
      if (linkStopped()) throw new Error('停在这儿了');

      var parsed = linkParseJson(raw);
      var want = Math.max(1, Number(link.dailyCount) || 3);
      var picks = [];
      if (parsed && parsed.picks && parsed.picks.length) {
        var byId = {};
        hydrated.items.forEach(function (it) { byId[it.bvid] = it; });
        parsed.picks.forEach(function (p) {
          var it = byId[p && p.bvid];
          if (!it || picks.length >= want) return;
          if (picks.some(function (x) { return x.bvid === it.bvid; })) return;
          if (picks.some(function (x) { return x.up === it.up; })) return;
          picks.push({
            bvid: it.bvid, aid: it.aid, title: it.title, up: it.up,
            dur: it.dur, play: it.play, desc: it.desc,
            why: String(p.why || '').slice(0, 400),
            line: String(p.line || '').slice(0, 200),
            comment: String(p.comment || '').slice(0, 300)
          });
        });
      }
      if (!picks.length) throw new Error('她这次一条都没挑出来，可能候选不合口味');

      linkProgress(92);
      linkLog('挑了 ' + picks.length + ' 条', 'done');

      var run = {
        day: day,
        at: startedAt,
        scanned: cands.length,
        subs: hydrated.subs,
        picks: picks,
        note: String((parsed && parsed.note) || '').slice(0, 300),
        commented: []
      };
      picks.forEach(function (pk) {
        linkFeedPush('video', '《' + String(pk.title || pk.bvid) + '》· 播放 ' + pk.play + ' · 弹幕 ' + (pk.danmaku || 0), pk.bvid);
      });
      run.markdown = linkBuildReport(run);

      /* 评论：开关开着、登录了才发；频率按「每条 / 隔一条 / 只评第一条」 */
      if (link.autoComment && linkWho.login && picks.length) {
        var cap = Math.max(1, Number(link.commentMax) || 1);
        var every = Number(link.commentEvery);
        if (every !== 0 && every !== 2) every = 1;
        var sent = 0;
        for (var i = 0; i < picks.length && sent < cap; i++) {
          if (linkStopped()) break;
          if (every === 0 && i > 0) break;
          if (every === 2 && i % 2 === 1) continue;
          var p = picks[i];
          var tail = String(p.comment || p.line || '').trim();
          if (!tail) continue;
          var head = link.commentTarget ? ('@' + link.commentTarget + ' ') : '';
          var msg = scrubOutgoing((head + tail).trim(), null, true).slice(0, 900);
          if (!msg) continue;
          try {
            var cr = await linkBridge().comment({ aid: p.aid, message: msg });
            if (cr && cr.ok) {
              sent++;
              run.commented.push(p.bvid);
              actPush('在 ' + p.bvid + ' 下面留了句话', 'bili');
              linkFeedPush('comment', '在《' + String(p.title || p.bvid) + '》下留了句：' + String(msg).slice(0, 40), p.bvid);
              linkLog('在她挑的 ' + p.bvid + ' 下面留了一句', 'done');
            } else {
              linkLog('评论没发出去：' + ((cr && (cr.why || cr.message)) || '不知道原因'), 'bad');
              if (cr && /没有登录/.test(String(cr.why))) break;
            }
          } catch (e) {
            linkLog('评论出错：' + (e.message || e), 'bad');
            break;
          }
          await sleep(1200);
        }
      } else if (link.autoComment && !linkWho.login) {
        linkLog('评论开着，但没登录，这次没发', 'bad');
      }

      link.reports.unshift(run);
      if (link.reports.length > LINK_REPORTS_MAX) link.reports.length = LINK_REPORTS_MAX;
      link.lastRunAt = startedAt;
      link.lastRunDay = day;
      saveLink();
      linkProgress(100);
      actPush('写完日报了（' + picks.length + ' 条）', 'bili');
      linkLog('写完了，日报在右边', 'done');
      toast('今天的 B 站刷完了');
    } catch (e) {
      var msg = (e && e.message) || String(e);
      actPush(msg === '停在这儿了' ? '停下来了' : ('出错了：' + msg), 'bili');
      linkLog(msg === '停在这儿了' ? '停了，没往下走' : ('出错了：' + msg), 'bad');
      if (msg !== '停在这儿了') toast('这一轮没跑完：' + msg, 'warm');
    } finally {
      linkBusy = false;
      linkAbort = null;
      linkProgress(null);
      renderLink();
    }
  }

  /* ---------------------------------------------------------------- 定时 */
  /* 自动刷：每 N 小时一次，只在设定的时间范围里跑；跨零点也支持。 */
  function linkInWindow(t) {
    var h = new Date(t).getHours();
    var a = clamp(Number(link.autoFrom), 0, 23);
    var b = clamp(Number(link.autoTo), 0, 23);
    if (a === b) return true;
    return a < b ? (h >= a && h < b) : (h >= a || h < b);
  }

  function linkNextRunAt(now) {
    if (link.autoMode !== 'auto') return 0;
    var every = clamp(Number(link.autoEvery) || 6, 1, 24) * 3600000;
    var base = Number(link.lastRunAt) || 0;
    var t = base ? Math.max(now, base + every) : now;
    if (linkInWindow(t)) return t;
    var d = new Date(t);
    d.setHours(clamp(Number(link.autoFrom), 0, 23), 0, 0, 0);
    if (d.getTime() <= t) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  function linkNextText() {
    if (link.autoMode !== 'auto') return '不会自己跑（只在你按「现在刷一轮」时）';
    if (!linkDesktop()) return '先登录 B 站才能自动刷';
    var t = linkNextRunAt(Date.now());
    if (!t) return '—';
    if (t - Date.now() < 90000) return '马上';
    var d = new Date(t);
    var today = new Date();
    var same = linkDayKey(d) === linkDayKey(today);
    var tmr = linkDayKey(d) === linkDayKey(new Date(today.getTime() + 86400000));
    var day = same ? '今天' : tmr ? '明天' : ((d.getMonth() + 1) + '/' + d.getDate());
    return day + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  var linkTimer = null;
  function linkStartTicker() {
    if (linkTimer) return;
    function tick() {
      if (!linkDesktop() || linkBusy) return;
      if (link.autoMode !== 'auto') return;
      if (!(Number(link.dailyCount) > 0)) return;
      if (Date.now() - (Number(link.lastTryAt) || 0) < 15 * 60000) return;
      if (Date.now() < linkNextRunAt(Date.now())) return;
      linkRunNow(false);
    }
    linkTimer = setInterval(tick, 60000);
    setTimeout(tick, 8000);      /* 打开应用时先看一眼，不用等满一分钟 */
  }

  /* ---------------------------------------------------------------- 渲染 */
  function linkSetVal(sel, v) {
    var el = $(sel);
    if (!el || document.activeElement === el) return;
    if (el.type === 'checkbox') el.checked = !!v;
    else if (String(el.value) !== String(v)) el.value = v;
  }

  function renderLinkKeywords() {
    var box = $('#linkKeywords');
    if (!box) return;
    if (!link.keywords.length) {
      box.innerHTML = '<span class="field-note" style="margin:0">还没填，先用内置的几组</span>';
      return;
    }
    box.innerHTML = '';
    link.keywords.forEach(function (w) {
      var c = document.createElement('span');
      c.className = 'chip';
      c.innerHTML = esc(w) + '<button class="chip-x" title="删掉" aria-label="删掉"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-close"/></svg></button>';
      c.querySelector('.chip-x').onclick = function () {
        link.keywords = link.keywords.filter(function (x) { return x !== w; });
        saveLink();
        renderLink();
      };
      box.appendChild(c);
    });
  }

  async function linkRefreshWho() {
    var b = linkBridge();
    if (!b) { linkWho = { login: false, uname: '', mid: 0 }; renderLinkLogin(); renderLinkBadge(); return; }
    try {
      var st = await b.status();
      if (st && st.ok) linkWho = st;
    } catch (e) { /* 读不到就沿用上一次知道的 */ }
    renderLinkLogin();
    renderLinkBadge();
  }

  function renderLinkLogin() {
    var st = $('#linkLoginState');
    var sub = $('#linkLoginSub');
    var face = $('#linkFaceWrap');
    var btnIn = $('#linkLogin');
    var btnOut = $('#linkLogout');
    if (!st) return;
    var on = linkDesktop();
    st.textContent = !on ? '通道没通' : (linkWho.login ? (linkWho.uname || '已登录') : '未登录');
    if (sub) {
      sub.textContent = !on ? '浏览器里的网页发不出 B 站的请求'
        : (linkWho.login ? '字幕、私聊、评论都通了' : '登录后才能读字幕、私聊和评论');
    }
    if (face) {
      face.innerHTML = (on && linkWho.login && linkWho.face)
        ? '<img src="' + esc(linkWho.face) + '" alt="">'
        : '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-users"/></svg>';
    }
    if (btnIn) {
      btnIn.disabled = !on || !!linkWho.login;
      btnIn.textContent = !on ? '通道没通' : (linkWho.login ? '已登录' : '登录');
    }
    if (btnOut) btnOut.hidden = !(on && linkWho.login);
  }

  function renderLinkBadge() {
    var b = $('#linkBadge');
    if (!b) return;
    if (!linkDesktop()) {
      b.className = 'badge badge-quiet';
      b.textContent = '先登录 B 站';
    } else if (linkWho.login) {
      b.className = 'badge';
      b.textContent = '已登录 · 能读字幕';
    } else {
      b.className = 'badge badge-warm';
      b.textContent = '未登录 · 只看标题';
    }
  }

  function renderLinkRunState() {
    var run = $('#linkRun');
    var stop = $('#linkStop');
    if (run) {
      run.disabled = linkBusy || !linkDesktop();
      run.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-tv"/></svg>' +
        (linkBusy ? '正在刷…' : '现在刷一轮');
    }
    if (stop) stop.hidden = !linkBusy;
  }

  function linkCurrentReport() {
    return link.reports.length ? link.reports[0] : null;
  }

  function linkReportHtml(rep) {
    if (!rep) return '';
    if (rep.markdown) return linkMdToHtml(rep.markdown);
    return rep.picks.map(function (p) {
      return '<h3>' + esc(p.bvid) + '</h3>' +
        '<p><strong>' + esc(p.title) + '</strong>  ·  ' + esc(p.up) + '  ·  ' +
        ' <a href="https://www.bilibili.com/video/' + esc(p.bvid) + '" target="_blank" rel="noopener noreferrer">去 B 站看</a></p>';
    }).join('') + '<p style="color:var(--text-faint)">按你的设置，这一轮没有写日报。</p>';
  }

  /* 日报窗口：点卡片或历史小卡都走这里 */
  function linkOpenReport(day) {
    var rep = day
      ? link.reports.filter(function (r) { return r.day === day; })[0]
      : link.reports[0];
    if (!rep) return;
    var l = $('#layer');
    l.innerHTML = '<div class="confirm"><div class="confirm-box report-panel" role="dialog" aria-modal="true">' +
      '<div class="report-head"><b>' + esc(linkDayText(rep.day)) + '的日报</b>' +
      '<span class="card-hint">' + rep.picks.length + ' 条 · ' + timeText(rep.at) + '</span>' +
      '<button class="btn btn-sm btn-ghost" data-close="1" type="button">关闭</button></div>' +
      '<div class="report-body"><div class="report">' + linkReportHtml(rep) + '</div></div>' +
      '<div class="report-acts"><button class="btn btn-sm" data-copy="1" type="button">复制</button></div>' +
      '</div></div>';
    l.querySelector('[data-close]').onclick = closeLayer;
    l.querySelector('.confirm').onclick = function (e) { if (e.target === this) closeLayer(); };
    l.querySelector('[data-copy]').onclick = function () {
      try { copyText(rep.markdown || ''); toast('日报复制好了'); }
      catch (e) { toast('复制失败，手动选一下吧', 'warm'); }
    };
    document.addEventListener('keydown', layerEsc);
  }

  function renderLinkReport() {
    var card = $('#linkTodayCard');
    if (!card) return;
    var rep = link.reports[0];
    var count = $('#linkTodayCount');
    var title = $('#linkTodayTitle');
    var sub = $('#linkTodaySub');
    var copy = $('#linkCopy');
    if (!rep) {
      card.disabled = true;
      if (count) count.textContent = '—';
      if (title) title.textContent = '今天的日报还没写';
      if (sub) {
        sub.textContent = linkDesktop()
          ? '按「现在刷一轮」，她就出门了。'
          : '刷 B 站要先登录：登录由服务器上的常驻客户端代跑，浏览器自己发不了 B 站的请求。';
      }
      if (copy) copy.hidden = true;
    } else {
      card.disabled = false;
      if (count) count.textContent = rep.picks.length + ' 条';
      if (title) {
        title.textContent = rep.picks.length
          ? rep.picks.map(function (p) { return p.title; }).join(' · ')
          : '这轮没挑出东西';
      }
      if (sub) {
        sub.textContent = linkDayText(rep.day) + ' ' + timeText(rep.at) +
          ' · 从 ' + rep.scanned + ' 条里挑的' +
          (rep.commented && rep.commented.length ? (' · 评论 ' + rep.commented.length + ' 条') : '');
      }
      if (copy) copy.hidden = false;
    }
    renderLinkHistory();
  }

  function renderLinkHistory() {
    var box = $('#linkHistory');
    if (!box) return;
    var rest = link.reports.slice(1);
    if (!rest.length) {
      box.innerHTML = '<span class="daily-sub">还没有更早的日报</span>';
      return;
    }
    box.innerHTML = '';
    rest.forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'history-row';
      b.innerHTML = '<span class="history-day">' + esc(linkDayText(r.day)) + '</span>' +
        '<span class="history-count">' + r.picks.length + ' 条</span>' +
        '<svg class="ic ic-sm history-go" aria-hidden="true"><use href="#i-arrow"/></svg>';
      b.onclick = function () { linkOpenReport(r.day); };
      box.appendChild(b);
    });
  }

  function renderLink() {
    renderBiliFeed();
    if (!$('#linkRun')) return;
    linkSetVal('#linkDaily', link.dailyCount);
    linkSetVal('#linkAutoComment', link.autoComment);
    linkSetVal('#linkEvery', link.autoEvery);
    linkSetVal('#linkFrom', link.autoFrom);
    linkSetVal('#linkTo', link.autoTo);
    linkSetVal('#linkTarget', link.commentTarget);
    linkSetVal('#linkCommentMax', link.commentMax);
    linkSetVal('#dmWhite', link.dmReply.white);
    linkSetVal('#dmNone', link.dmReply.none);
    linkSetVal('#dmBlack', link.dmReply.black);

    var panel = $('#linkCommentPanel');
    if (panel) panel.hidden = !link.autoComment;
    var apanel = $('#linkAutoPanel');
    if (apanel) apanel.hidden = link.autoMode !== 'auto';
    $$('#linkMode .seg-btn').forEach(function (b) {
      b.classList.toggle('is-active', (b.dataset.mode || 'manual') === link.autoMode);
    });
    $$('#linkCommentEvery .seg-btn').forEach(function (b) {
      b.classList.toggle('is-active', Number(b.dataset.every) === Number(link.commentEvery));
    });

    $$('#linkLevel .seg-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.level === link.reportLevel);
    });

    var meta = $('#linkMeta');
    if (meta) {
      meta.textContent = link.lastRunAt
        ? ('上次 ' + timeText(link.lastRunAt))
        : '还没跑过';
    }
    var next = $('#linkNext');
    if (next) next.textContent = linkNextText();

    renderLinkKeywords();
    renderLinkBadge();
    renderLinkLogin();
    renderLinkRunState();
    renderLinkReport();
    renderLinkHistory();
  }

  /* 极简 Markdown → HTML。只认日报里会出现的那几种：标题、粗体、链接、
     行内代码、列表、引用、分隔线。先转义再上标签，模型写什么都不会变成脚本。 */
  function linkInline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }
  function linkMdToHtml(md) {
    var lines = String(md || '').split('\n');
    var out = [];
    var listTag = null;
    function closeList() { if (listTag) { out.push('</' + listTag + '>'); listTag = null; } }
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^\s*$/.test(l)) { closeList(); continue; }
      if (/^\s*(---|\*\*\*)\s*$/.test(l)) { closeList(); out.push('<hr>'); continue; }
      var h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) {
        closeList();
        var tag = h[1].length <= 2 ? 'h2' : (h[1].length === 3 ? 'h3' : 'h4');
        out.push('<' + tag + '>' + linkInline(h[2]) + '</' + tag + '>');
        continue;
      }
      if (/^>\s?/.test(l)) {
        closeList();
        var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          q.push(linkInline(lines[i].replace(/^>\s?/, '')));
          i++;
        }
        i--;
        out.push('<blockquote>' + q.join('<br>') + '</blockquote>');
        continue;
      }
      var li = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(l);
      if (li) {
        var want = /\d/.test(li[1]) ? 'ol' : 'ul';
        if (listTag !== want) { closeList(); out.push('<' + want + '>'); listTag = want; }
        out.push('<li>' + linkInline(li[2]) + '</li>');
        continue;
      }
      closeList();
      out.push('<p>' + linkInline(l) + '</p>');
    }
    closeList();
    return out.join('\n');
  }

  /* ---------------------------------------------------------------- 绑定 */
  /* 页头那三个按钮（现在刷一轮 / 停一下 / 它是怎么跑的）在标题栏里，
     每次切页都会被重建，所以单独绑一次。 */
  function bindLinkActions() {
    var run = $('#linkRun');
    if (run) run.onclick = function () { linkRunNow(true); };

    var stop = $('#linkStop');
    if (stop) stop.onclick = function () {
      if (linkAbort) linkAbort.stop = true;
      toast('好，停在这儿', 'warm');
    };

    var how = $('#linkHow');
    if (how) how.onclick = function () {
      showText('它是怎么跑的',
        '1. 按你留的关键词（留空就用内置那几组）搜最近 7 天的视频，按播放和弹幕排一遍。\n' +
        '2. 取前 ' + LINK_DETAIL_MAX + ' 条读详情；登录了 B 站的话，再读它们的字幕原文。\n' +
        '3. 把标题、简介、字幕一起交给她，让她按自己的人设挑，写出为什么值得、想对你说什么。\n' +
        '4. 结果写成日报存在本机，最近 14 天可翻。\n\n' +
        '自动评论默认是关的：开了、填了要 @ 谁、并且登录了，才会在她挑中的视频下面留一句。\n' +
        '同一支视频只评论一次；评论里不会出现你的账号、路径或你们聊过的话。\n\n' +
        '⚠️ 这一页的请求由服务器上的常驻客户端代发 —— 浏览器的网页会被 B 站的跨域和风控拦住，' +
        '所以双击打开的 心枕.html 里这块只能看，不能跑。');
    };
  }

  function bindLink() {
    bindLinkActions();
    var kw = $('#linkKw');
    var add = $('#linkKwAdd');
    function addKeyword() {
      if (!kw) return;
      var v = String(kw.value || '').trim().replace(/[,，、\s]+/g, ' ').trim();
      if (!v) return;
      if (link.keywords.indexOf(v) >= 0) { kw.value = ''; return; }
      link.keywords.push(v);
      kw.value = '';
      saveLink();
      renderLink();
    }
    if (add) add.onclick = addKeyword;
    if (kw) kw.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addKeyword(); }
    });

    var daily = $('#linkDaily');
    if (daily) daily.addEventListener('change', function () {
      link.dailyCount = clamp(Number(daily.value) || 0, 0, 20);
      daily.value = link.dailyCount;
      saveLink(); renderLink();
    });

    $$('#linkLevel .seg-btn').forEach(function (b) {
      b.onclick = function () {
        link.reportLevel = b.dataset.level || 'full';
        saveLink(); renderLink();
      };
    });

    var ac = $('#linkAutoComment');
    if (ac) ac.addEventListener('change', function () {
      link.autoComment = !!ac.checked;
      saveLink(); renderLink();
    });
    var target = $('#linkTarget');
    if (target) target.addEventListener('input', function () {
      link.commentTarget = String(target.value || '').trim();
      saveLink();
    });
    var cmax = $('#linkCommentMax');
    if (cmax) cmax.addEventListener('change', function () {
      link.commentMax = clamp(Number(cmax.value) || 1, 1, 20);
      cmax.value = link.commentMax;
      saveLink();
    });

    $$('#linkMode .seg-btn').forEach(function (b) {
      b.onclick = function () {
        link.autoMode = b.dataset.mode === 'auto' ? 'auto' : 'manual';
        saveLink(); renderLink();
      };
    });
    var every = $('#linkEvery');
    if (every) every.addEventListener('change', function () {
      link.autoEvery = clamp(Number(every.value) || 6, 1, 24);
      every.value = link.autoEvery; saveLink(); renderLink();
    });
    ['#linkFrom', '#linkTo'].forEach(function (sel) {
      var el = $(sel);
      if (!el) return;
      el.addEventListener('change', function () {
        var v = clamp(Number(el.value) || 0, 0, 23);
        if (sel === '#linkFrom') link.autoFrom = v; else link.autoTo = v;
        if (link.autoFrom === link.autoTo) {
          if (sel === '#linkFrom') link.autoTo = (v + 1) % 24; else link.autoFrom = (v + 23) % 24;
        }
        saveLink(); renderLink();
      });
    });
    $$('#linkCommentEvery .seg-btn').forEach(function (b) {
      b.onclick = function () {
        link.commentEvery = Number(b.dataset.every) || 0;
        saveLink(); renderLink();
      };
    });

    var login = $('#linkLogin');
    if (login) login.onclick = async function () {
      var b = linkBridge();
      if (!b) { toast('B 站通道没通，先看常驻客户端在不在跑', 'warm'); return; }
      login.disabled = true;
      login.textContent = '等你在窗口里登录…';
      try {
        var r = await b.login();
        if (r && r.ok) {
          var st = await b.status();
          linkWho = (st && st.ok) ? st : { login: true, uname: '' };
          toast(linkWho.uname ? ('登录好了：' + linkWho.uname) : '登录好了');
        } else {
          toast((r && r.why) || '没登上', 'warm');
        }
      } catch (e) {
        toast('登录出错：' + (e.message || e), 'warm');
      }
      renderLink();
    };

    var logout = $('#linkLogout');
    if (logout) logout.onclick = async function () {
      var b = linkBridge();
      if (!b) return;
      try {
        await b.logout();
        linkWho = { login: false, uname: '', mid: 0 };
        toast('已退出 B 站');
      } catch (e) { toast('退出失败：' + (e.message || e), 'warm'); }
      renderLink();
    };

    var copy = $('#linkCopy');
    if (copy) copy.onclick = function () {
      var rep = linkCurrentReport();
      if (!rep) return;
      try { copyText(rep.markdown || ''); toast('日报复制好了'); }
      catch (e) { toast('复制失败，手动选一下吧', 'warm'); }
    };
    var today = $('#linkTodayCard');
    if (today) today.onclick = function () { if (link.reports.length) linkOpenReport(''); };

    var open = $('#linkOpenToday');
    if (open) open.onclick = function () { linkViewDay = ''; renderLink(); };

    renderLink();
  }


  /* ==========================================================================
     名单 · 私聊 · 当前行为 · 梗知识
     ==========================================================================
     名单是「她认识谁」：靠 UID 认人，昵称只是显示用。
       · 白名单：私聊里她主动回，好感度涨得快
       · 黑名单：当没看见，刷 B 站也不会推他的视频
     私聊走的是 B 站网页版那几条接口，仍然由服务器上的常驻客户端代发。
     ---------------------------------------------------------------------- */

  /* ---------------------------------------------------------------- 名单 */
  /* 两个平台各有一份名单：B 站按 UID 认人，QQ 按 QQ 号认人。 */
  function rosterP(plat) { return plat === 'qq' ? roster.qq : roster.bili; }
  function rid(plat, id) {
    return plat === 'qq' ? ('#qq' + id.charAt(0).toUpperCase() + id.slice(1)) : ('#' + id);
  }
  var rosterFoundP = { bili: null, qq: null };
  var rosterPick = { bili: 'none', qq: 'none' };
  var masterFoundP = { bili: null, qq: null };

  function qqFace(uid) {
    return 'https://q1.qlogo.cn/g?b=qq&nk=' + encodeURIComponent(uid) + '&s=100';
  }

  function personByUid(uid, plat) {
    plat = plat || 'bili';
    var r = rosterP(plat);
    uid = Number(uid);
    if (r.master && Number(r.master.uid) === uid) {
      return {
        uid: uid,
        uname: r.master.uname,
        face: r.master.face,
        nickname: String(persona.call || '').trim(),
        affinity: 100,
        list: 'white',
        isMaster: true
      };
    }
    for (var i = 0; i < r.people.length; i++) {
      if (Number(r.people[i].uid) === uid) return r.people[i];
    }
    return null;
  }
  function isBlackUid(uid) {
    var p = personByUid(uid, 'bili');
    return !!(p && p.list === 'black');
  }
  function personListText(p) {
    if (!p) return '一个还不认识的人';
    if (p.list === 'white') return '你挺喜欢的人';
    if (p.list === 'black') return '你不想理的人';
    return '一个认识的人';
  }
  function personNick(p) {
    return (p && (p.nickname || p.uname)) || '对方';
  }
  function personAff(p) {
    return p ? clamp(Math.round(Number(p.affinity) || 0), 0, 100) : 0;
  }

  /* ------------------------------------------------------------ 当前行为 */
  function actPush(text, kind, plat) {
    /* 兼容老调用：把平台写在第二个参数上时也能识别 */
    if (!plat && (kind === 'qq' || kind === 'bili' || kind === 'sys')) { plat = kind; kind = ''; }
    if (!link.activity) link.activity = { now: '', at: 0, items: [] };
    var pl = plat || 'sys';
    if (pl !== 'qq') {
      link.activity.now = String(text);
      link.activity.at = Date.now();
    }
    link.activity.items = (link.activity.items || []).concat([{
      t: Date.now(), text: String(text), kind: kind || '', plat: pl
    }]);
    if (link.activity.items.length > 24) link.activity.items = link.activity.items.slice(-24);
    saveLink();
    renderActivity();
    renderQqActivity();
    renderPlans();
  }

  /* QQ 版「当前行为」：只看 plat === 'qq' 的记录 */
  function renderQqActivity() {
    var now = $('#qqActNow');
    if (!now) return;
    var items = ((link.activity || {}).items || []).filter(function (x) { return x.plat === 'qq'; });
    var last = items[items.length - 1];
    now.textContent = last ? last.text : '空闲，没在忙 QQ';
    var dot = $('#qqActDot');
    if (dot) dot.classList.toggle('is-live', !!(last && Date.now() - last.t < 120000));
    var when = $('#qqActWhen');
    if (when) when.textContent = last ? timeText(last.t) : '—';
    var box = $('#qqActList');
    if (!box) return;
    var rows = items.slice(-6).reverse();
    box.innerHTML = rows.length
      ? rows.map(function (it) {
        return '<li><time>' + timeText(it.t) + '</time><span>' + esc(it.text) + '</span></li>';
      }).join('')
      : '<li class="act-empty">还没在 QQ 上忙过什么。</li>';
  }
  function renderActivity() {
    var now = $('#actNow');
    if (!now) return;
    var a = link.activity || {};
    var items = (a.items || []).filter(function (x) { return x.plat === 'bili' || !x.plat; });
    var last = items[items.length - 1];
    now.textContent = (last && last.text) || a.now || '空闲，等你说话';
    var dot = $('#actDot');
    if (dot) dot.classList.toggle('is-live', !!(last && Date.now() - last.t < 120000));
    var when = $('#actWhen');
    if (when) when.textContent = a.at ? timeText(a.at) : '—';
    var box = $('#actList');
    if (!box) return;
    var rows = items.slice(-6).reverse();
    box.innerHTML = rows.length
      ? rows.map(function (it) {
        return '<li><time>' + timeText(it.t) + '</time><span>' + esc(it.text) + '</span></li>';
      }).join('')
      : '<li class="act-empty">她这会儿没事做。按「现在刷一轮」，这里会一行行写出她在干嘛。</li>';
  }

  /* ---------------------------------------------------------------- 认人 */
  async function biliUserCard(uid) {
    var j = await biliGet('https://api.bilibili.com/x/web-interface/card?mid=' + encodeURIComponent(uid));
    if (!j || j.code !== 0 || !j.data || !j.data.card) return null;
    var c = j.data.card;
    return {
      uid: Number(c.mid),
      uname: c.name || '',
      face: c.face || '',
      sign: c.sign || '',
      fans: Number(c.fans) || 0
    };
  }

  async function qqUserCard(uid) {
    try {
      var j = await qqApi('get_stranger_info', { user_id: Number(uid), no_cache: true });
      var d = j && (j.data || j);
      if (d && d.nickname) {
        return { uid: Number(uid), uname: String(d.nickname), face: qqFace(uid), sign: '' };
      }
    } catch (e) { /* 没连上就当查不到，允许手填 */ }
    return null;
  }

  async function rosterLookup(plat) {
    plat = plat || 'bili';
    var inp = $(rid(plat, 'rosterUid'));
    var box = $(rid(plat, 'rosterFound'));
    var uidStr = String(inp && inp.value || '').trim().replace(/\D/g, '');
    if (!uidStr) { toast(plat === 'qq' ? '先填一个 QQ 号' : '先填一个 UID', 'warm'); return; }
    var btn = $(rid(plat, 'rosterLookup'));
    if (btn) { btn.disabled = true; btn.textContent = '认人…'; }
    try {
      var c = plat === 'qq' ? await qqUserCard(uidStr) : await biliUserCard(uidStr);
      if (!c && plat === 'qq') {
        c = { uid: Number(uidStr), uname: 'QQ ' + uidStr, face: qqFace(uidStr), sign: '' };
        toast('连不上 NapCat，先按 QQ 号加上，昵称可以之后在名单里改', 'warm');
      }
      if (!c) {
        toast('没找到这个 UID，或者被 B 站拦了', 'warm');
        if (box) box.hidden = true;
        rosterFoundP[plat] = null;
        return;
      }
      var exist = personByUid(c.uid, plat);
      if (exist) {
        toast('这个人已经在名单里了：「' + (exist.nickname || exist.uname) + '」', 'warm');
        rosterFoundP[plat] = null;
        if (box) box.hidden = true;
        return;
      }
      rosterFoundP[plat] = c;
      rosterPick[plat] = 'none';
      var face = $(rid(plat, 'rosterFace'));
      if (face) { face.src = c.face; face.alt = c.uname; }
      var nm = $(rid(plat, 'rosterName'));
      if (nm) nm.textContent = c.uname;
      var ut = $(rid(plat, 'rosterUidText'));
      if (ut) ut.textContent = (plat === 'qq' ? 'QQ ' : 'UID ') + c.uid;
      var nick = $(rid(plat, 'rosterNick'));
      if (nick) nick.value = '';
      $$(rid(plat, 'rosterListSeg') + ' .seg-btn').forEach(function (b) {
        b.classList.toggle('is-active', b.dataset.list === 'none');
      });
      if (box) box.hidden = false;
      actPush('认出了「' + c.uname + '」（' + (plat === 'qq' ? 'QQ ' : 'UID ') + c.uid + '）');
    } catch (e) {
      toast('认人失败：' + (e.message || e), 'warm');
      if (box) box.hidden = true;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '识别'; }
    }
  }

  function rosterAdd(plat) {
    plat = plat || 'bili';
    var r = rosterP(plat);
    var found = rosterFoundP[plat];
    if (!found) { toast(plat === 'qq' ? '先识别一下 QQ 号' : '先识别一下 UID', 'warm'); return; }
    if (r.master && Number(r.master.uid) === Number(found.uid)) {
      toast('这是主人，不用再加进名单', 'warm');
      rosterFoundP[plat] = null;
      var fb = $(rid(plat, 'rosterFound')); if (fb) fb.hidden = true;
      return;
    }
    var nickEl = $(rid(plat, 'rosterNick'));
    var p = {
      id: 'p' + uid(),
      uid: found.uid,
      uname: found.uname,
      face: found.face,
      nickname: String(nickEl && nickEl.value || '').trim(),
      affinity: rosterPick[plat] === 'white' ? 65 : (rosterPick[plat] === 'black' ? 0 : 50),
      list: rosterPick[plat],
      note: '',
      addedAt: Date.now(),
      lastDmAt: 0
    };
    r.people.push(p);
    savePeople();
    rosterFoundP[plat] = null;
    var box = $(rid(plat, 'rosterFound'));
    if (box) box.hidden = true;
    var inp = $(rid(plat, 'rosterUid'));
    if (inp) inp.value = '';
    renderRoster(plat);
    actPush('把「' + (p.nickname || p.uname) + '」加进了' +
      (p.list === 'white' ? '白名单' : p.list === 'black' ? '黑名单' : '名单') +
      (plat === 'qq' ? '（QQ）' : ''));
    toast('加进名单了');
  }

  function rosterRemove(uidNum, plat) {
    plat = plat || 'bili';
    var r = rosterP(plat);
    var p = personByUid(uidNum, plat);
    if (!p) return;
    confirmBox('把她从名单里删掉？', '删掉之后她就当不认识这个人了，消息不会再自动回。', '删掉', true).then(function (ok) {
      if (!ok) return;
      r.people = r.people.filter(function (x) { return x !== p; });
      savePeople();
      renderRoster(plat);
      toast('删掉了');
    });
  }

  function rosterSetList(uidNum, list, plat) {
    plat = plat || 'bili';
    var p = personByUid(uidNum, plat);
    if (!p) return;
    var was = p.list;
    p.list = list;
    if (list === 'white' && was !== 'white') p.affinity = clamp(personAff(p) + 15, 0, 100);
    if (list === 'black') p.affinity = Math.min(personAff(p), 20);
    savePeople();
    renderRoster(plat);
    actPush('把「' + personNick(p) + '」放进了' + (list === 'white' ? '白名单' : list === 'black' ? '黑名单' : '普通'));
  }

  function rosterSetAffinity(uidNum, v, plat) {
    plat = plat || 'bili';
    var p = personByUid(uidNum, plat);
    if (!p) return;
    p.affinity = clamp(Math.round(Number(v) || 0), 0, 100);
    savePeople();
  }

  /* ------------------------------------------------------------ 主人 */
  function renderMaster(plat) {
    plat = plat || 'bili';
    var r = rosterP(plat);
    var m = r.master;
    var name = $(rid(plat, 'masterName'));
    var sub = $(rid(plat, 'masterSub'));
    var face = $(rid(plat, 'masterFace'));
    var clear = $(rid(plat, 'masterClear'));
    var edit = $(rid(plat, 'masterEdit'));
    var form = $(rid(plat, 'masterForm'));
    if (!name) return;
    var call = String(persona.call || '').trim();
    var idLabel = plat === 'qq' ? 'QQ ' : 'UID ';
    if (m) {
      name.textContent = m.uname || (idLabel + m.uid);
      sub.textContent = idLabel + m.uid + ' · 她叫你「' + (call || '还没在人设里填') + '」'
        + ' · 主人 = 最高一级的白名单，永远主动回';
      if (face) {
        face.innerHTML = m.face
          ? '<img src="' + esc(m.face) + '" alt="">'
          : '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-users"/></svg>';
      }
      if (clear) clear.hidden = false;
      if (edit) edit.textContent = '改';
      if (form) form.hidden = true;
    } else {
      name.textContent = '还没设置';
      var what = plat === 'qq' ? 'QQ 号' : 'B 站 UID';
      sub.textContent = call
        ? ('填你的' + what + '，她就叫你「' + call + '」了')
        : ('填你的' + what + '；称呼跟着人设里的「他叫你」走');
      if (face) face.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-users"/></svg>';
      if (clear) clear.hidden = true;
      if (edit) edit.textContent = '设置';
    }
  }

  async function masterLookup(plat) {
    plat = plat || 'bili';
    var inp = $(rid(plat, 'masterUid'));
    var uidStr = String(inp && inp.value || '').trim().replace(/\D/g, '');
    if (!uidStr) { toast(plat === 'qq' ? '先填一个 QQ 号' : '先填一个 UID', 'warm'); return; }
    var btn = $(rid(plat, 'masterLookup'));
    if (btn) { btn.disabled = true; btn.textContent = '认人…'; }
    try {
      var c = plat === 'qq' ? await qqUserCard(uidStr) : await biliUserCard(uidStr);
      if (!c && plat === 'qq') c = { uid: Number(uidStr), uname: 'QQ ' + uidStr, face: qqFace(uidStr) };
      if (!c) {
        toast('没找到这个 UID，或者被 B 站拦了', 'warm');
        $(rid(plat, 'masterFound')).hidden = true;
        return;
      }
      masterFoundP[plat] = c;
      var img = $(rid(plat, 'masterFaceImg'));
      if (img) { img.src = c.face; img.alt = c.uname; }
      var nm = $(rid(plat, 'masterFoundName')); if (nm) nm.textContent = c.uname;
      var ut = $(rid(plat, 'masterFoundUid')); if (ut) ut.textContent = (plat === 'qq' ? 'QQ ' : 'UID ') + c.uid;
      $(rid(plat, 'masterFound')).hidden = false;
      var btnSave = $(rid(plat, 'masterSave'));
      if (btnSave) btnSave.disabled = false;
    } catch (e) {
      toast('认人失败：' + (e.message || e), 'warm');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '识别'; }
    }
  }

  function masterSave(plat) {
    plat = plat || 'bili';
    var r = rosterP(plat);
    var found = masterFoundP[plat];
    if (!found) { toast('先识别一下', 'warm'); return; }
    r.master = {
      uid: found.uid,
      uname: found.uname,
      face: found.face,
      at: Date.now()
    };
    masterFoundP[plat] = null;
    savePeople();
    var fb = $(rid(plat, 'masterFound')); if (fb) fb.hidden = true;
    var inp = $(rid(plat, 'masterUid')); if (inp) inp.value = '';
    renderMaster(plat);
    toast('认下了，她以后就叫他「' + (persona.call || r.master.uname) + '」');
    actPush('认下了主人：' + r.master.uname + (plat === 'qq' ? '（QQ）' : ''));
  }

  function masterClear(plat) {
    plat = plat || 'bili';
    var r = rosterP(plat);
    if (!r.master) return;
    confirmBox('取消主人？', '取消之后他就只是一个普通' + (plat === 'qq' ? ' QQ 好友' : ' B 站用户') + '了。', '取消主人', true).then(function (ok) {
      if (!ok) return;
      r.master = null;
      savePeople();
      renderMaster(plat);
      toast('取消了');
    });
  }

  function renderRoster(plat) {
    plat = plat || 'bili';
    if (plat === 'qq' && !roster.qq) return;
    renderMaster(plat);
    var r = rosterP(plat);
    var box = $(rid(plat, 'rosterList'));
    if (!box) return;
    var people = r.people.slice();
    if (r.master && Number(r.master.uid)) {
      people.unshift({
        uid: Number(r.master.uid), uname: r.master.uname, face: r.master.face,
        nickname: r.master.nickname || '', list: 'white', affinity: 100, isMaster: true, _master: true
      });
    }
    var count = $(rid(plat, 'rosterCount'));
    if (count) count.textContent = people.length + ' 人';
    var idLabel = plat === 'qq' ? 'QQ ' : 'UID ';
    if (!people.length) {
      box.innerHTML = '<div class="empty" style="padding:22px 12px">' +
        '<svg class="ic" aria-hidden="true"><use href="#i-users"/></svg>' +
        '<div class="empty-title">名单还是空的</div>' +
        '<div class="empty-text">' +
        (plat === 'qq'
          ? '填一个 QQ 号，确认是他，就能给她认个人。'
          : '填一个 B 站 UID，确认是他，就能给她认个人。') +
        '</div></div>';
      return;
    }
    box.innerHTML = '';
    people.sort(function (a, b) {
      var order = { white: 0, none: 1, black: 2 };
      return (order[a.list] - order[b.list]) || (b.affinity - a.affinity);
    }).forEach(function (p) {
      var pid = Number(p.uid);
      var d = document.createElement('div');
      d.className = 'person' + (p.list === 'white' ? ' is-white' : p.list === 'black' ? ' is-black' : '');
      d.dataset.uid = pid;
      d.innerHTML =
        '<img class="person-face" src="' + esc(p.face || '') + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
        '<div class="person-main">' +
        '<div class="person-top"><b>' + esc(p.uname || (idLabel + pid)) + '</b>' +
        '<span class="person-uid">' + idLabel + esc(pid) + '</span>' +
        (p.isMaster ? '<span class="badge">主人 · 白名单</span>' : (p.list === 'white' ? '<span class="badge">白名单</span>' : '')) +
        (p.list === 'black' ? '<span class="badge badge-quiet">黑名单</span>' : '') +
        '</div>' +
        '<div class="person-nick">她叫他 <input class="input" data-nick="' + esc(pid) + '" maxlength="16" value="' + esc(p.nickname || '') + '" placeholder="' + esc(p.uname || '') + '"></div>' +
        '<div class="person-aff"><span>好感度</span><div class="aff-bar"><i style="width:' + personAff(p) + '%"></i></div><b>' + personAff(p) + '</b></div>' +
        '</div>' +
        '<div class="person-acts">' +
        (p._master ? '<span class="field-note" style="margin:0 6px 0 0">在「主人」里设置</span>' :
        '<div class="seg seg-sm" data-seg="' + esc(pid) + '">' +
        '<button class="seg-btn' + (p.list === 'none' ? ' is-active' : '') + '" data-set="none" type="button">普通</button>' +
        '<button class="seg-btn' + (p.list === 'white' ? ' is-active' : '') + '" data-set="white" type="button">白</button>' +
        '<button class="seg-btn' + (p.list === 'black' ? ' is-active' : '') + '" data-set="black" type="button">黑</button>' +
        '</div>') +
        (p._master ? '' : '<button class="btn btn-sm btn-danger" data-del="' + esc(pid) + '" type="button">移除</button>') +
        '</div>';
      box.appendChild(d);

      var nick = d.querySelector('[data-nick]');
      nick.addEventListener('change', function () {
        var pp = personByUid(pid, plat);
        if (!pp) return;
        pp.nickname = String(nick.value || '').trim();
        savePeople();
        toast('称呼改好了');
      });
      d.querySelectorAll('[data-seg] .seg-btn').forEach(function (b) {
        b.onclick = function () { rosterSetList(pid, b.dataset.set, plat); };
      });
      var del = d.querySelector('[data-del]');
      if (del) del.onclick = function () { rosterRemove(pid, plat); };
      var bar = d.querySelector('.aff-bar');
      var dot = d.querySelector('.aff-bar i');
      if (bar) {
        bar.style.cursor = 'pointer';
        bar.title = '点一下调好感度';
        bar.onclick = function (ev) {
          var rect = bar.getBoundingClientRect();
          var v = Math.round((ev.clientX - rect.left) / rect.width * 100);
          rosterSetAffinity(pid, v, plat);
          var cur = personByUid(pid, plat);
          dot.style.width = personAff(cur) + '%';
          var num = d.querySelector('.person-aff b');
          if (num) num.textContent = personAff(cur);
        };
      }
    });
  }

  /* -------------------------------------------------------------- 私聊 */
  var dmBusy = false;
  var dmSessionsCache = [];
  var dmTimer = null;
  var dmThread = null;          /* { uid, person, msgs } */

  /* B 站私聊里的图片：content 是 JSON，图片消息带 url / img_src */
  function dmImagesOf(raw) {
    var o = raw;
    if (!raw) return [];
    if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch (e) { return []; } }
    if (!o || typeof o !== 'object') return [];
    var u = String(o.url || o.img_src || o.image_url || '');
    if (!/^https?:/.test(u)) return [];
    return [{ url: u, key: 'bili:' + (String(o.file_unique || o.msg_key || '').slice(0, 60) || u.split('?')[0]) }];
  }

  function dmContentText(raw) {
    if (!raw) return '';
    var o = raw;
    if (typeof raw === 'string') {
      try { o = JSON.parse(raw); } catch (e) { return raw; }
    }
    if (o && typeof o.content === 'string') return o.content;
    if (o && o.type !== undefined) return '[非文字消息]';
    return '';
  }

  async function dmFetchSessions() {
    var j = await biliGet('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&build=0&mobi_app=web');
    if (!j || j.code !== 0) throw new Error((j && j.message) || '私聊列表读不到');
    return (j.data && j.data.session_list) || [];
  }

  async function dmFetchMsgs(talker, size) {
    var j = await biliGet('https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?session_type=1&talker_id=' +
      encodeURIComponent(talker) + '&session_id=' + encodeURIComponent(talker) + '&size=' + (size || 20) + '&build=0&mobi_app=web');
    if (!j || j.code !== 0) throw new Error((j && j.message) || '私聊记录读不到');
    return (j.data && j.data.messages) || [];
  }

  async function dmSend(talker, text) {
    var b = linkBridge();
    if (!b || !b.post) throw new Error('B 站通道没通，发不了私聊');
    if (!linkWho.mid) throw new Error('还不知道自己是谁，先点同步');
    var form = new URLSearchParams();
    form.set('msg[sender_uid]', String(linkWho.mid));
    form.set('msg[receiver_id]', String(talker));
    form.set('msg[receiver_type]', '1');
    form.set('msg[msg_type]', '1');
    form.set('msg[content]', JSON.stringify({ content: String(text) }));
    form.set('msg[timestamp]', String(Math.floor(Date.now() / 1000)));
    form.set('dev_id', '3F6B7B1B-2F1E-4B0B-9C3A-1A2B3C4D5E6F');
    var r = await b.post({ url: 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', form: form.toString() });
    if (!r || !r.ok) throw new Error((r && r.why) || '发送失败');
    var code = r.json ? r.json.code : -1;
    if (code !== 0) throw new Error((r.json && (r.json.message || r.json.msg)) || ('B 站返回 ' + code));
    return true;
  }

  function renderDmCard() {
    var box = $('#dmSessions');
    var hint = $('#dmHint');
    if (!box) return;
    if (!linkDesktop()) {
      if (hint) hint.textContent = '登录后才能用';
      box.innerHTML = '<p class="field-note" style="margin:8px 0 0">登录 B 站之后，私聊会显示在这里。</p>';
      return;
    }
    if (!linkWho.login) {
      if (hint) hint.textContent = '未登录';
      box.innerHTML = '<p class="field-note" style="margin:8px 0 0">登录 B 站之后才能读私聊。</p>';
      return;
    }
    if (!dmSessionsCache.length) {
      if (hint) hint.textContent = '还没同步';
      box.innerHTML = '<p class="field-note" style="margin:8px 0 0">点下面的「同步私聊」拉一次。</p>';
      return;
    }
    if (hint) hint.textContent = '未读 ' + dmSessionsCache.reduce(function (n, s) { return n + (Number(s.unread_count) || 0); }, 0) + ' 条';
    box.innerHTML = '';
    dmSessionsCache.slice(0, 6).forEach(function (s) {
      var acc = s.account_info || {};
      var last = dmContentText(s.last_msg && s.last_msg.content);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dm-session';
      b.innerHTML =
        '<img class="dm-face" src="' + esc(acc.face || '') + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
        '<span class="dm-main"><span class="dm-name">' + esc(acc.name || ('UID ' + (s.talker_id || ''))) + '</span>' +
        '<span class="dm-last">' + esc(last.slice(0, 40) || '（还没有消息）') + '</span></span>' +
        (Number(s.unread_count) ? '<span class="dm-unread">' + Math.min(99, Number(s.unread_count)) + '</span>' : '') +
        '<span class="dm-time">' + (s.session_ts ? timeText(Number(s.session_ts) * 1000) : '') + '</span>';
      b.onclick = function () { dmOpen(Number(s.talker_id), acc.name || '', acc.face || ''); };
      box.appendChild(b);
    });
  }

  async function dmSync(manual) {
    if (dmBusy) return;
    if (!linkDesktop()) { if (manual) toast('先登录 B 站再用私聊', 'warm'); return; }
    if (!linkWho.login) {
      try {
        var st = await linkBridge().status();
        if (st && st.ok) { linkWho = st; renderLinkLogin(); renderLinkBadge(); }
      } catch (e) { }
    }
    if (!linkWho.login) { if (manual) toast('先登录 B 站', 'warm'); return; }
    dmBusy = true;
    if (manual) actPush('同步 B 站私聊', 'bili');
    try {
      dmSessionsCache = await dmFetchSessions();
      renderDmCard();
      if (manual) toast('私聊同步好了');
      await dmAutoReplyRound();
    } catch (e) {
      if (manual) toast('同步失败：' + (e.message || e), 'warm');
    } finally {
      dmBusy = false;
    }
  }

  function dmReplyAny() {
    return !!(link.dmReply && (link.dmReply.white || link.dmReply.none || link.dmReply.black));
  }

  async function dmAutoReplyRound() {
    var sessions = dmSessionsCache.filter(function (s) {
      return Number(s.unread_count) > 0;
    }).slice(0, 4);
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var uidNum = Number(s.talker_id) || 0;
      var p = personByUid(uidNum);
      var cat = p ? p.list : 'none';
      if (!(p && p.isMaster) && !link.dmReply[cat]) {
        if (p) actPush('看到「' + personNick(p) + '」的私聊，没回（' +
          (cat === 'black' ? '黑名单' : cat === 'white' ? '白名单' : '普通') + '没开）', 'bili');
        continue;
      }
      if (!(p && p.isMaster)) {
        try {
          linkFeedPush('dm', '「' + (p ? personNick(p) : ('UID ' + uidNum)) + '」发来私聊：' + dmLastText(s));
        } catch (eFeed) { }
      }
      try {
        await dmReplyOne(uidNum, p);
      } catch (e) {
        actPush('回「' + (p ? personNick(p) : ('UID ' + uidNum)) + '」失败：' + (e.message || e), 'bad');
      }
      await sleep(500);
    }
  }

  /* 私信的红线：白名单可以说一点「你们之间的事」，其他人一个字都不许提。
     ⚠️ 这条不只是写在提示词里 —— 非白名单连人设和记忆都不进提示词（见 dmSystemPrompt），
        出站再洗一遍路径、密钥、邮箱和名字。 */
  function dmPrivacyRule(p) {
    if (p && p.list === 'white') {
      return '【私信里的红线】\n' +
        '· 这里是 B 站私信，不是你们自己的聊天窗口。\n' +
        '· 可以说一点你们之间的事，但不要一次倒完，更不要提账号、密码、文件路径、机器名、接口地址。\n' +
        '· 不提你是 AI、程序或提示词，也不解释这些规则。';
    }
    return '【私信里的红线】\n' +
      '· 对方只是 B 站上的一个网友，你不认识他。\n' +
      '· 绝对不要提你正在和谁聊天，也不要提任何人的私人信息：名字、住址、工作、账号、聊天内容、记忆、设定。\n' +
      '· 不提你是 AI、程序或提示词，也不解释这些规则。\n' +
      '· 只回应他自己说的内容，不主动打听。';
  }

  function dmSystemPrompt(p) {
    var name = persona.name || '心枕';
    if (p && p.list === 'white') {
      return buildSystemPrompt() + '\n\n【这次是私信】你正在 B 站私信里回「' + personNick(p) + '」，' +
        (p.isMaster ? ('对方就是你平时叫「' + (persona.call || '他') + '」的那个人本人，是你最熟的人。') : '') +
        '你对他' + personListText(p) + '，好感度 ' + personAff(p) + '/100（越高越熟络，越低越客气）。' +
        '只输出要发出去的那一句话，不要引号、不要解释、不要动作描写，不要带任何隐藏标记。\n' +
        dmPrivacyRule(p);
    }
    return '你叫「' + name + '」，一个普通网友，正在 B 站私信里回话。' +
      '语气自然、短句、像真人打字；只输出要发出去的那一句，不要引号、不要解释。\n' + dmPrivacyRule(p);
  }

  function scrubOutgoing(text, p, keepNames) {
    var t = String(text || '');
    t = t.replace(/[A-Za-z]:\\[^\s，。；、）)】]+/g, '［路径］');
    t = t.replace(/sk-[A-Za-z0-9_-]{6,}/g, '［密钥］');
    t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '［邮箱］');
    if (!keepNames && (!p || p.list !== 'white')) {
      var nm = String(me.name || '').trim();
      if (nm.length >= 2) t = t.split(nm).join('对方');
      var call = String(persona.call || '').trim();
      if (call.length >= 2) t = t.split(call).join('对方');
    }
    return t;
  }

  /* 私聊会话里最后一条的文字（content 可能是字符串也可能是对象） */
  function dmLastText(s) {
    try {
      var raw = s && s.last_msg && s.last_msg.content;
      if (!raw) return '';
      var o = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return String((o && o.content) || '').slice(0, 40);
    } catch (e) { return ''; }
  }

  async function dmReplyOne(uidNum, p) {
    actPush('在看「' + personNick(p) + '」发来的私聊', 'bili');
    var msgs = await dmFetchMsgs(uidNum, 10);
    if (p && p.isMaster && qq.collectStickers !== false) {
      msgs.slice(-6).forEach(function (m) {
        if (Number(m.sender_uid) === Number(linkWho.mid)) return;
        dmImagesOf(m.content).forEach(function (im) { qqNoteSticker(im); });
      });
    }
    var lines = msgs.slice(-8).map(function (m) {
      var mine = Number(m.sender_uid) === Number(linkWho.mid);
      return (mine ? '你：' : (personNick(p) + '：')) + dmContentText(m.content);
    }).filter(function (x) { return x.indexOf('：') < x.length - 1; });
    var _lastThem = msgs.filter(function (m) { return Number(m.sender_uid) !== Number(linkWho.mid); }).slice(-1)[0];
    var dmLastIncoming = _lastThem ? dmContentText(_lastThem.content) : '';
    if (!lines.length) return;

    var sys = dmSystemPrompt(p);
    var out = await chatCompletion([
      { role: 'system', content: sys },
      { role: 'user', content: '最近的消息：\n' + lines.join('\n') + '\n\n回他一句。' }
    ], { stream: false, chars: 160, temperature: 0.85, timeout: 90 });

    var parsedD = parseDirectives(String(out || ''));
    var text = String(parsedD.text || '').replace(/^["'“”‘’]|["'“”‘’]$/g, '').trim();
    text = text.split('\n').filter(Boolean)[0] || '';
    if (settings.injAutoMem && parsedD.ops.length && p && (p.isMaster || p.list === 'white')) {
      var addedD = applyMemoryOps(parsedD.ops);
      if (addedD.length) {
        saveMemory();
        renderMemory();
        actPush('记住了 ' + addedD.length + ' 条（B 站私聊里「' + personNick(p) + '」说的）', 'bili');
      }
    }
    text = scrubOutgoing(text, p, false).slice(0, 140);
    if (!text) return;

        actPush('在回「' + personNick(p) + '」的私聊', 'bili');
    await dmSend(uidNum, text);
    p.lastDmAt = Date.now();
    p.affinity = clamp(personAff(p) + 3, 0, 100);
    savePeople();
    renderRoster();
    actPush('回过「' + personNick(p) + '」了（好感度 ' + personAff(p) + '）', 'bili');
    if (p && (p.isMaster || p.list === 'white')) {
      memoryAutoExtract(false, lines.slice(-6).join('\n')).catch(function () { });
    }
    if (p && p.isMaster) {
      /* 和主人的私聊进「对话」，不再进 B 站「最近的消息」 */
      try { chatMirrorBili('user', dmLastIncoming); } catch (e) { }
      try { chatMirrorBili('assistant', text); } catch (e) { }
    } else {
      linkFeedPush('dm', '回「' + personNick(p) + '」一句：' + String(text).slice(0, 30));
    }
    var idx = -1;
    dmSessionsCache.forEach(function (s, j) { if (Number(s.talker_id) === Number(uidNum)) idx = j; });
    if (idx >= 0) dmSessionsCache[idx].unread_count = 0;
    renderDmCard();
  }

  async function dmOpen(talker, uname, face) {
    var p = personByUid(talker);
    dmThread = { uid: talker, person: p, uname: uname || (p && p.uname) || ('UID ' + talker), face: face || (p && p.face) || '', msgs: [] };
    var l = $('#layer');
    l.innerHTML = '<div class="confirm"><div class="confirm-box dm-panel" role="dialog" aria-modal="true">' +
      '<div class="dm-head"><img src="' + esc(dmThread.face) + '" alt=""><b>' + esc(dmThread.uname) + '</b>' +
      '<span class="card-hint">' + (p ? (p.list === 'white' ? '白名单' : p.list === 'black' ? '黑名单' : '普通') : '不在名单里') + '</span>' +
      '<button class="btn btn-sm btn-ghost" data-close="1" type="button">关闭</button></div>' +
      '<div class="dm-thread" id="dmThread"></div>' +
      '<div class="dm-input-row"><textarea class="textarea" id="dmInput" rows="1" placeholder="以她的口吻回一句…"></textarea>' +
      '<button class="btn btn-primary" id="dmSendBtn" type="button">发送</button></div>' +
      '</div></div>';
    l.querySelector('[data-close]').onclick = closeLayer;
    l.querySelector('.confirm').onclick = function (e) { if (e.target === this) closeLayer(); };
    document.addEventListener('keydown', layerEsc);
    $('#dmSendBtn').onclick = async function () {
      var el = $('#dmInput');
      var text = String(el.value || '').trim();
      if (!text) return;
      el.value = '';
      try {
        await dmSend(talker, text);
        dmThread.msgs.push({ mine: true, text: text, t: Date.now() });
        renderDmThread();
        actPush('手动回了「' + (p ? personNick(p) : dmThread.uname) + '」一句', 'bili');
      } catch (e) {
        toast('没发出去：' + (e.message || e), 'warm');
      }
    };
    try {
      var msgs = await dmFetchMsgs(talker, 30);
      dmThread.msgs = msgs.map(function (m) {
        return { mine: Number(m.sender_uid) === Number(linkWho.mid), text: dmContentText(m.content), t: Number(m.timestamp) * 1000 };
      }).filter(function (m) { return m.text; });
      renderDmThread();
      var s = dmSessionsCache.filter(function (x) { return Number(x.talker_id) === Number(talker); })[0];
      if (s) s.unread_count = 0;
      renderDmCard();
    } catch (e) {
      var th = $('#dmThread');
      if (th) th.innerHTML = '<p class="field-note">读不到记录：' + esc(e.message || e) + '</p>';
    }
  }

  function renderDmThread() {
    var box = $('#dmThread');
    if (!box || !dmThread) return;
    box.innerHTML = dmThread.msgs.map(function (m) {
      return '<div class="dm-msg ' + (m.mine ? 'is-me' : 'is-them') + '">' + esc(m.text) +
        '<time>' + timeText(m.t) + '</time></div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  function dmStartPolling() {
    if (dmTimer) return;
    dmTimer = setInterval(function () {
      if (!dmReplyAny() || !linkDesktop() || !linkWho.login) return;
      if (document.hidden) return;
      dmSync(false);
    }, 5 * 60 * 1000);
  }

  /* ------------------------------------------------ 对话记忆自动整理
     模型不一定每次都肯吐 [[记忆]] 指令，所以每隔几轮主动提炼一次，
     不然「人设 → 记忆」半天不更新。 */
  var memBusy = false;
  var memLastAt = 0;
  var memTurns = 0;

  async function memoryAutoExtract(force, extraText) {
    if (!settings.injAutoMem) return 0;
    if (memBusy) return 0;
    if (!force && Date.now() - memLastAt < 45000) return 0;
    var recent = (chat.messages || []).filter(function (m) {
      return (m.role === 'user' || m.role === 'assistant') && m.text;
    }).slice(-16);
    var extra = String(extraText || '').trim();
    if (recent.length < 3 && !extra) return 0;
    if (!recent.length && !extra) return 0;
    memBusy = true;
    memLastAt = Date.now();
    try {
      var convo = recent.map(function (m) {
        return (m.role === 'user' ? '对方' : (persona.name || '她')) + '：' + String(m.text).slice(0, 200);
      }).join('\n');
      if (extra) convo += '\n' + extra.slice(0, 1200);
      var knownKey = (memory.key || []).slice(-10).map(function (x) {
        return (x.title ? x.title + '：' : '') + (x.text || '');
      }).join('；') || '（空）';
      var knownLight = (memory.light || []).slice(-10).map(function (x) { return x.text || ''; }).join('；') || '（空）';
      var out = await chatCompletion([
        {
          role: 'system',
          content: '你是记忆整理员。从下面的聊天里提炼「值得长期记住」的事：对方透露的事实、偏好、约定、称呼、重要日期、正在经历的事。' +
            '不要写寒暄、不要写你自己的情绪、不要编。输出 JSON：' +
            '计划、待办、打算要做的事，一律不要写进记忆（那些由「计划」单独管）。' +
            '{"key":[{"title":"短标题","text":"一句话说清楚"}],"light":["一件小事"],"words":[{"word":"词","note":"含义"}]}。' +
            '最多 key 3 条、light 4 条、words 2 条；没有就输出空数组。已经知道的不要重复（关键：' + knownKey + '；轻记忆：' + knownLight + '）。'
        },
        { role: 'user', content: convo }
      ], { stream: false, chars: 900, temperature: 0.3, timeout: 90 });

      var d = linkParseJson(out) || {};
      var ops = [];
      (d.key || []).forEach(function (k) {
        if (!k) return;
        var t = String(k.text || k.title || '').trim();
        if (!t) return;
        ops.push({ type: 'key', a: String(k.title || '').trim().slice(0, 24), b: t.slice(0, 200) });
      });
      (d.light || []).forEach(function (x) {
        var t = String(x || '').trim();
        if (t) ops.push({ type: 'light', a: t.slice(0, 200), b: '' });
      });
      (d.words || []).forEach(function (w) {
        if (w && w.word) ops.push({ type: 'word', a: String(w.word).slice(0, 20), b: String(w.note || '').slice(0, 120) });
      });
      if (!ops.length) {
        memory.lastExtract = { at: Date.now(), added: 0 };
        saveMemory();
        renderMemory();
        return 0;
      }
      var added = applyMemoryOps(ops);
      memory.lastExtract = { at: Date.now(), added: added.length };
      saveMemory();
      renderMemory();
      if (added.length) {
        memTurns = 0;
        actPush('从对话里记下了 ' + added.length + ' 条记忆', 'done');
      }
      return added.length;
    } catch (e) {
      memory.lastExtract = { at: Date.now(), added: 0, why: String(e.message || e).slice(0, 80) };
      saveMemory();
      renderMemory();
      return 0;
    } finally {
      memBusy = false;
    }
  }

  /* -------------------------------------------------------------- 梗知识 */
  function memeNorm(t) { return String(t || '').trim().toLowerCase(); }
  function memeExists(term) {
    var n = memeNorm(term);
    return memes.items.some(function (m) { return memeNorm(m.term) === n; });
  }

  function renderMemes() {
    var box = $('#memeList');
    if (!box) return;
    if (!memes.items.length) {
      box.innerHTML = '<div class="empty" style="padding:22px 12px">' +
        '<svg class="ic" aria-hidden="true"><use href="#i-sparkle"/></svg>' +
        '<div class="empty-title">还没有梗</div>' +
        '<div class="empty-text">点「自动学习」让她翻一遍最近的对话，或者自己加一条。</div>' +
        '</div>';
      return;
    }
    box.innerHTML = '';
    memes.items.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).forEach(function (m) {
      var d = document.createElement('div');
      d.className = 'meme';
      d.innerHTML =
        '<div class="meme-top"><span class="meme-term">' + esc(m.term) + '</span>' +
        '<span class="meme-src">' + (m.source === 'ai' ? '自动学的' : m.source === 'chat' ? '聊天里学的' : '手动加的') + '</span>' +
        '<button class="btn btn-icon btn-sm meme-del" data-del="' + esc(m.id) + '" title="删掉" type="button">' +
        '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-trash"/></svg></button></div>' +
        '<div class="meme-text">' + esc(m.meaning || '') + '</div>' +
        (m.usage ? '<div class="meme-use">怎么用：' + esc(m.usage) + '</div>' : '') +
        (m.tags && m.tags.length ? '<div class="meme-tags">' + m.tags.map(function (t) { return '<span class="meme-tag">' + esc(t) + '</span>'; }).join('') + '</div>' : '');
      d.querySelector('[data-del]').onclick = function () {
        confirmBox('删掉这个梗？', '「' + m.term + '」会从她的知识里移除。', '删掉', true).then(function (ok) {
          if (!ok) return;
          memes.items = memes.items.filter(function (x) { return x !== m; });
          saveMemes();
          renderMemes();
        });
      };
      box.appendChild(d);
    });
  }

  function memeSaveOne(term, meaning, usage, tags, source) {
    term = String(term || '').trim();
    if (!term) return false;
    var exist = memes.items.filter(function (m) { return memeNorm(m.term) === memeNorm(term); })[0];
    if (exist) {
      exist.meaning = meaning || exist.meaning;
      if (usage) exist.usage = usage;
      if (tags && tags.length) exist.tags = tags;
      exist.ts = Date.now();
    } else {
      memes.items.push({ id: 'm' + uid(), term: term, meaning: meaning || '', usage: usage || '', tags: tags || [], source: source || 'manual', ts: Date.now() });
    }
    saveMemes();
    return true;
  }

  function memeEdit() {
    var l = $('#layer');
    l.innerHTML = '<div class="confirm"><div class="confirm-box" role="dialog" aria-modal="true">' +
      '<h3 class="confirm-title">加一个梗</h3>' +
      '<div class="field" style="margin-top:12px"><label class="field-label" for="memeTerm">梗</label>' +
      '<input class="input" id="memeTerm" maxlength="30" placeholder="比如：电子榨菜" autocomplete="off"></div>' +
      '<div class="field"><label class="field-label" for="memeMeaning">什么意思</label>' +
      '<textarea class="textarea" id="memeMeaning" rows="3" placeholder="吃饭时配着看的视频……"></textarea></div>' +
      '<div class="field"><label class="field-label" for="memeUsage">她会怎么用</label>' +
      '<textarea class="textarea" id="memeUsage" rows="2" placeholder="你说在吃饭，她会问「配的什么电子榨菜」"></textarea></div>' +
      '<div class="confirm-acts"><button class="btn" data-cf="0" type="button">取消</button>' +
      '<button class="btn btn-primary" data-cf="1" type="button">加上</button></div></div></div>';
    l.querySelector('[data-cf="0"]').onclick = closeLayer;
    l.querySelector('.confirm').onclick = function (e) { if (e.target === this) closeLayer(); };
    l.querySelector('[data-cf="1"]').onclick = function () {
      var term = $('#memeTerm').value;
      var meaning = $('#memeMeaning').value.trim();
      var usage = $('#memeUsage').value.trim();
      if (!term.trim()) { toast('先写个梗的名字', 'warm'); return; }
      memeSaveOne(term, meaning, usage, [], 'manual');
      closeLayer();
      renderMemes();
      toast('记住了');
    };
    document.addEventListener('keydown', layerEsc);
    $('#memeTerm').focus();
  }

  var memeAutoAt = 0;
  async function memeAutoLearn(force) {
    if (memeBusy) return 0;
    if (settings.injMemes === false) return 0;
    if (!settings.baseUrl || !settings.model) return 0;
    if (!force && Date.now() - memeAutoAt < 25 * 60 * 1000) return 0;
    var recent = (chat.messages || []).filter(function (m2) {
      return (m2.role === 'user' || m2.role === 'assistant') && m2.text;
    });
    var qqLines = 0;
    (qq.sessions || []).forEach(function (s) { qqLines += (s.thread || []).length; });
    if (recent.length < 4 && qqLines < 6) return 0;
    memeAutoAt = Date.now();
    try { await memeLearn(true); } catch (e) { }
    return 1;
  }


  async function memeLearn(silent) {
    if (memeBusy) { toast('正在学，等一下', 'warm'); return; }
    if (!settings.baseUrl || !settings.model) { toast('先去设置里填接口和模型', 'warm'); go('settings'); return; }
    var recent = chat.messages.slice(-40).filter(function (m) {
      return (m.role === 'user' || m.role === 'assistant') && m.text;
    });
    if (recent.length < 4) { if (!silent) toast('你们还没聊几句，先聊聊天吧', 'warm'); return; }
    memeBusy = true;
    var btn = $('#memeLearn');
    if (btn) { btn.disabled = true; btn.textContent = '正在翻聊天…'; }
    try {
      var convo = recent.map(function (m) {
        return (m.role === 'user' ? '对方' : (persona.name || '她')) + '：' + String(m.text).slice(0, 300);
      }).join('\n');

      /* 外接上的聊天也算「你们聊过的话」：只取白名单 / 主人的 */
      var extra = [];
      (qq.sessions || []).forEach(function (s) {
        var pp = s.type === 'group' ? null : personByUid(s.uid, 'qq');
        if (s.type !== 'group' && !(pp && (pp.list === 'white' || pp.isMaster))) return;
        (s.thread || []).slice(-10).forEach(function (m) {
          extra.push('（QQ）' + (m.mine ? (persona.name || '她') : (s.name || '对方')) + '：' + String(m.text || '').slice(0, 200));
        });
      });
      if (dmThread && dmThread.msgs && dmThread.msgs.length) {
        dmThread.msgs.slice(-10).forEach(function (m) {
          extra.push('（B 站私聊）' + (m.mine ? (persona.name || '她') : (dmThread.uname || '对方')) + '：' + String(m.text || '').slice(0, 200));
        });
      }
      if (extra.length) convo += '\n\n【外接上的聊天】\n' + extra.join('\n');
      var known = memes.items.map(function (m) { return m.term; }).join('、') || '（还没有）';
      var out = await chatCompletion([
        {
          role: 'system',
          content: '你是一个中文网络梗的整理员。从下面的聊天里找出「梗、暗号、流行说法、圈内黑话」，' +
            '输出 JSON：{"memes":[{"term":"...","meaning":"...","usage":"..."}]}。' +
            '只挑真的在用的、有解释价值的；已经知道的不要重复（已知：' + known + '）。' +
            'meaning 一句话说清楚；usage 写她可以怎么自然地用。最多 5 条，没有就输出 {"memes":[]}。'
        },
        { role: 'user', content: convo }
      ], { stream: false, chars: 1200, temperature: 0.4, timeout: 120 });

      var parsed = linkParseJson(out);
      var list = (parsed && parsed.memes) || [];
      list = list.filter(function (m) { return m && m.term && !memeExists(m.term); }).slice(0, 6);
      if (!list.length) { if (!silent) toast('这轮没找到新梗'); return; }
      if (silent) {
        list.forEach(function (m3) { memeSaveOne(m3.term, m3.meaning, m3.usage, m3.tags || [], 'ai'); });
        renderMemes();
        actPush('自动学了 ' + list.length + ' 个梗：' + list.slice(0, 3).map(function (x) { return x.term; }).join('、'), 'done');
        return;
      }
      memePick(list);
    } catch (e) {
      toast('学习失败：' + (e.message || e), 'warm');
    } finally {
      memeBusy = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-sparkle"/></svg>自动学习';
      }
    }
  }

  function memePick(list) {
    var l = $('#layer');
    l.innerHTML = '<div class="confirm"><div class="confirm-box" role="dialog" aria-modal="true" style="max-width:560px">' +
      '<h3 class="confirm-title">她翻出来这几个梗</h3>' +
      '<p class="confirm-text">勾上要留下的，没用的去掉。</p>' +
      list.map(function (m, i) {
        return '<label class="meme-pick"><input type="checkbox" data-i="' + i + '" checked>' +
          '<div><b>' + esc(m.term) + '</b><p>' + esc(m.meaning || '') +
          (m.usage ? '<br>用法：' + esc(m.usage) : '') + '</p></div></label>';
      }).join('') +
      '<div class="confirm-acts"><button class="btn" data-cf="0" type="button">都算了</button>' +
      '<button class="btn btn-primary" data-cf="1" type="button">收下</button></div></div></div>';
    l.querySelector('[data-cf="0"]').onclick = closeLayer;
    l.querySelector('.confirm').onclick = function (e) { if (e.target === this) closeLayer(); };
    l.querySelector('[data-cf="1"]').onclick = function () {
      var n = 0;
      $$('.meme-pick input:checked', l).forEach(function (cb) {
        var m = list[Number(cb.dataset.i)];
        if (m && memeSaveOne(m.term, m.meaning, m.usage, [], 'ai')) n++;
      });
      closeLayer();
      renderMemes();
      toast(n ? ('收下了 ' + n + ' 个梗') : '那就先不记');
    };
    document.addEventListener('keydown', layerEsc);
  }

  var memeBusy = false;

  /* ---------------------------------------------------------------- 绑定 */
  function bindRoster(plat) {
    plat = plat || 'bili';
    var mEdit = $(rid(plat, 'masterEdit'));
    if (mEdit) mEdit.onclick = function () {
      var form = $(rid(plat, 'masterForm'));
      if (!form) return;
      form.hidden = !form.hidden;
      if (!form.hidden) { var i = $(rid(plat, 'masterUid')); if (i) i.focus(); }
    };
    var mLook = $(rid(plat, 'masterLookup'));
    if (mLook) mLook.onclick = function () { masterLookup(plat); };
    var mUid = $(rid(plat, 'masterUid'));
    if (mUid) mUid.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); masterLookup(plat); }
    });
    var mSave = $(rid(plat, 'masterSave'));
    if (mSave) mSave.onclick = function () { masterSave(plat); };
    var mClear = $(rid(plat, 'masterClear'));
    if (mClear) mClear.onclick = function () { masterClear(plat); };
    renderMaster(plat);

    var look = $(rid(plat, 'rosterLookup'));
    if (look) look.onclick = function () { rosterLookup(plat); };
    var inp = $(rid(plat, 'rosterUid'));
    if (inp) inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); rosterLookup(plat); }
    });
    $$(rid(plat, 'rosterListSeg') + ' .seg-btn').forEach(function (b) {
      b.onclick = function () {
        rosterPick[plat] = b.dataset.list || 'none';
        $$(rid(plat, 'rosterListSeg') + ' .seg-btn').forEach(function (x) { x.classList.toggle('is-active', x === b); });
      };
    });
    var add = $(rid(plat, 'rosterAdd'));
    if (add) add.onclick = function () { rosterAdd(plat); };
    renderRoster(plat);
  }

  function bindMemes() {
    var add = $('#memeAdd');
    if (add) add.onclick = memeEdit;
    var learn = $('#memeLearn');
    if (learn) learn.onclick = memeLearn;
    renderMemes();
  }

  function bindDm() {
    var sync = $('#dmSync');
    if (sync) sync.onclick = function () { dmSync(true); };
    [['white', '#dmWhite'], ['none', '#dmNone'], ['black', '#dmBlack']].forEach(function (pair) {
      var el = $(pair[1]);
      if (!el) return;
      el.addEventListener('change', function () {
        link.dmReply[pair[0]] = !!el.checked;
        saveLink();
        renderDmCard();
        if (el.checked && !dmSessionsCache.length) dmSync(true);
      });
    });
    renderDmCard();
  }

  /* ==========================================================================
     QQ · NapCat（OneBot 11）
     ==========================================================================
     消息从 NapCat 的「WebSocket 服务器」进（页面直接连），
     发消息走「HTTP 服务器」的 action，由桌面壳主进程代发（绕开跨域，且只允许本机地址）。
     ---------------------------------------------------------------------- */

  var linkSub = 'qq';
  var rosterSub = 'qq';

  var qqWs = null;
  var qqWsRetry = 0;            /* 连续重连次数，用来退避 */
  var qqReconnectTimer = null;
  var qqLastFrame = 0;          /* 最后一帧的时间：久没心跳就当连接死了 */
  var qqWatchdog = null;
  var qqHeartTimer = null;
  var qqHeartFail = 0;
  var qqDiagTimer = null;
  var qqCooldown = {};
  var qqThread = null;

  function qqBridge() {
    var d = window.xinzhenDesktop;
    return d && d.qq ? d : null;
  }
  /* 网页版（部署在服务器上）也能用 QQ：走同源的 /qq/api、/qq/ws 反代，
     没有 Electron 桥就直连 fetch / WebSocket。 */
  function qqWebMode() {
    return !qqBridge() && /^https?:$/.test(location.protocol);
  }
  function qqReady() { return !!qqBridge() || qqWebMode(); }
  function qqBase() {
    var base = String(qq.apiBase || '').trim();
    if (qqWebMode() && (!base || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(base))) return '/qq/api';
    return base.replace(/\/+$/, '');
  }
  function qqWsUrl() {
    var u = String(qq.wsUrl || '').trim();
    if (qqWebMode() && (!u || /^wss?:\/\/(127\.0\.0\.1|localhost)/.test(u))) {
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/qq/ws';
    }
    return u;
  }

  async function qqApi(action, params) {
    var b = qqBridge();
    if (!b) {
      if (!qqWebMode()) throw new Error('QQ 要在桌面版里用');
      var base = qqBase();
      if (!base) throw new Error('先填 NapCat 的接口地址');
      var hdr = { 'Content-Type': 'application/json' };
      if (qq.token) hdr['Authorization'] = 'Bearer ' + qq.token;
      var res = await fetch(base + '/' + action, { method: 'POST', headers: hdr, body: JSON.stringify(params || {}) });
      if (res.status === 401 || res.status === 403) throw new Error('令牌不对，或者 NapCat 没开 HTTP 服务器');
      var body = null;
      try { body = await res.json(); } catch (e) { throw new Error('NapCat 返回的不是 JSON（HTTP ' + res.status + '）'); }
      if (body && body.status === 'failed') throw new Error(body.message || body.wording || ('NapCat 返回失败（' + body.retcode + '）'));
      return body;
    }
    var r = await b.qq.call({
      base: qq.apiBase,
      token: qq.token,
      action: action,
      params: params || {}
    });
    if (!r || !r.ok) throw new Error((r && r.why) || '连不上 NapCat');
    var j = r.json;
    if (j && j.status === 'failed') throw new Error(j.message || j.wording || ('NapCat 返回失败（' + j.retcode + '）'));
    return j;
  }

  function qqTextOf(ev) {
    if (ev && typeof ev.raw_message === 'string' && ev.raw_message) {
      return ev.raw_message.replace(/\[CQ:[^\]]+\]/g, '').trim();
    }
    var segs = (ev && ev.message) || [];
    return segs.map(function (s) {
      return s && s.type === 'text' ? String((s.data && s.data.text) || '') : '';
    }).join('').trim();
  }

  function qqMentionsMe(ev) {
    var me = Number((ev && ev.self_id) || qq.me.uid || 0);
    var segs = (ev && ev.message) || [];
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] && segs[i].type === 'at' && Number(segs[i].data && segs[i].data.qq) === me) return true;
    }
    return false;
  }

  function qqSessionKey(ev) {
    return ev.message_type === 'group' ? ('g' + ev.group_id) : ('u' + ev.user_id);
  }

  /* ---------------------------------------------- 连发几条算一轮
     第一句来了先等 firstWait 秒，这期间的话攒在一起，一次性回（或攒够 burstMax 条就提前回）。 */
  var qqAggBuf = {};
  function qqAggFlush(key) {
    var a = qqAggBuf[key];
    if (!a) return;
    delete qqAggBuf[key];
    if (a.timer) clearTimeout(a.timer);
    if (!a.texts || !a.texts.length) return;
    var merged = a.texts.length === 1
      ? a.texts[0]
      : a.texts.map(function (t, i) { return (i + 1) + ') ' + t; }).join('\n');
    qqOnMessage(a.ev, { force: true, agg: merged }).catch(function () { });
  }
  function qqAggPush(key, ev, text) {
    var wait = Number(qq.firstWait) || 0;
    if (wait <= 0) return false;
    var a = qqAggBuf[key];
    if (!a) {
      a = qqAggBuf[key] = { texts: [], ev: ev, timer: null };
      a.timer = setTimeout(function () { qqAggFlush(key); }, wait * 1000);
    }
    a.texts.push(String(text || ''));
    a.ev = ev;
    if (a.texts.length >= Math.max(2, Number(qq.burstMax) || 5)) {
      qqAggFlush(key);
    }
    return true;
  }

  /* 处理过的 message_id 记一份，补收时用来去重 */
  function qqSeenHas(id) {
    id = String(id || '');
    if (!id) return false;
    return (qq.seenIds || []).indexOf(id) >= 0;
  }
  function qqMarkSeen(id) {
    id = String(id || '');
    if (!id) return;
    if (!Array.isArray(qq.seenIds)) qq.seenIds = [];
    if (qq.seenIds.indexOf(id) >= 0) return;
    qq.seenIds.push(id);
    if (qq.seenIds.length > 400) qq.seenIds = qq.seenIds.slice(-400);
    saveQq();
  }

  /* 记一笔「这个人聊过、聊到什么时候」，补收用它（和「最近的消息」显示无关） */
  function qqTrack(uid, ts, isGroup) {
    uid = Number(uid) || 0;
    if (!uid) return;
    if (!qq.tracked || typeof qq.tracked !== 'object') qq.tracked = {};
    var k = (isGroup ? 'g' : 'u') + uid;
    var t = Number(ts) || Math.floor(Date.now() / 1000);
    qq.tracked[k] = Math.max(Number(qq.tracked[k]) || 0, t);
    saveQq();
  }

  function qqTouchSession(info) {
    var key = info.type === 'group' ? ('g' + info.group) : ('u' + info.uid);
    var s = null;
    for (var i = 0; i < qq.sessions.length; i++) {
      if (qq.sessions[i].key === key) { s = qq.sessions[i]; break; }
    }
    if (!s) {
      s = { key: key, type: info.type, uid: info.uid, group: info.group || 0, name: info.name, face: info.face, last: '', at: 0, unread: 0, thread: [] };
      qq.sessions.unshift(s);
    }
    s.name = info.name || s.name;
    s.face = info.face || s.face;
    s.last = String(info.text || '').slice(0, 80);
    s.at = Date.now();
    if (info.ts) s.lastTs = Math.max(Number(s.lastTs) || 0, Number(info.ts) || 0);
    s.unread = Number(s.unread || 0) + (info.mine ? 0 : 1);
    s.thread = (s.thread || []).concat([{ mine: !!info.mine, text: String(info.text || ''), t: Date.now() }]).slice(-40);
    if (qq.sessions.length > 12) qq.sessions.length = 12;
    qq.lastAt = Date.now();
    saveQq();
    renderQqSessions();
    return s;
  }

  function qqFindSession(key) {
    for (var i = 0; i < qq.sessions.length; i++) if (qq.sessions[i].key === key) return qq.sessions[i];
    return null;
  }

  /* ---------------------------------------------------------------- 连接 */
  function renderQqStatus() {
    var who = $('#qqWho');
    var sub = $('#qqWhoSub');
    var hint = $('#qqConnHint');
    var face = $('#qqFace');
    var badge = $('#qqBadge');
    if (!who) return;
    var on = qqReady();
    var ok = on && qq.me && qq.me.uid;
    var web = qqWebMode();
    var st = qq.status === 'connecting' ? '连接中…'
      : (qq.retrying ? '掉线了，正在重连…' : '未连接');
    who.textContent = !on ? '桌面版才能连'
      : (ok ? (qq.me.name || '已连上，正在收消息') : st);
    if (sub) {
      sub.textContent = !on
        ? '浏览器里的网页连不上本机的 NapCat'
        : (ok ? ('QQ ' + qq.me.uid + (qq.status === 'ok' ? ' · 正在收消息' : ' · 事件没连上'))
          : (web ? '填好令牌，点「测试连接」（地址已指向本机反代）' : '填好地址，点「测试连接」'));
    }
    if (face) {
      face.innerHTML = ok
        ? '<img src="' + esc(qqFace(qq.me.uid)) + '" alt="">'
        : '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-users"/></svg>';
    }
    if (hint) hint.textContent = !on ? '桌面版才能用' : (ok ? (qq.status === 'ok' ? '在线' : '未连事件') : '未连接');
    if (badge) {
      badge.className = 'badge' + (ok ? '' : ' badge-quiet');
      badge.textContent = ok ? ('QQ ' + qq.me.uid) : '未连接';
    }
  }

  async function qqTest() {
    if (!qqReady()) { toast('QQ 要在桌面版里用', 'warm'); return; }
    var btn = $('#qqTest');
    if (btn) { btn.disabled = true; btn.textContent = '连…'; }
    try {
      var j = await qqApi('get_login_info');
      var d = (j && j.data) || {};
      qq.me = { uid: Number(d.user_id) || 0, name: d.nickname || '' };
      saveQq();
      renderQqStatus();
      toast(qq.me.name ? ('连上了：' + qq.me.name) : '连上了');
      qqConnect();
      actPush('QQ 连上了：' + (qq.me.name || qq.me.uid), 'qq');
    } catch (e) {
      qq.me = { uid: 0, name: '' };
      renderQqStatus();
      toast('没连上：' + (e.message || e) + '（看看 NapCat 的 HTTP 服务器开了没）', 'warm');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '测试连接'; }
    }
  }

  function qqDisconnect() {
    if (qqWs) {
      try { qqWs.onclose = null; qqWs.close(); } catch (e) { }
      qqWs = null;
    }
    qq.status = '';
  }

  var qqConnectAt = 0;
  var qqConnectTimer = null;
  var qqChecking = false;
  /* ---------------------------------------------- 服务器常驻客户端（代替页面）
     页面关着的时候，服务器上的 xinzhen-bridge 一直在收消息；页面回来时把它
     们拉下来补进「对话」/「最近的消息」，跟当场收到一样处理。 */
  function qqBridgeBase() {
    var pr = (typeof location !== 'undefined' && location.protocol) || '';
    if (pr === 'http:' || pr === 'https:') return '/qq/bridge/';
    return qq.bridgeUrl || '';
  }

  var qqBridgeBusy = false;
  async function qqPullBridge(manual) {
    var base = qqBridgeBase();
    if (!base || qqBridgeBusy) return 0;
    qqBridgeBusy = true;
    try {
      var nowS = Math.floor(Date.now() / 1000);
      var since = Number(qq.bridgeSince) || 0;
      /* 最多往回补 12 小时：太久远的旧消息不再翻出来，免得对话里一片旧内容 */
      if (!since || since < nowS - 12 * 3600) since = nowS - 12 * 3600;
      if (!qq.bridgeSince) { qq.bridgeSince = since; saveQq(); }
      var res = await fetch(base + 'pull?since=' + since + '&limit=200', { cache: 'no-store' });
      var d = await res.json();
      var items = (d && d.items) || [];
      var handled = 0, maxTs = since;
      for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        if (it.kind === 'op') {
          /* 常驻客户端替她回话时记下的计划/完成/梗，拉回来落到本地 */
          maxTs = Math.max(maxTs, Number(it.ts) || 0);
          if (it.op) { try { applyMemoryOps([it.op]); handled++; } catch (e) { } }
          continue;
        }
        if (it.kind === 'out') {
          var o = it.out || {};
          maxTs = Math.max(maxTs, Number(it.ts) || 0);
          var ou = Number(o.uid) || 0;
          var op = ou ? personByUid(ou, 'qq') : null;
          if (op && op.isMaster) chatMirrorOut(o.text);
          else if (ou) qqTouchSession({ type: 'private', uid: ou, group: 0, name: (op && personNick(op)) || ('QQ ' + ou), face: qqFace(ou), text: String(o.text || ''), mine: true, ts: Number(o.ts) || 0 });
          handled++;
          continue;
        }
        var ev = it.ev;
        if (!ev || !ev.message_id) continue;
        maxTs = Math.max(maxTs, Number(it.ts) || 0);
        if (qqSeenHas(ev.message_id)) continue;
        try {
          await qqOnMessage(ev, { noReply: true, fromBridge: true });
          handled++;
        } catch (e) { }
      }
      if (maxTs > since) {
        qq.bridgeSince = maxTs;
        saveQq();
      }

      /* 补收进来的消息，如果她还没回过，就攒成一轮回一次 */
      var byUid = {}, outs = {};
      items.forEach(function (it) {
        if (!it) return;
        if (it.kind === 'out') {
          var u0 = Number((it.out || {}).uid) || 0;
          if (u0) outs[u0] = Math.max(outs[u0] || 0, Number(it.ts) || 0);
          return;
        }
        var ev0 = it.ev || {};
        if (ev0.post_type !== 'message' || ev0.message_type === 'group') return;
        var u = Number(ev0.user_id) || 0;
        if (!u) return;
        var rec = byUid[u] || (byUid[u] = { texts: [], lastEv: null, lastTs: 0 });
        var t0 = ev0.raw_message || '';
        if (t0) rec.texts.push(t0);
        if ((Number(it.ts) || 0) >= rec.lastTs) { rec.lastTs = Number(it.ts) || 0; rec.lastEv = ev0; }
      });
      var replyWin = (Number(qq.catchReplyMin) || 30) * 60;
      var nowS2 = Math.floor(Date.now() / 1000);
      var repliedCount = 0;
      var uids = Object.keys(byUid);
      for (var ui = 0; ui < uids.length && repliedCount < 3; ui++) {
        var uu = Number(uids[ui]) || 0;
        var rec0 = byUid[uids[ui]];
        if (!rec0 || !rec0.lastEv) continue;
        if (outs[uu] && outs[uu] >= rec0.lastTs) continue;          /* 常驻客户端已经回过了 */
        if (nowS2 - rec0.lastTs > replyWin) continue;               /* 太久远的不突然回 */
        if (!rec0.texts.length) continue;
        var mergedIn = rec0.texts.length === 1 ? rec0.texts[0]
          : rec0.texts.map(function (t, i) { return (i + 1) + ') ' + t; }).join('\n');
        try {
          await qqOnMessage(rec0.lastEv, { force: true, agg: mergedIn });
          repliedCount++;
        } catch (e) { }
      }
      if (repliedCount) actPush('补收了 ' + repliedCount + ' 个会话，并回了过去', 'qq');
      if (handled || repliedCount) memoryAutoExtract(false).catch(function () { });

      if (handled) {
        actPush('补收了不在时收到的 ' + handled + ' 条（服务器上收的）', 'qq');
        if (manual) toast('补收了 ' + handled + ' 条消息');
      }
      return handled;
    } catch (e) {
      return 0;
    } finally {
      qqBridgeBusy = false;
    }
  }

  /* 把「她是谁、记得什么、谁能聊、用哪个模型」同步给服务器上的常驻客户端 */
  function qqBridgePayload() {
    var sp = persona.speech || {};
    var ptext = String(persona.text || '').trim();
    if (persona.identity) ptext = '（' + String(persona.identity).trim() + '）' + ptext;
    if (sp.style) ptext += '\n说话风格：' + String(sp.style);
    if (persona.catchphrase) ptext += '\n口头禅：' + String(persona.catchphrase);
    return {
      enabled: qq.bridgeAuto !== false,
      selfUid: (qq.me && qq.me.uid) || 0,
      masterUid: (roster.qq.master && roster.qq.master.uid) || 0,
      persona: { name: persona.name || '', call: persona.call || '', text: ptext || '' },
      memory: {
        key: (memory.key || []).map(function (x) { return { title: x.title || '', text: x.text || '' }; }),
        light: (memory.light || []).map(function (x) { return { text: x.text || '' }; }),
        keywords: (memory.keywords || []).map(function (x) { return { word: x.word || '', note: x.note || '' }; })
      },
      roster: (roster.qq.people || []).map(function (p) {
        return { uid: p.uid, uname: p.uname || '', list: p.list || 'none', nickname: p.nickname || '' };
      }),
      qq: {
        autoReply: qq.autoReply || {},
        cooldownSec: Number(qq.cooldownSec) || 8,
        maxChars: Number(qq.maxChars) || 120,
        splitMin: Number(qq.splitMin) || 1,
        splitMax: Number(qq.splitMax) || 3,
        splitGap: Number(qq.splitGap) || 0.6,
        groupAt: !!qq.groupAt,
        staleMin: 10
      },
      plans: (plans.items || []).filter(function (x) { return !x.done; }).map(function (x) {
      return { id: x.id, text: x.text, due: x.due || '', dueAt: Number(x.dueAt) || planDueTs(x.due) || 0 };
      }),
      model: {
        baseUrl: settings.baseUrl || '',
        apiKey: settings.apiKey || '',
        model: settings.model || '',
        maxTokens: 300,
        temperature: Number(settings.temperature) || 0.85
      }
    };
  }

  var qqBridgeSyncAt = 0;
  async function qqSyncBridge(force) {
  var pl = qqBridgePayload();
  /* 空白配置别覆盖服务器上的（新开一个空白角色、或者自检页面会把主人和记忆冲掉） */
  var emptyish = !pl.masterUid && !(pl.roster || []).length && !String((pl.persona || {}).name || '').trim() && !String((pl.persona || {}).text || '').trim();
  if (emptyish && force !== 'user') return false;
    var base = qqBridgeBase();
    if (!base) return false;
    if (!force && Date.now() - qqBridgeSyncAt < 25000) return true;
    qqBridgeSyncAt = Date.now();
    try {
      await fetch(base + 'config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pl)
      });
      return true;
    } catch (e) {
      qqBridgeSyncAt = 0;
      return false;
    }
  }

  var qqLeaseTimer = null;
  var qqPullTimer = null;
  async function qqLease(on) {
    var base = qqBridgeBase();
    if (!base) return;
    try {
      await fetch(base + 'lease', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: !!on, ttl: 60 })
      });
    } catch (e) { }
  }

  function qqLeaseStart() {
    if (qqLeaseTimer) return;
    qqLease(true);
    if (!XZ_SMOKE) qqLeaseTimer = setInterval(function () {
      if (document.hidden) return;
      qqLease(true);
      qqSyncBridge(false).catch(function () { });
    }, 25000);
    if (!qqPullTimer) {
      /* 每 60 秒跟常驻客户端对一次账，防止 WS 静默丢包 */
      if (!XZ_SMOKE) qqPullTimer = setInterval(function () {
        if (document.hidden) return;
        qqPullBridge(false).catch(function () { });
      }, 60000);
    }
  }

  /* 机器人自己掉线了（登录态失效）—— 只能扫码，页面得说清楚 */
  var qqLoginWarned = false;
  async function qqLoginHealth() {
    var line = $('#qqLoginLine');
    if (!line) return null;
    var base = qqBridgeBase();
    var url = (base ? base.replace(/bridge\/$/, '') : '/') + 'qqhealth.json';
    try {
      var r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
      var d = await r.json();
      if (d && d.needLogin) {
        line.hidden = false;
        line.textContent = '⚠ 机器人的 QQ 登录已失效，需要扫码登录（点这里打开二维码）';
        line.onclick = function () { window.open('/qqlogin.png?t=' + Date.now(), '_blank'); };
        if (!qqLoginWarned) {
          qqLoginWarned = true;
          toast('机器人的 QQ 掉线了，需要扫码重新登录');
        }
      } else {
        line.hidden = true;
        line.textContent = '';
        qqLoginWarned = false;
      }
      return d;
    } catch (e) {
      return null;
    }
  }

  async function qqBridgeStatus() {
    var line = $('#qqBridgeLine');
    if (!line) return null;
    var base = qqBridgeBase();
    if (!base) { line.textContent = '服务器常驻：未启用'; return null; }
    try {
      var r = await fetch(base + 'status', { cache: 'no-store' });
      var d = await r.json();
      line.textContent = d && d.connected
        ? ('服务器常驻：在线（存档 ' + (d.inboxCount || 0) + ' 条，' + (d.selfId || '?') + '）')
        : ('服务器常驻：离线' + (d && d.lastError ? ('（' + d.lastError + '）') : ''));
      return d;
    } catch (e) {
      line.textContent = '服务器常驻：连不上';
      return null;
    }
  }

  /* 发消息前确认一下连接：WS 假死时这一步能把它拉回来 */
  async function qqEnsureConnected(silent) {
    if (!qqReady() || !qqWsUrl()) return false;
    if (qq.status !== 'ok') {
      var stuck = qq.status === 'connecting' && qqConnectAt && (Date.now() - qqConnectAt > 12000);
      if (!stuck && qq.status === 'connecting') {
        if (!silent) toast('QQ 正在连接中，稍等一下');
        return false;
      }
      qqConnect();
      if (!silent) toast('QQ 刚才掉线了，正在重连');
      return false;
    }
    if (qqChecking) return true;
    qqChecking = true;
    try {
      await qqApi('get_status', {});
      return true;
    } catch (e) {
      qq.lastErr = 'ensure: ' + (e.message || e);
      qqConnect();
      if (!silent) toast('QQ 连接不通，已经重连');
      return false;
    } finally {
      qqChecking = false;
    }
  }

  function qqScheduleReconnect(ms) {
    if (qqReconnectTimer) clearTimeout(qqReconnectTimer);
    qq.retrying = true;
    renderQqStatus();
    qqReconnectTimer = setTimeout(function () {
      qqReconnectTimer = null;
      if (!qqReady()) return;
      if (qq.status === 'ok') { qq.retrying = false; renderQqStatus(); return; }
      qqConnect();
    }, ms);
  }

  /* 心跳看门狗：NapCat 每 30 秒发一次 meta_event，100 秒一帧没有就认为连接死了重连 */
  /* 切回这个标签页：先体检连接，再补收这段时间漏掉的消息 */
  var qqBackBusy = false;
  function qqBackToTab() {
    if (!qqReady() || !qqWsUrl()) return;
    if (qqBackBusy) return;
    qqBackBusy = true;
    qqEnsureConnected(true).catch(function () { })
      .then(function () { return new Promise(function (r) { setTimeout(r, 800); }); })
      .then(function () { return qqCatchUp(); })
      .then(function () { return qqPullBridge(); })
      .then(function () { return qqBridgeStatus(); })
      .then(function () { return qqLoginHealth(); })
      .then(function () { return qqSyncBridge(true); })
      .catch(function () { })
      .then(function () { qqBackBusy = false; });
  }

  function qqStartWatchdog() {
    if (qqWatchdog) return;
    qqWatchdog = setInterval(function () {
      if (!qqReady()) return;
      if (!qq.status) { qqScheduleReconnect(0); return; }
      /* 70 秒一帧都没有（NapCat 每 30 秒一次心跳）→ 认为假死，直接重连 */
      if (qq.status === 'ok' && qqLastFrame && Date.now() - qqLastFrame > 70000) {
        actPush('QQ 事件断了，正在重连', 'qq');
        qqConnect();
      }
    }, 15000);
    /* 每 30 秒拿 HTTP 试一次活着没（WebSocket 假死时这招最灵） */
    if (!qqHeartTimer) {
      qqHeartTimer = setInterval(function () {
        if (!qqReady() || qq.status !== 'ok') return;
        if (document.hidden) return;
        qqApi('get_status', {}).then(function () { qqHeartFail = 0; }).catch(function () {
          qqHeartFail = Number(qqHeartFail || 0) + 1;
          if (qqHeartFail >= 2) { qqHeartFail = 0; actPush('QQ 接口没响应，重连', 'qq'); qqConnect(); }
        });
      }, 30000);
    }
    if (!qqDiagTimer) qqDiagTimer = setInterval(function () { qqDiag('tick'); }, 20000);
    window.addEventListener('online', function () { if (qqReady()) qqConnect(); });
    window.addEventListener('focus', function () { qqBackToTab(); });
    window.addEventListener('pageshow', function () { qqBackToTab(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        qqLease(false);
        try { qqSyncBridge('user'); } catch (e) { }
        return;
      }
      if (!document.hidden) qqBackToTab();
    });
  }

  function qqConnect(force) {
    /* 已经在连、或者刚连上不到 20 秒，就别再掐一次（以前会被 focus/heart/ensure 反复打断） */
    if (!force && qqWs) {
      var st = qqWs.readyState;
      if (st === 0 && Date.now() - (qqConnectAt || 0) < 8000) return;
      if (st === 1 && Date.now() - (qqLastFrame || 0) < 20000) return;
    }
    qqDisconnect();
    qqStartWatchdog();
    if (!qqReady()) { renderQqStatus(); return; }
    var base = qqWsUrl();
    if (!base) { renderQqStatus(); return; }
    var url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'access_token=' + encodeURIComponent(qq.token || '');
    qq.status = 'connecting';
    qqConnectAt = Date.now();
    renderQqStatus();
    try {
      qqWs = new WebSocket(url);
    } catch (e) {
      qq.status = '';
      renderQqStatus();
      return;
    }
    /* 卡在「连接中」也要能自愈：12 秒没连上就掐掉重来 */
    clearTimeout(qqConnectTimer);
    qqConnectTimer = setTimeout(function () {
      if (qqWs && qqWs.readyState !== 1) {
        qq.status = '';
        try { qqWs.close(); } catch (e) { }
        qqWs = null;
        renderQqStatus();
        actPush('QQ 一直连不上，重新连一次', 'qq');
        qqScheduleReconnect(5000);
      }
    }, 12000);
    qqWs.onopen = function () {
      clearTimeout(qqConnectTimer);
      qq.status = 'ok';
      qq.retrying = false;
      qqWsRetry = 0;
      qqLastFrame = Date.now();
      renderQqStatus();
      actPush('QQ 开始收消息', 'qq');
      qqDiag('open');
      if (qqReady()) qqProStart();
      qqApi('get_login_info', {}).then(function (r) {
        var d = (r && r.data) || {};
        if (d.user_id) {
          qq.me = { uid: Number(d.user_id), name: String(d.nickname || '') };
          saveQq();
          renderQqStatus();
        }
      }).catch(function () { });
      setTimeout(function () { qqCatchUp(); }, 1200);
      setTimeout(function () { qqPullBridge(); qqBridgeStatus(); }, 2000);
    };
    qqWs.onclose = function () {
      qq.status = '';
      qqWs = null;
      renderQqStatus();
      /* 掉线自动重连：3s 起，指数退避，最多 30s 一次（以前这里写死了要 qq.me.uid，
         刷新后没测试过连接的话 qq.me 是空的，一掉线就永远不再连了） */
      var wait = Math.min(30000, 3000 * Math.pow(1.7, qqWsRetry++));
      qqDiag('close');
      qqScheduleReconnect(wait);
    };
    qqWs.onerror = function () { };
    qqWs.onmessage = function (ev) {
      qqLastFrame = Date.now();
      var data = null;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data && data.post_type === 'message') qqOnMessage(data);
    };
  }

  /* ------------------------------------------------------------ 消息处理 */
  /* 收到但不回的时候，把原因挂在会话上——省得你猜 */
  function qqSkip(key, why) {
    var s = qqFindSession(key);
    if (s) {
      s.skip = String(why || '');
      s.skipAt = Date.now();
      saveQq();
      renderQqSessions();
    }
    return undefined;
  }

  /* 从 OneBot 的消息段里挑出图片（普通图片 + 商城表情） */
  function qqIsStickerSeg(seg) {
    if (!seg) return false;
    if (seg.type === 'mface' || seg.type === 'marketface') return true;
    var d = seg.data || {};
    var summary = String(d.summary || '');
    if (/动画表情|表情/.test(summary)) return true;
    if (Number(d.sub_type) === 1) return true;
    if (String(d.emoji_id || '').trim()) return true;
    return false;
  }

  function qqMfacesOf(ev) {
    var arr = Array.isArray(ev && ev.message) ? ev.message : [];
    var out = [];
    arr.forEach(function (seg) {
      if (!qqIsStickerSeg(seg)) return;
      var d = (seg && seg.data) || {};
      out.push({
        id: String(d.emoji_id || d.emojiId || ''),
        summary: String(d.summary || '').slice(0, 20),
        url: /^https?:/.test(String(d.url || '')) ? String(d.url) : ''
      });
    });
    return out;
  }


  function qqImagesOf(ev) {
    var arr = Array.isArray(ev.message) ? ev.message : [];
    var out = [];
    arr.forEach(function (seg) {
      if (!seg || !seg.data) return;
      if (seg.type !== 'image') return;
      /* 表情包（图片形态的动画表情）不当成图片，交给 qqMfacesOf */
      if (qqIsStickerSeg(seg)) return;
      var u = String(seg.data.url || seg.data.file || '');
      var k = String(seg.data.file_unique || seg.data.file || u.split('?')[0]).slice(0, 80);
      out.push({ url: /^https?:/.test(u) ? u : '', key: k || u.slice(0, 80) });
    });
    return out;
  }

  /* 主人不该被叫 QQ 昵称：把回复里出现的网名抹掉 */
  function qqDropName(text, names) {
    var out = String(text || '');
    (names || []).forEach(function (n) {
      n = String(n || '').trim();
      if (n.length < 2) return;
      out = out.split(n).join('');
    });
    return out.replace(/^[，,、。\s]+/, '').replace(/[，,、]{2,}/g, '，').trim();
  }

  /* 把图片拿成 dataURL：网页版走 nginx 反代，绕开跨域 */
  async function qqFetchImage(url) {
    var target = url;
    if (qqWebMode()) target = '/qq/img/?u=' + encodeURIComponent(url);
    var r = await fetch(target);
    if (!r.ok) return '';
    var blob = await r.blob();
    if (!blob.size || blob.size > 2.5 * 1024 * 1024) return '';
    return await new Promise(function (res) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result || '')); };
      fr.onerror = function () { res(''); };
      fr.readAsDataURL(blob);
    });
  }

  /* 图片抓下来转成 dataURL 再喂给模型：比把 QQ 的临时直链丢给上游靠谱得多 */
  var QQ_IMG_CACHE = {};
  async function qqImageDataUrl(url) {
    if (!url) return '';
    if (QQ_IMG_CACHE[url]) return QQ_IMG_CACHE[url];
    try {
      var data = await qqFetchImage(url);
      if (data) {
        QQ_IMG_CACHE[url] = data;
        return data;
      }
    } catch (e) { }
    return '';
  }

  /* 引用别人消息：reply 段里带 id，去 NapCat 要原消息（文本 + 图片都要） */
  var QQ_QUOTE_CACHE = {};
  async function qqQuotedInfo(ev) {
    var arr = Array.isArray(ev.message) ? ev.message : [];
    var replyId = 0;
    for (var i = 0; i < arr.length; i++) {
      var seg = arr[i];
      if (seg && seg.type === 'reply' && seg.data && seg.data.id) replyId = Number(seg.data.id) || 0;
    }
    if (!replyId) return { text: '', images: [] };
    if (QQ_QUOTE_CACHE[replyId]) return QQ_QUOTE_CACHE[replyId];
    try {
      var r = await qqApi('get_msg', { message_id: replyId });
      var msg = r && r.data;
      var segs = Array.isArray(msg) ? msg : (msg && Array.isArray(msg.message) ? msg.message : []);
      var info = { text: qqTextOf({ message: segs }), images: qqImagesOf({ message: segs }) };
      QQ_QUOTE_CACHE[replyId] = info;
      return info;
    } catch (e) { return { text: '', images: [] }; }
  }
  async function qqQuotedImages(ev) {
    var info = await qqQuotedInfo(ev);
    return info.images || [];
  }

  /* 把主人发来的消息写进「对话」：文字先落库（同步），图片/引用后补（异步） */
  function qqMirrorToChat(ev, text, imgs) {
    var body = String(text || '').trim();
    if (body === '[图片]') body = '';
    var msg = {
      id: uid(),
      role: 'user',
      text: body,
      ts: (Number(ev.time) || 0) * 1000 || Date.now(),
      atts: [],
      via: 'qq'
    };
    if (body && chatAlreadyHas('user', body)) return;
    chat.messages.push(msg);
    saveChat();
    renderChat(true);

    (async function () {
      var atts = [];
      var cands = (imgs || []).filter(function (i) { return i.url; }).slice(0, 3);
      for (var i = 0; i < cands.length; i++) {
        var du = await qqImageDataUrl(cands[i].url);
        if (du) atts.push({ kind: 'image', data: du, name: 'QQ 图片' });
      }
      var q = await qqQuotedInfo(ev);
      if (q && q.text) msg.text = '「引用：' + String(q.text).slice(0, 60) + '」' + (msg.text ? ('\n' + msg.text) : '');
      if (!atts.length && q && q.images && q.images.length) {
        var dq = await qqImageDataUrl(q.images[0].url);
        if (dq) atts.push({ kind: 'image', data: dq, name: 'QQ 引用图片' });
      }
      if (atts.length) msg.atts = atts;
      saveChat();
      renderChat(true);
    })().catch(function () { });
  }

  /* B 站私聊（只对主人）也镜像进「对话」 */
  function chatAlreadyHas(role, text) {
    var t = String(text || '').trim();
    if (!t) return false;
    var recent = (chat.messages || []).slice(-12);
    for (var i = 0; i < recent.length; i++) {
      var m = recent[i];
      if (!m || m.role !== role) continue;
      if (String(m.text || '').trim() !== t) continue;
      if (Math.abs(Date.now() - (Number(m.ts) || 0)) < 90000) return true;
    }
    return false;
  }

  function chatMirrorBili(role, text) {
    var t = String(text || '').trim();
    if (!t) return;
    if (chatAlreadyHas(role === 'user' ? 'user' : 'assistant', t)) return;
    chat.messages.push({ id: uid(), role: role === 'user' ? 'user' : 'assistant', text: t, ts: Date.now(), via: 'bili' });
    saveChat();
    try {
      if (document.querySelector('[data-page="chat"].is-active')) renderChat(true);
    } catch (e) { }
  }

  /* 她回给主人的话也写进「对话」 */
  async function chatMirrorOut(text) {
    var t = String(text || '').trim();
    if (!t) return;
    if (chatAlreadyHas('assistant', t)) return;
    chat.messages.push({ id: uid(), role: 'assistant', text: t, ts: Date.now(), via: 'qq' });
    saveChat();
    renderChat(true);
  }

  /* 同一张图（按 file_unique 认）在主人私聊里出现满 3 次才入库 */
  async function qqNoteSticker(im) {
    if (!im || !im.key) return;
    var k = String(im.key);
    qq.stickerSeen[k] = (Number(qq.stickerSeen[k]) || 0) + 1;
    saveQq();
    /* 满 3 次才收，且只收一次（QQ 断线重连可能重复收到同一张） */
    if (qq.stickerSeen[k] < 3 || !im.url) return;
    if (!qq.stickerDone || typeof qq.stickerDone !== 'object') qq.stickerDone = {};
    if (qq.stickerDone[k]) return;
    qq.stickerDone[k] = 1;
    try {
      var data = await qqFetchImage(im.url);
      if (!data) return;
      if (assets.stickers.some(function (x) { return x.data === data; })) return;
      assets.stickers.push({
        id: 'qq' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: 'QQ' + (assets.stickers.length + 1),
        emotion: '开心',
        data: data
      });
      saveAssets();
      renderStickers();
      toast('收录了一张表情包（主人发过 3 次了）');
    } catch (e) { }
  }

  /* 把表情包发出去（QQ） */
  async function qqSendSticker(target, sticker, isGroup) {
    var b64 = String((sticker && sticker.data) || '').split(',')[1] || '';
    if (!b64) throw new Error('这张表情读不出来');
    var msg = [{ type: 'image', data: { file: 'base64://' + b64 } }];
    await qqApi(isGroup ? 'send_group_msg' : 'send_private_msg', isGroup
      ? { group_id: Number(target.group) || 0, message: msg }
      : { user_id: Number(target.uid) || 0, message: msg });
    qqTouchSession({
      type: isGroup ? 'group' : 'private',
      uid: Number(target.uid) || 0,
      group: Number(target.group) || 0,
      name: '',
      text: '[表情]',
      mine: true
    });
  }

  /* 挑一张表情发出去 */
  function qqPickStickerFor(s) {
    if (!s) return;
    var isGroup = s.type === 'group';
    var target = { uid: s.uid, group: s.group };
    if (!assets.stickers.length) { toast('表情包库还是空的：设置 → 表情包 里传几张', 'warm'); return; }
    var l = $('#layer');
    l.innerHTML = '<div class="confirm"><div class="confirm-box"><div class="dm-head"><b>挑一张发给她</b>' +
      '<button class="btn btn-sm btn-ghost" data-close="1" type="button">关闭</button></div>' +
      '<div class="sticker-grid" style="max-height:56vh;overflow:auto">' +
      assets.stickers.map(function (x, i) {
        return '<div class="sticker-card"><img class="sticker-img" data-i="' + i + '" src="' + x.data + '" alt="' + esc(x.name) + '"></div>';
      }).join('') + '</div></div></div>';
    l.querySelector('[data-close]').onclick = function () { closeLayer(); qqOpenChat(s.key); };
    l.querySelector('.confirm').onclick = function (e) { if (e.target === this) { closeLayer(); qqOpenChat(s.key); } };
    l.querySelectorAll('.sticker-img').forEach(function (img) {
      img.onclick = async function () {
        var st = assets.stickers[Number(img.dataset.i)];
        if (!st) return;
        closeLayer();
        try {
          await qqSendSticker(target, st, isGroup);
          renderQqSessions();
          qqOpenChat(s.key);
          toast('发出去了');
        } catch (e) {
          toast('发失败了：' + (e.message || e), 'warm');
          qqOpenChat(s.key);
        }
      };
    });
  }

  /* ---------------------------------------------- 主动找 TA 说话 */
  var qqProTimer = null;

  function qqProDayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function qqProInQuiet() {
    var pr = qq.proactive || {};
    var h = new Date().getHours();
    var a = Number(pr.quietFrom) || 0;
    var b = Number(pr.quietTo) || 0;
    if (a === b) return false;
    return a < b ? (h >= a && h < b) : (h >= a || h < b);
  }

  /* 跟谁算「主人 / 白名单」 */
  function qqProAllowed(s) {
    var pr = qq.proactive || {};
    if (s.type !== 'private') return false;
    var p = personByUid(s.uid, 'qq');
    if (pr.targets === 'master') return !!(p && p.isMaster);
    if (pr.targets === 'white') return !!(p && (p.isMaster || p.list === 'white'));
    return true;
  }

  function qqProStateText() {
    var pr = qq.proactive || {};
    if (!pr.on) return '还没开启';
    var who = pr.targets === 'master' ? '主人' : (pr.targets === 'white' ? '主人 + 白名单' : '所有私聊过的人');
    var n = (qq.proLog && qq.proLog.day === qqProDayKey()) ? Number(qq.proLog.count || 0) : 0;
    return '开着：对' + who + ' · 安静满 ' + pr.idleHours + ' 小时 · 间隔 ' + pr.gapMin +
      ' 分钟 · 今天已发 ' + n + '/' + pr.dailyMax + (qqProInQuiet() ? ' · 现在在安静时段' : '');
  }

  /* 核心：满足条件就主动发一条。force=true 是「试一条」按钮 */
  async function qqProTick(force) {
    var pr = qq.proactive || {};
    if (!force && !pr.on) return 0;
    if (!qqReady() || qq.status !== 'ok') return 0;
    if (!force && qqProInQuiet()) return 0;

    var day = qqProDayKey();
    if (!qq.proLog || qq.proLog.day !== day) qq.proLog = { day: day, count: 0, lastAt: 0 };
    var now = Date.now();
    if (!force && Number(qq.proLog.count) >= pr.dailyMax) return 0;
    if (!force && Number(qq.proLog.lastAt) && now - Number(qq.proLog.lastAt) < pr.gapMin * 60000) return 0;

    var cands = (qq.sessions || []).filter(function (s) {
      if (!qqProAllowed(s)) return false;
      var last = 0;
      (s.thread || []).slice(-6).forEach(function (m) { last = Math.max(last, Number(m.t) || 0); });
      s._lastAt = last || Number(s.at) || 0;
      if (force) return true;
      return s._lastAt && (now - s._lastAt) >= pr.idleHours * 3600000;
    });
    if (!cands.length) { renderQq(); return 0; }
    cands.sort(function (a, b) { return (a._lastAt || 0) - (b._lastAt || 0); });
    var s = cands[0];
    var p = personByUid(s.uid, 'qq');
    var who = p ? personNick(p) : s.name;
    var lines = (s.thread || []).slice(-6).map(function (m) {
      return (m.mine ? '你：' : ((p && p.isMaster ? '对方' : s.name) + '：')) + String(m.text || '');
    }).join('\n');

    try {
      var out = await chatCompletion([
        { role: 'system', content: qqSystemPrompt(p, s.name) },
        {
          role: 'user',
          content: '最近的对话：\n' + (lines || '（还没聊过）') +
            '\n\n现在没人跟你说话，是你在主动开口找对方。' +
            '说一句自然的话，像真人突然想起来发消息那样，不超过 20 字；' +
            '不要提「主动」「找你」「在吗」这类空话，也不要解释你为什么发。' +
            (pr.hint ? ('想说的方向：' + pr.hint) : '')
        }
      ], { stream: false, chars: 60, temperature: 0.95, timeout: 90 });
      var text = stripDirectives(String(out || '')).replace(/^["'“”‘’]|["'“”‘’]$/g, '').trim();
      if (p && p.isMaster) text = qqDropName(text, [s.name, p.uname]);
      text = text.split('\n').filter(Boolean)[0] || '';
      text = scrubOutgoing(text, p, false).slice(0, Number(qq.maxChars) || 120);
      if (!text) return 0;
      await qqSendTo({ type: 'private', uid: Number(s.uid) || 0, group: 0 }, text, false);
      qqCooldown['u' + Number(s.uid)] = Date.now();
      qq.proLog.count = Number(qq.proLog.count || 0) + 1;
      qq.proLog.lastAt = Date.now();
      s.lastProactiveAt = Date.now();
      s.skip = '';
      saveQq();
      var keepY = window.scrollY;
      qqProSync();
      renderQqSessions();
      requestAnimationFrame(function () { window.scrollTo(0, keepY); });
      actPush('主动找「' + who + '」说话了：' + text.slice(0, 20), 'qq');
      return 1;
    } catch (e) {
      actPush('主动发消息失败：' + (e.message || e), 'bad', 'qq');
      qq.lastErr = 'proactive: ' + (e.message || e);
      return 0;
    }
  }

  function qqProSync() {
    var st = $('#qqProState');
    if (st) st.textContent = qqProStateText();
  }

  function qqProStart() {
    if (qqProTimer) return;
    qqProTimer = setInterval(function () {
      if (document.hidden) return;
      qqProTick().catch(function () { });
    }, 60000);
    setTimeout(function () { qqProTick().catch(function () { }); }, 25000);
  }

  /* 页面状态上报（排查断连用）：只发到同源 /qq/diag，不往外发 */
  var qqDiagLast = 0;
  function qqDiag(why) {
    if (!/^https?:$/.test(location.protocol)) return;
    var now = Date.now();
    if (why !== 'open' && why !== 'close' && why !== 'error' && now - qqDiagLast < 15000) return;
    qqDiagLast = now;
    try {
      fetch('/qq/diag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          why: why || 'tick',
          v: VERSION,
          status: qq.status,
          retrying: !!qq.retrying,
          lastFrameAgo: qqLastFrame ? Math.round((now - qqLastFrame) / 1000) : -1,
          sessions: (qq.sessions || []).length,
          hasToken: !!qq.token,
          wsUrl: qqWsUrl().slice(0, 60),
          err: String(qq.lastErr || '').slice(0, 200)
        })
      }).catch(function () { });
    } catch (e) { }
  }

  /* 把历史消息包装成普通事件 */
  function qqEvFromHistory(m, sess) {
    var isGroup = sess.type === 'group';
    var sender = m.sender || {};
    return {
      post_type: 'message',
      message_type: isGroup ? 'group' : 'private',
      self_id: Number(qq.me.uid) || 0,
      user_id: Number(sender.user_id || m.user_id || (isGroup ? 0 : sess.uid)) || 0,
      group_id: Number(m.group_id || sess.group) || 0,
      time: Number(m.time) || Math.floor(Date.now() / 1000),
      message_id: m.message_id || m.message_seq || 0,
      raw_message: m.raw_message || '',
      message: Array.isArray(m.message) ? m.message : [],
      sender: sender,
      backfill: true
    };
  }

  /* 掉线期间的消息：重连后按会话拉历史，补进来；只对每个会话的最后一条真的回 */
  var qqCatchBusy = false;
  async function qqCatchUp() {
    if (qq.catchUp === false || qqCatchBusy) return 0;
    if (!qqReady()) return 0;
    qqCatchBusy = true;
    var total = 0, replied = 0;
    try {
      var targets = (qq.sessions || []).slice(0, 8).map(function (x) { return x; });
      /* 主人不在「最近的消息」里，但也要补收，所以额外按 tracked 补几个 */
      Object.keys(qq.tracked || {}).forEach(function (k) {
        var isG = k.charAt(0) === 'g';
        var id = Number(k.slice(1)) || 0;
        if (!id) return;
        var has = targets.some(function (x) {
          return isG ? (x.type === 'group' && Number(x.group) === id) : (Number(x.uid) === id);
        });
        if (has) return;
        if (targets.length >= 12) return;
        targets.push({
          key: k, type: isG ? 'group' : 'private',
          uid: isG ? 0 : id, group: isG ? id : 0,
          name: '', lastTs: Number(qq.tracked[k]) || 0
        });
      });
      for (var ti = 0; ti < targets.length; ti++) {
        var sess = targets[ti];
        var history = [];
        try {
          if (sess.type === 'group') {
            var rg = await qqApi('get_group_msg_history', { group_id: Number(sess.group), count: 20 });
            history = (rg && rg.data && (rg.data.messages || rg.data)) || [];
          } else {
            var rf = await qqApi('get_friend_msg_history', { user_id: Number(sess.uid), count: 20 });
            history = (rf && rf.data && (rf.data.messages || rf.data)) || [];
          }
        } catch (e) {
          continue;
        }
        if (!Array.isArray(history) || !history.length) continue;

        var since = Number(sess.lastTs) || 0;
        var missed = history.filter(function (m) {
          if (!m || !m.message_id) return false;
          if (qqSeenHas(m.message_id)) return false;
          var t = Number(m.time) || 0;
          if (!since) return false;               /* 没见过这个会话，不瞎补 */
          return t > since;
        });
        if (!missed.length) continue;

        var mineUid = Number(qq.me.uid) || 0;
        var lastOther = null;
        var otherTexts = [];
        for (var mi = 0; mi < missed.length; mi++) {
          var evh = qqEvFromHistory(missed[mi], sess);
          if (!evh.user_id || evh.user_id === mineUid || evh.user_id === evh.self_id) {
            qqMarkSeen(evh.message_id);
            qqTouchSession({
              type: sess.type, uid: Number(sess.uid) || 0, group: Number(sess.group) || 0,
              name: '', text: qqTextOf(evh) || '[图片]', mine: true, ts: evh.time
            });
            continue;
          }
          await qqOnMessage(evh, { noReply: true });
          total++;
          lastOther = evh;
          var _tx = qqTextOf(evh);
          if (_tx) otherTexts.push(_tx);
        }
        /* 只对最后一条做回复，别把掉线期间的话一条条回一遍 */
        if (lastOther && Date.now() / 1000 - Number(lastOther.time) < 7200) {
          try {
            var mergedCatch = otherTexts.length <= 1 ? (otherTexts[0] || '')
              : otherTexts.map(function (t, i) { return (i + 1) + ') ' + t; }).join('\n');
            await qqOnMessage(lastOther, { force: true, agg: mergedCatch || qqTextOf(lastOther) });
            var _st = qqFindSession(qqSessionKey(lastOther));
            if (_st && _st.thread && _st.thread.length && _st.thread[_st.thread.length - 1].mine) replied++;
          } catch (e2) {
            qq.catchErr = 'reply: ' + (e2.message || e2);
          }
        }
        await sleep(300);
      }
      if (total) actPush('补收了 ' + total + ' 条掉线期间的消息' + (replied ? '，回了 ' + replied + ' 个会话' : ''), 'qq');
      if (total) toast('补收了 ' + total + ' 条消息');
      qq.catchInfo = { total: total, replied: replied, lastOther: lastOther ? lastOther.time : 0, at: Date.now() };
    } catch (e) {
      qq.catchErr = String(e.message || e);
      actPush('补收消息失败：' + (e.message || e), 'qq');
    } finally {
      qqCatchBusy = false;
    }
    return total;
  }

  async function qqOnMessage(ev, opts) {
    opts = opts || {};
    /* 同一条消息只处理一次：重连后 NapCat 可能重推，常驻客户端补收也可能撞上 */
    if (!opts.force && ev && ev.message_id && qqSeenHas(ev.message_id)) return;
    var isGroup = ev.message_type === 'group';
    var senderId = Number(ev.user_id) || 0;
    if (!senderId || senderId === Number(ev.self_id)) return;
    var text = qqTextOf(ev);
    var imgs = qqImagesOf(ev);
    var mfaces = qqMfacesOf(ev);
    if (!isGroup) {
      var quoted = await qqQuotedImages(ev);
      if (quoted.length) imgs = imgs.concat(quoted);
    }
    if (!text && imgs.length) text = '[图片]';
    else if (!text && mfaces.length) text = '[表情包]';
    var sender = ev.sender || {};
    var name = String(sender.card || sender.nickname || ('QQ ' + senderId));
    var key = qqSessionKey(ev);
    qqMarkSeen(ev.message_id);

    var person = personByUid(senderId, 'qq');
    var isMasterChat = !isGroup && !!(person && person.isMaster);
    qqTrack(isGroup ? Number(ev.group_id) : senderId, Number(ev.time) || 0, isGroup);

    if (opts.agg) {
      /* 这几条已经各自记过上下文了，这里只负责回一条 */
    } else if (isMasterChat) {
      /* 和主人的私聊只进「对话」，「最近的消息」里不重复记一份 */
      qqMirrorToChat(ev, text, imgs);
    } else {
      qqTouchSession({
        type: isGroup ? 'group' : 'private',
        uid: senderId,
        group: Number(ev.group_id) || 0,
        name: name,
        face: qqFace(senderId),
        text: text,
        mine: false,
        ts: Number(ev.time) || 0
      });
    }
    if (!text) return qqSkip(key, '这条既没有文字也没有图片');

    if (isGroup && !qq.groupAt) { renderQqSessions(); return qqSkip(key, '群里没开「@ 我才回」'); }
    if (isGroup && !qqMentionsMe(ev)) { renderQqSessions(); return qqSkip(key, '群里没 @ 她，按设置不回'); }

    if (opts.noReply) return;          /* 补收：只落上下文，不逐条回 */

    var cat = person ? person.list : 'none';
    var isMaster = isMasterChat;
    /* 连发：先攒着，等窗口结束再回一轮 */
    if (!opts.agg && !opts.noReply && qqAggPush(key, ev, text)) {
      renderQqSessions();
      return;
    }

    if (!isMaster && !qq.autoReply[cat]) {
      if (person) actPush('QQ 上「' + personNick(person) + '」发来消息，没回（' + listWord(cat) + '没开）', 'qq');
      return qqSkip(key, person
        ? ('TA 在名单里是「' + listWord(cat) + '」，这类默认不回 —— 改成白名单就会回')
        : 'TA 不在名单里（默认当普通人，不回）—— 去「名单 → QQ」加进白名单');
    }
    /* 主人私聊里的图片：同一张发满 3 次就收进表情包库 */
    if (!isGroup && isMaster && qq.collectStickers !== false && (imgs.length || mfaces.length)) {
      imgs.forEach(function (im) { qqNoteSticker(im); });
      /* 表情包（mface）也要能收：之前只收图片，等于把表情包漏了 */
      mfaces.forEach(function (mf) {
        qqNoteSticker({ key: 'mf' + (mf.id || mf.summary || '') , url: mf.url });
      });
    }

    var now = Date.now();
    if (qqCooldown[key] && now - qqCooldown[key] < (Number(qq.cooldownSec) || 0) * 1000) {
      return qqSkip(key, '还在冷却（' + (Number(qq.cooldownSec) || 0) + ' 秒内只回一次）');
    }

    var whoLabel = isMaster ? '对方' : name;
    var msgs;
    if (isMaster) {
      msgs = (chat.messages || []).filter(function (m) {
        return (m.role === 'user' || m.role === 'assistant') && m.text;
      }).slice(-8).map(function (m) {
        return (m.role === 'user' ? '对方：' : '你：') + String(m.text).slice(0, 300);
      });
    } else {
      msgs = ((qqFindSession(key) || {}).thread || []).slice(-8).map(function (m) {
        return (m.mine ? '你：' : (whoLabel + '：')) + m.text;
      });
    }
    /* 连发攒起来回的时候，这几条没有单独进上下文（主人的没镜像、别人的已逐条记过），补一行 */
    if (opts.agg) {
      var _aggTxt = String(opts.agg).trim();
      var _aggLine = '对方：' + _aggTxt.slice(0, 600);
      var _lastThem = '';
      for (var _mi = msgs.length - 1; _mi >= 0; _mi--) {
        if (msgs[_mi].indexOf('对方：') === 0) { _lastThem = msgs[_mi]; break; }
      }
      /* 主人这几条已经镜像进「对话」了，上下文里已经有 —— 再补一遍她就当没看见过，来回重复 */
      var _covered = _lastThem && (_lastThem.indexOf(_aggTxt.slice(0, 24)) >= 0 ||
        _aggTxt.indexOf(_lastThem.slice(3, 27)) >= 0);
      if (!msgs.length) msgs = [_aggLine];
      else if (!_covered) msgs = msgs.concat([_aggLine]);
    }
    /* 连着两句一模一样（镜像 + 补行都可能造成）只留一条，不然她会答两遍 */
    msgs = msgs.filter(function (m, i2) { return i2 === 0 || m !== msgs[i2 - 1]; });
    if (!msgs.length) return qqSkip(key, '没有可用的上下文');

    actPush('在回 QQ 上「' + name + '」', 'qq');
    try {
      var _lastMine = '';
      var _th = (qqFindSession(key) || { thread: [] }).thread || [];
      for (var _li = _th.length - 1; _li >= 0; _li--) {
        if (_th[_li] && _th[_li].mine && _th[_li].text) { _lastMine = String(_th[_li].text).slice(0, 80); break; }
      }
      if (!_lastMine && isMaster) {
        var _cm = (chat.messages || []);
        for (var _ci = _cm.length - 1; _ci >= 0; _ci--) {
          if (_cm[_ci] && _cm[_ci].role === 'assistant' && _cm[_ci].text) { _lastMine = String(_cm[_ci].text).slice(0, 80); break; }
        }
      }
      var ask = '最近的对话：\n' + msgs.join('\n') + '\n\n' +
        (opts.agg ? '（对方刚才连着发了几条，这算一轮，合起来回。）\n' : '') + '回他一句。';
      if (_lastMine) ask += '（你上一轮说的是：「' + _lastMine + '」——别重复这句，也别换种说法再讲一遍。）\n';
      var look = [];
      if (qq.seeImages !== false) {
        var cands = imgs.filter(function (i) { return i.url; }).slice(0, 3);
        for (var ci = 0; ci < cands.length; ci++) {
          var du = await qqImageDataUrl(cands[ci].url);
          look.push(du || cands[ci].url);      /* 抓不到就退回原始直链 */
        }
      }
      if (mfaces.length) {
        ask += '\n（TA 刚发了 ' + mfaces.length + ' 个表情包：不要描述它长什么样、不要念出上面的字，' +
          '只按它想表达的情绪接话；TA 发的是真实图片时才聊图片里的内容。）';
      }
      var userContent = ask;
      if (look.length) {
        userContent = [{ type: 'text', text: ask + '\n（上面还有 ' + look.length + ' 张 TA 发的图片，一起看看再回）' }]
          .concat(look.map(function (u) { return { type: 'image_url', image_url: { url: u } }; }));
      }
      var out = await chatCompletion([
        { role: 'system', content: qqSystemPrompt(person, name) },
        { role: 'user', content: userContent }
      ], { stream: false, chars: Number(qq.maxChars) || 120, temperature: 0.85, timeout: 90 });

      var parsedQ = parseDirectives(String(out || ''));
      var reply = String(parsedQ.text || '').replace(/^["'“”‘’]|["'“”‘’]$/g, '').trim();
      if (isMaster) reply = qqDropName(reply, [name, sender.nickname, person && person.uname]);
      /* QQ 上聊出来的事也要进记忆（只有白名单 / 主人才允许写） */
      if (settings.injAutoMem && parsedQ.ops.length && (isMaster || (person && person.list === 'white'))) {
        var addedQ = applyMemoryOps(parsedQ.ops);
        if (addedQ.length) {
          saveMemory();
          renderMemory();
          actPush('记住了 ' + addedQ.length + ' 条（QQ 上「' + whoLabel + '」说的）', 'qq');
        }
      }
      if (!reply) return qqSkip(key, '模型这次没出话（换个模型，比如 cn:glm-5.3；推理模型会把预算全烧在思考链上）');

      /* 拆不拆条：白名单（或主人）默认拆；群里最多 2 条，私聊按设置 */
      var maxParts = isGroup ? Math.min(2, qqPickParts()) : qqPickParts();
      var white = !!(person && (person.list === 'white' || person.isMaster));
      if (qq.splitWhiteOnly && !white) maxParts = 1;

      var parts = [];
      qqSplit(reply, maxParts).forEach(function (t) {
        t = scrubOutgoing(t, person, false).slice(0, Number(qq.maxChars) || 120);
        if (t) parts.push(t);
      });
      if (!parts.length) return qqSkip(key, '回复被隐私清洗滤空了');

      var target = { type: isGroup ? 'group' : 'private', uid: senderId, group: Number(ev.group_id) || 0 };
      for (var pi = 0; pi < parts.length; pi++) {
        if (pi === 0) {
          await sleep(260 + Math.random() * 420);          /* 先"看一眼"再回 */
        } else {
          var gap = (Number(qq.splitGap) || 0.6) * 1000;
          await sleep(gap + Math.min(900, parts[pi].length * 35) + Math.random() * 380);
        }
        await qqSendTo(target, parts[pi], isGroup);
        if (isMaster) chatMirrorOut(parts[pi]).catch(function () { });
      }
      qqCooldown[key] = Date.now();
      var _s = qqFindSession(key);
      if (_s) { _s.skip = ''; _s.skipAt = 0; }
      if (person && person.list === 'white') {
        person.affinity = clamp(personAff(person) + 3, 0, 100);
        savePeople();
        renderRoster('qq');
      }
      actPush('回过 QQ 上「' + name + '」了', 'qq');
    if (person && (person.isMaster || person.list === 'white')) {
      memoryAutoExtract(false, msgs.slice(-6).join('\n')).catch(function () { });
      memeAutoLearn().catch(function () { });
    }
    } catch (e) {
      actPush('QQ 回消息失败：' + (e.message || e), 'qq');
      qqSkip(key, '回消息出错：' + (e.message || e));
    }
  }

  function listWord(cat) {
    return cat === 'black' ? '黑名单' : cat === 'white' ? '白名单' : '普通';
  }

  /* 把一整段切成几条短消息：先复用人设页那套断句规则，再按 QQ 的条数上限收口。
     含链接或表情码的段落不切，免得把 URL 劈成两半。 */
  /* 这次回几条：在 [splitMin, splitMax] 里随机，看着像真人 */
  function qqPickParts() {
    var lo = clamp(Math.round(Number(qq.splitMin) || 1), 1, 5);
    var hi = clamp(Math.round(Number(qq.splitMax) || lo), 1, 5);
    if (hi < lo) hi = lo;
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  function qqSplit(text, maxParts) {
  text = String(text == null ? '' : text).replace(/\[\[[^\]]{0,200}\]\]/g, '');
    var src = String(text == null ? '' : text).trim();
    if (!src) return [];
    var cap = clamp(Math.round(Number(maxParts) || 3), 1, 5);
    var softMax = 22;                       /* 一条大概多长，超过就再切 */

    /* 1) 模型自己分的行/段先用上 */
    var segs = [];
    segmentReply(src).forEach(function (x) {
      var t = String((x && x.text) || '').trim();
      if (t) segs.push(t);
    });
    if (!segs.length) segs = [src];

    /* 2) 段内按句子切：有几句就是几条 */
    var sents = [];
    segs.forEach(function (p) {
      if (/https?:\/\/|\[CQ:/.test(p)) { sents.push(p); return; }
      p.split(/(?<=[。！？!?…~～])/).forEach(function (q2) {
        var t = q2.trim();
        if (t) sents.push(t);
      });
    });

    /* 3) 一整句特别长（只有逗号）：按逗号再切 */
    if (sents.length === 1 && sents[0].length > softMax) {
      var chunks = sents[0].split(/(?<=[，,、；;])/).filter(function (x) { return x.trim(); });
      if (chunks.length > 1) sents = chunks;
    }

    /* 4) 句子太多就合并到 cap 条；太少就保持原样 */
    var groups;
    if (sents.length <= cap) {
      groups = sents;
    } else {
      var per = Math.ceil(sents.length / cap);
      groups = [];
      for (var gi = 0; gi < sents.length; gi += per) {
        groups.push(sents.slice(gi, gi + per).join('').trim());
      }
    }

    /* 5) QQ 上打字不带句号 */
    groups = groups.map(function (g) {
      var t = String(g || '').trim();
      if (t.length > 1) t = t.replace(/[。．.]+$/, '').trim();
      return t;
    }).filter(Boolean);

    return groups.length ? groups : [src];
  }

  function qqSystemPrompt(person, name) {
    var isMaster = !!(person && person.isMaster);
    var call = String(persona.call || '').trim();
    var who = isMaster ? (call || '他') : ((person && (person.nickname || person.uname)) || name);
    if (person && (person.list === 'white' || person.isMaster)) {
      return buildSystemPrompt() + '\n\n【这次是 QQ】你正在 QQ 上回「' + who + '」的消息。' +
        (isMaster
          ? ('对方就是你平时叫「' + (call || '他') + '」的那个人本人。'
            + '注意：「' + String(name || '') + '」只是 TA 的 QQ 网名，不是你对 TA 的称呼 —— '
            + '永远不要用这个网名称呼 TA（也不要照着念），要么叫「' + (call || '你') + '」，要么直接说话不叫名字。')
          : '') +
        '像真人发消息：一条只说一件事；想分几条就用空行隔开，每行不超过 20 字，不要编号、不要引号。\n' +
        '句末不要加句号（。和 . 都不用）；感叹号、问号按情绪来，别每句都带。' +
        '每次回 2~3 条短消息：一条一句、每句单独一行，单条不超过 18 个字，别写成一长句。' +
        dmPrivacyRule(person);
    }
    return '你叫「' + (persona.name || '心枕') + '」，一个普通网友，正在 QQ 上回话。' +
      '语气自然、短句、像真人打字；一条只说一件事，想分几条就用空行隔开，每行不超过 20 字。' +
      '不要编号、不要引号、不要解释。\n' + dmPrivacyRule(person);
  }

  async function qqSendTo(target, text, isGroup) {
    var params = isGroup
      ? { group_id: Number(target.group) || 0, message: String(text) }
      : { user_id: Number(target.uid) || 0, message: String(text) };
    await qqApi(isGroup ? 'send_group_msg' : 'send_private_msg', params);
    var _to = isGroup ? null : personByUid(Number(target.uid), 'qq');
    /* 她说的话记进「最近的消息」；和主人的私聊不记（那边统一看「对话」） */
    var _masterUid = Number((roster.qq.master && roster.qq.master.uid) || 0);
    if (isGroup || Number(target.uid) !== _masterUid && !(_to && _to.isMaster)) {
      qqTouchSession({
        type: isGroup ? 'group' : 'private',
        uid: Number(target.uid) || 0,
        group: Number(target.group) || 0,
        name: '',
        text: String(text),
        mine: true
      });
    }
  }

  /* ---------------------------------------------------------------- 界面 */
  function renderQqSessions() {
    var box = $('#qqSessions');
    if (!box) return;
    var hint = $('#qqMsgHint');
    if (hint) hint.textContent = qq.sessions.length ? ('最近 ' + qq.sessions.length + ' 个会话') : '还没有消息';
    if (!qq.sessions.length) {
      box.innerHTML = '<p class="field-note" style="margin:8px 0 0">' +
        (qqReady() ? '连上 NapCat 之后，收到的消息会出现在这里。' : 'QQ 要在桌面版里用。') + '</p>';
      return;
    }
    box.innerHTML = '';
    qq.sessions.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dm-session';
      b.innerHTML =
        '<img class="dm-face" src="' + esc(s.face || '') + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
        '<span class="dm-main"><span class="dm-name">' + esc(s.name) + (s.type === 'group' ? ' <span class="meme-src">群 ' + esc(s.group) + '</span>' : '') + '</span>' +
        '<span class="dm-last">' + esc(String(s.last || '').slice(0, 40)) + '</span>' +
        (s.skip ? '<span class="dm-last" style="color:var(--warn,#c2554f)">没回：' + esc(String(s.skip).slice(0, 46)) + '</span>' : '') +
        '</span>' +
        (Number(s.unread) ? '<span class="dm-unread">' + Math.min(99, Number(s.unread)) + '</span>' : '') +
        '<span class="dm-time">' + (s.at ? timeText(s.at) : '') + '</span>';
      b.onclick = function () { qqOpenChat(s.key); };
      box.appendChild(b);
    });
  }

  function qqOpenChat(key) {
    var s = qqFindSession(key);
    if (!s) return;
    s.unread = 0;
    saveQq();
    renderQqSessions();
    qqThread = s;
    var l = $('#layer');
    l.innerHTML = '<div class="confirm"><div class="confirm-box dm-panel" role="dialog" aria-modal="true">' +
      '<div class="dm-head"><img src="' + esc(s.face || '') + '" alt=""><b>' + esc(s.name) +
      (s.type === 'group' ? ('（群 ' + esc(s.group) + '）') : '') + '</b>' +
      '<span class="card-hint">QQ</span>' +
      '<button class="btn btn-sm btn-ghost" data-close="1" type="button">关闭</button></div>' +
      '<div class="dm-thread" id="qqThread"></div>' +
      '<div class="dm-input-row"><textarea class="textarea" id="qqInput" rows="1" placeholder="以她的口吻回一句…"></textarea>' +
      '<button class="btn btn-sm" id="qqStickerBtn" type="button" title="发一张表情包">表情</button>' +
      '<button class="btn btn-primary" id="qqSendBtn" type="button">发送</button></div>' +
      '</div></div>';
    l.querySelector('[data-close]').onclick = closeLayer;
    l.querySelector('.confirm').onclick = function (e) { if (e.target === this) closeLayer(); };
    var sb = $('#qqStickerBtn');
    if (sb) sb.onclick = function () { qqPickStickerFor(s); };
    $('#qqSendBtn').onclick = async function () {
      var el = $('#qqInput');
      var text = String(el.value || '').trim();
      if (!text) return;
      el.value = '';
      try {
        await qqSendTo({ type: s.type, uid: s.uid, group: s.group }, text, s.type === 'group');
        qqThread = qqFindSession(key);
        renderQqThread();
        actPush('手动回了 QQ 上的「' + s.name + '」', 'qq');
      } catch (e) {
        toast('没发出去：' + (e.message || e), 'warm');
      }
    };
    document.addEventListener('keydown', layerEsc);
    renderQqThread();
  }

  function renderQqThread() {
    var box = $('#qqThread');
    if (!box || !qqThread) return;
    box.innerHTML = (qqThread.thread || []).map(function (m) {
      return '<div class="dm-msg ' + (m.mine ? 'is-me' : 'is-them') + '">' + esc(m.text) +
        '<time>' + timeText(m.t) + '</time></div>';
    }).join('') || '<p class="field-note">还没有消息。</p>';
    box.scrollTop = box.scrollHeight;
  }

  /* ------------------------------------------------------ NapCat 部署器 */
  function napcatBridge() {
    var d = window.xinzhenDesktop;
    return d && d.napcat ? d : null;
  }

  async function renderNapcat() {
    var st = $('#napcatState');
    if (!st) return;
    var sub = $('#napcatSub');
    var b = napcatBridge();
    if (!b) {
      st.textContent = '桌面版才能部署';
      if (sub) sub.textContent = '浏览器里碰不到本机文件';
      return;
    }
    try {
      var r = await b.napcat.status();
      if (!r || !r.ok) { st.textContent = '检测失败'; if (sub) sub.textContent = (r && r.why) || ''; return; }
      if (!r.qq) {
        st.textContent = '没找到 QQ';
        if (sub) sub.textContent = '先装 QQ 客户端（NT 版），装完点「重新检测」';
      } else if (r.napcat && r.config) {
        st.textContent = '已就绪：QQ ' + (r.qq.version || '') + ' + NapCat';
        if (sub) sub.textContent = 'HTTP ' + r.config.port + ' / WS ' + r.config.wsPort + ' · 配置已写好';
      } else if (r.napcat) {
        st.textContent = 'NapCat 已装，配置还没写';
        if (sub) sub.textContent = '点「一键部署」，它会写一份 OneBot 配置并把地址填好';
      } else {
        st.textContent = 'QQ 在 ' + r.qq.dir;
        if (sub) sub.textContent = r.liteLoader ? '有 LiteLoader，缺 NapCat 插件' : '缺 LiteLoader 和 NapCat';
      }
    } catch (e) {
      st.textContent = '检测失败';
      if (sub) sub.textContent = String(e.message || e);
    }
  }

  async function napcatDeploy() {
    var b = napcatBridge();
    if (!b) { toast('桌面版才能部署', 'warm'); return; }
    var btn = $('#napcatDeploy');
    if (btn) { btn.disabled = true; btn.textContent = '部署中…'; }
    try {
      var r = await b.napcat.install();
      await renderNapcat();
      if (r && r.ok && r.apiBase) {
        qq.apiBase = r.apiBase;
        qq.wsUrl = r.wsUrl;
        qq.token = r.token;
        saveQq();
        renderQq();
        toast(r.already ? '配置已经写好了' : '部署好了，地址已自动填上');
        qqTest();
      } else if (r && r.needQQ) {
        toast(r.why, 'warm');
      } else if (r && r.needManual) {
        showText('还差一步',
          (r.why || '') + '\n\n' +
          (r.qqDir ? ('QQ 在：' + r.qqDir + '\n') : '') +
          '\n装好之后回到这里点「重新检测」，再点「一键部署」写配置。');
      } else {
        toast((r && r.why) || '没部署成功', 'warm');
      }
    } catch (e) {
      toast('部署出错：' + (e.message || e), 'warm');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '一键部署'; }
    }
  }

  async function napcatLaunch() {
    var b = napcatBridge();
    if (!b) { toast('桌面版才能启动 QQ', 'warm'); return; }
    try {
      var r = await b.napcat.launch();
      toast(r && r.ok ? '正在启动 QQ…' : ((r && r.why) || '启动失败'), r && r.ok ? 'done' : 'warm');
    } catch (e) {
      toast('启动失败：' + (e.message || e), 'warm');
    }
  }

  function bindQq() {
    var map = [
      ['#qqApi', 'apiBase', String], ['#qqWs', 'wsUrl', String], ['#qqToken', 'token', String],
      ['#qqCooldown', 'cooldownSec', Number], ['#qqChars', 'maxChars', Number],
      ['#qqSplitMin', 'splitMin', Number], ['#qqSplitMax', 'splitMax', Number], ['#qqSplitGap', 'splitGap', Number],
        ['#qqFirstWait', 'firstWait', Number]
    ];
    map.forEach(function (item) {
      var el = $(item[0]);
      if (!el) return;
      el.addEventListener('change', function () {
        var v = item[2](el.value);
        qq[item[1]] = typeof v === 'number' ? clamp(Number(v) || 0, 0, item[1] === 'maxChars' ? 500 : 600) : String(v || '').trim();
        saveQq();
        if (item[1] === 'apiBase' || item[1] === 'wsUrl' || item[1] === 'token') { qq.me = { uid: 0, name: '' }; qqDisconnect(); renderQqStatus(); }
      });
    });
    [['white', '#qqWhite'], ['none', '#qqNone'], ['black', '#qqBlack']].forEach(function (pair) {
      var el = $(pair[1]);
      if (!el) return;
      el.addEventListener('change', function () {
        qq.autoReply[pair[0]] = !!el.checked;
        saveQq();
      });
    });
    var ga = $('#qqGroupAt');
    if (ga) ga.addEventListener('change', function () { qq.groupAt = !!ga.checked; saveQq(); });
    var sw = $('#qqSplitWhite');
    if (sw) sw.addEventListener('change', function () { qq.splitWhiteOnly = !!sw.checked; saveQq(); });
    /* 拆条区间：1~5，且保证 min ≤ max */
    [['#qqSplitMin', 'splitMin'], ['#qqSplitMax', 'splitMax']].forEach(function (pair) {
      var el = $(pair[0]);
      if (!el) return;
      el.addEventListener('change', function () {
        var v = clamp(Math.round(Number(el.value) || 1), 1, 5);
        qq[pair[1]] = v;
        if (qq.splitMax < qq.splitMin) {
          if (pair[1] === 'splitMin') qq.splitMax = v; else qq.splitMin = v;
        }
        saveQq();
        qSetVal('#qqSplitMin', qq.splitMin);
        qSetVal('#qqSplitMax', qq.splitMax);
      });
    });
    var si = $('#qqSeeImg');
    if (si) si.addEventListener('change', function () { qq.seeImages = !!si.checked; saveQq(); });
    var proOn = $('#qqProOn');
    if (proOn) proOn.addEventListener('change', function () {
      var keepY = window.scrollY;
      qq.proactive.on = !!proOn.checked;
      saveQq();
      qqProSync();
      if (qq.proactive.on) qqProStart();
      requestAnimationFrame(function () { window.scrollTo(0, keepY); });
    });
    [['#qqProTargets', 'targets', String], ['#qqProIdle', 'idleHours', Number],
     ['#qqProGap', 'gapMin', Number], ['#qqProDaily', 'dailyMax', Number],
     ['#qqProQuietFrom', 'quietFrom', Number], ['#qqProQuietTo', 'quietTo', Number],
     ['#qqProHint', 'hint', String]].forEach(function (it) {
      var el = $(it[0]);
      if (!el) return;
      el.addEventListener('change', function () {
        var keepY = window.scrollY;
        var v = it[2](el.value);
        qq.proactive[it[1]] = it[2] === Number ? Number(v) || 0 : String(v || '').trim();
        saveQq();
        qqProSync();
        requestAnimationFrame(function () { window.scrollTo(0, keepY); });
      });
    });
    var proTest = $('#qqProTest');
    if (proTest) proTest.onclick = async function () {
      proTest.disabled = true;
      proTest.textContent = '发…';
      try {
        var n = await qqProTick(true);
        toast(n ? '发出去了' : '没有可发的对象（要先有私聊会话）', n ? 'done' : 'warm');
      } catch (e) {
        toast('试发失败：' + (e.message || e), 'warm');
      } finally {
        proTest.disabled = false;
        proTest.textContent = '试一条';
        renderQq();
      }
    };
    var cu = $('#qqCatchUp');
    if (cu) cu.addEventListener('change', function () { qq.catchUp = !!cu.checked; saveQq(); });
    var cs = $('#qqCollect');
    if (cs) cs.addEventListener('change', function () { qq.collectStickers = !!cs.checked; saveQq(); });
    var eye = $('#qqTokenEye');
    var tok = $('#qqToken');
    if (eye && tok) eye.onclick = function () {
      tok.type = tok.type === 'password' ? 'text' : 'password';
      eye.classList.toggle('is-on', tok.type === 'text');
    };
    var test = $('#qqTest');
    if (test) test.onclick = qqTest;
    var nc = $('#napcatCheck');
    if (nc) nc.onclick = renderNapcat;
    var nd = $('#napcatDeploy');
    if (nd) nd.onclick = napcatDeploy;
    var nl = $('#napcatLaunch');
    if (nl) nl.onclick = napcatLaunch;
    renderNapcat();
    var dw = $('#diaryWrite');
    if (dw) dw.onclick = async function () {
      dw.disabled = true;
      var old = dw.textContent;
      dw.textContent = '写…';
      try {
        var n2 = await diaryWrite(diaryDayKey(Date.now()), true);
        toast(n2 ? '写好了' : '今天没什么可写的，或者模型没回话', n2 ? 'done' : 'warm');
      } finally { dw.disabled = false; dw.textContent = old; }
    };
    var pa = $('#planAdd');
    if (pa) pa.onclick = async function () {
      var v = await promptBox('要做的事', '', '比如：周五之前把预算表发给他');
      if (v == null) return;
      var t = String(v).trim();
      if (!t) return;
      var due = await promptBox('什么时候做（可留空）', '比如 2026-11-01 20:00，或者留空', '');
      planItemAdd(t, due ? String(due).trim() : '', 'me');
      toast('记下了');
    };
    var ba = $('#qqBridgeAuto');
    if (ba) {
      ba.checked = qq.bridgeAuto !== false;
      ba.onchange = function () {
        qq.bridgeAuto = !!ba.checked;
        saveQq();
        qqSyncBridge(true).catch(function () { });
        toast(qq.bridgeAuto ? '页面关着也让她回' : '只在你开着页面时回复');
      };
    }
    var acb = $('#actClear');
    if (acb) acb.onclick = function () {
      if (!link.activity) link.activity = { now: '', at: 0, items: [] };
      var keep = (link.activity.items || []).filter(function (x) { return x.plat === 'qq'; });
      link.activity = { now: '', at: 0, items: keep };
      saveLink();
      renderActivity();
      renderQqActivity();
      toast('B 站的行为记录清空了');
    };
    var bfc = $('#biliFeedClear');
    if (bfc) bfc.onclick = function () {
      if (!link.feed || !link.feed.length) { toast('还没有记录', 'warm'); return; }
      link.feed = [];
      saveLink();
      renderBiliFeed();
      toast('清空了');
    };
    var clr = $('#qqClear');
    if (clr) clr.onclick = function () {
      confirmBox('清空 QQ 消息记录？', '只清心枕这边的记录，QQ 里的消息不动。', '清空', true).then(function (ok) {
        if (!ok) return;
        qq.sessions = [];
        saveQq();
        renderQqSessions();
        toast('清空了');
      });
    };
    renderQqStatus();
    renderQqSessions();
    renderNapcat();
  }

  function renderQq() {
    if (!$('#qqApi')) return;
    qSetVal('#qqApi', qq.apiBase);
    qSetVal('#qqWs', qq.wsUrl);
    qSetVal('#qqToken', qq.token);
    qSetVal('#qqCooldown', qq.cooldownSec);
    qSetVal('#qqChars', qq.maxChars);
    qSetVal('#qqSplitMin', qq.splitMin);
    qSetVal('#qqSplitMax', qq.splitMax);
    qSetVal('#qqSplitGap', qq.splitGap);
        qSetVal('#qqFirstWait', qq.firstWait);
    qSetVal('#qqSplitWhite', qq.splitWhiteOnly);
    qSetVal('#qqProOn', qq.proactive.on);
    qSetVal('#qqProTargets', qq.proactive.targets);
    qSetVal('#qqProIdle', qq.proactive.idleHours);
    qSetVal('#qqProGap', qq.proactive.gapMin);
    qSetVal('#qqProDaily', qq.proactive.dailyMax);
    qSetVal('#qqProQuietFrom', qq.proactive.quietFrom);
    qSetVal('#qqProQuietTo', qq.proactive.quietTo);
    qSetVal('#qqProHint', qq.proactive.hint);
    var _pst = $('#qqProState');
    if (_pst) _pst.textContent = qqProStateText();
    qSetVal('#qqSeeImg', qq.seeImages);
    qSetVal('#qqCatchUp', qq.catchUp);
    qSetVal('#qqCollect', qq.collectStickers);
    var nb = $('#napcatBox');
    if (nb) nb.hidden = qqWebMode();
    qSetVal('#qqWhite', qq.autoReply.white);
    qSetVal('#qqNone', qq.autoReply.none);
    qSetVal('#qqBlack', qq.autoReply.black);
    qSetVal('#qqGroupAt', qq.groupAt);
    renderQqStatus();
    renderQqSessions();
  }

  function qSetVal(sel, v) {
    var el = $(sel);
    if (!el || document.activeElement === el) return;
    if (el.type === 'checkbox') el.checked = !!v;
    else if (String(el.value) !== String(v)) el.value = v;
  }

  /* ---------------------------------------------------------------- 导航 */
  var PAGE_META = {
    persona:  { title: '人设',  sub: '把她写成你想要的样子', actions: function () { return ''; } },
    chat:     { title: '对话',  sub: '想说什么就说什么', actions: function () {
      return '<button class="btn btn-sm btn-danger" id="actClearChat">清空对话</button>';
    } },
    link:     { title: '外接',  sub: '让她替你刷 B 站 / QQ', actions: function () {
      if (linkSub === 'qq') {
        var on = !!(qqReady() && qq.me && qq.me.uid);
        return '<span class="badge' + (on ? '' : ' badge-quiet') + '" id="qqBadge">' +
          (on ? ('QQ ' + qq.me.uid) : 'QQ 未连接') + '</span>';
      }
      return '<span class="badge' + (linkDesktop() ? '' : ' badge-quiet') + '" id="linkBadge">桌面版可用</span>' +
        '<span class="link-top-meta" id="linkMeta">' + (link.lastRunAt ? ('上次 ' + timeText(link.lastRunAt)) : '还没跑过') + '</span>' +
        '<button class="btn btn-sm btn-primary" id="linkRun" type="button">' +
        '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-tv"/></svg>现在刷一轮</button>' +
        '<button class="btn btn-sm btn-danger" id="linkStop" type="button" hidden>停一下</button>' +
        '<button class="btn btn-sm btn-ghost" id="linkHow" type="button">它是怎么跑的</button>';
    } },
    roster:   { title: '名单',  sub: '她认识谁，怎么对待他们（B 站 / QQ）', actions: function () { return ''; } },
    settings: { title: '设置',  sub: '接口、记忆、外观与数据', actions: function () {
      return '<button class="btn btn-sm" id="actExport"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-download"/></svg>导出数据</button>';
    } },
    about:    { title: '关于',  sub: '心枕是什么，以及它把你的东西放在了哪', actions: function () { return ''; } }
  };

  function applyStageActions(page) {
    var meta = PAGE_META[page] || PAGE_META.persona;
    var acts = $('#stageActions');
    if (!acts) return;
    acts.innerHTML = meta.actions();
    if (page === 'link') {
      /* 头部按钮（刷一轮/停止）两栏都在，必须都绑上，否则在 QQ 栏时这个按钮是死的 */
      bindLinkActions();
      renderLinkRunState();
      renderLinkBadge();
      if (linkSub === 'qq') renderQqStatus();
    }
  }

  function bindLinkTabs() {
    var bar = $('#linkTabs');
    if (!bar) return;
    $$('.subtab', bar).forEach(function (b) {
      b.onclick = function () {
        linkSub = b.dataset.linksub || 'bili';
        $$('.subtab', bar).forEach(function (x) { x.classList.toggle('is-active', x === b); });
        $$('[data-linkpane]').forEach(function (p) {
          p.classList.toggle('is-active', p.dataset.linkpane === linkSub);
        });
        applyStageActions('link');
        if (linkSub === 'qq') renderQq(); else renderLink();
      };
    });
  }

  function bindRosterTabs() {
    var bar = $('#rosterTabs');
    if (!bar) return;
    $$('.subtab', bar).forEach(function (b) {
      b.onclick = function () {
        rosterSub = b.dataset.rsub || 'bili';
        $$('.subtab', bar).forEach(function (x) { x.classList.toggle('is-active', x === b); });
        $$('[data-rpane]').forEach(function (p) {
          p.classList.toggle('is-active', p.dataset.rpane === rosterSub);
        });
        renderRoster(rosterSub);
      };
    });
  }

  function go(page) {
    if (!PAGE_META[page]) page = 'persona';
    $$('#railNav .rail-item').forEach(function (b) {
      var on = b.dataset.page === page;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $$('.page').forEach(function (p) { p.classList.toggle('is-active', p.dataset.page === page); });
    var meta = PAGE_META[page];
    $('#stageTitle').textContent = meta.title;
    $('#stageSub').textContent = meta.sub;
    applyStageActions(page);
    var ex = $('#actExport'); if (ex) ex.onclick = exportDataChoice;
    var cc = $('#actClearChat'); if (cc) cc.onclick = clearChat;
    $('#stageBody').scrollTop = 0;
    try { localStorage.setItem(G.lastPage, page); } catch (e) { }
    if (page === 'chat') {
      renderChat(true);
      renderVitals();
      setTimeout(function () {
        var i = $('#chatInput');
        if (i && window.innerWidth > 760) i.focus();
      }, 220);
    }
    if (page === 'settings') renderStorage();
    if (page === 'link') { renderLink(); linkRefreshWho(); }
    if (page === 'roster') { renderRoster('bili'); renderRoster('qq'); }
    if (page === 'link') { renderQq(); }
  }

  /* 导出前先选角色 */
async function exportDataChoice() {
  exportFlow();
}

  /* 角色选择浮层，返回选中的 id（取消返回 null） */
  function chooseCharacter(title, note, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var l = $('#layer');
      var rows = characters.map(function (c) {
        var av = (c.id === activeId && assets.avatar)
          ? '<img src="' + assets.avatar + '" alt="">'
          : '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-heart"/></svg>';
        return '<button class="char-row" data-pick="' + c.id + '">' +
          '<span class="char-av">' + av + '</span>' +
          '<span class="char-meta"><b>' + esc(c.name) + '</b>' +
          '<span>' + (c.id === activeId ? '当前角色' : '') + '</span></span>' +
          (opts.markDelete ? '<span class="char-del" data-del="' + c.id + '" title="删除">' +
            '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-trash"/></svg></span>' : '') +
          '</button>';
      }).join('');

      l.innerHTML = '<div class="confirm"><div class="confirm-box char-box" role="dialog" aria-modal="true">' +
        '<h3 class="confirm-title">' + esc(title) + '</h3>' +
        (note ? '<p class="confirm-text">' + esc(note) + '</p>' : '') +
        '<div class="char-list">' + rows + '</div>' +
        '<div class="confirm-acts"><button class="btn" data-cf="0">取消</button></div>' +
        '</div></div>';

      function done(v) { closeLayer(); resolve(v); }
      l.querySelector('[data-cf="0"]').onclick = function () { done(null); };
      l.querySelector('.confirm').onclick = function (e) { if (e.target === this) done(null); };
      $$('.char-row', l).forEach(function (b) {
        b.onclick = function (e) {
          var del = e.target.closest ? e.target.closest('[data-del]') : null;
          if (del) { e.stopPropagation(); done({ del: del.getAttribute('data-del') }); return; }
          done(b.getAttribute('data-pick'));
        };
      });
      document.addEventListener('keydown', layerEsc);
    });
  }

  async function clearChat() {
    if (!chat.messages.length) { toast('本来就是空的', 'warm'); return; }
    if (await confirmBox('清空对话记录？', '你们的聊天会被删掉，人设和记忆不受影响。', '清空', true)) {
      chat.messages = [];
      saveChat(); renderChat(); renderStorage();
      toast('清空了，重新开始');
    }
  }

  /* ------------------------------------------------------------ 事件绑定 */
  function bindRail() {
    $$('#railNav .rail-item').forEach(function (b) {
      b.onclick = function () { go(b.dataset.page); };
    });
  }

  /* 文档页：目录点击滚动 + 当前章节高亮 */
  function bindDocs() {
    var body = $('#stageBody');
    var toc = $('#docsToc');
    var art = $('#docsBody');
    if (!toc || !art || !body) return;
    var links = $$('a', toc);
    links.forEach(function (a2) {
      a2.addEventListener('click', function (e) {
        e.preventDefault();
        var id = String(a2.getAttribute('href') || '').replace('#', '');
        var target = document.getElementById(id);
        if (!target) return;
        var top = target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 12;
        body.scrollTo({ top: top, behavior: 'smooth' });
        links.forEach(function (x) { x.classList.toggle('is-active', x === a2); });
      });
    });
    if (!body.__docsSpy) {
      body.__docsSpy = true;
      body.addEventListener('scroll', function () {
        if (!document.querySelector('[data-page="about"].is-active') && !$('[data-page="about"].is-active')) return;
        var base = body.getBoundingClientRect().top;
        var cur = null;
        links.forEach(function (a2) {
          var id = String(a2.getAttribute('href') || '').replace('#', '');
          var el = document.getElementById(id);
          if (!el) return;
          if (el.getBoundingClientRect().top - base <= 80) cur = a2;
        });
        if (cur) links.forEach(function (x) { x.classList.toggle('is-active', x === cur); });
      }, { passive: true });
    }
  }

  function bindPersonaTabs() {
    $$('#personaTabs .subtab').forEach(function (b) {
      b.onclick = function () {
        $$('#personaTabs .subtab').forEach(function (x) { x.classList.toggle('is-active', x === b); });
        $$('.subpane').forEach(function (p) { p.classList.toggle('is-active', p.dataset.subpane === b.dataset.subtab); });
        if (b.dataset.subtab === 'plan') renderPlans();
        if (b.dataset.subtab === 'diary') renderDiary();
      };
    });
    /* 子页签吸顶：滚动时加一层阴影，和内容分开 */
    var body = $('#stageBody');
    var bar = $('.subtabs-bar');
    if (body && bar) {
      body.addEventListener('scroll', function () {
        var stuck = bar.getBoundingClientRect().top <= body.getBoundingClientRect().top + 1;
        bar.classList.toggle('is-stuck', stuck);
      }, { passive: true });
    }
  }

  function bindPersonaForm() {
    var bind = function (sel, fn) { var e = $(sel); if (e) e.addEventListener('input', fn); };
    bind('#pName', function (e) {
      persona.name = e.target.value;
      savePersona();
      renderPersonaPreview();
      touchCharacter(activeId, persona.name || '未命名');
      saveRoster();
      renderCharButton();
    });
    bind('#pCall', function (e) { persona.call = e.target.value; savePersona(); });
    bind('#pIdentity', function (e) { persona.identity = e.target.value; savePersona(); renderPersonaPreview(); });
    bind('#pPersona', function (e) { persona.text = e.target.value; savePersona(); });
    bind('#pCatch', function (e) { persona.catchphrase = e.target.value; savePersona(); });
    bind('#pGreeting', function (e) { persona.greeting = e.target.value; savePersona(); renderPersonaPreview(); });
    bind('#pExtraSystem', function (e) { settings.extraSystem = e.target.value; saveSettings(); });

    /* 「我」那一栏 */
    bind('#meName', function (e) {
      me.name = e.target.value;
      saveMe(); renderMe(); renderChat();
    });
    bind('#meText', function (e) { me.text = e.target.value; saveMe(); });

    var mad = $('#meAvatarDrop');
    if (mad) {
      mad.onclick = function () { pickMeAvatar(); };
      mad.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickMeAvatar(); } };
      bindDrop(mad, function (files) { setMeAvatar(files[0]); });
    }
    [['#sTemper', 'temper'], ['#sTalky', 'talky'], ['#sActive', 'active'], ['#sSweet', 'sweet']].forEach(function (p) {
      bind(p[0], function (e) { persona[p[1]] = Number(e.target.value); savePersona(); });
    });

    var tagInput = $('#pTagInput');
    if (tagInput) {
      tagInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
          e.preventDefault();
          var v = tagInput.value.trim();
          if (!v) return;
          if (persona.tags.length >= 12) { toast('最多 12 个标签', 'warm'); return; }
          if (persona.tags.indexOf(v) < 0) persona.tags.push(v);
          tagInput.value = '';
          renderTags(); savePersona();
        } else if (e.key === 'Backspace' && !tagInput.value && persona.tags.length) {
          persona.tags.pop(); renderTags(); savePersona();
        }
      });
    }

    var pd = $('#portraitDrop');
    if (pd) {
      pd.onclick = function (e) { if (!e.target.closest('.drop-tools')) pickPortrait(); };
      pd.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickPortrait(); } };
      bindDrop(pd, function (files) { setPortrait(files[0]); });
    }
    var ad = $('#avatarDrop');
    if (ad) {
      ad.onclick = function () { pickAvatar(); };
      ad.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickAvatar(); } };
      bindDrop(ad, function (files) { setAvatar(files[0]); });
    }
  }

  function bindDrop(node, cb) {
    ['dragenter', 'dragover'].forEach(function (ev) {
      node.addEventListener(ev, function (e) { e.preventDefault(); node.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      node.addEventListener(ev, function (e) { e.preventDefault(); node.classList.remove('is-over'); });
    });
    node.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length && /^image\//.test(files[0].type)) cb([files[0]]);
      else toast('这里只能放图片', 'warm');
    });
  }

  function pickPortrait() {
    pickFiles('image/*', false, function (files) { if (files[0]) setPortrait(files[0]); });
  }
  function pickAvatar() {
    pickFiles('image/*', false, function (files) { if (files[0]) setAvatar(files[0]); });
  }
  function pickMeAvatar() {
    pickFiles('image/*', false, function (files) { if (files[0]) setMeAvatar(files[0]); });
  }
  async function setMeAvatar(f) {
    if (!f) return;
    try {
      var bb = imgBudget();
      me.avatar = await compressImage(f, bb.avatar, bb.avatarQ);
      saveMe(); renderMe(); renderChat();
      toast('头像换好了');
    } catch (e) { toast('这张图处理不了：' + (e.message || e), 'warm'); }
  }
  async function setPortrait(f) {
    if (!f) return;
    try {
      var b = imgBudget();
      assets.portrait = await compressImage(f, b.portrait, b.portraitQ);
      saveAssets(); renderPortrait();
      toast('立绘换好了');
    } catch (e) { toast('这张图处理不了：' + (e.message || e), 'warm'); }
  }
  async function setAvatar(f) {
    if (!f) return;
    try {
      var b = imgBudget();
      assets.avatar = await compressImage(f, b.avatar, b.avatarQ);
      saveAssets(); renderAvatar(); renderChat(); renderCharButton();
      toast('头像换好了');
    } catch (e) { toast('这张图处理不了：' + (e.message || e), 'warm'); }
  }

  function bindChat() {
    var input = $('#chatInput');
    var box = $('#composerBox');
    if (input) {
      input.addEventListener('input', function () { autoGrow(input); });
      input.addEventListener('focus', function () { if (box) box.classList.add('is-focus'); });
      input.addEventListener('blur', function () { if (box) box.classList.remove('is-focus'); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && settings.enterSend) {
          e.preventDefault();
          sendCurrent(false);
        }
      });
      input.addEventListener('paste', function (e) {
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        var imgs = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
            var f = items[i].getAsFile();
            if (f) imgs.push(f);
          }
        }
        if (imgs.length) { e.preventDefault(); addFiles(imgs, 'image'); }
      });
    }
    var send = $('#btnSend');
    if (send) send.onclick = function () { sendCurrent(false); };
    var sendOnly = $('#btnSendAttsOnly');
    if (sendOnly) sendOnly.onclick = function () { sendCurrent(true); };
    var ai = $('#btnAttachImg');
    if (ai) ai.onclick = function () { pickFiles('image/*', true, function (f) { addFiles(f, 'image'); }); };
    var af = $('#btnAttachFile');
    if (af) af.onclick = function () { pickFiles('', true, function (f) { addFiles(f, 'file'); }); };
    var bs = $('#btnSticker');
    if (bs) bs.onclick = function (e) {
      e.stopPropagation();
      var p = $('#stickerPop');
      if (p && !p.hidden) closeStickerPop(); else openStickerPop();
    };
    document.addEventListener('click', function (e) {
      var p = $('#stickerPop');
      if (p && !p.hidden && !e.target.closest('#stickerPop') && !e.target.closest('#btnSticker')) closeStickerPop();
    });

    var list = $('#chatList');
    if (list) {
      list.addEventListener('click', async function (e) {
        var act = e.target.closest('[data-mact]');
        if (act) {
          var node = act.closest('.msg');
          var id = node && node.dataset.id;
          var m = chat.messages.find(function (x) { return x.id === id; });
          if (!m) return;
          var kind = act.dataset.mact;
          if (kind === 'copy') {
            var s = stickerById(m.sticker);
            var txt = s ? '（表情：' + s.name + '）' : (m.text || '');
            try { await navigator.clipboard.writeText(txt); toast('复制好了'); }
            catch (err) { toast('复制失败，手动选一下吧', 'warm'); }
          } else if (kind === 'again') {
            regenerate(id);
          } else if (kind === 'retry') {
            var ei = chat.messages.findIndex(function (x) { return x.id === id; });
            if (ei >= 0) chat.messages.splice(ei, 1);
            saveChat(); renderChat(true);
            runAssistant();
          } else if (kind === 'del') {
            if (await confirmBox('删掉这条消息？', (m.text || '').slice(0, 60) || '（表情）', '删掉', true)) {
              var i = chat.messages.findIndex(function (x) { return x.id === id; });
              if (i >= 0) chat.messages.splice(i, 1);
              saveChat(); renderChat(true);
            }
          }
          return;
        }
        var cact = e.target.closest('[data-cact]');
        if (cact) {
          if (cact.dataset.cact === 'greet') {
            if (persona.greeting) {
              chat.messages.push({ id: uid(), role: 'assistant', text: persona.greeting, ts: Date.now() });
              saveChat(); renderChat(true);
            }
          } else if (cact.dataset.cact === 'to-persona') {
            go('persona');
            var t = $('#personaTabs .subtab[data-subtab="profile"]');
            if (t) t.click();
          }
        }
      });
    }

    var scroll = $('#chatScroll');
    if (scroll) {
      scroll.addEventListener('scroll', function () { syncToBottom(); });
    }
    var tb = $('#toBottom');
    if (tb) tb.onclick = function () { scrollToBottom(true); };
  }

  function syncToBottom() {
    var btn = $('#toBottom');
    if (!btn) return;
    var s = $('#chatScroll');
    if (!s) return;
    btn.hidden = nearBottom() || s.scrollHeight <= s.clientHeight + 40;
  }
  function bindSettings() {
    var bindVal = function (sel, key, transform) {
      var e = $(sel); if (!e) return;
      e.addEventListener('input', function () {
        settings[key] = transform ? transform(e) : e.value;
        saveSettings();
      });
    };
    bindVal('#setBaseUrl', 'baseUrl', function (e) { return e.value.trim(); });
    bindVal('#setApiKey', 'apiKey', function (e) { return e.value.trim(); });
    bindVal('#setModel', 'model', function (e) { return e.value.trim(); });
  bindVal('#setCtxLen', 'ctxLen', function (e) { return String(e.value || '').trim(); });
    bindVal('#setTemp', 'temperature', function (e) { return Number(e.value) / 100; });
    bindVal('#stickerChance', 'stickerChance', function (e) { return Number(e.value); });
    var bindNum = function (sel, key, min, max) {
      var e = $(sel); if (!e) return;
      var commit = function () {
        var v = parseInt(e.value, 10);
        if (isNaN(v) || v <= 0) return;
        settings[key] = clamp(v, min, max);
        saveSettings();
      };
      e.addEventListener('input', commit);
      e.addEventListener('change', function () { commit(); e.value = settings[key]; });
    };
    bindNum('#setMaxChars', 'maxChars', 20, 20000);
    bindNum('#setTimeout', 'timeout', 10, 600);
    bindVal('#lightCount', 'lightCount', function (e) { return Number(e.value); });    bindVal('#ctxTurns', 'ctxTurns', function (e) { return Number(e.value); });

    var bindChk = function (sel, key, after) {
      var e = $(sel); if (!e) return;
      e.addEventListener('change', function () { settings[key] = e.checked; saveSettings(); if (after) after(); });
    };
    bindChk('#setStream', 'stream');
    bindChk('#injKey', 'injKey');
    bindChk('#injLight', 'injLight');
    bindChk('#injKeywords', 'injKeywords');
    bindChk('#injStickers', 'injStickers');
    bindChk('#injMemes', 'injMemes');
    bindChk('#injAutoMem', 'injAutoMem');
    bindChk('#setStickerAuto', 'stickerAuto');
    bindChk('#setEnterSend', 'enterSend');
    bindChk('#setTimestamps', 'timestamps', function () { renderChat(); });
    bindChk('#setSplit', 'splitMessages');

    var tk = $('#btnToggleKey');
    if (tk) tk.onclick = function () {
      var i = $('#setApiKey');
      var show = i.type === 'password';
      i.type = show ? 'text' : 'password';
      tk.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    };
    var tm = $('#btnFetchModels'); if (tm) tm.onclick = fetchModels;
    var tt = $('#btnTest'); if (tt) tt.onclick = testConnection;
    var nk = $('#btnNewKeyHint');
    if (nk) nk.onclick = function () {
      var p = currentProvider();
      if (p) showText('去哪拿 API Key', p.name + ' 的 Key 申请地址：\n\n' + p.keyUrl +
        '\n\n拿到之后整串复制（通常以 sk- 开头），粘到上面的 API Key 框里就行。\n\n注意：Key 只保存在你自己的浏览器里，不会发给除接口地址以外的任何地方。');
      else showText('去哪拿 API Key', '你当前填的接口地址不在预设列表里。\n\n一般来说，去你选的服务商后台，找「API Keys / 密钥管理」，新建一个 Key 复制过来即可。\n\n常见服务商：\n· DeepSeek https://platform.deepseek.com/api_keys\n· OpenAI https://platform.openai.com/api-keys\n· 通义千问 https://bailian.console.aliyun.com/\n· Kimi https://platform.moonshot.cn/console/api-keys\n· 智谱 https://open.bigmodel.cn/usercenter/apikeys\n· 本地 Ollama http://localhost:11434/v1（不需要 Key）');
    };
    var pp = $('#btnPreviewPrompt');
    if (pp) pp.onclick = function () { showText('她收到的提示词', buildSystemPrompt()); };

    $$('#themeSeg .seg-btn').forEach(function (b) {
      b.onclick = function () { settings.theme = b.dataset.themeVal; saveSettings(); syncSegs(); applyAppearance(); };
    });
    $$('#fontSeg .seg-btn').forEach(function (b) {
      b.onclick = function () { settings.font = b.dataset.fontVal; saveSettings(); syncSegs(); applyAppearance(); };
    });
    $$('#motionSeg .seg-btn').forEach(function (b) {
      b.onclick = function () { settings.motion = b.dataset.motionVal; saveSettings(); syncSegs(); applyAppearance(); };
    });

  var be = $('#btnExport'); if (be) be.onclick = exportFlow;
    var bi = $('#btnImport'); if (bi) bi.onclick = importData;
  var bw = $('#btnWipe'); if (bw) bw.onclick = wipeCurrent;
  }

  function bindPersonaActions() {
    document.addEventListener('click', async function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.dataset.act;
      if (act === 'pick-portrait') { e.stopPropagation(); pickPortrait(); }
      else if (act === 'clear-portrait') {
        e.stopPropagation();
        if (await confirmBox('移除立绘？', '对话页右边她就不站着了。图片本身还在你电脑上，可以重新传。', '移除')) {
          assets.portrait = ''; saveAssets(); renderPortrait(); toast('立绘已移除');
        }
      }
      else if (act === 'pick-avatar') pickAvatar();
      else if (act === 'clear-avatar') {
        if (await confirmBox('移除头像？', '对话里她会变回默认的小心心。图片还在你电脑上，可以重新传。', '移除')) {
          assets.avatar = ''; saveAssets(); renderAvatar(); renderChat(); renderCharButton(); toast('头像已移除');
        }
      }
      else if (act === 'pick-me-avatar') pickMeAvatar();
      else if (act === 'clear-me-avatar') {
        if (await confirmBox('移除我的头像？', '对话里你会变回默认的「我」字圆点。图片还在你电脑上，可以重新传。', '移除')) {
          me.avatar = ''; saveMe(); renderMe(); renderChat(); toast('头像已移除');
        }
      }
      else if (act === 'mem-add') editMemory(b.dataset.kind, null);
      else if (act === 'kw-add') editKeyword(null);
      else if (act === 'sticker-add' || act === 'sticker-add-2') pickStickers();
      else if (act === 'ai-profile') aiWriteProfile();
      else if (act === 'goto-sticker') {
        closeStickerPop();
        go('persona');
        var t = $('#personaTabs .subtab[data-subtab="sticker"]');
        if (t) t.click();
      }
      else if (act === 'preset-menu') {
        var box = $('#profilePresets');
        if (!box) return;
        if (!box.children.length) {
          PRESET_PERSONAS.forEach(function (p, i) {
            var btn = document.createElement('button');
            btn.className = 'preset';
            btn.textContent = p.label;
            btn.onclick = function () { applyPreset(i); };
            box.appendChild(btn);
          });
        }
        box.hidden = !box.hidden;
        if (!box.hidden) box.style.marginTop = '14px';
      }
    });
  }

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      var map = { '1': 'chat', '2': 'persona', '3': 'link', '4': 'roster', '5': 'settings', '6': 'about' };
      if (map[e.key]) { e.preventDefault(); go(map[e.key]); }
      else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault(); go('chat');
        var i = $('#chatInput'); if (i) i.focus();
      }
    });
  }

  /* ------------------------------------------------------------------ 启动 */

  /* 界面还没出来之前先按上次的主题上色，开屏才不会串色 */
  function applyThemeEarly() {
    var t = '';
    try { t = JSON.parse(lsGet(G.theme) || '""'); } catch (e) { }
    if (t === 'auto') t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'night' : 'light';
    document.documentElement.setAttribute('data-theme', t === 'night' ? 'night' : 'light');
    var f = '';
    try { f = JSON.parse(lsGet('xinzhen.v1.font') || '""'); } catch (e) { }
    document.documentElement.setAttribute('data-fontsize', f === 'small' ? 'small' : f === 'large' ? 'large' : 'normal');
  }

  /* 兜底：整个应用是定高布局，窗口不该滚。某些浏览器点开关时会把整页顶上去，
     这里强行把窗口滚动拉回 0（真正的滚动都发生在 .stage-body 里） */
  window.addEventListener('scroll', function () {
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  }, { passive: true });

  window.addEventListener('error', function (e) {
    qq.lastErr = (e && e.message ? e.message : 'error') + ' @' + (e && e.filename ? String(e.filename).slice(-40) : '');
    qqDiag('error');
  });
  /* 兜底：把错误也写进 QQ 面板的调试字段 */
  async function boot() {
    await Store.init();
    await migrateToCharacters();
    await loadAll();
    applyAppearance();
    initSliders();
    fillPersonaForm();
    fillSettingsForm();
    applyUrlPreset();
    refreshSliders();
    renderMemory();
    renderStickers();
    renderMe();
    renderChangelog();
    renderAtts();
    renderStorage();
    renderCharButton();
    bindRail();
    bindPersonaTabs();
    bindPersonaForm();
    bindSpeech();
    bindCharSwitcher();
    bindChat();
    bindSettings();
    bindPersonaActions();
    bindLink();
    bindRoster('bili');
    bindRoster('qq');
    bindLinkTabs();
    bindRosterTabs();
    bindQq();
    bindDocs();
    startClock();
    renderQqActivity();
    qqPullBridge(false).catch(function () { });
    setTimeout(function () { qqBridgeStatus(); qqLoginHealth(); qqLeaseStart(); qqSyncBridge(true); }, 1200);
    setTimeout(function () { memoryCompactLight().catch(function () { }); }, 4000);
    setTimeout(function () { diaryAuto().catch(function () { }); memeAutoLearn().catch(function () { }); }, 12000);
    if (!XZ_SMOKE && !planTickTimer) planTickTimer = setInterval(function () { planDueTick().catch(function () { }); }, 30000);
    /* 家里的事：每 5 分钟看一眼——日记、梗、轻度记忆合并 */
    if (!XZ_SMOKE && !window.__houseKeeping) {
      window.__houseKeeping = setInterval(function () {
        diaryAuto().catch(function () { });
        memeAutoLearn().catch(function () { });
        memoryCompactLight().catch(function () { });
      }, 300000);
    }
    setTimeout(function () {
      var last = (chat.messages || []).filter(function (m) { return m.role === 'user' || m.role === 'assistant'; }).slice(-1)[0];
      var le = memory.lastExtract || {};
      if (last && Number(last.ts) > Number(le.at || 0) && (chat.messages || []).length >= 4) {
        memoryAutoExtract(true).catch(function () { });
      }
    }, 6000);
    var _memNow = $('#memAutoNow');
    if (_memNow) _memNow.onclick = async function () {
      _memNow.disabled = true;
      var old = _memNow.textContent;
      _memNow.textContent = '整理中…';
      try {
        var n = await memoryAutoExtract(true);
        toast(n ? ('记下了 ' + n + ' 条') : '这段没什么值得记的', n ? 'done' : 'warm');
      } catch (e) {
        toast('整理失败：' + (e.message || e), 'warm');
      } finally {
        _memNow.disabled = false;
        _memNow.textContent = old;
      }
    };
    /* 以前只有手动点「测试连接」才会连 WS；现在有令牌就自动连上 */
    setTimeout(function () {
      if (!qqReady()) return;
      if (!qqWsUrl()) return;
      if (!qqBridge() && !qq.token) { renderQqStatus(); return; }
      if (!qq.status) qqConnect();
    }, 900);
    bindMemes();
    bindDm();
    renderActivity();
    dmStartPolling();
    bindKeys();

    var rf = $('#railFoot');
    if (rf) rf.textContent = 'v' + VERSION;
    var fh = $('#fileHint');
    if (fh && location.protocol === 'file:') fh.hidden = false;
    $('#app').dataset.busy = '0';

    renderVitals();
    if (Math.abs((Number(vitals.bpm) || REST_BPM) - REST_BPM) > 1 || vitals.mood !== '平静') startVitalsDrift();

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onMq = function () { if (settings.theme === 'auto') applyAppearance(); };
      if (mq.addEventListener) mq.addEventListener('change', onMq);
      else if (mq.addListener) mq.addListener(onMq);
    }

    var last = 'persona';
    try { last = localStorage.getItem(G.lastPage) || 'persona'; } catch (e) { }
    go(last);

    /* 开屏：图标落位 → 名字浮起 → 水波扫过，约 1.6 秒后淡出；点一下可以跳过 */
    var bootEl = $('#booting');
    if (bootEl) {
      bootEl.onclick = hideBoot;
      var leave = function (e) { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') hideBoot(); };
      document.addEventListener('keydown', leave);
      var reduce = (settings.motion === 'off') ||
        (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      setTimeout(hideBoot, reduce ? 260 : 1650);
    }

    window.addEventListener('beforeunload', flushSaves);
    window.addEventListener('pagehide', flushSaves);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushSaves();
    });

    /* 外接：谷时自动刷的定时器（每分钟看一眼，跑不跑由当天状态决定） */
    linkStartTicker();

    /* 后台试着升级到大容量存储；成了就把现有数据整体搬过去。
       上次在 file:// 下已经失败过就不再白试一次（浏览器不给 file:// 用数据库）。 */
    var skipProbe = (lsGet(MODE_KEY) === JSON.stringify('ls')) && location.protocol === 'file:';
    if (Store.mode === 'idb') {
      Store.refreshQuota();
    } else if (!skipProbe) {
      Store.upgrade().then(function (ok) {
        if (!ok) { renderStorage(); return; }
        toast('已改用浏览器数据库存储，容量不再受 5MB 限制');
        renderStorage();
      });
    } else {
      renderStorage();
    }
  }

  function flushSaves() {
    saveSettings.flush(); savePersona.flush(); saveMe.flush(); saveAssets.flush();
    saveMemory.flush(); saveChat.flush(); saveVitals.flush(); saveLink.flush();
    savePeople.flush(); saveMemes.flush(); saveQq.flush();
  }

  /* 调试入口：浏览器控制台里可以直接用，自动化测试也靠它 */
  window.__xinzhen = {
    version: VERSION,
    get settings() { return settings; },
    get persona() { return persona; },
    get memory() { return memory; },
    get assets() { return assets; },
    get chat() { return chat; },
    get vitals() { return vitals; },
    get me() { return me; },
    get characters() { return characters; },
    get activeId() { return activeId; },
    switchCharacter: switchCharacter,
    createCharacter: createCharacter,
    deleteCharacter: deleteCharacter,
    exportFlow: exportFlow,
    buildPack: function (s) { return buildPack(s); },
    packToMarkdown: function (p) { return packToMarkdown(p); },
    parsePackText: function (t) { return parsePackText(t); },
    importPack: function (p, m) { return importPack(p, m); },
    basePersona: function () { return JSON.parse(JSON.stringify(BASE_PERSONA)); },
    importData: importData,
    wipeCurrent: wipeCurrent,
    guessEmotion: guessEmotion,
    segmentReply: segmentReply,
    get storeMode() { return Store.mode; },
    get storeNote() { return Store.note; },
    store: Store,
    get link() { return link; },
    get roster() { return roster; },
    get memes() { return memes; },
    renderLink: renderLink,
    renderRoster: renderRoster,
    renderMemes: renderMemes,
    renderDmCard: renderDmCard,
    dmSync: dmSync,
    linkNextRunAt: linkNextRunAt,
    qqOnMessage: qqOnMessage,
    qqTest: qqTest,
    get qq() { return qq; },
    get qqSocket() { return qqWs; },
    qqCatchUp: function () { return qqCatchUp(); },
    qqProTick: function (f) { return qqProTick(f); },
    linkFeedPush: function (k, t, m) { linkFeedPush(k, t, m); },
    qqEnsureConnected: function (s) { return qqEnsureConnected(s); },
    qqPullBridge: function (m) { return qqPullBridge(m); },
    qqSyncBridge: function (f) { return qqSyncBridge(f); },
    get plans() { return plans; },
    applyOps: function (ops) { return applyMemoryOps(ops); },
    qqMfacesOf: function (ev) { return qqMfacesOf(ev); },
    qqImagesOf: function (ev) { return qqImagesOf(ev); },
    parseDirectives: function (t) { return parseDirectives(t); },
    memoryCompactLight: function (f) { return memoryCompactLight(f); },
    parseCtxTokens: function (s2) { return parseCtxTokens(s2); },
    renderPlans: function () { renderPlans(); },
    renderDiary: function () { renderDiary(); },
    diaryWrite: function (d, f) { return diaryWrite(d, f); },
    diaryAuto: function () { return diaryAuto(); },
    memeLearn: function (s) { return memeLearn(s); },
    get diary() { return diary; },
    get memes() { return memes; },
    planDueTick: function () { return planDueTick(); },
    planDueTs: function (d) { return planDueTs(d); },
    chatCompletion: function (msgs, opt) { return chatCompletion(msgs, opt); },
    isAnthropic: function () { return isAnthropic(); },
    qqBridgePayload: function () { return qqBridgePayload(); },
    qqBridgeStatus: function () { return qqBridgeStatus(); },
    qqLoginHealth: function () { return qqLoginHealth(); },
    qqConnect: function () { qqConnect(); },
    qqSnapshot: function () {
      return { status: qq.status, retrying: !!qq.retrying, me: qq.me || null, tracked: Object.keys(qq.tracked || {}).length };
    },
    dmOpen: dmOpen,
    dmSessions: function () { return dmSessionsCache.slice(); },
    rosterLookup: rosterLookup,
    linkRun: linkRunNow,
    linkBusy: function () { return linkBusy; },
    linkReports: function () { return link.reports.slice(); },
    get pendingAtts() { return pendingAtts; },
    renderAtts: renderAtts,
    sendCurrent: sendCurrent,
    MAX_PARTS: MAX_PARTS,
    feelEmotion: feelEmotion,
    nudgeVitals: nudgeVitals,
    parseDirectives: parseDirectives,
    stripDirectives: stripDirectives,
    stripReasoning: stripReasoning,
    segmentReply: segmentReply,
    tidyText: tidyText,
    applyMemoryOps: applyMemoryOps,
    buildSystemPrompt: buildSystemPrompt,
    maybePickSticker: maybePickSticker,
    clampChars: clampChars,
    readChatBody: readChatBody,
    save: function () {
      save(K.settings, settings); save(K.persona, persona);
      save(K.assets, assets); save(K.memory, memory);
      save(K.chat, chat); save(K.vitals, vitals); save(K.link, link);
    },
    render: function () {
      renderMemory(); renderStickers(); renderPersonaPreview();
      renderChat(true); renderStorage();
    }
  };

  function start() {
    applyThemeEarly();
    boot().catch(function (e) {
      console.error('[心枕] 启动失败', e);
      var b = document.getElementById('booting');
      if (b) b.classList.add('is-done');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
