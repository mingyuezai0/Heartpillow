/* 1.0.4 验证：上下文不重复、测试连接不重发、主人会话不进最近的消息、B站评论 */
const { spawn } = require('child_process');
const http = require('http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9391;
const KEY = 'rfB2pmlH3xPvyhQeWTiy6QGHp2aKm2r';
const URL_ = 'http://8.156.81.219:7863/?api=' + encodeURIComponent('http://8.156.81.219:7863/v1') +
  '&key=' + encodeURIComponent(KEY) + '&model=' + encodeURIComponent('cn:glm-5.3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
(async () => {
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + process.env.TEMP + '/edge-104-' + Date.now(), '--remote-debugging-port=' + PORT,
    '--window-size=1400,940', URL_], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const l = await getJSON('/json'); target = l.find((t) => t.type === 'page' && t.url.includes('8.156.81.219')); if (target) break; } catch (e) {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  await new Promise((r) => (ws.onopen = r));
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return 'EXC ' + ((r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : 'NOVAL';
  };
  await sleep(4500);
  await ev('window.__errs = []; window.addEventListener("error", function(e){ window.__errs.push(String(e.message)); }); 1');

  // 1) 主人连发两条 → 上下文里不该重复，最近的消息里不该有她的回复
  console.log('主人会话 =>', await ev([
    '(async function(){',
    '  var q = window.__xinzhen.qq; q.token="T"; q.apiBase="/qq/api"; q.status="ok"; q.firstWait=1; q.cooldownSec=0; q.splitMin=1; q.splitMax=2;',
    '  window.__xinzhen.roster.qq.master = { uid: 2672275509, uname: "小鱼干干干", face: "", nickname: "" };',
    '  window.__cap = { sends: 0, prompts: [] };',
    '  var orig = window.fetch;',
    '  window.fetch = function(u, o){ var url = String(u);',
    '    if (url.indexOf("send_") >= 0) { window.__cap.sends++; return Promise.resolve(new Response("{\\"status\\":\\"ok\\"}", {status:200})); }',
    '    if (url.indexOf("/v1/chat/completions") >= 0) {',
    '      try { var b = JSON.parse(o.body); var um = (b.messages||[]).filter(function(m){return m.role==="user";}).slice(-1)[0];',
    '        if (um && String(um.content).indexOf("回他一句") >= 0) window.__cap.prompts.push(String(um.content)); } catch(e){}',
    '      return Promise.resolve(new Response(JSON.stringify({choices:[{message:{content:"嗯嗯\\n知道啦"}}]}), {status:200, headers:{"Content-Type":"application/json"}}));',
    '    }',
    '    if (url.indexOf("/qq/bridge/") >= 0) return Promise.resolve(new Response("{\\"items\\":[]}", {status:200}));',
    '    return orig.apply(window, arguments); };',
    '  var base = { post_type:"message", message_type:"private", sub_type:"friend", self_id:2821744520, user_id:2672275509,',
    '    sender:{user_id:2672275509, nickname:"小鱼干干干", card:""} };',
    '  await window.__xinzhen.qqOnMessage(Object.assign({}, base, {time:Math.floor(Date.now()/1000), message_id:551001, raw_message:"在吗", message:[{type:"text",data:{text:"在吗"}}]}));',
    '  await new Promise(function(r){setTimeout(r,900);});',
    '  await window.__xinzhen.qqOnMessage(Object.assign({}, base, {time:Math.floor(Date.now()/1000), message_id:551002, raw_message:"今天几号", message:[{type:"text",data:{text:"今天几号"}}]}));',
    '  for (var k=0;k<40;k++){ await new Promise(function(r){setTimeout(r,500);}); if (window.__cap.sends>0) break; }',
    '  await new Promise(function(r){setTimeout(r,1500);});',
    '  var sess = (window.__xinzhen.qq.sessions||[]).filter(function(x){return x.uid===2672275509;});',
    '  var lastPrompt = window.__cap.prompts.slice(-1)[0] || "";',
    '  var ctxPart = lastPrompt.split("回他一句")[0];',
    '  var dupCount = (ctxPart.match(/对方：/g)||[]).length;',
    '  var twice = ctxPart.indexOf("今天几号") >= 0 ? (ctxPart.split("今天几号").length - 1) : -1;',
    '  return JSON.stringify({ sends: window.__cap.sends, 会话条数: sess.length, 上下文里对方行数: dupCount, 当前这句出现次数: twice,',
    '    chatLen: window.__xinzhen.chat.messages.length, 最近消息里她的发言: sess.length? sess[0].thread.filter(function(m){return m.mine;}).length : 0,',
    '    chat: window.__xinzhen.chat.messages.map(function(m){return m.role+":"+String(m.text).slice(0,10);}),',
    '    prompt: ctxPart.slice(0,120), thread: sess.length? sess[0].thread.slice(-12).map(function(m){return (m.mine?"她:":"他:")+String(m.text).slice(0,12);}) : [] });',
    '})()'
  ].join('\n')));

  // 2) 测试连接不动全局限流设置（回归：不再重发）
  console.log('测试连接 =>', await ev([
    '(async function(){',
    '  document.querySelector("#railNav [data-page=\\"settings\\"]").click();',
    '  var before = window.__xinzhen.settings.stream;',
    '  var btn = document.querySelector("#btnTest");',
    '  btn.click();',
    '  await new Promise(function(r){setTimeout(r,400);});',
    '  var during = window.__xinzhen.settings.stream;',
    '  for (var k=0;k<40;k++){ await new Promise(function(r){setTimeout(r,400);}); var o=document.querySelector("#testOut"); if(o && /通了|失败|不是|接口/.test(o.textContent)) break; }',
    '  return JSON.stringify({ streamBefore: before, streamDuring: during, streamAfter: window.__xinzhen.settings.stream, out: (document.querySelector("#testOut")||{}).textContent.slice(0,40) });',
    '})()'
  ].join('\n')));

  // 3) B 站聚合：没登录也有评论
  console.log('B站详情 =>', await ev([
    '(async function(){',
    '  var r = await fetch("/bili/video", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({bvid:"BV1GJ411x7h7"})});',
    '  var d = await r.json();',
    '  return JSON.stringify({ ok: d.ok, 评论数: (d.comments||[]).length, 首条: ((d.comments||[])[0]||{}).text ? d.comments[0].text.slice(0,30) : "-", desc: (d.desc||"").slice(0,20) });',
    '})()'
  ].join('\n')));

  console.log('错误 =>', await ev('JSON.stringify((window.__errs||[]).slice(0,3))'));
  ws.close(); child.kill(); process.exit(0);
})();
