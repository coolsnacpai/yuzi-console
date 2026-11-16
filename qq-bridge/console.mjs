// 玉子控制台 · 后端（P0）
// 零第三方依赖。监听 127.0.0.1:3210，只服务本机。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { backup, restore, listBackups } from './backup.mjs';
import { memoryStats, exportMemory, importMemory, parseMemoryPack, exportPersona, parsePersonaPack, importPersona, readStyle, writeStyle, styleBlock, aiStyle, STYLE_DEFAULTS, readPersona, exportMemoryDoc, importDocMemory, exportPersonaDoc, looksLikePack, personaTextFromDoc } from './packs.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.CONSOLE_PORT || 3210);
const NAPCAT_DIR = 'D:\\NapCat\\NapCat.52230.Shell';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_PROFILE = path.join(DATA, 'edge-profile');
const DSH_EXE = 'D:\\DeepSeek Harness\\DeepSeek Harness.exe';
const WAYU = path.join(DATA, 'console.log');

// ---------- 环境 ----------
function loadEnv() {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}
const CFG = loadEnv();
const OWNER = CFG.OWNER_QQ || '';

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`;
  try { fs.appendFileSync(WAYU, line + '\r\n'); } catch {}
}

// ---------- 基础工具 ----------
function tcpProbe(port, timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

function runHidden(file, args, cwd) {
  const p = spawn(file, args, { cwd: cwd || ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
  return p.pid;
}

function runCmd(cmdline, cwd) {
  const p = spawn('cmd.exe', ['/c', cmdline], { cwd: cwd || ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
  return p.pid;
}

// NapCat 快速登录：账号 + 密码（NapCat 自己算 MD5），避免掉线后只能扫码
function napcatEnv() {
  const acc = CFG.NAPCAT_QUICK_ACCOUNT || CFG.BOT_QQ || '';
  const pwd = CFG.NAPCAT_QUICK_PASSWORD || '';
  const md5 = CFG.NAPCAT_QUICK_PASSWORD_MD5 || '';
  const env = {};
  if (acc) env.NAPCAT_QUICK_ACCOUNT = acc;
  if (pwd) env.NAPCAT_QUICK_PASSWORD = pwd;
  if (md5) env.NAPCAT_QUICK_PASSWORD_MD5 = md5;
  if (acc) env.ACCOUNT = acc;
  return env;
}

// 直接起进程并接管日志文件：不经 cmd，就没有黑窗口，也不依赖 /b 这种「要看父进程有没有控制台」的写法
function runLogged(file, args, logFile, cwd, extraEnv) {
  let fd = -1;
  try {
    fd = fs.openSync(path.join(DATA, logFile), 'a');
    const p = spawn(file, args, {
      cwd: cwd || ROOT, detached: true, windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: extraEnv ? Object.assign({}, process.env, extraEnv) : process.env
    });
    p.unref();
    return p.pid;
  } catch (e) {
    // 日志被旧进程独占时退化成丢弃输出，别让一次启动失败拖垮整个接口
    log(`启动 ${path.basename(file)} 时日志打不开（${e.code || e.message}），改为丢弃输出`);
    const p = spawn(file, args, { cwd: cwd || ROOT, detached: true, windowsHide: true, stdio: 'ignore', env: extraEnv ? Object.assign({}, process.env, extraEnv) : process.env });
    p.unref();
    return p.pid;
  } finally { if (fd >= 0) { try { fs.closeSync(fd); } catch {} } }
}

// 通过临时文件取回 PowerShell 的结构化输出（避免管道，托盘/后台场景都安全）
let tmpSeq = 0;
function psJson(script, timeoutMs = 12000) {
  const tmp = path.join(os.tmpdir(), `yuzu-${process.pid}-${++tmpSeq}.json`);
  const cmd = `$ErrorActionPreference='SilentlyContinue'; ${script} | ConvertTo-Json -Depth 4 -Compress | Set-Content -Encoding UTF8 '${tmp}'`;
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'ignore', windowsHide: true });
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      let v = [];
      try {
        const t = fs.readFileSync(tmp, 'utf8').trim();
        if (t) { const j = JSON.parse(t); v = Array.isArray(j) ? j : [j]; }
      } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => { try { p.kill(); } catch {} finish(); }, timeoutMs);
    p.on('exit', () => { clearTimeout(timer); setTimeout(finish, 30); });
    p.on('error', () => { clearTimeout(timer); finish(); });
  });
}

async function nodeProcs() {
  const rows = await psJson("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine");
  return rows.map((r) => ({ pid: r.ProcessId, cmd: r.CommandLine || '' }));
}

async function qqProcs() {
  const rows = await psJson("Get-Process -Name QQ -ErrorAction SilentlyContinue | Select-Object Id,Path");
  return rows.map((r) => ({ pid: r.Id, path: r.Path || '' }));
}

// tasklist 比 PowerShell / WMI 快一个数量级（约 0.4s vs 2s+），状态刷新这条热路径只用它。
// 注意：WMI 的 Get-CimInstance 在受限令牌下会直接「拒绝访问」，所以这里不走 WMI。
function tasklistRows(image) {
  const out = execFileSync('tasklist', ['/fi', `imagename eq ${image}`, '/fo', 'csv', '/nh'],
    { encoding: 'utf8', timeout: 4000, windowsHide: true });
  return out.split(/\r?\n/).filter((l) => l.trim() && !/^信息|^INFO/i.test(l)).map((l) => {
    const c = l.match(/"([^"]*)","([^"]*)","([^"]*)"/);
    return c ? { name: c[1], pid: Number(c[2]) } : null;
  }).filter(Boolean);
}

async function qqCount() {
  try { return tasklistRows('QQ.exe').length; } catch { return (await qqProcs()).length; }
}

function killPid(pid) {
  try { runCmd(`taskkill /f /pid ${Number(pid)} /t`); } catch {}
}

// 同步跑一条命令并收回输出（走临时文件，管道在这个环境里会被拦）
function runCmdSilent(cmdline, cwd) {
  const tmp = path.join(os.tmpdir(), `yuzu-out-${process.pid}-${Date.now()}.txt`);
  try {
    execFileSync('cmd.exe', ['/c', `${cmdline} > "${tmp}" 2>&1`], { cwd: cwd || ROOT, timeout: 15000, windowsHide: true });
  } catch {}
  let out = '';
  try { out = fs.readFileSync(tmp, 'latin1'); } catch {}
  try { fs.unlinkSync(tmp); } catch {}
  return { out };
}

// 进程详情：名字、PID、启动时间、内存。一次 PowerShell 拿完，避免每个服务各开一遍。
async function procGroups() {
  // node 进程不再靠翻命令行（Get-CimInstance 这台机器上时不时「拒绝访问」返回空），
  // 改成按各自的监听端口反查 PID，稳得多。
  const script = `
