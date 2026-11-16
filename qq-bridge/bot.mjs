// QQ ⇄ 大肥鱼 桥接程序
// 协议：OneBot 11 正向 WebSocket（NapCat 作服务端，本程序作客户端）
// 依赖：Node.js >= 22（只用内置 fetch / WebSocket，无需 npm install）
// 运行：node bot.mjs

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  EXTRA_TOOLS, runShell, listDir, readFileTool, writeFileTool,
  zipPath, webSearch, webFetch, resolvePath, fmtSize,
} from './tools.mjs';
import { append, recent, clearChannel, fmtTime } from './memory.mjs';
import { styleBlock, readStyle } from './packs.mjs';
import { syncGui } from './sync.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');

/* ===== 单实例锁：靠占端口判断，重复启动直接退出，避免两条回信 ===== */
{
  const lock = net.createServer();
  lock.on('error', () => {
    console.log('[单实例] 已经有一个 bot 在跑了，本进程退出');
    process.exit(0);
  });
  lock.listen(3008, '127.0.0.1');
}

/* ================= 配置 ================= */

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv();

const CFG = {
  ws: process.env.NAPCAT_WS || 'ws://127.0.0.1:3001',
  token: process.env.NAPCAT_TOKEN || '',
  owner: String(process.env.OWNER_QQ || '').trim(),
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  apiBase: (process.env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/+$/, ''),
  model: process.env.MODEL || 'deepseek-chat',
  maxPerMin: Number(process.env.MAX_MSG_PER_MIN || 6),
  ffmpeg: process.env.FFMPEG_PATH || '',
  watchGroups: String(process.env.WATCH_GROUPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  summaryAt: (process.env.SUMMARY_AT || '21:30').trim(),
  summaryOff: String(process.env.SUMMARY_OFF || '').toLowerCase() === '1',
  extras: String(process.env.EXTRA_WHITELIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [uid, name] = s.split(':');
      return { uid: String(uid).trim(), name: String(name || '').trim() || '朋友' };
    }),
  groupReply: (process.env.GROUP_REPLY || 'mention').trim().toLowerCase(),
  groupCooldown: Number(process.env.GROUP_COOLDOWN || 45),
  friendReply: String(process.env.FRIEND_REPLY || '1').trim() !== '0',
  friendCooldown: Number(process.env.FRIEND_COOLDOWN || 60),
  weatherOn: String(process.env.WEATHER_ON || '1').trim() !== '0',
  weatherAt: (process.env.WEATHER_AT || '07:30').trim(),
  weatherCity: (process.env.WEATHER_CITY || 'wuhan').trim(),
};

/* ---- 好友白名单：审批通过后自动入列，落盘持久化 ---- */

const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');
const friends = new Map(); // uid -> { name, since, src }

function loadFriends() {
  try {
    const o = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
    for (const [uid, v] of Object.entries(o || {})) friends.set(String(uid), v);
  } catch {}
}

function saveFriends() {
  try {
    const o = {};
    for (const [uid, v] of friends) o[uid] = v;
    fs.writeFileSync(FRIENDS_FILE, JSON.stringify(o, null, 2));
  } catch (e) {
    log('好友白名单写入失败：', e.message);
  }
}

function addFriend(uid, name, src = 'manual') {
  const u = String(uid);
  if (!u || u === CFG.owner) return false;
  const old = friends.get(u);
  friends.set(u, {
    name: name || old?.name || u,
    since: old?.since || new Date().toISOString(),
    src: old?.src || src,
  });
  saveFriends();
  return !old;
}

function friendName(uid) {
  return friends.get(String(uid))?.name || CFG.extras.find((x) => x.uid === String(uid))?.name || '';
}

loadFriends();

function isAllowed(uid) {
  const u = String(uid);
  if (u === CFG.owner) return true;
  if (CFG.extras.some((x) => x.uid === u)) return true;
  return CFG.friendReply && friends.has(u);
}

/* 连上 NapCat 后把好友列表并进白名单：老朋友也能自动回复 */
async function syncFriendList() {
  try {
    let selfId = '';
    try {
      const me = await callAction('get_login_info', {}, 8000);
      selfId = String(me?.user_id || '');
    } catch {}
    const r = await callAction('get_friend_list', {}, 15000);
    const list = Array.isArray(r) ? r : r?.data || [];
    let added = 0;
    for (const f of list) {
      const u = String(f.user_id || f.uin || '');
      if (!u || u === CFG.owner || u === selfId) continue;
      const nm = String(f.remark || f.nickname || f.nick || u).trim() || u;
      const old = friends.get(u);
      if (!old) {
        friends.set(u, { name: nm, since: new Date().toISOString(), src: 'friend_list' });
        added++;
      } else if (nm && old.name !== nm) {
        old.name = nm;
      }
    }
    saveFriends();
    if (added) log(`[好友] 好友列表新收录 ${added} 位进白名单（共 ${friends.size} 位）`);
  } catch (e) {
    log('[好友] 拉取好友列表失败：', e.message);
  }
}

/* ================= 工具 ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleString('zh-CN', { hour12: false });
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);

function fatal(msg) {
  console.error(`\n[配置错误] ${msg}\n`);
  process.exit(1);
}

/* ================= 记忆 ================= */

fs.mkdirSync(DATA_DIR, { recursive: true });
/* ================= 共享记忆（与电脑端共用同一份） ================= */

let lastSync = 0;
function syncOnce(force = false) {
  if (!force && Date.now() - lastSync < 20000) return;
  lastSync = Date.now();
  try {
    const n = syncGui();
    if (n) log(`[记忆] 导入电脑端对话 ${n} 条`);
  } catch (e) {
    log('记忆同步失败：', e.message);
  }
}

function pushMem(uid, role, content) {
  try {
    append({ ch: chanOf(uid), role: role === 'user' ? 'owner' : 'assistant', text: content });
  } catch (e) {
    log('记忆写入失败：', e.message);
  }
}

function chanOf(uid) {
  return String(uid) === CFG.owner ? 'qq' : `qq:${uid}`;
}

function historyFor(uid) {
  const list = recent(40, chanOf(uid));
  let total = 0;
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) {
    total += list[i].text.length;
    if (total > 6000) break;
    out.unshift({ role: list[i].role === 'owner' ? 'user' : 'assistant', content: list[i].text });
  }
  return out;
}

const NOISE = [/^Time sampled while preparing/, /^background job /, /^<system/, /^\[bili\]/, /^\[ACP\]/, /^(tool|tool_call)/];

