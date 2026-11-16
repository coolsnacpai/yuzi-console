/**
 * 记忆包 / 性格包 —— 导出、导入、互通。
 *
 * 设计目标：
 *   1) 体积小：gzip 压过的 JSON，.yzm / .yzp 后缀，纯文本工具也能看懂（gunzip 就是 JSON）。
 *   2) 兼容好：不依赖本机路径、QQ 号、时间格式；渠道用短码，导入时再映射回当前账号。
 *   3) 可迁移：导出的记忆包能直接给一个全新用户（他的主人号/小号都不一样也能用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeDocx, writeRtf, readAnyDoc } from './docfmt.mjs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readAll } from './memory.mjs';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const BRAIN = path.join(DATA, 'brain', 'messages.jsonl');
const STYLE_FILE = path.join(DATA, 'style.json');
const PERSONA_FILE = path.join(ROOT, 'persona.md');

export const MEM_TAG = 'yuzu.memory';
export const PER_TAG = 'yuzu.persona';
export const PACK_VERSION = 1;

/* ---------------- 小工具 ---------------- */

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
function gz(obj) { return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'), { level: 9 }); }
function ungz(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length > 1 && b[0] === 0x1f && b[1] === 0x8b) return zlib.gunzipSync(b);
  return b;
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function hash(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12); }
function envOwner() {
  try {
    const t = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = t.match(/^OWNER_QQ\s*=\s*(\d+)/m);
    return m ? m[1] : '';
  } catch { return ''; }
}

/* ---------------- 渠道短码：导出压成 3 种，导入再还原 ---------------- */
export function toCode(ch) {
  if (ch === 'qq' || ch === 'owner') return 'o';
  if (ch === 'gui') return 'x';
  if (ch.startsWith('qq:')) return 'f:' + ch.slice(3);
  if (ch.startsWith('group:')) return 'g:' + ch.slice(6);
  return 'u:' + ch;
}
export function fromCode(code) {
  if (code === 'o' || code === 'owner' || code === 'qq') return 'qq';
  if (code === 'x' || code === 'gui') return 'gui';
  if (code.startsWith('f:')) return 'qq:' + code.slice(2);
  if (code.startsWith('g:')) return 'group:' + code.slice(2);
  if (code.startsWith('u:')) return code.slice(2);
  return code;
}

/* ---------------- 记忆包 ---------------- */

export function memoryStats() {
  const all = readAll();
  const byCh = {};
  for (const m of all) { const k = m.ch || 'qq'; byCh[k] = (byCh[k] || 0) + 1; }
  let size = 0;
  try { size = fs.statSync(BRAIN).size; } catch {}
  const est = gz({ format: MEM_TAG, messages: all.map((m) => [m.t, toCode(m.ch || 'qq'), m.text]) }).length;
  return {
    total: all.length,
    byChannel: byCh,
    firstAt: all.length ? all[0].t : 0,
    lastAt: all.length ? all[all.length - 1].t : 0,
    rawKB: Math.round(size / 1024),
    packKB: Math.round(est / 1024),
  };
}

/**
 * 导出记忆包。
 * scope: 'all' 全部 | 'owner' 只主人私聊 | 'chat' 只 QQ 侧（私聊+群，不含电脑端）
 */
export function exportMemory({ scope = 'all', limit = 0 } = {}) {
  let all = readAll();
  if (scope === 'owner') all = all.filter((m) => (m.ch || 'qq') === 'qq');
  else if (scope === 'chat') all = all.filter((m) => (m.ch || '').startsWith('qq') || (m.ch || '').startsWith('group'));
  if (limit > 0) all = all.slice(-limit);

  const friends = readJson(path.join(DATA, 'friends.json'), {});
  const names = {};
  if (envOwner()) names[envOwner()] = '主人';
  for (const [uid, v] of Object.entries(friends || {})) {
    if (v && typeof v === 'object' && v.name) names[uid] = v.name;
  }

  const pack = {
    format: MEM_TAG,
    version: PACK_VERSION,
    createdAt: new Date().toISOString(),
    source: {
      ownerQQ: envOwner(),
      count: all.length,
      names,
      note: '记忆包只含对话文本与时间戳，不含 API Key、cookie、文件路径。',
    },
    // 紧凑三元组：[时间戳, 渠道短码, 角色, 文本]
    messages: all.map((m) => [m.t, toCode(m.ch || 'qq'), m.role === 'assistant' ? 1 : 0, String(m.text || '').slice(0, 4000)]),
  };
  const buf = gz(pack);
  return { buf, filename: `玉子记忆包-${stamp()}.yzm`, count: all.length, sizeKB: Math.round(buf.length / 1024), pack };
}