$o = @()
foreach ($n in @('NapCatWinBootMain','QQ','msedge','DeepSeek Harness')) {
  $o += Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{ tag=$n; pid=$_.Id; start=$(try { $_.StartTime.ToString('MM-dd HH:mm:ss') } catch { '' }); mem=[int]($_.WorkingSet64/1MB) }
  }
}
foreach ($pair in @(@('bot',3008),@('watch',3009),@('console',3210))) {
  $c = Get-NetTCPConnection -LocalPort $pair[1] -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    $o += [pscustomobject]@{ tag=$pair[0]; pid=$c.OwningProcess; start=$(try { $p.StartTime.ToString('MM-dd HH:mm:ss') } catch { '' }); mem=[int]($p.WorkingSet64/1MB) }
  }
}
$o`;
  const rows = await psJson(script, 12000);
  const g = { napcat: [], qq: [], edge: [], dsh: [], bot: [], watch: [], console: [] };
  const TAG2KEY = { NapCatWinBootMain: 'napcat', QQ: 'qq', msedge: 'edge', 'DeepSeek Harness': 'dsh' };
  for (const r of rows) {
    const k = TAG2KEY[r.tag] || r.tag;
    if (k && g[k]) g[k].push(r);
  }
  return g;
}

// ---------- 服务定义 ----------
const QR_PATH = 'D:\\NapCat\\NapCat.52230.Shell\\versions\\9.9.33-52230\\resources\\app\\napcat\\cache\\qrcode.png';
function qrMtime() {
  try { return fs.statSync(QR_PATH).mtimeMs; } catch { return 0; }
}

// ---------- NapCat WebUI 接口（用它来热刷新二维码，不必重启 NapCat） ----------
// 登录方式：hash = sha256(token + ".napcat")，POST /api/auth/login 拿 Credential，之后带 Bearer。
const NAPCAT_WEBUI = 'http://127.0.0.1:6099';
function napcatToken() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(NAPCAT_DIR, 'versions', '9.9.33-52230', 'resources', 'app', 'napcat', 'config', 'webui.json'), 'utf8'));
    return j.token || '';
  } catch { return ''; }
}
let napcatCred = { cred: '', at: 0 };
async function napcatApi(pathname, body = {}, timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    if (!napcatCred.cred || Date.now() - napcatCred.at > 50 * 60 * 1000) {
      const tk = napcatToken();
      if (!tk) throw new Error('读不到 webui.json 里的 token');
      const hash = crypto.createHash('sha256').update(tk + '.napcat').digest('hex');
      const r = await fetch(NAPCAT_WEBUI + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash }), signal: ctl.signal
      });
      const j = await r.json();
      const cred = j?.data?.Credential;
      if (!cred) throw new Error('WebUI 登录失败：' + (j?.message || '无 Credential'));
      napcatCred = { cred, at: Date.now() };
    }
    const r = await fetch(NAPCAT_WEBUI + pathname, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + napcatCred.cred, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctl.signal
    });
    return await r.json();
  } finally { clearTimeout(timer); }
}

// 取一张新二维码：先让 NapCat 刷新，再从 cache/qrcode.png 读（NapCat 只回 URL，不回图片）
async function napcatFreshQr() {
  const st = await napcatApi('/api/QQLogin/CheckLoginStatus');
  const d = st?.data || {};
  if (d.isLogin) return { ok: false, loggedIn: true, msg: '已经登录了（' + (d.loginPhase || 'ready') + '），不需要二维码' };
  const before = qrMtime();
  await napcatApi('/api/QQLogin/RefreshQRcode');
  // 等 NapCat 把新图写进缓存（一般 0.5~2 秒）
  let at = before;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    at = qrMtime();
    if (at > before) break;
  }
  if (!at) return { ok: false, msg: 'NapCat 没写出二维码缓存，稍后再点一次' };
  if (at <= before) return { ok: false, msg: '二维码没有刷新（可能还在生成），3 秒后再点一次' };
  const buf = fs.readFileSync(QR_PATH);
  // NapCat 的 qrcode.png 其实是 JPEG 字节，按魔数判断类型
  const mime = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png';
  return { ok: true, dataUrl: `data:${mime};base64,` + buf.toString('base64'), at };
}
const SVC = {
  napcat: {
    name: 'NapCat（QQ 协议端）', port: 3001,
    async start() {
      const qq = await qqProcs();
      for (const q of qq) killPid(q.pid);
      // 用 /min 最小化启动：NapCat 会弹一个自己的控制台窗口，不最小化就大刺刺盖在屏幕中间
      runLogged(path.join(NAPCAT_DIR, 'NapCatWinBootMain.exe'), [CFG.botQq || '10001'], 'napcat-out.log', NAPCAT_DIR, napcatEnv());
      return 'NapCat 正在启动（约 20–40 秒）；如果 QQ 掉登录了，这里会显示二维码，扫码即可';
    },
    async stop() {
      const boot = await psJson("Get-Process -Name NapCatWinBootMain -ErrorAction SilentlyContinue | Select-Object Id");
      for (const b of boot) killPid(b.Id);
      const qq = await qqProcs();
      for (const q of qq) if (/^D:\\NapCat/i.test(q.path)) killPid(q.pid);
      return 'NapCat 已关闭（日常用的 QQ 没动）';
    },
    async running() { return await tcpProbe(3001); }
  },
  bot: {
    name: '玉子 bot（聊天主进程）', port: 3008,
    async start() {
      runLogged(process.execPath, ['bot.mjs'], 'bot.log');
      return '正在启动玉子，约 3 秒…';
    },
    async stop() {
      const ns = await nodeProcs();
      for (const n of ns) if (/bot\.mjs/.test(n.cmd)) killPid(n.pid);
      return '玉子 bot 已停止';
    },
    async running() { return await tcpProbe(3008); }
  },
  watch: {
    name: '空间监听（点赞+评论）', port: 0,
    async start() {
      runLogged(process.execPath, ['qz_watch.mjs'], 'qzone.log');
      return '空间监听启动中';
    },
    async stop() {
      const ns = await nodeProcs();
      for (const n of ns) if (/qz_watch\.mjs/.test(n.cmd)) killPid(n.pid);
      return '空间监听已停止';
    },
    // 监听进程自己占了 3009 当单实例锁，探端口比翻命令行可靠
    async running() { return await tcpProbe(3009); }
  },
  edge: {
    name: '无头 Edge（点赞用）', port: 9333,
    async start() {
      fs.mkdirSync(EDGE_PROFILE, { recursive: true });
      runHidden(EDGE, [
        '--headless=new', '--remote-debugging-port=9333',
        `--user-data-dir=${EDGE_PROFILE}`, '--no-first-run', '--disable-gpu',
        '--window-size=1280,900', 'about:blank'
      ]);
      return '无头 Edge 启动中（约 5 秒）';
    },
    async stop() {
      const es = await psJson("Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -match '9333' } | Select-Object ProcessId");
      for (const e of es) killPid(e.ProcessId);
      return '无头 Edge 已关闭';
    },
    async running() { return await tcpProbe(9333); }
  },
  dsh: {
    name: 'DSH（DeepSeek Harness）', port: 0,
    async start() {
      runHidden(DSH_EXE, []);
      return 'DSH 启动中';
    },
    async stop() {
      runCmd('taskkill /f /im "DeepSeek Harness.exe" /t');
      return 'DSH 已关闭（电脑端会话会断开）';
    },
    async running() {
      try { return tasklistRows('DeepSeek Harness.exe').length > 0; } catch { return false; }
    }
  }
};

// 简单防抖：同一服务 3 秒内不接受重复操作
const lastOp = new Map();

async function statusAll() {
  const out = { t: Date.now(), services: {}, sys: {} };
  await Promise.all(Object.entries(SVC).map(async ([id, s]) => {
    const up = await s.running();
    out.services[id] = { name: s.name, port: s.port, up: !!up };
  }));
  const qqN = await qqCount();
  out.services.napcat.qqProcs = qqN;
  // NapCat 后端进程活着但 3001 没开，只有一种可能：掉登录了，正等着扫码
  if (!out.services.napcat.up) {
    let bootAlive = 0;
    try { bootAlive = tasklistRows('NapCatWinBootMain.exe').length; } catch {}
    out.services.napcat.bootAlive = bootAlive;
    out.services.napcat.detail = bootAlive
      ? '后端已启动，正在等扫码登录（二维码见下方）'
      : '后端没在跑';
    out.services.napcat.qrAt = qrMtime();
    if (bootAlive) {
      // 再问一句 NapCat 自己：是在等扫码，还是正在起客户端
      try {
        const st = await napcatApi('/api/QQLogin/CheckLoginStatus', {}, 4000);
        const d = st?.data || {};
        out.services.napcat.phase = d.loginPhase || '';
        out.services.napcat.loggedIn = !!d.isLogin;
        out.services.napcat.loginError = d.loginError || '';
        if (d.loginPhase && d.loginPhase !== 'ready') out.services.napcat.detail = '登录阶段：' + d.loginPhase + '（等扫码）';
        if (d.loginError) out.services.napcat.detail = '登录报错：' + d.loginError;
      } catch {}
    }
  }
  out.services.qq = { name: '本机 QQ 进程', up: qqN > 0, port: 0, count: qqN };
  out.sys = {
    freeMemMB: Math.round(os.freemem() / 1048576),
    totalMemMB: Math.round(os.totalmem() / 1048576),
    uptimeMin: Math.round(os.uptime() / 60),
    consolePid: process.pid,
    consoleMemMB: Math.round(process.memoryUsage().rss / 1048576),
    owner: OWNER,
    self: CFG.BOT_QQ || ''
  };
  return out;
}

// ---------- 日志 ----------
function tailLog(name, lines = 120) {
  const map = {
    boot: path.join(DATA, 'boot.log'),
    bot: path.join(DATA, 'bot.log'),
    qzone: path.join(DATA, 'qzone.log'),
    console: WAYU,
    autostart: path.join(DATA, 'autostart.log')
  };
  const f = map[name];
  if (!f || !fs.existsSync(f)) return `（没有 ${name} 日志）`;
  try {
    const buf = fs.readFileSync(f);
    // GBK 日志按 latin1 读出，前端不强求中文正确，先保证可读
    const txt = buf.toString('utf8');
    const arr = txt.split(/\r?\n/).filter((x) => x.trim());
    return arr.slice(-lines).join('\n');
  } catch (e) {
    return '读取失败：' + e.message;
  }
}

// ---------- OneBot 客户端 ----------
let obWs = null;
let obSeq = 0;
const obPending = new Map();

function obConnect() {
  return new Promise((resolve, reject) => {
    if (obWs && obWs.readyState === 1) return resolve(obWs);
    let ws;
    try {
      ws = new WebSocket(CFG.NAPCAT_WS || 'ws://127.0.0.1:3001');
    } catch (e) { return reject(e); }
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('连接 NapCat 超时')); }, 5000);
    ws.addEventListener('open', () => { clearTimeout(t); obWs = ws; resolve(ws); });
    ws.addEventListener('message', (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (d && d.echo && obPending.has(d.echo)) {
        const job = obPending.get(d.echo);
        clearTimeout(job.timer);
        obPending.delete(d.echo);
        job.resolve(d);
      }
    });
    ws.addEventListener('close', () => { if (obWs === ws) obWs = null; });
    ws.addEventListener('error', () => { clearTimeout(t); try { ws.close(); } catch {} reject(new Error('连不上 NapCat（3001 没开？）')); });
  });
}

async function ob(action, params = {}, timeoutMs = 25000) {
  const ws = await obConnect();
  const echo = 'c' + (++obSeq) + Date.now().toString(36);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { obPending.delete(echo); reject(new Error('NapCat 响应超时：' + action)); }, timeoutMs);
    obPending.set(echo, { resolve, timer });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

// ---------- 历史记录 ----------
let histCache = { mtime: 0, rows: [] };

function loadHistory() {
  const f = path.join(DATA, 'brain', 'messages.jsonl');
  try {
    const st = fs.statSync(f);
    if (st.mtimeMs === histCache.mtime) return histCache.rows;
    const rows = [];
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o && typeof o.text === 'string' && o.text.trim()) rows.push(o); } catch {}
    }
    rows.sort((a, b) => (a.t || 0) - (b.t || 0));
    histCache = { mtime: st.mtimeMs, rows };
    return rows;
  } catch { return histCache.rows; }
}

function friendsMap() {
  const out = {};
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, 'friends.json'), 'utf8'));
    if (Array.isArray(j)) {
      for (const f of j) out[String(f.uid || f.user_id)] = f.name || f.nickname || String(f.uid);
    } else if (j && typeof j === 'object' && (j.list || j.friends)) {
      for (const f of (j.list || j.friends)) out[String(f.uid || f.user_id)] = f.name || f.nickname || String(f.uid);
    } else if (j && typeof j === 'object') {
      // { "uid": { name, since, src } }
      for (const [uid, v] of Object.entries(j)) out[uid] = (v && (v.name || v.nick)) || uid;
    }
  } catch {}
  return out;
}

function chanName(ch, role) {
  if (!ch || ch === 'qq') return role === 'assistant' ? '玉子' : '主人';
  if (ch === 'gui') return '电脑端';
  if (ch.startsWith('qq:')) return friendsMap()[ch.slice(3)] || ('好友 ' + ch.slice(3));
  if (ch.startsWith('group:')) return '群 ' + ch.slice(6);
  return ch;
}

function chanSummary() {
  const rows = loadHistory();
  const m = new Map();
  for (const r of rows) {
    const k = r.ch || 'qq';
    const e = m.get(k) || { ch: k, name: chanName(k, 'user'), count: 0, last: 0 };
    e.count++; e.last = Math.max(e.last, r.t || 0);
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.last - a.last);
}

function filterHistory(sp) {
  const q = (sp.get('q') || '').trim().toLowerCase();
  const ch = sp.get('ch') || '';
  const from = Number(sp.get('from') || 0);
  const to = Number(sp.get('to') || 0);
  return loadHistory().filter((r) => {
    const c = r.ch || 'qq';
    if (ch === 'qqall') {
      if (!(c === 'qq' || c.startsWith('qq:') || c.startsWith('group:'))) return false;
    } else if (ch && c !== ch) return false;
    if (from && (r.t || 0) < from) return false;
    if (to && (r.t || 0) > to) return false;
    if (q && !(r.text || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

// 跑一次性 node 脚本，输出重定向到临时文件（避免沙箱管道限制）
function runNodeScript(script, args = [], timeoutMs = 45000) {
  const out = path.join(os.tmpdir(), `yuzu-run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.log`);
  const q = args.map((a) => '"' + String(a).replace(/"/g, '') + '"').join(' ');
  const cmd = `node ${script} ${q} > "${out}" 2>&1`;
  const p = spawn('cmd.exe', ['/c', cmd], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      let txt = '';
      try { txt = fs.readFileSync(out, 'utf8'); } catch {}
      resolve({ ok, text: (txt.trim() || '（脚本没有输出）').slice(-2500) });
    };
    const timer = setTimeout(() => { try { p.kill(); } catch {} finish(false); }, timeoutMs);
    p.on('exit', (code) => { clearTimeout(timer); finish(code === 0); });
    p.on('error', () => { clearTimeout(timer); finish(false); });
  });
}

// ---------- 天气 / 余额 / 峰谷 ----------
const VERSION = '0.3.15';
const CITIES = { wuhan: { name: '武汉', lat: 30.5928, lon: 114.3055 } };
const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹'
};

async function jsonFetch(url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 300) }; }
    return { status: r.status, json: j };
  } catch (e) {
    return { status: 0, json: { error: e.name === 'AbortError' ? '超时 8 秒' : e.message } };
  } finally { clearTimeout(t); }
}

let weatherCache = { at: 0, data: null };
async function getWeather(force = false) {
  if (!force && weatherCache.data && Date.now() - weatherCache.at < 10 * 60 * 1000) return weatherCache.data;
  const c = CITIES[CFG.WEATHER_CITY || 'wuhan'] || CITIES.wuhan;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
    '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&timezone=Asia%2FShanghai&forecast_days=5';
  const r = await jsonFetch(url);
  if (r.status !== 200 || !r.json || !r.json.current) {
    return { ok: false, city: c.name, error: r.json?.error || ('HTTP ' + r.status) };
  }
  const cur = r.json.current;
  const d = r.json.daily || {};
  const days = (d.time || []).map((day, i) => ({
    day,
    code: d.weather_code?.[i],
    text: WMO[d.weather_code?.[i]] || '—',
    max: d.temperature_2m_max?.[i],
    min: d.temperature_2m_min?.[i],
    precip: d.precipitation_probability_max?.[i]
  }));
  const data = {
    ok: true,
    city: c.name,
    at: Date.now(),
    now: {
      temp: cur.temperature_2m,
      code: cur.weather_code,
      text: WMO[cur.weather_code] || '—',
      wind: cur.wind_speed_10m,
      humidity: cur.relative_humidity_2m
    },
    today: days[0] || null,
    days
  };
  weatherCache = { at: Date.now(), data };
  return data;
}

// 北京时间（假 Date，用 getHours 即可）
function cnNow() {
  const d = new Date();
  return new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
}

function pricingRules() {
  const f = path.join(DATA, 'pricing.json');
  const def = { tz: 'Asia/Shanghai', peak: [[9, 12], [14, 18]], offPeakFactor: 0.5, weekendOffPeak: false, effective: '2026-08-17', note: '高峰时段原价，其余时段半价' };
  try { return { ...def, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; }
  catch { try { fs.writeFileSync(f, JSON.stringify(def, null, 2), 'utf8'); } catch {} return def; }
}

function peakState() {
  const r = pricingRules();
  const now = cnNow();
  const h = now.getHours() + now.getMinutes() / 60;
  const dow = now.getDay();
  const weekendFree = !!r.weekendOffPeak && (dow === 0 || dow === 6);
  let inPeak = false;
  for (const [a, b] of r.peak) if (h >= a && h < b) inPeak = true;
  if (weekendFree) inPeak = false;
  let nextAt;
  if (inPeak) {
    const w = r.peak.find(([a, b]) => h >= a && h < b);
    nextAt = new Date(now);
    nextAt.setHours(w[1], 0, 0, 0);
  } else {
    const next = r.peak.map(([a]) => a).find((a) => a > h);
    nextAt = new Date(now);
    if (next === undefined) { nextAt.setDate(nextAt.getDate() + 1); nextAt.setHours(r.peak[0][0], 0, 0, 0); }
    else nextAt.setHours(next, 0, 0, 0);
  }
  const nextIn = Math.max(0, Math.round((nextAt - now) / 1000));
  return {
    isPeak: inPeak,
    label: inPeak ? '高峰·原价' : '低谷·半价',
    factor: inPeak ? 1 : (weekendFree ? 0 : 1) * (r.offPeakFactor || 1),
    nextAt: Date.now() + nextIn * 1000,
    nextIn,
    rules: r
  };
}

let balCache = { at: 0, data: null };
async function getBalance(force = false) {
  const key = CFG.DEEPSEEK_API_KEY || '';
  const peak = peakState();
  if (!key) return { ok: false, error: '没配 DEEPSEEK_API_KEY', peak };
  if (!force && balCache.data && Date.now() - balCache.at < 5 * 60 * 1000) return { ...balCache.data, peak };
  const base = CFG.DEEPSEEK_BASE || 'https://api.deepseek.com';
  const r = await jsonFetch(base.replace(/\/$/, '') + '/user/balance', { headers: { Authorization: 'Bearer ' + key } });
  if (r.status !== 200) {
    const data = { ok: false, error: r.json?.error?.message || r.json?.error || ('HTTP ' + r.status), peak };
    return data;
  }
  const infos = r.json.balance_infos || [];
  const cny = infos.find((x) => x.currency === 'CNY') || infos[0] || {};
  const data = {
    ok: true,
    available: r.json.is_available,
    currency: cny.currency || 'CNY',
    total: Number(cny.total_balance || 0),
    granted: Number(cny.granted_balance || 0),
    topped: Number(cny.topped_up_balance || 0),
    at: Date.now(),
    peak
  };
  balCache = { at: Date.now(), data };
  return data;
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8'
};

function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2e6) b = b.slice(0, 2e6); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// 上传记忆包/性格包用：放宽到 40MB
// 导出目录：默认 我的文档\玉子导出，可用 .env 的 EXPORT_DIR 覆盖
function exportDirPath() {
  const d = CFG.EXPORT_DIR || path.join(process.env.USERPROFILE || 'C:\\Users\\Lenovo', 'Documents', '玉子导出');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
// 交给托盘的 Windows 原生另存为：请求文件 <id>.req + <id>.bin，托盘回 <id>.res
// 返回 OK|<path> / CANCEL / ERR|<msg>
const SAVE_DIR = path.join(DATA, 'save');
function saveViaTray(name, buf, timeoutMs = 60000) {
  return new Promise((resolve) => {
    try { fs.mkdirSync(SAVE_DIR, { recursive: true }); } catch { }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const reqFile = path.join(SAVE_DIR, id + '.req');
    const binFile = path.join(SAVE_DIR, id + '.bin');
    const resFile = path.join(SAVE_DIR, id + '.res');
    try {
      fs.writeFileSync(binFile, buf);
      fs.writeFileSync(reqFile, JSON.stringify({ id, name, size: buf.length }), 'utf8');
    } catch (e) { return resolve({ ok: false, error: '写临时文件失败：' + e.message }); }
    const t0 = Date.now();
    const tick = setInterval(() => {
      let raw = null;
      try { if (fs.existsSync(resFile)) raw = fs.readFileSync(resFile, 'utf8'); } catch { }
      if (raw !== null) {
        clearInterval(tick);
        for (const f of [reqFile, binFile, resFile]) { try { fs.unlinkSync(f); } catch { } }
        if (raw.startsWith('OK|')) { log(`导出文件：${raw.slice(3)}`); return resolve({ ok: true, path: raw.slice(3) }); }
        if (raw.trim() === 'CANCEL') return resolve({ ok: false, error: '已取消保存', cancel: true });
        return resolve({ ok: false, error: raw.replace(/^ERR\|/, '') || '保存失败' });
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(tick);
        for (const f of [reqFile, binFile]) { try { fs.unlinkSync(f); } catch { } }
        resolve({ ok: false, error: '托盘没有响应（另存为窗口没弹出来？可到 导出目录 取文件）' });
      }
    }, 300);
  });
}
function readBodyBig(req, maxBytes = 40 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    let over = false;
    req.on('data', (c) => {
      n += c.length;
      if (n > maxBytes) { over = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return resolve({ __err: '文件太大（上限 40MB）' });
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { resolve({ __err: '请求体不是合法 JSON' }); }
    });
  });
}
// ---------- 用量 / 自检 ----------
function usageStats() {
  const f = path.join(DATA, 'usage.jsonl');
  const rows = [];
  try {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const today = dayKey(Date.now());
  const byDay = new Map();
  for (const r of rows) {
    const k = dayKey(r.t || 0);
    const cur = byDay.get(k) || { day: k, calls: 0, inTok: 0, outTok: 0, ms: 0, toolCalls: 0 };
    cur.calls += 1;
    cur.inTok += r.inTok || 0;
    cur.outTok += r.outTok || 0;
    cur.ms += r.ms || 0;
    if (r.tools) cur.toolCalls += 1;
    byDay.set(k, cur);
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 7)
    .map((d) => ({ ...d, avgMs: d.calls ? Math.round(d.ms / d.calls) : 0 }));
  const t = byDay.get(today) || { day: today, calls: 0, inTok: 0, outTok: 0, ms: 0, toolCalls: 0 };
  return { today: { ...t, avgMs: t.calls ? Math.round(t.ms / t.calls) : 0 }, days, total: rows.length };
}

async function doctor() {
  const items = [];
  const add = (name, ok, detail, fix) => items.push({ name, ok, detail: detail || '', fix: fix || '' });

  add('Node 运行时', true, process.version, '');

  const ff = CFG.FFMPEG_PATH || path.join(ROOT, 'tools', 'ffmpeg.exe');
  add('ffmpeg（视频抽帧）', fs.existsSync(ff), fs.existsSync(ff) ? ff : '没找到 ' + ff, '下载后放到 qq-bridge/tools/ffmpeg.exe，或在 .env 写 FFMPEG_PATH');

  add('Edge（控制台窗口 / 空间点赞）', fs.existsSync(EDGE), fs.existsSync(EDGE) ? EDGE : '没找到 ' + EDGE, '装 Edge 或改 console.mjs 里的 EDGE 路径');

  add('NapCat 目录', fs.existsSync(NAPCAT_DIR), fs.existsSync(NAPCAT_DIR) ? NAPCAT_DIR : '没找到', '把 NapCat Shell 解压到 D:\\NapCat\\NapCat.52230.Shell');

  const ports = { 3001: 'NapCat OneBot', 9333: '无头 Edge', 3210: '控制台本身' };
  for (const [port, label] of Object.entries(ports)) {
    const up = await tcpProbe(Number(port));
    add(`${label}（${port}）`, up, up ? '能连' : '端口没开', up ? '' : '首页点「启动」，或等开机自检最多 2 分钟');
  }

  let hasTask = false;
  try {
    const j = await psJson("$t = Get-ScheduledTask -TaskName 'QQBridge-KeepAlive' -ErrorAction SilentlyContinue; $(if ($t) { @{ ok = $true } } else { @{ ok = $false } })");
    hasTask = !!(Array.isArray(j) ? j[0] && j[0].ok : j && j.ok);
  } catch {}
  add('计划任务（每 2 分钟自检）', hasTask, hasTask ? 'QQBridge-KeepAlive 已注册' : '没找到这个任务', '把 C:\\DSH\\run-bridge.bat 注册成每 2 分钟的计划任务（见使用手册）');

  let hasReg = false;
  try {
    const j = await psJson("$r = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue; $(if ($r.QQBridge_AutoStart) { @{ ok = $true } } else { @{ ok = $false } })");
    hasReg = !!(Array.isArray(j) ? j[0] && j[0].ok : j && j.ok);
  } catch {}
  add('注册表开机启动项', hasReg, hasReg ? '已写入' : '缺少 QQBridge_AutoStart', '双击 qq-bridge 里的自启安装脚本，或手动写注册表');

  const qr = qrMtime();
  add('二维码缓存可写', true, qr ? '最近一次生成 ' + new Date(qr).toLocaleString('zh-CN') : '还没有二维码（说明当前登录正常）', '');

  return { at: Date.now(), items, okCount: items.filter((i) => i.ok).length, total: items.length };
}

// ---------- 安装向导：装没装齐、缺的能一键补 ----------
function psScript(script, timeoutMs = 20000) {
  const f = path.join(os.tmpdir(), `yuzu-ps-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(f, '\ufeff' + script, 'utf8');
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  } catch (e) {
    return String((e && (e.stdout || e.message)) || '');
  } finally {
    try { fs.unlinkSync(f); } catch {}
  }
}

