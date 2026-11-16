/** 跨渠道共享记忆：QQ 和电脑会话共用同一个记录文件。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BRAIN_DIR = path.join(ROOT, 'data', 'brain');
const MSG_FILE = path.join(BRAIN_DIR, 'messages.jsonl');
const STATE_FILE = path.join(BRAIN_DIR, 'state.json');

fs.mkdirSync(BRAIN_DIR, { recursive: true });

export function append(entry) {
  const rec = {
    t: entry.t || Date.now(),
    ch: entry.ch || 'qq',
    role: entry.role || 'owner',
    text: String(entry.text || '').slice(0, 4000),
  };
  if (!rec.text.trim()) return;
  fs.appendFileSync(MSG_FILE, JSON.stringify(rec) + '\n', 'utf8');
}

export function readAll() {
  try {
    return fs.readFileSync(MSG_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** 取最近 n 条，可按渠道过滤 */
export function recent(n = 40, ch = null) {
  const all = readAll();
  const list = ch ? all.filter((x) => x.ch === ch) : all;
  return list.slice(-n);
}

export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { sessions: {} }; }
}

export function writeState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

/** 只保留最近 max 条，防止无限膨胀 */
export function trim(max = 800) {
  const all = readAll();
  if (all.length <= max) return 0;
  const keep = all.slice(-max);
  fs.writeFileSync(MSG_FILE, keep.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  return all.length - keep.length;
}

/** 清空某个渠道的记忆 */
export function clearChannel(ch) {
  const keep = readAll().filter((x) => x.ch !== ch);
  fs.writeFileSync(MSG_FILE, keep.map((x) => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
  return keep.length;
}

export function fmtTime(t) {
  return new Date(t).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5);
}