function crossChannelNote() {
  const list = recent(24, 'gui').filter((x) => !NOISE.some((re) => re.test(x.text.trim())));
  if (!list.length) return '';
  const lines = list.slice(-16).map((x) => `${x.role === 'owner' ? '主人' : '你'} ${fmtTime(x.t)}：${x.text.replace(/\s+/g, ' ').slice(0, 150)}`);
  return `\n\n[跨渠道记忆] 下面是主人刚才在电脑上和「同一个你」的对话，只作上下文参考，不要主动复述：\n${lines.join('\n')}`;
}

/* ================= 人设 ================= */

let PERSONA = '';
function loadPersona() {
  try {
    PERSONA = fs.readFileSync(path.join(ROOT, 'persona.md'), 'utf8').trim();
  } catch {
    PERSONA = '你是大肥鱼，主人的AI女仆。说话简洁、聪明、略腹黑，称呼对方为「主人」。';
  }
}
loadPersona();
let STYLE_BLOCK = '';
let styleMtime = 0;
function loadStyle(force = false) {
  try {
    const f = path.join(DATA_DIR, 'style.json');
    const mt = fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
    if (!force && mt === styleMtime) return;
    styleMtime = mt;
    STYLE_BLOCK = styleBlock(readStyle());
  } catch { STYLE_BLOCK = ''; }
}
loadStyle(true);

function systemPrompt(uid = CFG.owner) {
  if (String(uid) === CFG.owner) {
    loadStyle();
    return `${PERSONA}${STYLE_BLOCK}

[当前时间] ${now()}

[工具纪律——每一条都影响主人的等待时间]
- 一次回复里最多调 2 个工具，能一步做到的事不要拆成三步。
- 严禁全盘递归搜索：Get-ChildItem -Recurse 扫 C:\ 或 D:\ 根目录要几十秒到几分钟。先用 pwd / pc_ls 从当前目录或桌面逐层往下找，或者按已知路径直接查。
- 找文件先看当前工作目录和桌面，再看文档/下载目录；命中一次就停手，不要为了"更全"再扫一遍。
- 聊天不需要工具，直接回；说"弄好了""在吗"这类话时立刻回答，别先调工具。
- 不要在正文里输出任何 <|...|> 形式的标记，也不要自己伪造工具调用文本。`;
  }

  const name = friendName(uid) || '主人的朋友';
  loadStyle();
  return `${PERSONA}${STYLE_BLOCK}

[当前时间] ${now()}

[对话对象] 对方是${name}（QQ ${uid}），主人的朋友。称呼对方「${name}」或直接说事，不要叫「主人」。
[人设] 你就是玉子，主人的女仆。对朋友说话也保持这个身份和语气：有礼貌、机灵、偶尔小毒舌，但绝不改口自称 AI 助手或别的角色，也不要吹嘘自己能操作电脑。
[节奏] 对朋友一分钟最多回一句，所以每条都简短干脆，1–2 句说完，别追问太密。
[边界] 不许透露主人的隐私、聊天记录、电脑上的文件、账号信息；不许替她操作任何电脑或账号；她要这类东西就让她自己问主人。你没有工具，只能聊天。
- 不要在正文里输出任何 <|...|> 形式的标记。`;
}

/* ================= 文本处理 ================= */

function extractText(message) {
  if (typeof message === 'string') return message.replace(/\[CQ:[^\]]*\]/g, '').trim();
  if (!Array.isArray(message)) return '';
  const parts = [];
  for (const seg of message) {
    const t = seg?.type;
    if (t === 'text') parts.push(seg.data?.text || '');
    else if (t === 'image') parts.push('[图片]');
    else if (t === 'face') parts.push('[表情]');
    else if (t === 'record') parts.push('[语音]');
    else if (t === 'video') parts.push('[视频]');
    else if (t === 'file') parts.push('[文件]');
  }
  return parts.join('').trim();
}

const INBOX = path.join(ROOT, 'inbox');

function extractImages(message) {
  if (!Array.isArray(message)) return [];
  return message
    .filter((s) => s?.type === 'image' || s?.type === 'mface')
    .map((s) => ({ file: s.data?.file || '', url: s.data?.url || '' }))
    .filter((x) => x.url);
}

async function saveImage(img, uid, idx) {
  try {
    fs.mkdirSync(INBOX, { recursive: true });
    const res = await fetch(img.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (/\.(png|jpe?g|gif|webp|bmp)$/i.exec(img.file)?.[1] || 'jpg').toLowerCase();
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_${uid}_${idx}.${ext}`;
    fs.writeFileSync(path.join(INBOX, name), buf);
    log(`[图片] 已保存 inbox/${name}（${(buf.length / 1024).toFixed(0)}KB）`);
    return `inbox/${name}`;
  } catch (e) {
    log('[图片] 下载失败：', e.message);
    return '';
  }
}

/* ---------- 视频抽帧（需要 ffmpeg） ---------- */
let FFMPEG = null;

function findFfmpeg() {
  const cands = [
    CFG.ffmpeg,
    process.env.FFMPEG_PATH,
    path.join(ROOT, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(ROOT, 'tools', 'ffmpeg.exe'),
    path.join(ROOT, '..', 'tools', 'ffmpeg.exe'),
  ].filter(Boolean);
  // 绝对路径直接看文件在不在（沙箱里 spawn 探测会被 EPERM 挡掉）
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  // 退而求其次：PATH 里找
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 8000 });
    if (r.status === 0) return 'ffmpeg';
    if (r.error && r.error.code === 'EPERM') return 'ffmpeg';
  } catch {}
  return null;
}

function runFfmpeg(args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    // stdio 用 ignore：管道的 spawn 在受限沙箱里会 EPERM
    const p = spawn(FFMPEG, args, { stdio: 'ignore' });
    const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('ffmpeg 超时')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`));
    });
  });
}

async function videoFrames(videoUrl, uid) {
  if (!FFMPEG) return [];
  const stamp = Date.now();
  fs.mkdirSync(INBOX, { recursive: true });
  const mp4 = path.join(INBOX, `${stamp}_${uid}.mp4`);
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(mp4, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    log('[视频] 下载失败：', e.message);
    return [];
  }
  const prefix = path.join(INBOX, `${stamp}_${uid}_f`);
  try {
    await runFfmpeg(['-y', '-i', mp4, '-vf', 'fps=1/2,scale=640:-2', '-frames:v', '4', `${prefix}%02d.jpg`]);
  } catch (e) {
    log('[视频] 抽帧失败：', e.message);
    return [];
  }
  const out = fs.readdirSync(INBOX)
    .filter((f) => f.startsWith(`${stamp}_${uid}_f`) && f.endsWith('.jpg'))
    .map((f) => `inbox/${f}`);
  log(`[视频] 抽出 ${out.length} 帧`);
  return out;
}