/** 解析记忆包（接受 gzip 的 .yzm 或未压缩 JSON） */
export function parseMemoryPack(buf) {
  const raw = ungz(buf).toString('utf8');
  let obj;
  try { obj = JSON.parse(raw); } catch { throw new Error('不是有效的记忆包（JSON 解析失败）'); }
  if (!obj || obj.format !== MEM_TAG) {
    if (Array.isArray(obj)) obj = { format: MEM_TAG, version: PACK_VERSION, messages: obj };
    else throw new Error(`格式不对：需要 ${MEM_TAG}`);
  }
  const msgs = [];
  for (const row of obj.messages || []) {
    let t, ch, role, text;
    if (Array.isArray(row)) {
      t = Number(row[0]) || 0;
      ch = fromCode(String(row[1] || 'o'));
      role = Number(row[2]) === 1 ? 'assistant' : 'user';
      text = String(row[3] || '');
    } else if (row && typeof row === 'object') {
      t = Number(row.t) || 0;
      ch = fromCode(String(row.ch || 'o'));
      role = row.role === 'assistant' ? 'assistant' : 'user';
      text = String(row.text || '');
    } else continue;
    if (!text.trim()) continue;
    msgs.push({ t, ch, role, text: text.slice(0, 4000) });
  }
  return { meta: { format: obj.format || '', version: obj.version || 1, createdAt: obj.createdAt || '', source: obj.source || {} }, messages: msgs };
}

/**
 * 导入记忆。mode: 'merge' 去重合并（默认） | 'replace' 覆盖
 * 返回 { added, dup, total }
 */
