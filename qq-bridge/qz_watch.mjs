// qz_watch.mjs —— QQ空间动态监听：主人发新说说 → 尝试点赞 + 评论 + 私聊回执
// 用法：
//   node qz_watch.mjs          # 常驻监听
//   node qz_watch.mjs --test   # 只对最新一条做一次点赞/评论尝试，打印原始返回
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { likePost, commentPost } from './qz_browser.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
for (const raw of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 1) continue;
  process.env[line.slice(0, eq).trim()] ??= line.slice(eq + 1).trim();
}

const CFG = {
  ws: process.env.NAPCAT_WS || 'ws://127.0.0.1:3001',
  owner: process.env.OWNER_QQ,
  // 拉取间隔：默认一天一次（主人在 .env 里设 QZ_POLL_MS 可改，单位毫秒）
  pollMs: Number(process.env.QZ_POLL_MS || 86400000),
};
const DATA = path.join(ROOT, 'data');
const STATE = path.join(DATA, 'qzone.json');
const LOG = path.join(DATA, 'qzone.log');
fs.mkdirSync(DATA, { recursive: true });

/* ===== 单实例锁：靠占端口判断，避免两条监听各点一次赞 ===== */
if (!process.argv.includes('--test')) {
  const lock = net.createServer();
  lock.on('error', () => {
    console.log('[单实例] 已经有一个空间监听在跑了，本进程退出');
    process.exit(0);
  });
  lock.listen(3009, '127.0.0.1');
}

function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch {}
}

// ---------- OneBot WS ----------
let ws = null;
let seq = 0;
const pending = new Map();

function connect() {
  return new Promise((resolve) => {
    const sock = new WebSocket(CFG.ws);
    sock.onopen = () => {
      ws = sock;
      log('已连接 NapCat');
      resolve(true);
    };
    sock.onerror = () => resolve(false);
    sock.onclose = () => {
      if (ws === sock) ws = null;
      resolve(false);
    };
    sock.onmessage = (e) => {
      let d;
      try {
        d = JSON.parse(e.data.toString());
      } catch {
        return;
      }
      const p = pending.get(d.echo);
      if (p) {
        pending.delete(d.echo);
        p(d);
      }
    };
  });
}

async function call(action, params = {}, timeoutMs = 20000) {
  if (!ws || ws.readyState !== 1) {
    const ok = await connect();
    if (!ok) throw new Error('NapCat 未连接');
  }
  const echo = `qz${++seq}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(echo);
      reject(new Error(`动作 ${action} 超时`));
    }, timeoutMs);
    pending.set(echo, (d) => {
      clearTimeout(t);
      resolve(d);
    });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

// ---------- QQ空间 ----------
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let ckCache = null;

async function cookies() {
  if (ckCache && Date.now() - ckCache.at < 20 * 60 * 1000) return ckCache;
  const r = await call('get_cookies', { domain: 'qzone.qq.com' });
  if (r.status !== 'ok') throw new Error('取 cookies 失败');
  ckCache = { at: Date.now(), cookies: r.data.cookies, bkn: r.data.bkn };
  return ckCache;
}

function jsonp(text) {
  const m = text.match(/callback\(\s*(\{[\s\S]*\})\s*\)/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function fetchFeed(hostUin, num = 10) {
  const ck = await cookies();
  const url =
    `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6` +
    `?uin=${hostUin}&ftype=0&sort=0&pos=0&num=${num}&replynum=0&g_tk=${ck.bkn}` +
    `&callback=_preloadCallback&code=2&format=jsonp&need_private_comment=1`;
  const r = await fetch(url, {
    headers: { Cookie: ck.cookies, Referer: `https://user.qzone.qq.com/${hostUin}`, 'User-Agent': UA },
  });
  const text = await r.text();
  const m = text.match(/^\s*_preloadCallback\(([\s\S]*)\)\s*;?\s*$/);
  if (!m) return [];
  const j = JSON.parse(m[1]);
  return (j.msglist || []).map((it) => ({
    tid: it.tid,
    uin: String(it.uin),
    created: Number(it.created_time || 0),
    content: String(it.content || ''),
    pics: Number(it.pictotal || 0),
  }));
}