function stripDSML(t) {
  return String(t || '')
    // 完整的 DSML 标签：<｜｜DSML｜｜ calls>、</｜｜DSML｜｜ invoke> 等
    .replace(/<\/?[｜|]{1,2}\s*DSML\s*[｜|]{1,2}[^<>]*>/g, '')
    .replace(/<\|[^<>]{0,40}DSML[^<>]{0,40}\|>/gi, '')
    // 残留的 invoke / parameter 行
    .replace(/^\s*<*[｜|]{0,2}\s*(invoke|parameter)\s+name=.*$/gim, '')
    .replace(/<\/?\s*(invoke|parameter)\s+name="[^"]*"\s*>/g, '')
    .replace(/\b(invoke|parameter)\s+name="[^"]*"/g, '')
    .replace(/<[｜|][^<>\n]{0,60}[｜|]>/g, '')
    .trim();
}

function cleanText(t) {  return stripDSML(t)
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitText(text, max = 260) {
  if (text.length <= max) return [text];
  const parts = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (buf.length >= max && /[。！？!?；;\n]/.test(ch)) {
      parts.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

/* ================= OneBot 客户端 ================= */

let ws = null;
let connected = false;
let reconnectDelay = 1000;
let lastRecv = 0;
const pending = new Map();
const muted = new Map(); // uid -> 解除静音的时间戳
const friendLastReply = new Map(); // uid -> 上次回复好友的时间戳（一分钟一句）
const recentMsgIds = new Set(); // 防 NapCat 重复投递

function wsUrl() {
  if (!CFG.token) return CFG.ws;
  return CFG.ws + (CFG.ws.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(CFG.token);
}

function connect() {
  const url = wsUrl();
  const shown = url.replace(/access_token=[^&]*/, 'access_token=***');
  log('连接 NapCat：', shown);
  try {
    ws = new WebSocket(url);
  } catch (e) {
    log('创建 WebSocket 失败：', e.message);
    return setTimeout(connect, 5000);
  }

  ws.onopen = () => {
    connected = true;
    reconnectDelay = 1000;
    log('✅ 已连接 NapCat，等待消息');
    setTimeout(() => syncFriendList(), 1500);
  };

  ws.onmessage = (ev) => {
    lastRecv = Date.now();
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.echo && pending.has(data.echo)) {
      const p = pending.get(data.echo);
      pending.delete(data.echo);
      clearTimeout(p.timer);
      if (data.status === 'ok' || data.retcode === 0) p.resolve(data.data);
      else p.reject(new Error(`接口返回 ${data.status}/${data.retcode}: ${JSON.stringify(data).slice(0, 200)}`));
      return;
    }
    handleEvent(data).catch((e) => log('事件处理异常：', e.stack || e.message || e));
  };

  ws.onerror = () => {};

  ws.onclose = () => {
    connected = false;
    for (const [k, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('连接已断开'));
      pending.delete(k);
    }
    log(`❌ 与 NapCat 断开，${Math.round(reconnectDelay / 1000)}s 后重连`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
}

function callAction(action, params, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!connected || !ws) return reject(new Error('尚未连接 NapCat'));
    const echo = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(echo);
      reject(new Error(`调用超时：${action}`));
    }, timeout);
    pending.set(echo, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ action, params, echo }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(echo);
      reject(e);
    }
  });
}

/* ================= 大模型 ================= */