export function importMemory(buf, { mode = 'merge' } = {}) {
  const { messages } = parseMemoryPack(buf);
  if (!messages.length) throw new Error('记忆包里没有有效消息');

  const existing = mode === 'replace' ? [] : readAll();
  const seen = new Set(existing.map((m) => m.t + '|' + (m.ch || 'qq') + '|' + hash(m.text)));
  let added = 0;
  let dup = 0;
  const out = existing.slice();
  for (const m of messages) {
    const key = m.t + '|' + m.ch + '|' + hash(m.text);
    if (seen.has(key)) { dup++; continue; }
    seen.add(key);
    out.push({ t: m.t || Date.now(), ch: m.ch, role: m.role, text: m.text });
    added++;
  }
  out.sort((a, b) => (a.t || 0) - (b.t || 0));
  const tmp = BRAIN + '.tmp';
  fs.mkdirSync(path.dirname(BRAIN), { recursive: true });
  fs.writeFileSync(tmp, out.map((x) => JSON.stringify(x)).join('\n') + (out.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, BRAIN);
  return { added, dup, total: out.length, mode };
}

/* ---------------- 性格：风格档案 ---------------- */

export const STYLE_DEFAULTS = {
  name: '玉子',
  callUser: '主人',
  tone: '温柔、机灵、偶尔毒舌',
  length: '1-3 句，短句优先',
  emoji: false,
  quirks: [],
  forbid: ['作为一个人工智能', 'AI 助手'],
  extra: '',
};

export function readStyle() {
  const s = readJson(STYLE_FILE, null);
  return s && typeof s === 'object' ? { ...STYLE_DEFAULTS, ...s } : { ...STYLE_DEFAULTS };
}
export function writeStyle(style) {
  const clean = {};
  for (const k of Object.keys(STYLE_DEFAULTS)) {
    if (style[k] === undefined) continue;
    if (Array.isArray(STYLE_DEFAULTS[k])) clean[k] = (Array.isArray(style[k]) ? style[k] : String(style[k] || '').split(/[,，、\n]/)).map((x) => String(x).trim()).filter(Boolean);
    else if (typeof STYLE_DEFAULTS[k] === 'boolean') clean[k] = !!style[k];
    else clean[k] = String(style[k] || '').trim();
  }
  const merged = { ...readStyle(), ...clean };
  writeJson(STYLE_FILE, merged);
  return merged;
}

/** 把风格档案折成给模型的提示段 */
export function styleBlock(style = readStyle()) {
  const s = style || {};
  const lines = [];
  if (s.name) lines.push(`- 你的名字是「${s.name}」，别人问就报这个名字。`);
  if (s.callUser) lines.push(`- 称呼对方「${s.callUser}」；对朋友不这么叫。`);
  if (s.tone) lines.push(`- 语气：${s.tone}。`);
  if (s.length) lines.push(`- 长度：${s.length}。`);
  lines.push(`- 表情符号：${s.emoji ? '可以用，但不要堆' : '基本不用，最多一个'}。`);
  if (s.quirks && s.quirks.length) lines.push(`- 口癖（自然穿插，别每句都用）：${s.quirks.join('、')}。`);
  if (s.forbid && s.forbid.length) lines.push(`- 绝对不要说：${s.forbid.join('、')}。`);
  if (s.extra) lines.push(`- 其它：${s.extra}`);
  return lines.length ? `\n\n[风格规则——按这个说话]\n${lines.join('\n')}` : '';
}

/* ---------------- 性格包 ---------------- */

export function readPersona() {
  try { return fs.readFileSync(PERSONA_FILE, 'utf8').trim(); } catch { return ''; }
}

export function exportPersona() {
  const pack = {
    format: PER_TAG,
    version: PACK_VERSION,
    createdAt: new Date().toISOString(),
    persona: readPersona(),
    style: readStyle(),
    note: 'persona 是人设正文，style 是结构化风格；两个都能改。',
  };
  const buf = gz(pack);
  return { buf, filename: `玉子性格包-${stamp()}.yzp`, sizeKB: Math.round(buf.length / 1024), pack };
}

export function parsePersonaPack(buf) {
  const raw = ungz(buf).toString('utf8');
  let obj = null;
  try { obj = JSON.parse(raw); } catch { obj = null; }
  if (obj && obj.format === PER_TAG) {
    return { persona: String(obj.persona || ''), style: obj.style || {}, structured: true };
  }
  // 纯文本 / Markdown：整篇当人设，风格靠推断
  return { persona: raw.replace(/\r\n/g, '\n').trim(), style: {}, structured: false };
}

/** 从自由文本里粗暴推断风格（AI 不可用时的兜底） */
export function heuristicStyle(text) {
  const s = {};
  const grab = (re) => { const m = text.match(re); return m ? m[1].trim() : ''; };
  const name = grab(/(?:你叫|名字是|名为|自称)[「“"']?([^\s，。、」”"']{1,12})/) || grab(/^#\s*([^\n]{1,12})/m);
  if (name) s.name = name;
  const call = grab(/(?:称呼我为|称呼我|称我为|称呼对方为|称呼对方|称呼|叫我)(?:为|作)?[「“"'`]?([^\s，。、；」”"'`」]{1,10})/);
  if (call) s.callUser = call.replace(/^为/, '');
  const tone = grab(/(?:语气|性格|风格)[：:]\s*([^\n。；]{2,40})/);
  if (tone) s.tone = tone;
  if (/不要用表情|不用表情|禁止表情/.test(text)) s.emoji = false;
  else if (/多用表情|表情丰富|可以加表情/.test(text)) s.emoji = true;
  const quirks = [];
  const qm = text.match(/(?:口癖|口头禅)[：:]\s*([^\n。；]{2,60})/);
  if (qm) quirks.push(...qm[1].split(/[、,，\s]+/).map((x) => x.replace(/[。；].*$/, '').trim()).filter(Boolean).slice(0, 8));
  if (quirks.length) s.quirks = quirks;
  if (/简短|简洁|短句|别啰嗦/.test(text)) s.length = '1-2 句，短句优先';
  if (/长篇|详细|多说/.test(text)) s.length = '可以多说几句，2-5 句';
  return s;
}

/** 用 DeepSeek 把任意人设文本整理成风格 JSON；失败返回 null */
export async function aiStyle(text, { apiKey, base = 'https://api.deepseek.com', model = 'deepseek-chat', timeoutMs = 30000 } = {}) {
  if (!apiKey) return null;
  const ask = [
    { role: 'system', content: '你是人设整理器。把给定的人设文本提炼成 JSON，只输出 JSON，不要解释。' },
    { role: 'user', content: `人设文本：\n"""\n${text.slice(0, 6000)}\n"""\n\n输出字段：name（角色名字）、callUser（如何称呼用户）、tone（语气，20字内）、length（回复长度要求）、emoji（true/false）、quirks（口癖数组，0-5个）、forbid（禁止出现的话数组，0-5个）、extra（其它硬性要求，50字内）。缺信息就留空字符串或空数组。` },
  ];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: ask, temperature: 0.2, max_tokens: 800, response_format: { type: 'json_object' } }),
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const txt = j?.choices?.[0]?.message?.content || '';
    return JSON.parse(txt);
  } catch { return null; } finally { clearTimeout(timer); }
}

/**
 * 导入性格包。返回 { structured, personaLen, style, aiUsed }
 */
export async function importPersona(buf, { useAI = true, apiKey = '', model = 'deepseek-chat', base = 'https://api.deepseek.com', mode = 'replace' } = {}) {
  const parsed = parsePersonaPack(buf);
  let style = { ...STYLE_DEFAULTS, ...(parsed.style || {}) };
  let aiUsed = false;

  if (!parsed.structured) {
    const guess = heuristicStyle(parsed.persona);
    style = { ...style, ...guess };
    if (useAI && apiKey) {
      const ai = await aiStyle(parsed.persona, { apiKey, model, base });
      if (ai && typeof ai === 'object') {
        style = { ...style, ...Object.fromEntries(Object.entries(ai).filter(([, v]) => v !== '' && !(Array.isArray(v) && !v.length))) };
        aiUsed = true;
      }
    }
  }

  if (parsed.persona) {
    if (mode === 'replace') fs.writeFileSync(PERSONA_FILE, parsed.persona.endsWith('\n') ? parsed.persona : parsed.persona + '\n', 'utf8');
    else fs.appendFileSync(PERSONA_FILE, '\n\n' + parsed.persona + '\n', 'utf8');
  }
  const saved = writeStyle(style);
  return { structured: parsed.structured, personaLen: readPersona().length, style: saved, aiUsed };
}

/* ---------------- 文档格式（docx / doc / rtf） ---------------- */

/** 判断是不是记忆包/性格包（gzip 或 JSON），否则当普通文档处理 */
export function looksLikePack(buf) {
  if (!buf || !buf.length) return false;
  if (buf[0] === 0x1f && buf[1] === 0x8b) return true;   // gzip
  const head = buf.slice(0, 400).toString('utf8').trim();
  if (!(head.startsWith('{') || head.startsWith('['))) return false;
  // 必须真的是记忆包/性格包的 JSON：带 format 标记或 messages/人设字段
  if (head.startsWith('{\\rtf')) return false;
  if (/"format"\s*:/.test(head)) return true;
  if (/"messages"\s*:/.test(head)) return true;
  if (/"persona"\s*:/.test(head) && /"style"\s*:/.test(head)) return true;
  return false;
}

const SCOPES = { all: '全部（含电脑端）', chat: 'QQ 侧（私聊+群）', owner: '只主人私聊' };

/** 记忆导出成 Word：可读的聊天记录 */
export function exportMemoryDoc({ scope = 'all', fmt = 'docx' } = {}) {
  const { pack, count } = exportMemory({ scope });
  const blocks = [];
  blocks.push({ text: `导出时间：${new Date().toLocaleString('zh-CN')}　共 ${count} 条　范围：${SCOPES[scope] || scope}`, size: 10, color: '808080' });
  blocks.push({ text: '（这份文件是「给人看」的版本；要还原成记忆请用 .yzm 记忆包）', size: 10, color: '808080' });
  blocks.push({ text: '' });
  const who = (code, role) => {
    if (role === 'assistant') return '玉子';
    if (code === 'o') return '主人';
    if (code === 'x') return '电脑端';
    if (code.startsWith('f:')) return '好友 ' + code.slice(2);
    if (code.startsWith('g:')) return '群 ' + code.slice(2);
    return '我';
  };
  for (const [ts, code, role, text] of pack.messages) {
    const d = new Date(Number(ts) || Date.now());
    const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const day = d.getMonth() + 1 + '/' + d.getDate();
    blocks.push({ text: `[${day} ${hh}] ${who(code, role === 1 ? 'assistant' : 'user')}：`, size: 9, color: '4a6fa5' });
    blocks.push({ text: String(text), size: 10 });
  }
  const title = '玉子记忆导出 · ' + (SCOPES[scope] || scope);
  if (fmt === 'doc') return { buf: Buffer.from(writeRtf(title, blocks), 'utf8'), filename: `玉子记忆-${stamp()}.doc`, count };
  return { buf: writeDocx(title, blocks), filename: `玉子记忆-${stamp()}.docx`, count };
}

/** 把一份普通文档（doc/docx/md/txt）当记忆导入：每段一条，渠道 doc */
export function importDocMemory(buf, filename = '', { mode = 'merge' } = {}) {
  const text = readAnyDoc(buf, filename);
  const paras = text.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (!paras.length) throw new Error('文档里没抽到文字');
  const now = Date.now();
  const pack = {
    format: MEM_TAG,
    version: PACK_VERSION,
    createdAt: new Date().toISOString(),
    source: { ownerQQ: envOwner(), count: paras.length, note: '文档导入' },
    messages: paras.map((p, i) => [now + i, 'u:doc', 0, p.slice(0, 4000)]),
  };
  const r = importMemory(Buffer.from(JSON.stringify(pack), 'utf8'), { mode });
  return { ...r, paras: paras.length, docName: filename };
}

/** 性格导出成 Word */
export function exportPersonaDoc({ fmt = 'docx' } = {}) {
  const persona = readPersona();
  const s = readStyle();
  const blocks = [];
  blocks.push({ text: '【风格档案】', bold: true, size: 13 });
  const rows = [
    ['名字', s.name], ['怎么称呼用户', s.callUser], ['语气', s.tone], ['回复长度', s.length],
    ['口癖', (s.quirks || []).join('、')], ['绝对不说', (s.forbid || []).join('、')],
    ['其它硬要求', s.extra], ['允许表情符号', s.emoji ? '是' : '否'],
  ];
  for (const [k, v] of rows) if (v) blocks.push({ text: `${k}：${v}`, size: 10 });
  blocks.push({ text: '' });
  blocks.push({ text: '【人设正文】', bold: true, size: 13 });
  for (const line of persona.split(/\n+/)) if (line.trim()) blocks.push({ text: line.trim(), size: 10 });
  const title = '玉子性格包 · ' + (s.name || '玉子');
  if (fmt === 'doc') return { buf: Buffer.from(writeRtf(title, blocks), 'utf8'), filename: `玉子性格包-${stamp()}.doc` };
  if (fmt === 'md') {
    const md = ['# ' + title, '', '## 风格档案', ...rows.filter(([, v]) => v).map(([k, v]) => `- ${k}：${v}`), '', '## 人设正文', '', persona].join('\n');
    return { buf: Buffer.from(md, 'utf8'), filename: `玉子性格包-${stamp()}.md` };
  }
  return { buf: writeDocx(title, blocks), filename: `玉子性格包-${stamp()}.docx` };
}

/** 从任意文档抽人设文本（供 importPersona 的纯文本分支使用） */
export function personaTextFromDoc(buf, filename = '') {
  return readAnyDoc(buf, filename);
}