async function setupStatus() {
  const items = [];
  const add = (key, name, ok, detail, fix) => items.push({ key, name, ok, detail: detail || '', fix: fix || '' });

  add('node', 'Node.js 运行时', true, process.version + ' · ' + process.execPath);
  add('edge', 'Microsoft Edge（控制台窗口 / 点赞）', fs.existsSync(EDGE), fs.existsSync(EDGE) ? EDGE : '没找到 ' + EDGE);

  const nm = path.join(NAPCAT_DIR, 'NapCatWinBootMain.exe');
  const nq = path.join(NAPCAT_DIR, 'QQ.exe');
  const napcatOk = fs.existsSync(nm) && fs.existsSync(nq);
  add('napcat', 'NapCat（QQ 协议端）', napcatOk,
    napcatOk ? NAPCAT_DIR + '（QQ ' + (() => { try { return '9.9.33'; } catch { return '?'; } })() + '）' : '缺 NapCatWinBootMain.exe 或 QQ.exe',
    napcatOk ? '' : 'napcat');

  const ff = CFG.FFMPEG_PATH || path.join(ROOT, 'tools', 'ffmpeg.exe');
  add('ffmpeg', 'ffmpeg（视频抽帧）', fs.existsSync(ff), fs.existsSync(ff) ? ff : '没找到 ' + ff, fs.existsSync(ff) ? '' : 'ffmpeg');

  const dshExe = 'D:\\DeepSeek Harness\\DeepSeek Harness.exe';
  add('dsh', 'DeepSeek Harness', fs.existsSync(dshExe), dshExe);

  const exe = path.join('D:\\DeepSeek test', '玉子软件开发', '玉子控制台.exe');
  add('console', '控制台程序（托盘 exe）', fs.existsSync(exe), exe);

  const lnk = path.join(process.env.USERPROFILE || '', 'Desktop', '玉子控制台.lnk');
  add('shortcut', '桌面快捷方式', fs.existsSync(lnk), fs.existsSync(lnk) ? lnk : '桌面还没有快捷方式', fs.existsSync(lnk) ? '' : 'shortcut');

  // 注意：runCmdSilent 的管道输出在这台机器上不可靠（cmd 重定向 + 编码问题），自启状态改用 PowerShell 查
  const regOut = psScript("$r = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue; if ($r.QQBridge_AutoStart) { 'yes' } else { 'no' }", 15000);
  const autoOk = /yes/i.test(regOut);
  add('autostart', '开机自启（注册表 + 计划任务）', autoOk, autoOk ? '已注册 QQBridge_AutoStart' : '没注册，重启电脑后不会自己起来', autoOk ? '' : 'autostart');

  const dist = path.join('D:\\DeepSeek test', '玉子项目开发-安装测试', '01-安装包');
  add('dist', '安装包', fs.existsSync(dist), fs.existsSync(dist) ? dist : '还没打包（跑 node build-dist.mjs）', fs.existsSync(dist) ? 'installer' : '');

  return { at: Date.now(), items, okCount: items.filter((i) => i.ok).length, total: items.length };
}