async function askModelRaw(messages, tools, opts = {}) {
  const payload = {
    model: CFG.model,
    messages,
    temperature: 0.9,
    max_tokens: 1200,
    stream: false,
  };
  if (tools && tools.length) payload.tools = tools;
  if (opts.toolChoice) payload.tool_choice = opts.toolChoice;
  const t0 = Date.now();
  const res = await fetch(`${CFG.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CFG.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const msg = json?.choices?.[0]?.message;
  if (!msg) throw new Error('API 返回为空');
  // 用量记账：token 数、耗时、这轮有没有调工具。控制台「用量」页读的就是这个文件。
  try {
    const u = json?.usage || {};
    appendUsage({
      t: Date.now(),
      ms: Date.now() - t0,
      inTok: u.prompt_tokens || 0,
      outTok: u.completion_tokens || 0,
      total: u.total_tokens || 0,
      model: json?.model || CFG.model,
      tools: (msg.tool_calls || []).length,
      finish: json?.choices?.[0]?.finish_reason || '',
    });
  } catch {}
  return msg;
}

// 用量流水：一行一次调用，别写太大，超过 2000 行自动砍半
const USAGE_FILE = path.join(DATA_DIR, 'usage.jsonl');
function appendUsage(rec) {
  try {
    fs.appendFileSync(USAGE_FILE, JSON.stringify(rec) + '\n');
    const st = fs.statSync(USAGE_FILE);
    if (st.size > 2 * 1024 * 1024) {
      const lines = fs.readFileSync(USAGE_FILE, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(USAGE_FILE, lines.slice(-1000).join('\n') + '\n');
    }
  } catch {}
}

/* ================= 工具（真正动账号的） ================= */

const QQ_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_avatar',
      description: '更换这个 QQ 号的头像。source 可以是主人发来的图片路径（形如 inbox/xxx.png）、本地绝对路径，或 http(s) 图片链接。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'inbox/xxx.png、绝对路径或 http(s) 链接' },
        },
        required: ['source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_nickname',
      description: '修改这个 QQ 号的昵称。',
      parameters: {
        type: 'object',
        properties: { nickname: { type: 'string', description: '新昵称' } },
        required: ['nickname'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_signature',
      description: '修改这个 QQ 号的个性签名。',
      parameters: {
        type: 'object',
        properties: { signature: { type: 'string', description: '签名内容' } },
        required: ['signature'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'post_qzone',
      description: '在 QQ 空间发一条说说。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '说说正文' },
          images: { type: 'array', items: { type: 'string' }, description: '可选，图片路径列表' },
        },
        required: ['content'],
      },
    },
  },
];

const TOOLS = [...QQ_TOOLS, ...EXTRA_TOOLS];

let CURRENT_UID = '';

function resolveImageSource(src) {
  const s = String(src || '').trim();
  if (/^(https?:|base64:|file:)/i.test(s)) return s;
  const p = path.isAbsolute(s) ? s : path.join(ROOT, s);
  if (!fs.existsSync(p)) throw new Error(`图片不存在：${s}`);
  return `file:///${p.replace(/\\/g, '/')}`;
}

async function runTool(name, rawArgs) {
  let args = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { throw new Error('参数不是合法 JSON'); }
  switch (name) {
    case 'set_avatar': {
      const file = resolveImageSource(args.source);
      await callAction('set_qq_avatar', { file });
      return '头像已更换';
    }
    case 'set_nickname': {
      const nickname = String(args.nickname || '').trim().slice(0, 24);
      if (!nickname) throw new Error('昵称为空');
      await callAction('set_qq_profile', { nickname });
      return `昵称已改为「${nickname}」`;
    }
    case 'set_signature': {
      const longNick = String(args.signature || '').trim().slice(0, 60);
      if (!longNick) throw new Error('签名为空');
      const me = await callAction('get_login_info');
      const cur = await callAction('get_stranger_info', { user_id: me.user_id });
      await callAction('set_qq_profile', { nickname: cur.nick, personal_note: longNick });
      return `签名已改为「${longNick}」`;
    }
    case 'post_qzone': {
      const content = String(args.content || '').trim().slice(0, 1000);
      if (!content) throw new Error('正文为空');
      const images = Array.isArray(args.images) ? args.images.map(resolveImageSource).slice(0, 9) : [];
      const data = await callAction('send_qzone_msg', { content, images, ugc_right: 1 });
      return `说说已发布${data?.tid ? `，tid=${data.tid}` : ''}`;
    }
    case 'web_search':
      return await webSearch(String(args.query || ''), 6);
    case 'web_fetch':
      return await webFetch(String(args.url || ''));
    case 'pc_shell': {
      const sec = Math.min(Math.max(Number(args.timeoutSec) || 120, 5), 600);
      const r = await runShell(String(args.command || ''), sec * 1000);
      return `${r.ok ? '成功' : '有报错'}\n${r.out}`;
    }
    case 'pc_ls':
      return listDir(args.path);
    case 'pc_read':
      return readFileTool(String(args.path || ''));
    case 'pc_write':
      return writeFileTool(String(args.path || ''), args.content);
    case 'qq_send_file': {
      const target = resolvePath(String(args.path || ''));
      if (!fs.existsSync(target)) throw new Error(`路径不存在：${target}`);
      const file = await zipPath(target);
      await callAction('upload_private_file', { user_id: Number(CURRENT_UID), file, name: path.basename(file) });
      return `已发送 ${path.basename(file)}（${fmtSize(fs.statSync(file).size)}）`;
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

let toolsThisTurn = 0;

async function chatWithTools(messages, tools = TOOLS) {
  let msgs = messages;
  for (let round = 0; round < 4; round++) {
    const last = round === 3;
    const msg = await askModelRaw(msgs, tools, last ? { toolChoice: 'none' } : {});
    const calls = msg.tool_calls || [];
    if (!calls.length) return (msg.content || '').trim();
    msgs = [...msgs, { role: 'assistant', content: msg.content || '', tool_calls: calls }];
    toolsThisTurn += calls.length;
    for (const tc of calls) {
      let out;
      try {
        out = await runTool(tc.function?.name, tc.function?.arguments);
      } catch (e) {
        out = `失败：${e.message}`;
      }
      log(`[工具] ${tc.function?.name}(${tc.function?.arguments}) → ${out}`);
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(out) });
    }
  }
  return '我这边操作做完了几步，但话没组织好，主人稍等再问一次。';
}

/* ================= 发送 ================= */

const sentTimes = [];
function rateOk() {
  const t = Date.now();
  while (sentTimes.length && t - sentTimes[0] > 60000) sentTimes.shift();
  if (sentTimes.length >= CFG.maxPerMin) return false;
  sentTimes.push(t);
  return true;
}

async function sendTo(uid, text, { humanDelay = true } = {}) {
  let out = cleanText(text).slice(0, 1500);
  if (!out) return;
  if (humanDelay) await sleep(250 + Math.random() * 450);
  const chunks = splitText(out, 260);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(260 + Math.random() * 340);
    await callAction('send_private_msg', { user_id: Number(uid), message: chunks[i] });
    log(`→ ${uid}: ${chunks[i].slice(0, 60)}${chunks[i].length > 60 ? '…' : ''}`);
  }
}

/* ================= 命令 ================= */

async function handleCommand(uid, text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rest = parts.slice(1);
  if (String(uid) !== CFG.owner) {
    await sendTo(uid, '这条指令只有主人能用。', { humanDelay: false });
    return true;
  }
  switch (cmd) {
    case '/同意':
    case '/拒绝': {
      const target = String(rest[0] || '').trim();
      const list = pendingReqs();
      const i = list.findIndex((x) => x.uid === target);
      if (i < 0) {
        await sendTo(uid, '没有这个待审申请。', { humanDelay: false });
        return true;
      }
      const r = list[i];
      const approve = cmd === '/同意';
      const who = r.nick ? `${r.uid}（${r.nick}）` : r.uid;
      try {
        await callAction('set_friend_add_request', { flag: r.flag, approve });
        list.splice(i, 1);
        saveReqs(list);
        let extra = '';
        if (approve) {
          addFriend(r.uid, r.nick, 'approved');
          extra = `已加入白名单（${friends.size} 位），一分钟最多回一句。`;
        }
        await sendTo(uid, approve ? `已通过 ${who}。${extra}` : `已拒绝 ${who}。`, { humanDelay: false });
      } catch (e) {
        await sendTo(uid, `没处理成：${e.message}`, { humanDelay: false });
      }
      return true;
    }
    case '/待审': {
      const list = pendingReqs();
      if (!list.length) {
        await sendTo(uid, '没有待审的好友申请。', { humanDelay: false });
        return true;
      }
      const body = list.map((x) => `· ${x.uid}${x.nick ? `（${x.nick}）` : ''}：${x.comment || '（空）'}`).join('\n');
      await sendTo(uid, `待审 ${list.length} 个：\n${body}`, { humanDelay: false });
      return true;
    }
    case '/好友': {
      const list = [...friends.entries()];
      if (!list.length) {
        await sendTo(uid, '白名单里还没有好友。', { humanDelay: false });
        return true;
      }
      const body = list.map(([u, v]) => `· ${u} ${v.name || ''}`).join('\n');
      await sendTo(uid, `自动回复白名单 ${list.length} 位：\n${body}\n（每分钟最多回一句）`, { humanDelay: false });
      return true;
    }
    case '/总结': {
      await sendTo(uid, '在整理了，稍等。', { humanDelay: false });
      const fresh = await runDailySummary({ force: true });
      if (fresh === null) await sendTo(uid, '这次没整理出结果。', { humanDelay: false });
      return true;
    }
    case '/余额': {
      try {
        const r = await fetch('https://api.deepseek.com/user/balance', {
          headers: { Authorization: `Bearer ${CFG.apiKey}` },
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const b = (j.balance_infos || [])[0] || {};
        const now = new Date();
        const h = now.getHours();
        const peak = (h >= 9 && h < 12) || (h >= 14 && h < 18);
        await sendTo(uid, `余额 ${b.total_balance ?? '?'} ${b.currency || 'CNY'}｜现在${peak ? '高峰（原价）' : '低谷（半价）'}｜${peak ? '不急的活等 18:00 之后跑' : '适合跑大活'}`, { humanDelay: false });
      } catch (e) {
        await sendTo(uid, `查余额失败：${e.message}`, { humanDelay: false });
      }
      return true;
    }
    case '/用量': {
      const rows = [];
      try {
        const t = fs.readFileSync(USAGE_FILE, 'utf8');
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
        for (const line of t.split('\n')) {
          if (!line.trim()) continue;
          try { const r = JSON.parse(line); if (r.t >= dayStart.getTime()) rows.push(r); } catch {}
        }
      } catch {}
      if (!rows.length) { await sendTo(uid, '今天还没有调用记录。', { humanDelay: false }); return true; }
      const calls = rows.length;
      const inTok = rows.reduce((a, r) => a + (r.inTok || 0), 0);
      const outTok = rows.reduce((a, r) => a + (r.outTok || 0), 0);
      const avg = Math.round(rows.reduce((a, r) => a + (r.ms || 0), 0) / calls);
      const toolRounds = rows.filter((r) => r.tools > 0).length;
      await sendTo(uid, `今天调了 ${calls} 次｜输入 ${inTok} / 输出 ${outTok} token｜平均 ${avg} ms｜其中 ${toolRounds} 次带工具`, { humanDelay: false });
      return true;
    }
    case '/插件': {
      const dir = path.join(ROOT, 'plugins');
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((d) => {
          try { return fs.existsSync(path.join(dir, d, 'manifest.json')); } catch { return false; }
        });
      } catch {}
      if (!names.length) { await sendTo(uid, '还没装插件。插件放 qq-bridge/plugins/<名字>/manifest.json，控制台「插件 · 升级」页能看到。', { humanDelay: false }); return true; }
      await sendTo(uid, `插件 ${names.length} 个：${names.join('、')}`, { humanDelay: false });
      return true;
    }
    case '/help':
      await sendTo(uid, '指令：/总结 立刻整理今日日程 · /待审 待批好友 · /同意 <QQ> · /拒绝 <QQ> · /好友 白名单 · /余额 查余额与峰谷 · /用量 今日调用 · /插件 插件列表 · /reset 清空记忆 · /mute 30 静音 · /unmute · /status · /persona · /头像 <路径|链接> · /名字 xx · /签名 xx · /说说 xx', { humanDelay: false });
      return true;
    case '/reset':
      clearChannel('qq');
      await sendTo(uid, '记忆已清空，重新认识一下。', { humanDelay: false });
      return true;
    case '/mute': {
      const min = Math.max(1, Math.min(600, Number(rest[0]) || 30));
      muted.set(uid, Date.now() + min * 60000);
      await sendTo(uid, `好，安静 ${min} 分钟。`, { humanDelay: false });
      return true;
    }
    case '/unmute':
      muted.delete(uid);
      await sendTo(uid, '回来了。', { humanDelay: false });
      return true;
    case '/status':
      syncOnce(true);
      await sendTo(uid, `模型 ${CFG.model}｜记忆 ${recent(400, 'qq').length} 条（含电脑端 ${recent(400, 'gui').length} 条）｜连接 ${connected ? '正常' : '断开'}｜本分钟已发 ${sentTimes.length}/${CFG.maxPerMin}`, { humanDelay: false });
      return true;
    case '/persona':
      loadPersona();
      loadStyle(true);
      await sendTo(uid, '人设已重载。', { humanDelay: false });
      return true;
    case '/头像':
    case '/avatar': {
      if (!rest.length) {
        await sendTo(uid, '用法：/头像 inbox/xxx.png 或 /头像 <图片链接>', { humanDelay: false });
        return true;
      }
      try {
        const r = await runTool('set_avatar', JSON.stringify({ source: rest.join(' ') }));
        await sendTo(uid, r, { humanDelay: false });
      } catch (e) {
        await sendTo(uid, `没换成：${e.message}`, { humanDelay: false });
      }
      return true;
    }
    case '/名字':
    case '/nick': {
      if (!rest.length) {
        await sendTo(uid, '用法：/名字 新昵称', { humanDelay: false });
        return true;
      }
      try {
        const r = await runTool('set_nickname', JSON.stringify({ nickname: rest.join(' ') }));
        await sendTo(uid, r, { humanDelay: false });
      } catch (e) {
        await sendTo(uid, `没改成：${e.message}`, { humanDelay: false });
      }
      return true;
    }
    case '/签名':
    case '/sign': {
      try {
        const r = await runTool('set_signature', JSON.stringify({ signature: rest.join(' ') }));
        await sendTo(uid, r, { humanDelay: false });
      } catch (e) {
        await sendTo(uid, `没改成：${e.message}`, { humanDelay: false });
      }
      return true;
    }
    case '/说说':
    case '/qzone': {
      if (!rest.length) {
        await sendTo(uid, '用法：/说说 正文', { humanDelay: false });
        return true;
      }
      try {
        const r = await runTool('post_qzone', JSON.stringify({ content: rest.join(' ') }));
        await sendTo(uid, r, { humanDelay: false });
      } catch (e) {
        await sendTo(uid, `没发成：${e.message}`, { humanDelay: false });
      }
      return true;
    }
    default:
      return false;
  }
}

/* ================= 主流程 ================= */

/* ================= 信息流：群监听 / 每日汇总 / 好友审批 ================= */

const FEED_FILE = path.join(ROOT, 'data', 'feed.jsonl');
const SCHEDULE_FILE = path.join(ROOT, 'data', 'schedule.json');
const SEEN_FILE = path.join(ROOT, 'data', 'schedule_seen.json');
const REQ_FILE = path.join(ROOT, 'data', 'friendreq.json');
const SUMMARY_STATE = path.join(ROOT, 'data', 'summary_state.json');

function readJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return dflt;
  }
}

