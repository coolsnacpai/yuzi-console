// qz_browser.mjs —— 用无头 Edge 真人在场式地给说说点赞/评论
// 用法：
//   node qz_browser.mjs <tid> --like-only
//   node qz_browser.mjs <tid> "评论内容"
//   node qz_browser.mjs <tid> "评论内容" --dry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage } from './cdp.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
for (const raw of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 1) continue;
  process.env[line.slice(0, eq).trim()] ??= line.slice(eq + 1).trim();
}

const WS = process.env.NAPCAT_WS;
const OWNER = process.env.OWNER_QQ;

function napcat(action, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const t = setTimeout(() => reject(new Error('NapCat 超时')), 15000);
    ws.onopen = () => ws.send(JSON.stringify({ action, params, echo: 'x' }));
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data.toString());
      if (!d.status) return;
      clearTimeout(t);
      ws.close();
      resolve(d);
    };
    ws.onerror = () => reject(new Error('NapCat 连不上'));
  });
}

export async function openMood(tid) {
  const page = await openPage();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');

  const ctxByFrame = new Map();
  page.on('Runtime.executionContextCreated', (p) => {
    const fid = p.context.auxData && p.context.auxData.frameId;
    if (fid) ctxByFrame.set(fid, p.context.id);
  });
  page.on('Runtime.executionContextDestroyed', (p) => {
    for (const [fid, id] of ctxByFrame) if (id === p.executionContextId) ctxByFrame.delete(fid);
  });

  const ck = await napcat('get_cookies', { domain: 'qzone.qq.com' });
  await page.setCookies(ck.data.cookies);
  await page.goto(`https://user.qzone.qq.com/${OWNER}/mood/${tid}`);
  await new Promise((r) => setTimeout(r, 7000));

  const tree = await page.send('Page.getFrameTree');
  const flat = [];
  (function walk(n) {
    flat.push({ id: n.frame.id, url: n.frame.url });
    (n.childFrames || []).forEach(walk);
  })(tree.frameTree);
  const mood = flat.find((f) => f.url.includes('mood_v6'));
  const ctxId = mood ? ctxByFrame.get(mood.id) : null;
  if (!ctxId) throw new Error('找不到说说 iframe');
  return { page, ctxId };
}

const LIKE_STATE = `
  (() => {
    const btn = [...document.querySelectorAll('a.qz_like_btn')].find(e => e.offsetHeight > 0);
    if (!btn) return JSON.stringify({ found: false });
    const txt = (btn.textContent || '').trim();
    const m = txt.match(/(\\d+)/);
    return JSON.stringify({ found: true, text: txt, count: m ? Number(m[1]) : null, liked: txt.includes('\\u53d6\\u6d88') });
  })()
`;

export async function likePost(tid) {
  const { page, ctxId } = await openMood(tid);
  const before = JSON.parse(await page.eval(LIKE_STATE, true, ctxId));
  if (!before.found) {
    page.close();
    return { ok: false, reason: 'no-button' };
  }
  if (before.liked) {
    page.close();
    return { ok: true, already: true, text: before.text };
  }
  await page.eval(
    `(() => { const b = [...document.querySelectorAll('a.qz_like_btn')].find(e => e.offsetHeight > 0); if (b) b.click(); return 1; })()`,
    true,
    ctxId,
  );
  await new Promise((r) => setTimeout(r, 2500));
  const after = JSON.parse(await page.eval(LIKE_STATE, true, ctxId));
  page.close();
  return { ok: after.liked === true, before: before.text, after: after.text, delta: (after.count ?? 0) - (before.count ?? 0) };
}

export async function commentPost(tid, text, { dry = false } = {}) {
  const { page, ctxId } = await openMood(tid);

  const opened = await page.eval(
    `(() => {
       const el = document.querySelector('.mod_comment_poster_wrapper .textinput_default') ||
                  document.querySelector('.comments_box .textinput_default');
       if (!el) return 'no-el';
       const r = el.getBoundingClientRect();
       const o = { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5, view: window };
       el.dispatchEvent(new MouseEvent('mousedown', o));
       el.dispatchEvent(new MouseEvent('mouseup', o));
       el.dispatchEvent(new MouseEvent('click', o));
       return 'opened';
     })()`,
    true,
    ctxId,
  );
  if (opened !== 'opened') {
    page.close();
    return { ok: false, reason: opened };
  }
  await new Promise((r) => setTimeout(r, 1500));

  const focused = await page.eval(
    `(() => {
       const eds = [...document.querySelectorAll('.qz-poster-editor-cont [contenteditable]')].filter(e => e.offsetHeight > 0);
       const el = eds[eds.length - 1];
       if (!el) return 'no-editor';
       el.focus();
       const s = window.getSelection(); const r = document.createRange();
       r.selectNodeContents(el); r.collapse(false);
       s.removeAllRanges(); s.addRange(r);
       return 'focused';
     })()`,
    true,
    ctxId,
  );
  if (focused !== 'focused') {
    page.close();
    return { ok: false, reason: focused, stage: 'editor' };
  }

  // 逐字符真实按键：框架只有在真实编辑事件后才生成“发表”按钮
  for (const ch of text) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 1200));

  const typed = await page.eval(
    `(() => {
       const eds = [...document.querySelectorAll('.qz-poster-editor-cont [contenteditable]')].filter(e => e.offsetHeight > 0);
       const el = eds[eds.length - 1];
       return el ? (el.textContent || '').trim() : '';
     })()`,
    true,
    ctxId,
  );
  if (!typed) {
    page.close();
    return { ok: false, reason: 'typing-failed' };
  }
  if (dry) {
    page.close();
    return { ok: false, dry: true, typed };
  }

  const submitted = await page.eval(
    `(() => {
       const btn = [...document.querySelectorAll('a.btn-post, .btn-post')].find(e => e.offsetHeight > 0);
       if (!btn) return 'no-submit';
       btn.click();
       return 'submitted';
     })()`,
    true,
    ctxId,
  );
  await new Promise((r) => setTimeout(r, 5000));

  const listText = await page.eval(
    `(() => {
       const el = document.querySelector('.comments_list') || document.querySelector('.mod_comments');
       return el ? (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 600) : '';
     })()`,
    true,
    ctxId,
  );
  page.close();
  return { ok: listText.includes(text.slice(0, 5)), typed, submitted, listText };
}

if (process.argv[1] && process.argv[1].endsWith('qz_browser.mjs')) {
  const tid = process.argv[2];
  const flags = process.argv.slice(3).filter((a) => a.startsWith('--'));
  const words = process.argv.slice(3).filter((a) => !a.startsWith('--'));
  const likeOnly = flags.includes('--like-only');
  const dry = flags.includes('--dry');
  const text = words[0] || '';
  if (!tid) {
    console.log('用法: node qz_browser.mjs <tid> ["评论内容"] [--like-only] [--dry]');
    process.exit(1);
  }
  if (!likeOnly) console.log('点赞:', JSON.stringify(await likePost(tid)));
  if (text) console.log('评论:', JSON.stringify(await commentPost(tid, text, { dry })));
  process.exit(0);
}