async function installFfmpeg() {
  const url = 'https://cdn.npmmirror.com/binaries/ffmpeg-static/b6.0/ffmpeg-win32-x64.gz';
  const r = await fetch(url);
  if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
  const gz = Buffer.from(await r.arrayBuffer());
  const exe = zlib.gunzipSync(gz);
  const dst = path.join(ROOT, 'tools', 'ffmpeg.exe');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, exe);
  log('安装向导：ffmpeg 已下载 ' + (exe.length / 1048576).toFixed(1) + 'MB → ' + dst);
  return { ok: true, msg: 'ffmpeg 装好了（' + (exe.length / 1048576).toFixed(1) + 'MB）', path: dst };
}

function makeShortcuts() {
  const exe = path.join('D:\\DeepSeek test', '玉子软件开发', '玉子控制台.exe');
  const ps = `$w = New-Object -ComObject WScript.Shell
$exe = '${exe}'
$wd = Split-Path $exe
$desk = Join-Path ([Environment]::GetFolderPath('Desktop')) '玉子控制台.lnk'
$s = $w.CreateShortcut($desk); $s.TargetPath = $exe; $s.WorkingDirectory = $wd; $s.IconLocation = $exe + ',0'; $s.Description = '玉子控制台'; $s.Save()
$sm = Join-Path ([Environment]::GetFolderPath('Programs')) '玉子控制台.lnk'
$s2 = $w.CreateShortcut($sm); $s2.TargetPath = $exe; $s2.WorkingDirectory = $wd; $s2.IconLocation = $exe + ',0'; $s2.Save()
Write-Output 'ok'`;
  const out = psScript(ps, 25000);
  const ok = /ok/i.test(out);
  log('安装向导：快捷方式 ' + (ok ? '已创建' : '失败 ' + out.slice(0, 120)));
  return { ok, msg: ok ? '桌面和开始菜单的快捷方式都建好了' : '建快捷方式失败：' + out.slice(0, 160) };
}