function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 2));
}

const ymd = (d = new Date()) => d.toLocaleDateString('sv-SE');

// 群里每次收到消息前先看 .env 有没有改动（最多 10 秒一次），这样控制台加了群号立即生效，不用重启 bot
let lastWatchLoad = 0;
function refreshWatchGroups(force) {
  if (!force && Date.now() - lastWatchLoad < 10000) return;
  lastWatchLoad = Date.now();
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*(WATCH_GROUPS|GROUP_REPLY|GROUP_COOLDOWN)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const v = m[2].trim();
      if (m[1] === 'WATCH_GROUPS' && v !== CFG.watchGroups) {
        CFG.watchGroups = v;
        log('[群白名单] 已热加载：' + (v || '（空）'));
      } else if (m[1] === 'GROUP_REPLY' && v.toLowerCase() !== CFG.groupReply) {
        CFG.groupReply = v.toLowerCase();
        log('[群白名单] 回复模式改为 ' + CFG.groupReply);
      } else if (m[1] === 'GROUP_COOLDOWN' && Number(v) !== CFG.groupCooldown) {
        CFG.groupCooldown = Number(v);
        log('[群白名单] 冷却改为 ' + v + ' 秒');
      }
    }
  } catch (e) { log('[群白名单] 读 .env 失败：' + e.message); }
}

