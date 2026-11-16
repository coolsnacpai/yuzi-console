/** 把 DSH 电脑端会话导入共享记忆。会话文件是多个 zstd 帧拼接，需要逐帧解压。 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { append, readState, writeState, trim, ROOT } from './memory.mjs';
import { pathToFileURL } from 'node:url';

const HOME = process.env.USERPROFILE || process.env.HOME;
const SESSIONS_ROOT = path.join(HOME, '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function sessionDirFor(cwd = process.cwd()) {
  const enc = cwd.replace(/:/g, '').replace(/\\/g, '-').replace(/ /g, '~0020');
  return path.join(SESSIONS_ROOT, `--${enc}--`);
}

/** 从 qq-bridge 往上找第一个存在会话目录的工作区路径 */
export function resolveWorkspace(cwd) {
  const chain = [];
  let cur = cwd || path.dirname(ROOT);
  for (let i = 0; i < 4 && cur; i++) {
    chain.push(cur);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const c of chain) {
    try { if (fs.statSync(sessionDirFor(c)).isDirectory()) return c; } catch {}
  }
  return chain[0];
}

function decodeZstd(file) {
  const buf = fs.readFileSync(file);
  const pos = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) pos.push(i);
  }
  const parts = [];
  for (let k = 0; k < pos.length; k++) {
    const end = k + 1 < pos.length ? pos[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(pos[k], end))); } catch {}
  }
  return Buffer.concat(parts).toString('utf8');
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n').trim();
}

const NOISE = [/^Time sampled while preparing/, /^background job /, /^<system/, /^\[bili\]/, /^\[ACP\]/];

function isNoise(t) {
  return !t || NOISE.some((re) => re.test(t.trim()));
}

/** 返回本次新导入的条数 */
export function syncGui({ cwd = null, maxInitial = 40, verbose = false } = {}) {
  const dir = sessionDirFor(resolveWorkspace(cwd));
  let files = [];
  try {
    for (const sub of fs.readdirSync(dir)) {
      const p = path.join(dir, sub);
      try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
      for (const f of fs.readdirSync(p)) {
        if (f.endsWith('.jsonl.zstd')) files.push(path.join(p, f));
      }
    }
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch { return 0; }
  if (!files.length) return 0;

  const state = readState();
  state.sessions ||= {};
  let added = 0;

  for (const file of files.slice(0, 1)) {
    const sid = path.basename(path.dirname(file));
    let lines;
    try { lines = decodeZstd(file).split(/\r?\n/).filter(Boolean); } catch { continue; }

    const records = [];
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.type === 'user/message') {
        const t = textOf(o.data?.content);
        if (!isNoise(t)) records.push({ seq: o.seq, role: 'owner', text: t, time: o.time });
      } else if (o.type === 'assistant/message') {
        const t = textOf(o.data?.message?.content);
        if (!isNoise(t)) records.push({ seq: o.seq, role: 'assistant', text: t, time: o.time });
      }
    }

    const lastSeq = state.sessions[sid] || 0;
    let fresh = records.filter((r) => r.seq > lastSeq);
    if (!lastSeq) fresh = fresh.slice(-maxInitial);

    for (const r of fresh) append({ ch: 'gui', role: r.role, text: r.text, t: r.time });
    if (fresh.length) {
      state.sessions[sid] = Math.max(lastSeq, ...records.map((r) => r.seq));
      writeState(state);
      added += fresh.length;
      if (verbose) console.log(`[同步] ${sid.slice(0, 24)}… 导入 ${fresh.length} 条`);
    }
  }

  if (added) trim(800);
  return added;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const n = syncGui({ verbose: true });
  console.log(n ? `完成，同步 ${n} 条电脑端对话` : '没有新内容需要同步');
}