function installAutostart() {
  const vbs = path.join(ROOT, 'qq-bridge-startup.vbs');
  psScript(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v QQBridge_AutoStart /t REG_SZ /d "wscript.exe \\"${vbs}\\"" /f | Out-Null
schtasks /create /tn QQBridge-KeepAlive /tr "cmd.exe /c C:\\DSH\\run-bridge.bat" /sc minute /mo 2 /f | Out-Null
$r = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue
if ($r.QQBridge_AutoStart) { 'yes' } else { 'no' }`, 30000);
  const again = psScript("$r = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue; if ($r.QQBridge_AutoStart) { 'yes' } else { 'no' }", 15000);
  const ok = /yes/i.test(again);
  log('安装向导：开机自启 ' + (ok ? '已注册' : '注册失败'));
  return { ok, msg: ok ? '开机自启已注册（注册表 + 每 2 分钟计划任务）' : '注册表写入失败，可能需要管理员权限' };
}

function buildDist() {
  const base = path.join('D:\\DeepSeek test', '玉子项目开发-安装测试');
  const pkg = path.join(base, '01-安装包');
  const bridgeDst = path.join(pkg, 'payload', 'bridge');
  const appDst = path.join(pkg, 'payload', 'app');
  fs.mkdirSync(bridgeDst, { recursive: true });
  fs.mkdirSync(appDst, { recursive: true });

  const copyList = [
    'bot.mjs', 'console.mjs', 'memory.mjs', 'sync.mjs', 'tools.mjs', 'cdp.mjs',
    'qz_browser.mjs', 'qz_watch.mjs', 'backup.mjs', 'say.mjs',
    'autostart.bat', 'start.bat', 'qq-bridge-startup.vbs', 'dsh-startup.vbs',
    'persona.md', '.env.example', 'README.md',
  ];
  let n = 0;
  for (const f of copyList) {
    const s = path.join(ROOT, f);
    if (fs.existsSync(s)) { fs.copyFileSync(s, path.join(bridgeDst, f)); n++; }
  }
  for (const d of ['web', 'tools']) {
    const s = path.join(ROOT, d);
    if (!fs.existsSync(s)) continue;
    const walk = (src, dst) => {
      fs.mkdirSync(dst, { recursive: true });
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const a = path.join(src, e.name);
        const b = path.join(dst, e.name);
        if (e.isDirectory()) walk(a, b);
        else { fs.copyFileSync(a, b); n++; }
      }
    };
    walk(s, path.join(bridgeDst, d));
  }
  const tray = path.join(base, '玉子控制台.exe');
  if (fs.existsSync(tray)) { fs.copyFileSync(tray, path.join(appDst, '玉子控制台.exe')); n++; }
  const ico = path.join(base, 'assets', 'yuzu.ico');
  if (fs.existsSync(ico)) {
    fs.copyFileSync(ico, path.join(appDst, 'yuzu.ico'));
    fs.copyFileSync(ico, path.join(pkg, 'yuzu.ico'));
    n += 2;
  }
  const setup = path.join(base, '安装玉子控制台.exe');
  if (fs.existsSync(setup)) { fs.copyFileSync(setup, path.join(pkg, '安装玉子控制台.exe')); n++; }

  const ver = {
    name: '玉子控制台', version: VERSION, builtAt: new Date().toISOString(),
    entry: '安装玉子控制台.exe', note: '双击安装；已有 .env / data 不会被覆盖',
  };
  fs.writeFileSync(path.join(pkg, 'version.json'), JSON.stringify(ver, null, 2));
  const size = (() => {
    let t = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p2 = path.join(d, e.name); if (e.isDirectory()) walk(p2); else t += fs.statSync(p2).size; } };
    try { walk(pkg); } catch {}
    return t;
  })();
  log('打包：' + n + ' 个文件 → ' + pkg + '（' + (size / 1048576).toFixed(2) + 'MB）');
  return { ok: true, msg: '安装包已更新：' + (size / 1048576).toFixed(2) + 'MB，' + n + ' 个文件', dir: pkg };
}

function launchInstaller() {
  const exe = path.join('D:\\DeepSeek test', '玉子项目开发-安装测试', '01-安装包', '安装玉子控制台.exe');
  if (!fs.existsSync(exe)) return { ok: false, msg: '安装包还没生成，先点「重新打包」' };
  runHidden('cmd.exe', ['/c', 'start', '', exe]);
  log('安装向导：已启动 ' + exe);
  return { ok: true, msg: '安装向导已打开，按提示点「开始安装」' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    if (p === '/api/status') return sendJson(res, 200, await statusAll());

    if (p.startsWith('/api/svc/')) {
      const [, , , id, act] = p.split('/');
      const s = SVC[id];
      if (!s) return sendJson(res, 404, { ok: false, error: '没有这个服务' });
      const key = id + act;
      const now = Date.now();
      if (lastOp.has(key) && now - lastOp.get(key) < 3000) return sendJson(res, 200, { ok: false, msg: '手速太快，等 3 秒' });
      lastOp.set(key, now);
      if (act === 'start') { const msg = await s.start(); log(`启动 ${id}`); return sendJson(res, 200, { ok: true, msg }); }
      if (act === 'stop') { const msg = await s.stop(); log(`停止 ${id}`); return sendJson(res, 200, { ok: true, msg }); }
      if (act === 'restart') { await s.stop(); await new Promise((r) => setTimeout(r, 1200)); const msg = await s.start(); log(`重启 ${id}`); return sendJson(res, 200, { ok: true, msg: '正在重启：' + msg }); }
      return sendJson(res, 400, { ok: false, error: '未知动作' });
    }

    if (p === '/api/logs') return sendJson(res, 200, { name: url.searchParams.get('name') || 'boot', text: tailLog(url.searchParams.get('name') || 'boot', Number(url.searchParams.get('lines') || 120)) });

    if (p === '/api/env') {
      const env = loadEnv();
      const masked = {};
      for (const [k, v] of Object.entries(env)) {
        if (/KEY|TOKEN|SECRET|PASS/i.test(k)) masked[k] = v ? v.slice(0, 6) + '****' + v.slice(-4) : '';
        else masked[k] = v;
      }
      return sendJson(res, 200, { env: masked, path: path.join(ROOT, '.env') });
    }

    if (p === '/api/qrcode') {
      const f = QR_PATH;
      if (!fs.existsSync(f)) return sendJson(res, 404, { ok: false, error: '还没有二维码（NapCat 未启动或已登录）' });
      const st = fs.statSync(f);
      // 老二维码扫了也是白扫，直接告诉前端「这是几点的图」
      if (Date.now() - st.mtimeMs > 2 * 60 * 1000) {
        return sendJson(res, 409, { ok: false, error: '二维码是 ' + st.mtime.toLocaleString('zh-CN') + ' 生成的，已过期，正在自动换一张' });
      }
      const b = fs.readFileSync(f);
      // NapCat 写出来的 qrcode.png 其实是 JPEG 字节，按魔数给正确的 Content-Type
      const qtype = b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : 'image/png';
      res.writeHead(200, { 'Content-Type': qtype, 'Content-Length': b.length, 'Cache-Control': 'no-store', 'X-Mtime': st.mtime.toISOString() });
      return res.end(b);
    }

    // 热刷新二维码：不重启 NapCat，直接让它换一张新的
    if (p === '/api/napcat/qr') {
      try {
        const r = await napcatFreshQr();
        log('刷新二维码：' + (r.ok ? '新图已生成' : r.msg));
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 500, { ok: false, msg: '拿不到二维码：' + e.message });
      }
    }

    // 进程详情：谁在跑、PID 多少、几点起的
    if (p === '/api/procs') {
      return sendJson(res, 200, { groups: await procGroups() });
    }

    // 防火墙：先查状态，再尝试加白（非管理员会失败，返回需要提权）
    if (p === '/api/firewall') {
      if (req.method === 'POST') {
        const r = runCmdSilent('netsh advfirewall firewall add rule name="玉子控制台" dir=in action=allow program="D:\\DeepSeek test\\玉子软件开发\\玉子控制台.exe" enable=yes profile=any');
        const ok = /确定|Ok\.|OK/.test(r.out || '');
        log('防火墙加白：' + (ok ? '成功' : '失败（' + (r.out || r.err || '').slice(0, 80) + '）'));
        return sendJson(res, 200, { ok, out: (r.out || r.err || '').slice(0, 300), needAdmin: !ok });
      }
      const chk = runCmdSilent('netsh advfirewall firewall show rule name="玉子控制台"');
      return sendJson(res, 200, { exists: /玉子控制台/.test(chk.out || '') && !/没有与指定标准相符/.test(chk.out || '') });
    }

    // ---------------- 天气 / 余额 / 日程 / 插件 / 设置 ----------------
    if (p === '/api/weather') return sendJson(res, 200, await getWeather());

    if (p === '/api/balance') return sendJson(res, 200, await getBalance());

    // 用量统计：读 bot 写的 data/usage.jsonl
    if (p === '/api/usage') return sendJson(res, 200, usageStats());

    // 自检：装没装、有没有跑、自启在不在
    if (p === '/api/doctor') return sendJson(res, 200, await doctor());

    // 一键修复：缺什么补什么，补完再自检一遍
    if (p === '/api/doctor/fix' && req.method === 'POST') {
      const actions = [];
      const step = async (label, fn) => {
        try { const r = await fn(); actions.push(label + (r ? '：' + r : '')); }
        catch (e) { actions.push(label + ' 失败：' + (e && e.message ? e.message : e)); }
      };
      if (!(await tcpProbe(3210))) actions.push('控制台自己在跑，这项跳过');
      if (!(await tcpProbe(3001))) await step('启动 NapCat', () => SVC.napcat.start());
      if (!(await tcpProbe(3008))) await step('启动玉子 bot', () => SVC.bot.start());
      if (!(await tcpProbe(3009))) await step('启动空间监听', () => SVC.watch.start());
      if (!(await tcpProbe(9333))) await step('启动无头 Edge', () => SVC.edge.start());

      let taskOk = false;
      try {
        const j = await psJson("$t = Get-ScheduledTask -TaskName 'QQBridge-KeepAlive' -ErrorAction SilentlyContinue; $(if ($t) { @{ ok = $true } } else { @{ ok = $false } })");
        taskOk = !!(Array.isArray(j) ? j[0] && j[0].ok : j && j.ok);
      } catch {}
      if (!taskOk) await step('注册计划任务', async () => {
        runCmdSilent('schtasks /create /tn QQBridge-KeepAlive /tr "cmd.exe /c C:\\DSH\\run-bridge.bat" /sc minute /mo 2 /f');
        return 'QQBridge-KeepAlive 已注册（每 2 分钟自检）';
      });

      let regOk = false;
      try {
        const j = await psJson("$r = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue; $(if ($r.QQBridge_AutoStart) { @{ ok = $true } } else { @{ ok = $false } })");
        regOk = !!(Array.isArray(j) ? j[0] && j[0].ok : j && j.ok);
      } catch {}
      if (!regOk) await step('写开机启动项', async () => {
        runCmdSilent('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v QQBridge_AutoStart /t REG_SZ /d "wscript.exe \\"D:\\DeepSeek test\\qq-bridge\\qq-bridge-startup.vbs\\"" /f');
        return '已写入 QQBridge_AutoStart';
      });

      await new Promise((r) => setTimeout(r, 1200));
      return sendJson(res, 200, { ok: true, actions, doctor: await doctor() });
    }

    // ---------- 安装向导 ----------
    if (p === '/api/setup') return sendJson(res, 200, await setupStatus());

    if (p === '/api/setup/action' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      let j = {};
      try { j = JSON.parse(raw || '{}'); } catch {}
      const op = String(j.op || '');
      try {
        if (op === 'ffmpeg') return sendJson(res, 200, await installFfmpeg());
        if (op === 'shortcut') return sendJson(res, 200, makeShortcuts());
        if (op === 'autostart') return sendJson(res, 200, installAutostart());
        if (op === 'napcat') {
          runHidden('cmd.exe', ['/c', 'start', '', 'https://github.com/NapNeko/NapCatQQ/releases']);
          return sendJson(res, 200, { ok: true, msg: '已打开 NapCat 下载页：下 NapCat.Shell.zip，解压到 D:\\NapCat，再用同目录的 NapCatWinBootMain.exe 启动' });
        }
        if (op === 'installer') {
          const dir = path.join('D:\\DeepSeek test', '玉子软件开发', 'dist');
          if (fs.existsSync(dir)) runHidden('explorer.exe', [dir]);
          return sendJson(res, 200, { ok: true, msg: fs.existsSync(dir) ? '已打开安装包目录' : '还没打包安装包，先跑一次 build-dist.mjs' });
        }
        if (op === 'build') return sendJson(res, 200, buildDist());
        if (op === 'launch') return sendJson(res, 200, launchInstaller());
        return sendJson(res, 400, { ok: false, msg: '不认识的 op：' + op });
      } catch (e) {
        return sendJson(res, 500, { ok: false, msg: String((e && e.message) || e) });
      }
    }

    // 升级检查：读 updates/version.json（有就比对，没有就说没有）
    if (p === '/api/update') {
      const f = path.join(ROOT, 'updates', 'version.json');
      let remote = null;
      try { remote = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      const local = VERSION;
      const latest = remote && remote.version ? String(remote.version) : '';
      return sendJson(res, 200, {
        local,
        remote,
        hasUpdate: !!(latest && latest !== local),
        note: remote ? '' : '还没有升级包，把 version.json 放进 qq-bridge/updates/ 就会显示',
      });
    }

    if (p === '/api/schedule') {
      if (req.method === 'POST') {
        const b = await readBody(req);
        const f = path.join(DATA, 'schedule.json');
        let j = { day: new Date().toISOString().slice(0, 10), items: [] };
        try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
        j.items = Array.isArray(j.items) ? j.items : [];
        if (b.op === 'add') {
          if (!b.item) return sendJson(res, 400, { ok: false, error: '内容不能为空' });
          j.items.push({ cat: b.cat || '其他', item: String(b.item), due: b.due || '', src: '控制台' });
        } else if (b.op === 'del') {
          const i = Number(b.idx);
          if (!(i >= 0 && i < j.items.length)) return sendJson(res, 400, { ok: false, error: '序号越界' });
          j.items.splice(i, 1);
        } else if (b.op === 'clear') {
          j.items = [];
        }
        fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf8');
        log(`日程变更 ${b.op}`);
        return sendJson(res, 200, { ok: true, items: j.items, day: j.day });
      }
      let j = { day: '', items: [] };
      try { j = JSON.parse(fs.readFileSync(path.join(DATA, 'schedule.json'), 'utf8')); } catch {}
      return sendJson(res, 200, { ok: true, day: j.day || '', items: j.items || [] });
    }

    if (p === '/api/plugins') {
      const dir = path.join(ROOT, 'plugins');
      const list = [];
      try {
        for (const name of fs.readdirSync(dir)) {
          const mf = path.join(dir, name, 'manifest.json');
          if (!fs.existsSync(mf)) continue;
          try {
            const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
            list.push({ id: name, name: m.name || name, version: m.version || '0.0.0', desc: m.desc || '', entry: m.entry || '' });
          } catch { list.push({ id: name, name, version: '?', desc: 'manifest.json 解析失败' }); }
        }
      } catch {}
      return sendJson(res, 200, { ok: true, version: VERSION, plugins: list, qqCmds: ['/插件', '/总结', '/状态', '/帮助'] });
    }

    if (p === '/api/settings') {
      if (req.method === 'POST') {
        const b = await readBody(req);
        const envPath = path.join(ROOT, '.env');
        await backup('pre-env');
        try {
          if (typeof b.raw === 'string') {
            fs.writeFileSync(envPath, b.raw.replace(/\r\n/g, '\n'), 'utf8');
          } else if (b.key) {
            const cur = fs.readFileSync(envPath, 'utf8');
            const re = new RegExp('^' + b.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=.*$', 'm');
            const line = `${b.key}=${b.value}`;
            fs.writeFileSync(envPath, re.test(cur) ? cur.replace(re, line) : cur.trimEnd() + '\n' + line + '\n', 'utf8');
          } else return sendJson(res, 400, { ok: false, error: '缺 key 或 raw' });
          log('设置已保存（改完要重启对应服务才生效）');
          return sendJson(res, 200, { ok: true, msg: '已保存，重启对应服务后生效' });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      const rows = [];
      try {
        for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
          const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
          if (!m) continue;
          const secret = /KEY|TOKEN|SECRET/i.test(m[1]);
          rows.push({ key: m[1], value: m[2], secret, masked: secret ? m[2].slice(0, 6) + '…' + m[2].slice(-4) : m[2] });
        }
      } catch {}
      return sendJson(res, 200, { ok: true, vars: rows, owner: OWNER });
    }

    // ---------------- 群聊白名单 ----------------
    if (p === '/api/groups') {
      const envPath = path.join(ROOT, '.env');
      const envLines = () => { try { return fs.readFileSync(envPath, 'utf8').split(/\r?\n/); } catch { return []; } };
      const envMap = () => {
        const out = {};
        for (const line of envLines()) {
          const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
          if (m) out[m[1]] = m[2];
        }
        return out;
      };
      const setEnv = (key, value) => {
        const lines = envLines();
        const hit = lines.findIndex((l) => l.startsWith(key + '='));
        if (hit >= 0) lines[hit] = key + '=' + value;
        else lines.push(key + '=' + value);
        fs.writeFileSync(envPath, lines.join('\r\n'), 'utf8');
      };
      const feedStats = () => {
        const map = {};
        try {
          for (const line of fs.readFileSync(path.join(DATA, 'feed.jsonl'), 'utf8').split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const o = JSON.parse(line);
              if (!o.group) continue;
              const g = map[o.group] || (map[o.group] = { count: 0, last: '', lastText: '' });
              g.count++;
              if (o.t > g.last) { g.last = o.t; g.lastText = String(o.text || '').slice(0, 40); }
            } catch {}
          }
        } catch {}
        return map;
      };
      const groupView = async () => {
        const env = envMap();
        const list = String(env.WATCH_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean);
        const stats = feedStats();
        let remote = [];
        try {
          const r = await ob('get_group_list', {}, 4000);
          const arr = Array.isArray(r) ? r : (r && r.data) || [];
          remote = arr.map((g) => ({ gid: String(g.group_id), name: g.group_name || '' }));
        } catch {}
        const whitelist = list.map((gid) => {
          const s = stats[gid] || {};
          const r = remote.find((x) => x.gid === gid);
          return { gid, name: (r && r.name) || '', messages: s.count || 0, last: s.last || '', lastText: s.lastText || '' };
        });
        const candidates = remote.filter((x) => list.indexOf(x.gid) < 0).map((x) => ({
          gid: x.gid, name: x.name, messages: (stats[x.gid] || {}).count || 0
        }));
        return {
          ok: true, whitelist, candidates, groups: list,
          mode: String(env.GROUP_REPLY || 'mention').toLowerCase(),
          cooldown: Number(env.GROUP_COOLDOWN || 45)
        };
      };
      if (req.method === 'POST') {
        const b = await readBody(req);
        const gid = String(b.gid || '').replace(/[^0-9]/g, '');
        const env = envMap();
        const cur = String(env.WATCH_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (b.op === 'add') {
          if (!gid) return sendJson(res, 400, { ok: false, error: '缺少群号' });
          const next = cur.indexOf(gid) >= 0 ? cur : cur.concat([gid]);
          setEnv('WATCH_GROUPS', next.join(','));
          if (String(b.mode || '') === 'all') setEnv('GROUP_REPLY', 'all');
          log('群白名单新增 ' + gid + '（共 ' + next.length + ' 个群）');
          return sendJson(res, 200, await groupView());
        }
        if (b.op === 'del') {
          if (!gid) return sendJson(res, 400, { ok: false, error: '缺少群号' });
          const next = cur.filter((x) => x !== gid);
          setEnv('WATCH_GROUPS', next.join(','));
          log('群白名单移除 ' + gid + '（剩 ' + next.length + ' 个群）');
          return sendJson(res, 200, await groupView());
        }
        if (b.op === 'mode') {
          const m = ['all', 'mention', 'off'].indexOf(String(b.mode)) >= 0 ? String(b.mode) : 'mention';
          setEnv('GROUP_REPLY', m);
          if (b.cooldown !== undefined) setEnv('GROUP_COOLDOWN', String(Math.max(5, Number(b.cooldown) || 45)));
          log('群回复模式改为 ' + m);
          return sendJson(res, 200, await groupView());
        }
        return sendJson(res, 400, { ok: false, error: '未知操作 ' + b.op });
      }
      return sendJson(res, 200, await groupView());
    }

    if (p === '/api/friends') {
      const f = path.join(DATA, 'friends.json');
      const read = () => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { return {}; } };
      if (req.method === 'POST') {
        const b = await readBody(req);
        const j = read();
        if (!b.uid) return sendJson(res, 400, { ok: false, error: '缺 QQ 号' });
        if (b.op === 'del') delete j[String(b.uid)];
        else j[String(b.uid)] = { name: b.name || String(b.uid), since: new Date().toISOString(), src: 'console' };
        fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true, list: j });
      }
      return sendJson(res, 200, { ok: true, list: read() });
    }

    if (p === '/api/backups') {
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (b.op === 'restore') {
          const r = await restore(String(b.name || ''));
          if (r.ok) log('已回滚备份 ' + b.name);
          return sendJson(res, r.ok ? 200 : 400, r);
        }
        const r = await backup(b.tag || 'manual');
        if (r.ok) log(`已备份 ${r.name}（${Math.round(r.size / 1024)}KB）`);
        return sendJson(res, r.ok ? 200 : 500, r);
      }
      return sendJson(res, 200, { ok: true, list: listBackups(), dir: 'D:\\DeepSeek test\\玉子软件开发\\backups' });
    }

    // ---------------- 聊天记录 ----------------
    if (p === '/api/history') {
      const rows = filterHistory(url.searchParams);
      const limit = Math.min(500, Number(url.searchParams.get('limit') || 80));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      const items = rows.slice(-limit - offset, rows.length - offset || undefined)
        .map((r) => ({ t: r.t || 0, ch: r.ch || 'qq', who: chanName(r.ch, r.role), role: r.role, text: r.text }));
      return sendJson(res, 200, { total: rows.length, offset, limit, items: items.reverse(), channels: chanSummary() });
    }

    if (p === '/api/history/export') {
      const rows = filterHistory(url.searchParams);
      const lines = rows.map((r) => `[${new Date(r.t || 0).toLocaleString('zh-CN')}] ${chanName(r.ch, r.role)}${r.role === 'assistant' ? '（玉子）' : ''}：${String(r.text).replace(/\r?\n/g, ' ')}`);
      const body = Buffer.from('\ufeff' + lines.join('\r\n'), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="yuzi-history-${new Date().toISOString().slice(0, 10)}.txt"`,
        'Content-Length': body.length
      });
      return res.end(body);
    }

    // ---------------- 调试台 ----------------
    if (p === '/api/debug/info') {
      const out = { ok: true };
      try { out.login = (await ob('get_login_info', {})).data; } catch (e) { out.loginErr = e.message; }
      try { out.friends = ((await ob('get_friend_list', {})).data || []).map((f) => ({ uid: f.user_id, nick: f.nickname, remark: f.remark })); } catch (e) { out.friendsErr = e.message; }
      try { out.groups = ((await ob('get_group_list', {})).data || []).map((g) => ({ gid: g.group_id, name: g.group_name, n: g.member_count })); } catch (e) { out.groupsErr = e.message; }
      out.whitelist = Object.entries(friendsMap()).map(([uid, name]) => ({ uid, name }));
      return sendJson(res, 200, out);
    }

    if (p === '/api/debug/send' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.text) return sendJson(res, 400, { ok: false, error: '内容不能为空' });
      const uid = Number(b.uid || OWNER);
      const r = await ob('send_private_msg', { user_id: uid, message: String(b.text) });
      log(`调试发私聊 → ${uid}`);
      return sendJson(res, 200, { ok: r.status === 'ok', ret: r });
    }

    if (p === '/api/debug/group' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.gid || !b.text) return sendJson(res, 400, { ok: false, error: '群号和内容都要填' });
      const r = await ob('send_group_msg', { group_id: Number(b.gid), message: String(b.text) });
      log(`调试发群聊 → ${b.gid}`);
      return sendJson(res, 200, { ok: r.status === 'ok', ret: r });
    }

    if (p === '/api/debug/friend' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.uid) return sendJson(res, 400, { ok: false, error: '缺 QQ 号' });
      const flag = b.flag || String(b.uid);
      const r = await ob('set_friend_add_request', { flag, approve: b.approve !== false });
      log(`调试好友审批 ${b.uid} → ${b.approve !== false ? '同意' : '拒绝'}`);
      return sendJson(res, 200, { ok: r.status === 'ok', ret: r });
    }

    if (p === '/api/debug/qzone' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.tid) return sendJson(res, 400, { ok: false, error: '缺 tid（说说编号）' });
      if (b.likeOnly) return sendJson(res, 200, await runNodeScript('qz_browser.mjs', [b.tid, '', '--like-only'], 90000));
      if (!b.text) return sendJson(res, 400, { ok: false, error: '要评论就填内容' });
      return sendJson(res, 200, await runNodeScript('qz_browser.mjs', [b.tid, b.text], 90000));
    }

    if (p === '/api/debug/summary' && req.method === 'POST') {
      const r = await ob('send_private_msg', { user_id: Number(OWNER), message: '/总结' });
      return sendJson(res, 200, { ok: r.status === 'ok', msg: '已让玉子强制汇总一次，结果会发到你 QQ' });
    }

    if (p === '/api/debug/raw' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.action) return sendJson(res, 400, { ok: false, error: '缺 action' });
      const r = await ob(String(b.action), b.params || {});
      return sendJson(res, 200, { ok: r.status === 'ok', ret: r });
    }

    if (p === '/api/qzone/state') {
      let st = {};
      try { st = JSON.parse(fs.readFileSync(path.join(DATA, 'qzone.json'), 'utf8')); } catch {}
      return sendJson(res, 200, { seen: (st.seen || []).slice(-8), pollMs: Number(CFG.QZ_POLL_MS || 60000) });
    }

    // ---------------- 人格调试：记忆包 ----------------
    if (p === '/api/mem/stats') {
      return sendJson(res, 200, { ok: true, ...memoryStats(), style: readStyle(), personaLen: readPersona().length });
    }

    // 导出目录（浏览器下载被系统权限挡住时的兜底：由控制台直接写盘）
    if (p === '/api/export-dir') {
      return sendJson(res, 200, { ok: true, dir: exportDirPath() });
    }
    if (p === '/api/open-export' && req.method === 'POST') {
      const d = exportDirPath();
      runHidden('explorer.exe', [d]);
      return sendJson(res, 200, { ok: true, dir: d });
    }
    // 真正的"随便选目录"：把字节交给托盘进程，由它弹 Windows 原生另存为
    // （浏览器端 showSaveFilePicker 在提权的 Edge 里会被沙箱挡住，写盘必失败）
    if (p === '/api/save/pick' && req.method === 'POST') {
      try {
        const b = await readBodyBig(req);
        const name = String(b.name || 'export.bin').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        const buf = Buffer.from(String(b.b64 || ''), 'base64');
        if (!buf.length) return sendJson(res, 400, { ok: false, error: '内容为空' });
        const r = await saveViaTray(name, buf);
        return sendJson(res, r.ok ? 200 : 500, r);
      } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
    }
    if (p === '/api/save-file' && req.method === 'POST') {
      try {
        const b = await readBodyBig(req);
        const name = String(b.name || 'export.bin').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        const buf = Buffer.from(String(b.b64 || ''), 'base64');
        if (!buf.length) return sendJson(res, 400, { ok: false, error: '内容为空' });
        const dir = exportDirPath();
        const file = path.join(dir, name);
        fs.writeFileSync(file, buf);
        log(`导出文件：${file}（${(buf.length / 1024).toFixed(0)}KB）`);
        return sendJson(res, 200, { ok: true, path: file, dir, size: buf.length });
      } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
    }

    if (p === '/api/mem/export') {
      const scope = url.searchParams.get('scope') || 'all';
      const limit = Number(url.searchParams.get('limit') || 0);
      const fmt = (url.searchParams.get('fmt') || 'yzm').toLowerCase();
      if (fmt === 'docx' || fmt === 'doc') {
        const r = exportMemoryDoc({ scope, fmt });
        log(`导出记忆文档（${fmt}）：${r.count} 条`);
        const fn = encodeURIComponent(r.filename);
        const ctype = fmt === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/msword';
        res.writeHead(200, {
          'Content-Type': ctype,
          'Content-Disposition': `attachment; filename="memory.${fmt}"; filename*=UTF-8''${fn}`,
          'Content-Length': r.buf.length,
          'Cache-Control': 'no-store'
        });
        return res.end(r.buf);
      }
      const r = exportMemory({ scope, limit });
      log(`导出记忆包：${r.count} 条，${r.sizeKB}KB`);
      const fn = encodeURIComponent(r.filename);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="memory.yzm"; filename*=UTF-8''${fn}`,
        'Content-Length': r.buf.length,
        'Cache-Control': 'no-store'
      });
      return res.end(r.buf);
    }

    if (p === '/api/mem/preview' && req.method === 'POST') {
      const b = await readBodyBig(req);
      if (b.__err) return sendJson(res, 400, { ok: false, error: b.__err });
      if (!b.data) return sendJson(res, 400, { ok: false, error: '没有收到文件内容' });
      try {
        const r = parseMemoryPack(Buffer.from(String(b.data), 'base64'));
        const byCh = {};
        for (const m of r.messages) byCh[m.ch] = (byCh[m.ch] || 0) + 1;
        return sendJson(res, 200, { ok: true, format: (r.meta && r.meta.format) || "", meta: r.meta, count: r.messages.length, byChannel: byCh, sample: r.messages.slice(0, 3) });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }

    if (p === '/api/mem/import' && req.method === 'POST') {
      const b = await readBodyBig(req);
      if (b.__err) return sendJson(res, 400, { ok: false, error: b.__err });
      if (!b.data) return sendJson(res, 400, { ok: false, error: '没有收到文件内容' });
      const mode = b.mode === 'replace' ? 'replace' : 'merge';
      try { await backup('pre-mem-import'); } catch {}
      try {
        const buf = Buffer.from(String(b.data), 'base64');
        if (!looksLikePack(buf)) {
          const r = importDocMemory(buf, String(b.name || ''), { mode });
          log(`导入文档记忆（${mode}）：新增 ${r.added}，重复 ${r.dup}，共 ${r.total}`);
          return sendJson(res, 200, { ok: true, ...r, asDoc: true });
        }
        const r = importMemory(buf, { mode });
        log(`导入记忆包（${mode}）：新增 ${r.added}，重复 ${r.dup}，共 ${r.total}`);
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }

    // ---------------- 人格调试：性格包 ----------------
    if (p === '/api/persona/pack') {
      const fmt = (url.searchParams.get('fmt') || 'yzp').toLowerCase();
      if (fmt === 'docx' || fmt === 'doc' || fmt === 'md') {
        const r = exportPersonaDoc({ fmt });
        const fn = encodeURIComponent(r.filename);
        const ctype = fmt === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : fmt === 'doc' ? 'application/msword' : 'text/markdown; charset=utf-8';
        res.writeHead(200, {
          'Content-Type': ctype,
          'Content-Disposition': `attachment; filename="persona.${fmt}"; filename*=UTF-8''${fn}`,
          'Content-Length': r.buf.length,
          'Cache-Control': 'no-store'
        });
        return res.end(r.buf);
      }
      const r = exportPersona();
      const fn = encodeURIComponent(r.filename);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="persona.yzp"; filename*=UTF-8''${fn}`,
        'Content-Length': r.buf.length,
        'Cache-Control': 'no-store'
      });
      return res.end(r.buf);
    }

    if (p === '/api/persona/style') {
      if (req.method === 'POST') {
        const b = await readBody(req);
        try { await backup('pre-style-change'); } catch {}
        const s = writeStyle(b.style || b || {});
        log('风格档案已更新');
        return sendJson(res, 200, { ok: true, style: s, block: styleBlock(s) });
      }
      return sendJson(res, 200, { ok: true, style: readStyle(), defaults: STYLE_DEFAULTS, block: styleBlock(), personaLen: readPersona().length });
    }

    if (p === '/api/persona/style/reset' && req.method === 'POST') {
      try { await backup('pre-style-reset'); } catch {}
      const s = writeStyle(STYLE_DEFAULTS);
      log('风格档案已重置');
      return sendJson(res, 200, { ok: true, style: s });
    }

    if (p === '/api/persona/ai' && req.method === 'POST') {
      const b = await readBodyBig(req);
      if (b.__err) return sendJson(res, 400, { ok: false, error: b.__err });
      const text = b.text || (b.data ? Buffer.from(String(b.data), 'base64').toString('utf8') : '');
      if (!text.trim()) return sendJson(res, 400, { ok: false, error: '没有人设文本' });
      const ai = await aiStyle(text, {
        apiKey: CFG.DEEPSEEK_API_KEY,
        base: CFG.DEEPSEEK_BASE || 'https://api.deepseek.com',
        model: CFG.STYLE_MODEL || 'deepseek-chat'
      });
      return sendJson(res, 200, { ok: !!ai, style: ai || {}, fallback: ai ? null : '（AI 分析失败，可先用手动编辑）' });
    }

    if (p === '/api/persona/import' && req.method === 'POST') {
      const b = await readBodyBig(req);
      if (b.__err) return sendJson(res, 400, { ok: false, error: b.__err });
      if (!b.data) return sendJson(res, 400, { ok: false, error: '没有收到文件内容' });
      try { await backup('pre-persona-import'); } catch {}
      try {
        const pm = path.join(ROOT, 'persona.md');
        if (fs.existsSync(pm)) {
          const dir = path.join(ROOT, 'data', 'persona-backup');
          fs.mkdirSync(dir, { recursive: true });
          fs.copyFileSync(pm, path.join(dir, 'persona-' + new Date().toISOString().replace(/[:.]/g, '-') + '.md'));
        }
      } catch {}
      try {
        const rawBuf = Buffer.from(String(b.data), 'base64');
        const srcBuf = looksLikePack(rawBuf) ? rawBuf : Buffer.from(personaTextFromDoc(rawBuf, String(b.name || '')), 'utf8');
        const r = await importPersona(srcBuf, {
          useAI: b.useAI !== false,
          apiKey: CFG.DEEPSEEK_API_KEY,
          base: CFG.DEEPSEEK_BASE || 'https://api.deepseek.com',
          model: CFG.STYLE_MODEL || 'deepseek-chat',
          mode: b.mode === 'append' ? 'append' : 'replace'
        });
        log(`导入性格包：人设 ${r.personaLen} 字，风格${r.aiUsed ? '（AI 分析）' : '（规则推断）'}`);
        return sendJson(res, 200, { ok: true, ...r, block: styleBlock(r.style) });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    // 静态文件
    let rel = p === '/' ? '/index.html' : p;
    const file = path.join(WEB, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(WEB)) return res.writeHead(403).end('forbidden');
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const b = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
      return res.end(b);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    log('ERR ' + e.message);
    try { sendJson(res, 500, { ok: false, error: e.message }); } catch {}
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`控制台已启动 http://127.0.0.1:${PORT}`);
  console.log(`玉子控制台 v0.1  http://127.0.0.1:${PORT}`);
});

// 单实例
process.on('uncaughtException', (e) => log('uncaught ' + e.message));
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log('控制台已经在跑了'); process.exit(0); }
  log('server error ' + e.message);
});