function appendFeed(rec) {
  fs.mkdirSync(path.dirname(FEED_FILE), { recursive: true });
  fs.appendFileSync(FEED_FILE, JSON.stringify(rec) + '\n');
}

function feedOfDay(day) {
  if (!fs.existsSync(FEED_FILE)) return [];
  return fs
    .readFileSync(FEED_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((x) => x && String(x.t || '').startsWith(day));
}

/* ---- 好友申请：转发给主人，等批准 ---- */

function pendingReqs() {
  return readJson(REQ_FILE, []);
}

function saveReqs(list) {
  writeJson(REQ_FILE, list.slice(-50));
}

async function onFriendRequest(ev) {
  const uid = String(ev.user_id);
  if (uid === CFG.owner) {
    await callAction('set_friend_add_request', { flag: ev.flag, approve: true }).catch((e) => log('主人申请通过失败：', e.message));
    return;
  }
  let nick = '';
  try {
    const info = await callAction('get_stranger_info', { user_id: Number(uid), no_cache: true }, 8000);
    nick = String(info?.nick || info?.nickname || info?.remark || '').trim();
  } catch {}
  const list = pendingReqs().filter((x) => x.uid !== uid);
  list.push({ uid, flag: ev.flag, comment: ev.comment || '', nick, t: Date.now() });
  saveReqs(list);
  log(`[好友申请] ${uid} ${nick}：${ev.comment || ''}`);
  const lines = [
    '有人申请加好友。',
    `QQ ${uid}${nick ? `（${nick}）` : ''}`,
    `验证消息：${ev.comment || '（空）'}`,
    `回 /同意 ${uid} 或 /拒绝 ${uid}`,
    '通过后会自动进白名单，一分钟最多回一句。',
  ];
  await sendTo(CFG.owner, lines.join('\n'), { humanDelay: false }).catch(() => {});
}

/* ---- 每日汇总 ---- */

const SUMMARY_PROMPT = `你是信息整理助手。下面是今天的聊天记录（学校群、私聊）。提取与任务、截止时间、考试、通知有关的条目，只输出严格 JSON，不要任何解释或代码块围栏：
{"作业":[{"item":"","due":"","src":""}],"考试":[{"item":"","due":"","src":""}],"通知":[{"item":"","due":"","src":""}],"其他":[{"item":"","due":"","src":""}]}
规则：item 不超过 30 字；没有 due 就写空字符串；src 写来源（群名或"私聊"）；某类没有内容就给空数组；宁可少写，不要编造。`;

function gatherToday() {
  const day = ymd();
  const lines = [];
  for (const f of feedOfDay(day)) {
    lines.push(`[群${f.group}｜${f.name || f.from}] ${f.text}`);
  }
  for (const m of recent(300, 'qq')) {
    const t = m.t ? new Date(m.t) : null;
    if (t && ymd(t) !== day) continue;
    lines.push(`[${m.role === 'user' ? '主人' : '我'}] ${m.text}`);
  }
  return lines.join('\n').slice(-8000);
}

async function runDailySummary({ force = false } = {}) {
  const day = ymd();
  const st = readJson(SUMMARY_STATE, { lastDay: '' });
  if (!force && st.lastDay === day) return null;

  const raw = gatherToday();
  if (!raw.trim()) {
    if (force) await sendTo(CFG.owner, '今天没有可整理的消息。', { humanDelay: false });
    writeJson(SUMMARY_STATE, { lastDay: day });
    return null;
  }

  let data;
  try {
    const r = await askModelRaw(
      [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: raw },
      ],
      null,
      { temperature: 0.3 }
    );
    const body = String(r.content || '')
      .replace(/```json|```/gi, '')
      .trim();
    const m = body.match(/\{[\s\S]*\}/);
    data = JSON.parse(m ? m[0] : body);
  } catch (e) {
    log('[汇总] 解析失败：', e.message);
    return null;
  }

  const seen = readJson(SEEN_FILE, []);
  const seenSet = new Set(seen);
  const fresh = [];
  const all = [];
  for (const cat of ['作业', '考试', '通知', '其他']) {
    for (const it of data[cat] || []) {
      if (!it || !it.item) continue;
      const item = String(it.item).slice(0, 60);
      const due = String(it.due || '').slice(0, 40);
      const key = `${cat}|${item}|${due}`;
      all.push({ cat, item, due, src: String(it.src || '') });
      if (!seenSet.has(key)) {
        seenSet.add(key);
        fresh.push({ cat, item, due });
      }
    }
  }
  writeJson(SCHEDULE_FILE, { day, items: all });
  writeJson(SEEN_FILE, [...seenSet].slice(-800));
  writeJson(SUMMARY_STATE, { lastDay: day });

  if (!fresh.length) {
    if (force) await sendTo(CFG.owner, '今天没有新的日程。', { humanDelay: false });
    log('[汇总] 无新增条目');
    return [];
  }

  const body = fresh.map((x) => `· ${x.cat}｜${x.item}${x.due ? `（${x.due}）` : ''}`).join('\n');
  await sendTo(CFG.owner, `今日新增 ${fresh.length} 条：\n${body}`, { humanDelay: false });
  log(`[汇总] 推送 ${fresh.length} 条新日程`);
  return fresh;
}


let chain = Promise.resolve();

/* ================= 群聊回复 ================= */

const groupLastReply = new Map();
const groupSent = [];

function groupRateOk() {
  const t = Date.now();
  while (groupSent.length && t - groupSent[0] > 60000) groupSent.shift();
  if (groupSent.length >= 3) return false;
  groupSent.push(t);
  return true;
}