// 旧版纯 API 实现：腾讯已用 qzonetoken 风控挡住，保留仅作对照
async function doLikeApi(post) {
  const ck = await cookies();
  const hostUin = post.uin;
  const unikey = `http://user.qzone.qq.com/${hostUin}/mood/${post.tid}`;
  const params = new URLSearchParams({
    opuin: hostUin,
    unikey,
    curkey: unikey,
    appid: '311',
    typeid: '0',
    abstime: String(post.created),
    fid: post.tid,
    from: '1',
    active: '0',
    format: 'json',
    g_tk: ck.bkn,
  });
  const r = await fetch(
    'https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?' + params,
    {
      method: 'POST',
      headers: {
        Cookie: ck.cookies,
        Referer: `https://user.qzone.qq.com/${hostUin}/mood/${post.tid}`,
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    },
  );
  const text = await r.text();
  return { http: r.status, json: jsonp(text), raw: text.slice(0, 300) };
}

async function doCommentApi(post, content) {
  const ck = await cookies();
  const hostUin = post.uin;
  const params = new URLSearchParams({
    topicId: `${hostUin}_${post.tid}`,
    feedsType: '100',
    inVirtualFeedKey: `${hostUin}_${post.tid}__1`,
    content,
    ua: UA,
    format: 'json',
    g_tk: ck.bkn,
  });
  const r = await fetch(
    'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_re_feeds?' + params,
    {
      method: 'POST',
      headers: {
        Cookie: ck.cookies,
        Referer: `https://user.qzone.qq.com/${hostUin}/mood/${post.tid}`,
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    },
  );
  const text = await r.text();
  return { http: r.status, json: jsonp(text), raw: text.slice(0, 300) };
}

// 新版：无头 Edge 里真点在页面按钮上（Cookie 从 NapCat 取，行为=真人）
async function doLike(post) {
  try {
    return await likePost(post.tid);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function doComment(post, content) {
  try {
    return await commentPost(post.tid, content);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const LINES = [
  '沙发！这条我先占着。',
  '看到了看到了，路过点个赞。',
  '这条挺有意思，收下了。',
  '嘿嘿，刚刷到你的新动态。',
  '又是你，我就看着不说话。',
];

function brief(content, n = 30) {
  return content
    .replace(/@\{[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return { seen: [], inited: false };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
}

async function tellOwner(text) {
  try {
    await call('send_private_msg', { user_id: Number(CFG.owner), message: text });
  } catch (e) {
    log('私聊失败', e.message);
  }
}

// ---------- 主流程 ----------
if (process.argv.includes('--test')) {
  const feed = await fetchFeed(CFG.owner, 3);
  const p = feed[0];
  if (!p) {
    log('读不到说说');
    process.exit(1);
  }
  log('最新说说', p.tid, brief(p.content, 40), '图片', p.pics);
  const like = await doLike(p);
  log('点赞结果', JSON.stringify(like).slice(0, 300));
  const cm = await doComment(p, '来啦，坐我旁边');
  log('评论结果', JSON.stringify(cm).slice(0, 300));
  process.exit(0);
}

await connect();
const state = loadState();
log(`监听启动：判定新动态 = uin ${CFG.owner} 且未见过；间隔 ${Math.round(CFG.pollMs / 60000)} 分钟`);

async function tick() {
  let feed;
  try {
    feed = await fetchFeed(CFG.owner);
  } catch (e) {
    log('拉取失败', e.message);
    return;
  }
  const mine = feed.filter((p) => p.uin === String(CFG.owner));
  if (!state.inited) {
    state.seen = mine.map((p) => p.tid);
    state.inited = true;
    saveState(state);
    log(`首次运行，记为已读 ${mine.length} 条`);
    return;
  }
  const fresh = mine.filter((p) => !state.seen.includes(p.tid)).reverse();
  for (const p of fresh) {
    log('发现新说说', p.tid, brief(p.content, 40));
    const like = await doLike(p);
    const likeOk = like.ok === true;
    log('点赞', likeOk ? (like.already ? '已经赞过' : '成功') : `失败 ${JSON.stringify(like).slice(0, 80)}`);
    const line = LINES[Math.floor(Math.random() * LINES.length)];
    const cm = await doComment(p, line);
    const cmOk = cm.ok === true;
    log('评论', cmOk ? '成功' : `失败 ${JSON.stringify(cm).slice(0, 80)}`);
    const txt = p.content ? `「${brief(p.content, 26)}」` : '（这组图我看到了）';
    const tail =
      likeOk || cmOk
        ? '空间里已经给你点了，嘿嘿。'
        : '空间那边腾讯拦着不让程序点赞，我就在这儿先应你一声。';
    await tellOwner(`你的新说说${txt}我刷到了。${tail}`);
    state.seen.push(p.tid);
  }
  if (fresh.length) {
    state.seen = state.seen.slice(-200);
    saveState(state);
  }
}

await tick();
setInterval(() => {
  tick().catch((e) => log('tick 异常', e.message));
}, CFG.pollMs);