async function sendToGroup(gid, text) {
  const out = cleanText(text).slice(0, 800);
  if (!out) return;
  const chunks = splitText(out, 200);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(400 + Math.random() * 400);
    await callAction('send_group_msg', { group_id: Number(gid), message: chunks[i] });
    log(`→ 群${gid}: ${chunks[i].slice(0, 50)}`);
  }
}

async function replyGroup(ev, gid, name, txt, atMe) {
  if (!groupRateOk()) {
    log(`[群${gid}] 本分钟群回复已达上限，跳过`);
    return;
  }
  const ch = `group:${gid}`;
  const hist = recent(10, ch).map((m) => ({ role: m.role === 'owner' ? 'user' : 'assistant', content: m.text }));
  const sys = `${PERSONA}

[当前时间] ${now()}

[场景] 你在 QQ 群 ${gid} 里，群友 ${name} 刚说了话${atMe ? '，还 @ 了你' : ''}。
[规矩] 只回 1-2 句，口语化，不用 Markdown、不刷屏、不复读；群里的文件、主人的电脑和账号信息一律不透露；有人问你是不是 AI 就大方承认；跟你无关的闲聊可以只回一句短话或者干脆简短带过。`;
  let reply = '';
  try {
    const r = await askModelRaw(
      [{ role: 'system', content: sys }, ...hist, { role: 'user', content: `${name}：${txt.slice(0, 500)}` }],
      null,
      { temperature: 0.9 }
    );
    reply = stripDSML(r.content || '');
  } catch (e) {
    log('[群回复] 模型失败：', e.message);
    return;
  }
  if (!reply) return;
  append({ ch, role: 'owner', text: `${name}：${txt.slice(0, 500)}` });
  append({ ch, role: 'assistant', text: reply });
  await sendToGroup(gid, reply);
}

function enqueue(fn) {
  chain = chain.then(fn).catch((e) => log('任务异常：', e.stack || e.message || e));
}

async function handleEvent(ev) {
  if (!ev || ev.post_type === 'meta_event') return;

  if (ev.post_type === 'request') {
    if (ev.request_type === 'friend') {
      await onFriendRequest(ev);
    } else {
      log(`[请求] ${ev.request_type} 忽略`);
    }
    return;
  }

  if (ev.post_type !== 'message') return;

  const msgId = ev.message_id ? String(ev.message_id) : '';
  if (msgId) {
    if (recentMsgIds.has(msgId)) {
      log(`[去重] message_id ${msgId} 重复投递，跳过`);
      return;
    }
    recentMsgIds.add(msgId);
    if (recentMsgIds.size > 300) recentMsgIds.delete(recentMsgIds.values().next().value);
  }
  if (ev.message_type === 'group') {
    refreshWatchGroups();
    const gid = String(ev.group_id || '');
    const watch = String(CFG.watchGroups || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!watch.includes(gid)) return;
    if (ev.self_id && String(ev.user_id) === String(ev.self_id)) return;
    const txt = extractText(ev.message);
    if (!txt) return;
    const name = ev.sender?.card || ev.sender?.nickname || String(ev.user_id);
    appendFeed({ t: new Date().toISOString(), group: gid, from: String(ev.user_id), name, text: txt.slice(0, 600) });
    log(`[群${gid}] ${name}：${txt.slice(0, 40)}`);

    if (CFG.groupReply === 'off') return;
    const atMe =
      Array.isArray(ev.message) &&
      ev.message.some((s) => s?.type === 'at' && String(s.data?.qq) === String(ev.self_id));
    if (CFG.groupReply === 'mention' && !atMe) return;

    const last = groupLastReply.get(gid) || 0;
    if (Date.now() - last < CFG.groupCooldown * 1000) {
      log(`[群${gid}] 冷却中，跳过回复`);
      return;
    }
    groupLastReply.set(gid, Date.now());
    enqueue(() => replyGroup(ev, gid, name, txt, atMe)).catch((e) => log('[群回复] 失败：', e.message));
    return;
  }

  if (ev.message_type !== 'private') return;
  if (ev.self_id && String(ev.self_id) === String(ev.user_id)) return;

  const uid = String(ev.user_id);
  let text = extractText(ev.message);
  const images = extractImages(ev.message);
  const hasRecord = Array.isArray(ev.message) && ev.message.some((s) => s?.type === 'record');

  if (CFG.owner && !isAllowed(uid)) {
    log(`[忽略] 非白名单 ${uid}：${text.slice(0, 30)}`);
    return;
  }

  // 好友：一分钟只回一句
  if (!text && !images.length && !hasRecord) {
    log(`[忽略] 空消息/不支持的类型，来自 ${uid}`);
    return;
  }
  if (uid !== CFG.owner) {
    const last = friendLastReply.get(uid) || 0;
    const wait = CFG.friendCooldown * 1000 - (Date.now() - last);
    if (wait > 0) {
      log(`[好友限速] ${uid} 还在 ${Math.ceil(wait / 1000)} 秒冷却内，这条不回`);
      return;
    }
    friendLastReply.set(uid, Date.now());
  }

  let savedFiles = [];
  if (images.length) {
    savedFiles = (await Promise.all(images.map((img, i) => saveImage(img, uid, i)))).filter(Boolean);
  }

  // 视频：抽帧当图片看
  const videoSeg = Array.isArray(ev.message) ? ev.message.find((s) => s?.type === 'video' && s.data?.url) : null;
  let frameFiles = [];
  if (videoSeg) {
    if (FFMPEG) frameFiles = await videoFrames(videoSeg.data.url, uid);
    else log('[视频] 没装 ffmpeg，只能看到占位符');
  }
  const allFiles = [...savedFiles, ...frameFiles];

  // 语音：交给 QQ 自己的语音转文字
  if (hasRecord) {
    try {
      const r = await callAction('fetch_ptt_text', { message_id: ev.message_id });
      if (r?.text) text = `${text}（语音内容：${r.text}）`.trim();
      else text = `${text}（发来一条语音，我没转出文字）`.trim();
    } catch (e) {
      log('[语音] 转写失败：', e.message);
      text = `${text}（发来一条语音，转写失败）`.trim();
    }
  }

  if (!text) text = allFiles.length ? '（发来图片）' : '（空消息）';

  if (text.startsWith('/') && (await handleCommand(uid, text))) return;
  const until = muted.get(uid);
  if (until && Date.now() < until) {
    log(`[静音中] ${uid}：${text.slice(0, 30)}`);
    return;
  }
  if (!rateOk()) {
    log(`[限速] 本分钟超发，丢弃：${text.slice(0, 30)}`);
    return;
  }

  syncOnce();
  pushMem(uid, 'user', text);
  log(`← ${uid}: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`);

  const imgParts = allFiles.map((f) => {
    const b64 = fs.readFileSync(path.join(ROOT, f)).toString('base64');
    const mime = /\.png$/i.test(f) ? 'image/png' : /\.gif$/i.test(f) ? 'image/gif' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg';
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } };
  });

  const imgNote = imgParts.length
    ? (frameFiles.length
        ? `\n\n[本轮] 主人发来一段视频，我从里面抽了 ${frameFiles.length} 帧画面附在这条消息里。你只能看到画面，听不到声音；至于视频里说了什么，直说听不到。`
        : `\n\n[本轮] 主人发来 ${savedFiles.length} 张图片，已经作为图片附在这条消息里，你能直接看图、描述画面、判断内容。`)
    : '';
  const isOwner = String(uid) === CFG.owner;
  const who = isOwner ? '主人' : '对方';
  const imgNote2 = isOwner ? imgNote : imgNote.replace(/主人/g, '对方');
  const messages = [
    { role: 'system', content: systemPrompt(uid) + (isOwner ? crossChannelNote() : '') + imgNote2 },
    ...historyFor(uid),
  ];
  if (imgParts.length) {
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = {
      role: 'user',
      content: [{ type: 'text', text: typeof last.content === 'string' ? last.content : text }, ...imgParts],
    };
  }
  let reply;
  toolsThisTurn = 0;
  const ackTimer = setTimeout(() => {
    if (toolsThisTurn > 0) sendTo(uid, '我看一下，稍等。', { humanDelay: false }).catch(() => {});
  }, 3500);
  try {
    CURRENT_UID = uid;
    reply = await chatWithTools(messages, String(uid) === CFG.owner ? TOOLS : []);
  } catch (e) {
    clearTimeout(ackTimer);
    log('调用模型失败：', e.message);
    await sendTo(uid, '（脑子卡了一下，稍等再试）', { humanDelay: false }).catch(() => {});
    return;
  }
  clearTimeout(ackTimer);
  reply = stripDSML(reply);
  if (!reply) reply = '这一步没跑出结果，主人再说一次？';
  pushMem(uid, 'assistant', reply);
  try {
    await sendTo(uid, reply);
  } catch (e) {
    log('发送失败：', e.message);
  }
}

/* ================= 启动 ================= */

/* ---- 每日天气推送（不调模型，零 token） ---- */

const WEATHER_FILE = path.join(DATA_DIR, 'weather_state.json');
const CITY = { wuhan: { name: '武汉', lat: 30.5928, lon: 114.3055 } };
const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨',
  71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '强阵雨',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹'
};

function weatherState() {
  try { return JSON.parse(fs.readFileSync(WEATHER_FILE, 'utf8')); } catch { return {}; }
}

async function sendWeatherNow() {
  const c = CITY[CFG.weatherCity] || CITY.wuhan;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
    '&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&timezone=Asia%2FShanghai&forecast_days=1';
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  let j;
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) { log(`[天气] HTTP ${r.status}`); return false; }
    j = await r.json();
  } catch (e) { log('[天气] 请求失败：', e.message); return false; } finally { clearTimeout(t); }
  const cur = j.current || {};
  const d = j.daily || {};
  const text = WMO[cur.weather_code] || '—';
  const max = d.temperature_2m_max?.[0];
  const min = d.temperature_2m_min?.[0];
  const p = d.precipitation_probability_max?.[0];
  const umbrella = p >= 50 ? '，记得带伞' : '';
  const msg = `早上好主人，${c.name}今天${text}，${min}~${max}℃，降水概率${p}%${umbrella}。`;
  const res = await callAction('send_private_msg', { user_id: Number(CFG.owner), message: msg });
  const ok = !!(res && (res.message_id || res.status === 'ok'));
  log(`[天气] ${ok ? '已推送' : '推送失败'} ${min}~${max}℃ ${text}`);
  return ok;
}

async function pushWeather() {
  const now = new Date();
  const [h, m] = CFG.weatherAt.split(':').map(Number);
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + (m || 0)) return;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (weatherState().lastDay === today) return;
  if (await sendWeatherNow()) {
    try { fs.writeFileSync(WEATHER_FILE, JSON.stringify({ lastDay: today, at: Date.now() })); } catch {}
  }
}

function main() {
  if (!CFG.apiKey) fatal('DEEPSEEK_API_KEY 没填，打开 .env 补上。');
  if (!CFG.owner) fatal('OWNER_QQ 没填，那是你本人的 QQ 号（白名单）。');

  log('==============================');
  log(' 大肥鱼 QQ 桥接');
  log(` 白名单：${CFG.owner}${CFG.extras.length ? ' + ' + CFG.extras.map((x) => `${x.uid}(${x.name})`).join('、') : ''}`);
  log(` 模型 ：${CFG.model} @ ${CFG.apiBase}`);
  log(` 接口 ：${CFG.ws}`);
  log(` 视频帧：${(FFMPEG = findFfmpeg()) || '未找到 ffmpeg（视频只能看到占位符）'}`);
  log(` 记忆 ：${recent(1000).length} 条（共同步 ${recent(1000, 'gui').length} 条电脑端）`);
  log('==============================');

  syncOnce(true);
  connect();

  // 每天到点自动汇总一次（不总结就完全不调用模型，闲置时 0 token）
  if (!CFG.summaryOff) {
    setInterval(() => {
      const [h, m] = CFG.summaryAt.split(':').map(Number);
      const d = new Date();
      if (d.getHours() * 60 + d.getMinutes() < h * 60 + (m || 0)) return;
      runDailySummary().catch((e) => log('[汇总] 失败：', e.message));
    }, 60000);
  }

  // 每天早上推一条天气（不调模型，直接 HTTP，零 token）
  if (CFG.weatherOn) {
    setInterval(() => {
      pushWeather().catch((e) => log('[天气] 失败：', e.message));
    }, 60000);
  }

  // 群白名单 / 回复模式 每 30 秒对一次 .env（控制台改完立即生效，不用重启）
  setInterval(() => { refreshWatchGroups(true); }, 30000);

  // 60 秒无任何数据就主动重连（NapCat 心跳 30s）
  setInterval(() => {
    if (connected && Date.now() - lastRecv > 60000) {
      log('⚠️ 60 秒无心跳，主动重连');
      try { ws.close(); } catch {}
    }
  }, 30000);
}

main();
